import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildCore } from "../src/app.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { corePaths, defaultAgentDir } from "../src/paths.ts";
import { storageLocations } from "../src/storage/locations.ts";
import { bundledPython, toolchainEnv, TOOLS_DIR } from "../src/agent/toolchain.ts";
import { SandboxShell } from "../src/agent/sandbox-shell.ts";
import { withToolEnvironment } from "../src/agent/tool-environment.ts";
import { PackageSourcesModule } from "../src/modules/package-sources.ts";
import { AGENT_UID, CHECK_SCRIPT, Sandbox, runWsl, type WslRunner } from "../src/sandbox/sandbox.ts";
import { bundledImage } from "../src/sandbox/image.ts";

const evidence = process.argv[2];
if (!evidence) throw new Error("usage: live-package-sources-t65.ts <evidence-json>");
const temporary = mkdtempSync(join(tmpdir(), "df-t65-sources-"));
const root = join(temporary, "data"), host = join(temporary, "host");
mkdirSync(host);
const distro = `df-t65-mirrors-${randomUUID().slice(0, 12)}`;
// WSL shares its network across distributions. Give this test agent/table unique identities:
// the production boot script is exercised without altering another sandbox's uid rules.
const uid = 35000 + Math.floor(Math.random() * 15000), table = `dreamflutter_t65_${randomUUID().slice(0, 8)}`;
const wsl: WslRunner = (args, options) => {
  const input = options?.input;
  return runWsl(args, typeof input === "string" && input.includes("table inet dreamflutter")
    ? { ...options, input: input.replaceAll(String(AGENT_UID), String(uid)).replaceAll("dreamflutter", table) } : options);
};
for (const path of Object.values(storageLocations(root))) mkdirSync(path, { recursive: true });
const core = buildCore({ piMigration: { automatic: false }, paths: corePaths(root), agentDir: defaultAgentDir(root), sessionDir: storageLocations(root).sessions,
  log: new Logger(undefined, false), notifier: new RecordingNotifier(), sandbox: { distro, wsl } });
core.settings.update({ memoryPaused: true, memoryAutoExtract: false, autoTitle: false, sandboxOnline: true });
const provider = core.module(PackageSourcesModule)!;
const sandbox = core.module(Sandbox)!;
const shell = withToolEnvironment({ provider, workspace: host }, () => new SandboxShell(distro, () => sandbox.prepare()));
const rows: Record<string, unknown>[] = [];
const proof: Record<string, any> = { at: new Date().toISOString(), temporary, distro, isolatedUid: uid, isolatedTable: table, modelCalls: 0, modelCost: 0, rows };
const allowedHosts = new Set(["pypi.org", "files.pythonhosted.org", "mirrors.tuna.tsinghua.edu.cn", "mirrors.ustc.edu.cn", "registry.npmjs.org", "registry.npmmirror.com", "cdn.npmmirror.com"]);
const clean = (s: string) => s.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@").replaceAll(temporary, "<temporary>");
function observations(output: string) {
  const urls = [...new Set((output.match(/https?:\/\/[^\s<>"'`)]+/g) ?? []).flatMap((item) => {
    try { const u = new URL(item); return allowedHosts.has(u.hostname) ? [`${u.origin}${u.pathname}`] : []; } catch { return []; }
  }))];
  return { urls, hosts: [...new Set(urls.map((u) => new URL(u).hostname))] };
}
function save() { writeFileSync(evidence, JSON.stringify(proof, null, 2)); }
function record(platform: string, label: string, started: number, code: number | null, output: string, more: Record<string, unknown> = {}) {
  const row = { platform, label, code, elapsedMs: Date.now() - started, ...observations(output), tail: clean(output).split(/\r?\n/).filter(Boolean).slice(-9).join("\n"), ...more };
  rows.push(row); save(); console.log(`${platform} ${label}: code=${code}, ${row.elapsedMs}ms, hosts=${row.hosts.join(",")}`); return row;
}
const base: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(^npm_config_|^pip_|^uv_|^python|^dreamflutter_|^rust_log$|proxy)/i.test(key)));
Object.assign(base, { HOME: host, USERPROFILE: host, APPDATA: host, LOCALAPPDATA: host, XDG_CONFIG_HOME: host, DREAMFLUTTER_CACHE: join(host, "cache"),
  PIP_CONFIG_FILE: "NUL", PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_RETRIES: "0", PIP_TIMEOUT: "8", UV_HTTP_RETRIES: "0", UV_HTTP_TIMEOUT: "8", UV_NO_PROGRESS: "1",
  npm_config_cache: join(host, "npm-cache"), npm_config_userconfig: join(host, "npmrc"), npm_config_fetch_retries: "0", npm_config_fetch_timeout: "10000", npm_config_audit: "false", npm_config_fund: "false" });
writeFileSync(join(host, "npmrc"), "");
async function native(label: string, exe: string, args: string[], cwd = host, timeout = 25_000) {
  const source = provider.host(cwd, host), env = toolchainEnv(base, undefined, undefined, source), started = Date.now();
  return new Promise<ReturnType<typeof record>>((done) => {
    let output = "", expired = false;
    const child = spawn(exe, args, { cwd, env, windowsHide: true });
    const timer = setTimeout(() => { expired = true; child.kill(); }, timeout);
    child.stdout.on("data", (data) => output += data); child.stderr.on("data", (data) => output += data);
    child.on("error", (error) => { clearTimeout(timer); done(record("Windows", label, started, null, String(error), { layers: source.snapshot })); });
    child.on("close", (code) => { clearTimeout(timer); done(record("Windows", label, started, code, output, { timedOut: expired, layers: source.snapshot })); });
  });
}
async function linux(label: string, command: string) {
  const started = Date.now(), signal = AbortSignal.timeout(40_000), output = await shell.run(command, signal);
  const code = /\[exit code: (\d+)\]/.exec(output)?.[1];
  return record("WSL", label, started, code ? Number(code) : signal.aborted || /shell exited|timed out/.test(output) ? null : 0, output, { layers: (await core.call("packageSources.status", { cwd: host }) as any).recent.sandbox });
}
const uv = join(TOOLS_DIR, "uv.exe"), python = bundledPython()!, npm = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const hash = (path: string) => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
try {
  await core.start();
  assert.ok(python && existsSync(uv) && existsSync(npm), "use already bundled tools");
  await native("uv-version", uv, ["--version"]); await native("pip-version", python, ["-m", "pip", "--version"]); await native("npm-version", process.execPath, [npm, "--version"]);
  for (const mirror of [false, true]) {
    const label = mirror ? "mirror" : "official";
    core.settings.update({ pythonPackageSource: mirror ? "tuna" : "pypi", npmPackageSource: mirror ? "npmmirror" : "npm" });
    await native(`${label}-uv-install`, uv, ["-v", "pip", "install", "--no-cache", "--target", join(host, `uv-${label}`), "idna==3.10"]);
    await native(`${label}-pip-download`, python, ["-m", "pip", "download", "--no-cache-dir", "--no-deps", "--dest", join(host, `pip-${label}`), "--verbose", "idna==3.10"]);
    await native(`${label}-npm-view`, process.execPath, [npm, "view", "is-number@7.0.0", "dist.tarball", "--loglevel=http", `--cache=${join(host, `npm-${label}`)}`]);
  }
  // Lock fixtures are explicitly generated in isolation; application code never writes them.
  const uvdir = join(host, "uv-lock"), npmdir = join(host, "npm-lock"); mkdirSync(uvdir); mkdirSync(npmdir);
  writeFileSync(join(uvdir, "pyproject.toml"), '[project]\nname="t65-fixture"\nversion="0.1.0"\nrequires-python=">=3.13"\ndependencies=["idna==3.10"]\n');
  writeFileSync(join(npmdir, "package.json"), JSON.stringify({ name: "t65-fixture", version: "1.0.0", private: true, dependencies: { "is-number": "7.0.0" } }));
  core.settings.update({ pythonPackageSource: "pypi", npmPackageSource: "npm" });
  await native("uv-create-lock-official", uv, ["lock", "-v"], uvdir);
  await native("npm-create-lock-official", process.execPath, [npm, "install", "--package-lock-only", "--ignore-scripts", "--loglevel=http"], npmdir);
  const beforeUv = hash(join(uvdir, "uv.lock")), beforeNpm = hash(join(npmdir, "package-lock.json"));
  core.settings.update({ pythonPackageSource: "tuna", npmPackageSource: "npmmirror" });
  await native("uv-sync-existing-lock-mirror", uv, ["sync", "--locked", "--no-install-project", "-v"], uvdir);
  await native("npm-ci-existing-lock-mirror", process.execPath, [npm, "ci", "--ignore-scripts", "--loglevel=http"], npmdir);
  proof.hostLocks = { uv: { created: !!beforeUv, unchanged: !!beforeUv && beforeUv === hash(join(uvdir, "uv.lock")) }, npm: { created: !!beforeNpm, unchanged: !!beforeNpm && beforeNpm === hash(join(npmdir, "package-lock.json")) } }; save();
  // Actual project precedence, with synthetic credential-free config, and no network request.
  writeFileSync(join(host, ".npmrc"), "registry=https://project.example.invalid\n");
  writeFileSync(join(host, "pip.ini"), "[global]\nindex-url=https://project.example.invalid/simple\n");
  await native("project-npm-registry", process.execPath, [npm, "config", "get", "registry"]);
  const pipProject = await native("project-pip-index", python, ["-m", "pip", "config", "list"]);
  assert.match(pipProject.tail, /global\.index-url='https:\/\/project\.example\.invalid\/simple'/);
  rmSync(join(host, ".npmrc")); rmSync(join(host, "pip.ini"));

  assert.ok(bundledImage(), "no online image rebuild");
  console.log("Importing only own temporary distro", distro);
  const imported = await runWsl(["--import", distro, join(sandbox.dir, "disk"), bundledImage()!, "--version", "2"], { timeoutMs: 180_000 });
  assert.equal(imported.code, 0, imported.stderr);
  const check = await runWsl(["-d", distro, "-u", "root", "--", "sh", "-s"], { input: CHECK_SCRIPT, timeoutMs: 30_000 });
  assert.match(check.stdout, /CHECK_OK/);
  const identity = await runWsl(["-d", distro, "-u", "root", "--", "sh", "-s"], { input: `usermod -u ${uid} agent && chown -R ${uid} /workspace\n`, timeoutMs: 30_000 });
  assert.equal(identity.code, 0, identity.stderr);
  await linux("linux-source-env", `python3 -c 'import os,json; print(json.dumps({k:os.getenv(k) for k in ["UV_DEFAULT_INDEX","PIP_INDEX_URL","npm_config_registry"]}))'`);
  const envRead = rows.at(-1)!.tail as string;
  assert.match(envRead, /mirrors\.tuna\.tsinghua\.edu\.cn/); assert.match(envRead, /registry\.npmmirror\.com/);
  await linux("tool-versions", "python3 --version; npm --version; command -v uv || true");
  core.settings.update({ pythonPackageSource: "pypi", npmPackageSource: "npm" });
  const prepare = await linux("isolated-uv-tooling", "python3 -m venv /workspace/t65-tools && timeout 30s /workspace/t65-tools/bin/python -m pip install --retries 0 --timeout 8 --disable-pip-version-check uv==0.13.6 && /workspace/t65-tools/bin/uv --version");
  proof.linuxUvAvailable = prepare.code === 0;
  for (const mirror of [false, true]) {
    const label = mirror ? "mirror" : "official";
    core.settings.update({ pythonPackageSource: mirror ? "tuna" : "pypi", npmPackageSource: mirror ? "npmmirror" : "npm" });
    if (proof.linuxUvAvailable) await linux(`${label}-uv-install`, `timeout 25s /workspace/t65-tools/bin/uv -v pip install --python /workspace/t65-tools/bin/python --no-cache --target /workspace/uv-${label} idna==3.10`);
    await linux(`${label}-pip-download`, `timeout 25s python3 -m pip download --retries 0 --timeout 8 --disable-pip-version-check --no-cache-dir --no-deps --dest /workspace/pip-${label} --verbose idna==3.10`);
    await linux(`${label}-npm-view`, `timeout 20s npm view is-number@7.0.0 dist.tarball --fetch-retries=0 --fetch-timeout=10000 --loglevel=http --cache=/workspace/npm-${label}`);
  }
  // Settings refresh and actual Linux project discovery, using only our own fixture files.
  await linux("linux-create-project-configs", `printf '%s\n' 'index-url="https://project.example.invalid/simple"' > /workspace/uv.toml; printf '%s\n' '[global]' 'index-url=https://project.example.invalid/simple' > /workspace/pip.conf; printf '%s\n' 'registry=https://project.example.invalid' > /workspace/.npmrc`);
  await linux("linux-project-env", `python3 -c 'import os,json; print(json.dumps({k:os.getenv(k) for k in ["UV_DEFAULT_INDEX","PIP_INDEX_URL","PIP_CONFIG_FILE","npm_config_registry"]}))'; npm config get registry`);
  const projectLayers = (rows.at(-1)!.layers as any);
  assert.equal(projectLayers.uv.layer, "project"); assert.equal(projectLayers.pip.layer, "project"); assert.equal(projectLayers.npm.layer, "project");
  await linux("linux-remove-project-configs", "rm /workspace/uv.toml /workspace/pip.conf /workspace/.npmrc");
  // Repeat lock behavior in Linux as well, keeping all fixtures inside this new distro.
  await linux("linux-lock-fixtures", `mkdir -p /workspace/uv-lock /workspace/npm-lock; printf '%s\\n' '[project]' 'name="t65-fixture"' 'version="0.1.0"' 'requires-python=">=3.13"' 'dependencies=["idna==3.10"]' > /workspace/uv-lock/pyproject.toml; printf '%s\\n' '{"name":"t65-fixture","version":"1.0.0","private":true,"dependencies":{"is-number":"7.0.0"}}' > /workspace/npm-lock/package.json`);
  core.settings.update({ pythonPackageSource: "pypi", npmPackageSource: "npm" });
  await linux("linux-enter-uv-lock", "cd /workspace/uv-lock");
  if (proof.linuxUvAvailable) await linux("uv-create-lock-official", "timeout 25s /workspace/t65-tools/bin/uv lock --python /workspace/t65-tools/bin/python -v");
  const uvHash = await linux("uv-lock-hash-before", "sha256sum uv.lock");
  core.settings.update({ pythonPackageSource: "tuna", npmPackageSource: "npmmirror" });
  if (proof.linuxUvAvailable) await linux("uv-sync-existing-lock-mirror", "timeout 25s /workspace/t65-tools/bin/uv sync --python /workspace/t65-tools/bin/python --locked --no-install-project -v");
  const uvHashAfter = await linux("uv-lock-hash-after", "sha256sum uv.lock");
  core.settings.update({ pythonPackageSource: "pypi", npmPackageSource: "npm" });
  await linux("linux-enter-npm-lock", "cd /workspace/npm-lock");
  await linux("npm-create-lock-official", "timeout 25s npm install --package-lock-only --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=8000 --loglevel=http");
  const npmHash = await linux("npm-lock-hash-before", "sha256sum package-lock.json");
  core.settings.update({ pythonPackageSource: "tuna", npmPackageSource: "npmmirror" });
  await linux("npm-ci-existing-lock-mirror", "timeout 25s npm ci --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=8000 --loglevel=http --cache=/workspace/npm-lock-cache");
  const npmHashAfter = await linux("npm-lock-hash-after", "sha256sum package-lock.json");
  proof.linuxLocks = { uv: { unchanged: uvHash.code === 0 && uvHash.tail === uvHashAfter.tail }, npm: { unchanged: npmHash.code === 0 && npmHash.tail === npmHashAfter.tail } };
  assert.ok(proof.linuxLocks.uv.unchanged && proof.linuxLocks.npm.unchanged);
  await linux("linux-workspace", "cd /workspace");
  await core.call("sandbox.setOnline", { online: false });
  const offline = await linux("offline-mirror-request", "timeout 8s curl --retry 0 --connect-timeout 3 --max-time 5 -I https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple/idna/");
  proof.offlineBlocked = offline.code !== 0 && offline.code !== null;
  assert.ok(proof.offlineBlocked, "mirror must never bypass offline firewall");
  const offlineEnv = await linux("offline-source-env", `python3 -c 'import os; print(os.getenv("UV_DEFAULT_INDEX")); print(os.getenv("npm_config_registry"))'`);
  assert.match(offlineEnv.tail, /mirrors\.tuna/);
  proof.settings = core.settings.get();
  proof.complete = true;
} catch (error) { proof.complete = false; proof.error = clean(String(error)); console.error(proof.error); process.exitCode = 1; }
finally {
  shell.reset();
  // Delete only our unique nft table; never touch dreamflutter or another distro's rules.
  if (/^dreamflutter_t65_[a-f0-9]+$/.test(table)) await runWsl(["-d", distro, "-u", "root", "--", "nft", "delete", "table", "inet", table], { timeoutMs: 10_000 });
  await core.shutdown();
  assert.match(distro, /^df-t65-mirrors-[a-f0-9-]+$/);
  await runWsl(["--terminate", distro], { timeoutMs: 30_000 });
  const removed = await runWsl(["--unregister", distro], { timeoutMs: 30_000 });
  const listed = await runWsl(["--list", "--quiet"], { timeoutMs: 10_000 });
  proof.cleanupCode = removed.code; proof.cleanedDistro = listed.code === 0 && !listed.stdout.split(/\r?\n/).includes(distro);
  const absolute = resolve(temporary);
  assert.ok(absolute.startsWith(resolve(tmpdir()) + "\\df-t65-sources-"));
  if (proof.cleanedDistro) { rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); proof.cleanedDirectory = true; }
  save();
}
