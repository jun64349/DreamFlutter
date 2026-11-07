import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { PYTHON_SOURCES, hostProjectFiles, packageEnvironment, projectPaths } from "../src/agent/package-sources.ts";
import { applyToolEnvironment, withToolEnvironment } from "../src/agent/tool-environment.ts";
import { JobRegistry, PersistentShell, pwshTool } from "../src/agent/shell.ts";
import { HarnessState } from "../src/agent/state.ts";
import { PackageSourcesModule } from "../src/modules/package-sources.ts";
import { linuxSourceEnvironment } from "../src/agent/sandbox-shell.ts";
import { bundledPython, TOOLS_DIR } from "../src/agent/toolchain.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

const dirs: string[] = [], cores: TestCore[] = [], shells: PersistentShell[] = [];
afterEach(async () => {
  for (const shell of shells.splice(0)) shell.reset();
  for (const core of cores.splice(0)) await core.cleanup();
  for (const dir of dirs.splice(0)) { assert.ok(dir.startsWith(join(tmpdir(), "df-package-source-"))); rmSync(dir, { recursive: true, force: true }); }
});
function fixture() { const dir = mkdtempSync(join(tmpdir(), "df-package-source-")); dirs.push(dir); return dir; }
function result(dir: string, pythonPackageSource: "inherit" | "pypi" | "tuna" | "ustc" = "tuna", npmPackageSource: "inherit" | "npm" | "npmmirror" = "npmmirror") {
  return packageEnvironment({ pythonPackageSource, npmPackageSource }, hostProjectFiles(projectPaths(dir, dir)), { cwd: dir, workspace: dir, platform: "host" });
}
async function core() { const t = await startTestCore(); cores.push(t); return t; }
const values = "[ordered]@{ pid=$PID; uv=$env:UV_DEFAULT_INDEX; pip=$env:PIP_INDEX_URL; npm=$env:npm_config_registry; config=$env:PIP_CONFIG_FILE } | ConvertTo-Json -Compress";

it("inherit preserves existing source/proxy/TLS environment and app presets set only process indexes", () => {
  const dir = fixture(); const base = { PIP_INDEX_URL: "https://existing.invalid", HTTPS_PROXY: "http://name:private@127.0.0.1:1234", NODE_TLS_REJECT_UNAUTHORIZED: "1" };
  const inherited = result(dir, "inherit", "inherit");
  assert.deepEqual(inherited.variables, {}); assert.deepEqual(inherited.unset, []);
  assert.deepEqual(applyToolEnvironment(base, inherited), base);
  const env = applyToolEnvironment(base, result(dir));
  assert.equal(env.UV_DEFAULT_INDEX, PYTHON_SOURCES.tuna); assert.equal(env.PIP_INDEX_URL, PYTHON_SOURCES.tuna); assert.equal(env.npm_config_registry, "https://registry.npmmirror.com");
  assert.equal(env.HTTPS_PROXY, base.HTTPS_PROXY); assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, "1");
  assert.equal(env.PIP_TRUSTED_HOST, undefined); assert.equal(env.UV_INSECURE_HOST, undefined);
  assert.equal(env.UV_EXTRA_INDEX_URL, undefined); assert.equal(env.PIP_EXTRA_INDEX_URL, undefined);
});

it("project uv/pip/npm settings win independently, are not rewritten and private URLs never enter snapshots", () => {
  const dir = fixture();
  writeFileSync(join(dir, "pyproject.toml"), '[project]\nname="fixture"\nversion="0.1.0"\n[[tool.uv.index]]\nurl="https://user:private@project.invalid/simple"\ndefault=true\n');
  writeFileSync(join(dir, "pip.ini"), "[global]\nindex-url=https://user:private@project.invalid/simple\n");
  writeFileSync(join(dir, ".npmrc"), "registry=https://user:private@project.invalid\n");
  const before = readFileSync(join(dir, "pip.ini"), "utf8"), choice = result(dir);
  const env = applyToolEnvironment({ UV_INDEX_URL: "old", PIP_INDEX_URL: "old", NPM_CONFIG_REGISTRY: "old" }, choice);
  assert.equal(env.UV_DEFAULT_INDEX, undefined); assert.equal(env.UV_INDEX_URL, undefined); assert.equal(env.PIP_INDEX_URL, undefined); assert.equal(env.NPM_CONFIG_REGISTRY, undefined);
  assert.equal(env.PIP_CONFIG_FILE, join(dir, "pip.ini"));
  assert.equal(choice.snapshot.uv.layer, "project"); assert.equal(choice.snapshot.pip.layer, "project"); assert.equal(choice.snapshot.npm.layer, "project");
  assert.doesNotMatch(JSON.stringify(choice.snapshot), /private|user:|project\.invalid/);
  assert.equal(readFileSync(join(dir, "pip.ini"), "utf8"), before);
});

it("lock files alone do not suppress explicit presets; unknown project files and directory-changing commands decline injection", () => {
  const dir = fixture(); writeFileSync(join(dir, "uv.lock"), "version=1\n"); writeFileSync(join(dir, "package-lock.json"), "{}\n");
  const selected = result(dir);
  assert.deepEqual(selected.snapshot.locks, { uv: true, npm: true }); assert.equal(selected.snapshot.uv.layer, "application");
  const paths = projectPaths(dir, dir), files = hostProjectFiles(paths); files[join(dir, ".npmrc")] = { state: "unknown" };
  const unknown = packageEnvironment({ pythonPackageSource: "tuna", npmPackageSource: "npmmirror" }, files, { cwd: dir, workspace: dir, platform: "host", command: "cd child; npm install" });
  assert.deepEqual(unknown.variables, {}); assert.equal(unknown.snapshot.npm.layer, "existing");
  assert.equal(readFileSync(join(dir, "uv.lock"), "utf8"), "version=1\n");
});

it("persistent shell retains unchanged environment, completes an active command then refreshes before the next", async () => {
  const t = await core(); t.core.settings.update({ pythonPackageSource: "tuna", npmPackageSource: "npmmirror" });
  const provider = t.core.module(PackageSourcesModule)!;
  const shell = withToolEnvironment({ provider, workspace: t.workspace }, () => new PersistentShell(() => t.workspace)); shells.push(shell);
  const first = JSON.parse(await shell.run(values, undefined));
  assert.equal(first.uv, PYTHON_SOURCES.tuna);
  assert.equal(JSON.parse(await shell.run(values, undefined)).pid, first.pid);
  const marker = join(t.workspace, "started.txt");
  const running = shell.run(`Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value started; Start-Sleep -Milliseconds 400; ${values}`, undefined);
  await t.waitFor(() => existsSync(marker), 10_000);
  t.core.settings.update({ pythonPackageSource: "ustc" });
  assert.equal(JSON.parse(await running).uv, PYTHON_SOURCES.tuna, "running commands retain their original environment");
  const refreshed = JSON.parse(await shell.run(values, undefined));
  assert.equal(refreshed.uv, PYTHON_SOURCES.ustc); assert.notEqual(refreshed.pid, first.pid);
  writeFileSync(join(t.workspace, "uv.toml"), 'index-url="https://project.invalid/simple"\n');
  const project = JSON.parse(await shell.run(values, undefined));
  assert.equal(project.uv, null); assert.equal(project.pip, PYTHON_SOURCES.ustc);
  const status = await t.core.call("packageSources.status", { cwd: t.workspace }) as any;
  assert.equal(status.recent.host.uv.layer, "project");
});

it("standard pwsh reads the project workdir and isolated core contexts cannot share selected sources", async () => {
  const a = await core(), b = await core();
  a.core.settings.update({ pythonPackageSource: "tuna" }); b.core.settings.update({ pythonPackageSource: "ustc" });
  const jobs = new JobRegistry();
  for (const [t, expected] of [[a, PYTHON_SOURCES.tuna], [b, PYTHON_SOURCES.ustc]] as const) {
    const tool = withToolEnvironment({ provider: t.core.module(PackageSourcesModule)!, workspace: t.workspace }, () => pwshTool(new HarnessState(t.workspace), jobs));
    const response = await tool.execute("sources", { command: "Write-Output $env:UV_DEFAULT_INDEX", description: "Read current index", timeoutMs: 5000 }, undefined, undefined, {} as never);
    assert.match(String((response.content[0] as any).text), new RegExp(expected.replaceAll(".", "\\.")));
  }
  jobs.killAll();
});

it("Core.openSlot captures the provider without editing harness, including the minimal persistent shell", async () => {
  const t = await core(); t.core.settings.update({ pythonPackageSource: "tuna", approvalMode: "off" });
  await t.core.openSlot({ slotId: "source-scope", cwd: t.workspace, agentMode: "minimal", client: t.client });
  let step = 0;
  t.respond((_context: Context) => {
    step++;
    return step === 1 ? fauxAssistantMessage([{ type: "toolCall", id: "source-tool", name: "pwsh", arguments: { command: "Write-Output $env:UV_DEFAULT_INDEX" } }]) : fauxAssistantMessage("done");
  });
  t.respond(() => fauxAssistantMessage("done"));
  await t.send("source-scope", { id: "source-prompt", type: "prompt", message: "read source" });
  await t.waitFor(() => settledCount(t.records("source-scope")) === 1, 20_000);
  assert.match(JSON.stringify(t.records("source-scope")), /mirrors\.tuna\.tsinghua\.edu\.cn/);
});

it("invalid source values cannot overwrite persisted choices", async () => {
  const t = await core(); t.core.settings.update({ pythonPackageSource: "tuna", npmPackageSource: "npmmirror" });
  t.core.settings.update({ pythonPackageSource: "http://not-a-preset.invalid", npmPackageSource: "" });
  assert.equal(t.core.settings.get().pythonPackageSource, "tuna"); assert.equal(t.core.settings.get().npmPackageSource, "npmmirror");
});

it("inherit retains persistent state across directory changes and Linux exports never include proxy credentials", async () => {
  const t = await core();
  const provider = t.core.module(PackageSourcesModule)!;
  const shell = withToolEnvironment({ provider, workspace: t.workspace }, () => new PersistentShell(() => t.workspace)); shells.push(shell);
  const nested = join(t.workspace, "nested"); mkdirSync(nested);
  const first = await shell.run(`$env:T65_RETAIN='retained'; Set-Location -LiteralPath '${nested.replaceAll("'", "''")}'; Write-Output $PID`, undefined);
  const next = await shell.run("Write-Output $PID; Write-Output $env:T65_RETAIN", undefined);
  assert.equal(next, `${first}\nretained`);
  const source = result(t.workspace);
  assert.match(linuxSourceEnvironment(source), /export UV_DEFAULT_INDEX='https:\/\/mirrors\.tuna/);
  assert.doesNotMatch(linuxSourceEnvironment(source), /proxy|password|trusted.host|INSECURE/i);
});

it("actual uv/pip/npm HTTPS requests select presets or project sources through a proxy without changing TLS", async () => {
  const dir = fixture(), seen: string[] = [];
  const server = createServer((_req, res) => { res.writeHead(502); res.end(); });
  server.on("connect", (req, socket) => { seen.push(req.url ?? ""); socket.end("HTTP/1.1 502 No upstream in test\r\nConnection: close\r\n\r\n"); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const port = (server.address() as { port: number }).port;
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(proxy|^pip_|^uv_|^npm_config_|^rust_log$)/i.test(k)));
    Object.assign(base, { HOME: dir, USERPROFILE: dir, APPDATA: dir, LOCALAPPDATA: dir, XDG_CONFIG_HOME: dir,
      HTTPS_PROXY: `http://fixture-user:fixture-secret@127.0.0.1:${port}`, HTTP_PROXY: `http://127.0.0.1:${port}`, NO_PROXY: "",
      PIP_CONFIG_FILE: "NUL", PIP_RETRIES: "0", PIP_TIMEOUT: "2", PIP_DISABLE_PIP_VERSION_CHECK: "1", UV_HTTP_RETRIES: "0", UV_HTTP_TIMEOUT: "2", UV_PYTHON_DOWNLOADS: "never",
      npm_config_userconfig: join(dir, "npmrc"), npm_config_cache: join(dir, "npm-cache"), npm_config_fetch_retries: "0", npm_config_fetch_timeout: "2000" });
    writeFileSync(join(dir, "npmrc"), ""); writeFileSync(join(dir, "requirements.txt"), "idna==3.10\n");
    const python = bundledPython()!;
    assert.ok(python, "bundled Python required for this regression");
    const tools = [
      { name: "uv", exe: join(TOOLS_DIR, "uv.exe"), args: ["pip", "compile", "requirements.txt", "--python-version", "3.13", "--no-cache"] },
      { name: "pip", exe: python, args: ["-m", "pip", "download", "--no-deps", "--no-cache-dir", "idna==3.10"] },
      { name: "npm", exe: process.execPath, args: [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), "view", "is-number@7.0.0", "version"] },
    ];
    for (const scenario of ["official", "mirror", "project"] as const) {
      if (scenario === "project") {
        writeFileSync(join(dir, "uv.toml"), '[[index]]\nurl="https://pypi.org/simple"\ndefault=true\n');
        writeFileSync(join(dir, "pip.ini"), "[global]\nindex-url=https://pypi.org/simple\n");
        writeFileSync(join(dir, ".npmrc"), "registry=https://registry.npmjs.org\n");
      }
      const source = result(dir, scenario === "official" ? "pypi" : "tuna", scenario === "official" ? "npm" : "npmmirror");
      for (const tool of tools) await (async () => {
        const start = seen.length;
        const env = applyToolEnvironment(base, source);
        assert.equal(env.PIP_TRUSTED_HOST, undefined); assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined); assert.equal(env.UV_INSECURE_HOST, undefined);
        await new Promise<void>((done, reject) => {
          const child = spawn(tool.exe, tool.args, { cwd: dir, env, windowsHide: true, stdio: "ignore" });
          const timer = setTimeout(() => { child.kill(); reject(new Error(`${tool.name} did not finish`)); }, 10_000);
          child.on("error", (error) => { clearTimeout(timer); reject(error); });
          child.on("close", () => { clearTimeout(timer); done(); });
        });
        const expected = scenario === "mirror" ? tool.name === "npm" ? "registry.npmmirror.com:443" : "mirrors.tuna.tsinghua.edu.cn:443" : tool.name === "npm" ? "registry.npmjs.org:443" : "pypi.org:443";
        assert.ok(seen.slice(start).includes(expected), `${scenario}/${tool.name}: expected HTTPS CONNECT ${expected}, saw ${seen.slice(start).join(",")}`);
      })();
    }
    const t = await core(), messages: unknown[] = [];
    t.core.settings.update({ pythonPackageSource: "tuna", npmPackageSource: "npmmirror" });
    t.core.log.info = (message, detail) => { messages.push({ message, detail }); };
    t.core.module(PackageSourcesModule)!.host(dir, dir);
    assert.match(JSON.stringify(messages), /package sources/);
    assert.doesNotMatch(JSON.stringify(messages), /fixture-secret|fixture-user|HTTPS_PROXY|https:\/\//);
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});

it("child tools and public session reloads retain the owning core's selected environment", async () => {
  const t = await core(); t.core.settings.update({ pythonPackageSource: "tuna", npmPackageSource: "npmmirror", approvalMode: "off" });
  let childOutput = "";
  const route = (context: Context) => {
    const messages = context.messages.filter((message) => message.role !== "system");
    const child = messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("## Task"));
    const last = messages.at(-1)!;
    if (child) {
      if (last.role === "toolResult") { childOutput = JSON.stringify(last.content); return fauxAssistantMessage(childOutput); }
      return fauxAssistantMessage([fauxToolCall("pwsh", { command: "Write-Output $env:UV_DEFAULT_INDEX; Write-Output $env:npm_config_registry", description: "Read isolated child indexes", timeoutMs: 5000 })], { stopReason: "toolUse" });
    }
    if (last.role === "toolResult") return fauxAssistantMessage("done");
    return fauxAssistantMessage([fauxToolCall("agent", { role: "general", description: "Check child source context", prompt: "Read the selected indexes in an isolated tool process" })], { stopReason: "toolUse" });
  };
  t.respond(...Array(4).fill(route));
  await t.core.openSlot({ slotId: "source-child", cwd: t.workspace, client: t.client });
  await t.send("source-child", { id: "child-context", type: "prompt", message: "check tool environment" });
  await t.waitFor(() => settledCount(t.records("source-child")) === 1, 20_000);
  assert.match(childOutput, /mirrors\.tuna\.tsinghua\.edu\.cn/); assert.match(childOutput, /registry\.npmmirror\.com/);

  await t.core.openSlot({ slotId: "source-reload", cwd: t.workspace, agentMode: "minimal", client: t.client });
  await t.core.slot("source-reload").session.reload();
  t.core.settings.update({ pythonPackageSource: "ustc" });
  assert.equal(t.faux.getPendingResponseCount(), 0);
  t.respond(() => fauxAssistantMessage([fauxToolCall("pwsh", { command: "Write-Output $env:UV_DEFAULT_INDEX" })], { stopReason: "toolUse" }), () => fauxAssistantMessage("done"));
  await t.send("source-reload", { id: "reload-context", type: "prompt", message: "read reloaded environment" });
  await t.waitFor(() => settledCount(t.records("source-reload")) === 1, 20_000);
  assert.match(JSON.stringify(t.records("source-reload")), /mirrors\.ustc\.edu\.cn/);
});
