// Run with the executable that ships in the app, against the staged production core.
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [major, minor] = process.versions.node.split(".").map(Number);
assert.ok(major > 24 || (major === 24 && minor >= 9), "DSH requires Node.js 24.9 or later");
const core = await realpath(resolve(process.argv[2] ?? fileURLToPath(new URL("../core", import.meta.url))));
const require = createRequire(join(core, "package.json"));
const manifest = JSON.parse(await readFile(join(core, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(join(core, "package-lock.json"), "utf8"));
let productionPackages = 0;
for (const [path, locked] of Object.entries(lock.packages)) {
  if (!path || locked.dev) continue;
  let installed;
  try {
    installed = JSON.parse(await readFile(join(core, path, "package.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && (locked.optional || locked.devOptional)) continue;
    throw error;
  }
  assert.equal(installed.version, locked.version, path + " differs from package-lock.json");
  productionPackages++;
}
const official = Object.entries(manifest.dependencies).filter(([name]) => name.startsWith("@deepseek-ai/"));
assert.ok(official.some(([name]) => name === "@deepseek-ai/dsh-agent-loop"), "DSH agent loop missing");
const modules = new Map();
for (const [name, version] of official) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, name + " needs an exact version");
  assert.equal(lock.packages[""].dependencies[name], version, name + " manifest and lock disagree");
  const locked = lock.packages["node_modules/" + name];
  assert.equal(locked.version, version, name + " installed version and lock disagree");
  assert.ok(locked.integrity, name + " has no integrity hash");
  const entry = await realpath(require.resolve(name));
  const local = relative(join(core, "node_modules"), entry);
  assert.ok(local && !local.startsWith("..") && !isAbsolute(local), name + " resolved outside the bundle");
  const pkg = JSON.parse(await readFile(join(core, "node_modules", name, "package.json"), "utf8"));
  assert.equal(pkg.version, version, name + " bundled package version mismatch");
  modules.set(name, await import(pathToFileURL(entry).href));
}

const { Context } = modules.get("@deepseek-ai/cordis");
const { default: Store, Session } = modules.get("@deepseek-ai/dsh-session");
const persistence = modules.get("@deepseek-ai/dsh-session-persistence-jsonl");
const { installDshSessions } = await import(pathToFileURL(join(core, "src/dsh/session.ts")).href);
const fixtures = fileURLToPath(new URL("../core/test/fixtures/dsh/", import.meta.url));
const versions = (await readdir(fixtures, { withFileTypes: true })).filter(entry =>
  entry.isDirectory() && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.name));
assert.ok(versions.length > 0, "no historical release fixtures");
const id = "compatibility-fixture";
const originalText = "DreamFlutter offline fixture";
const newText = "Continued by bundled runtime";
for (const version of versions) {
  const root = await mkdtemp(join(tmpdir(), "df-dsh-compat-"));
  try {
    await cp(join(fixtures, version.name), root, { recursive: true });
    for (const access of ["write", "read"]) {
      const ctx = new Context();
      try {
        if (access === "write") {
          await ctx.plugin(modules.get("@deepseek-ai/dsh-llm").default);
          await installDshSessions(ctx, { root });
          const handle = await ctx.agents.resume({ resumeSessionId: id });
          try {
            const live = handle.agent.session;
            assert.deepEqual(live.deriveMessages().map(message => message.content[0].text), [originalText]);
            live.append("user/message", {
              id: "msg-02", role: "user", source: { kind: "user" }, content: [{ type: "text", text: newText }],
            }, { surfaceOp: "append" });
            await ctx.sessions.flush(live);
          } finally {
            await handle.dispose();
          }
          continue;
        }
        await ctx.plugin(Store);
        await ctx.plugin(persistence, { root, compression: "none" });
        const handle = await ctx.sessionPersistence.open(id, "read");
        try {
          const { events, eventState } = await handle.read();
          const session = Session.fromRestore(id, events, handle.header, handle.inheritedEventCount, eventState);
          const texts = session.deriveMessages().map(message => message.content[0].text);
          assert.deepEqual(texts, [originalText, newText]);
        } finally {
          await handle.close();
        }
      } finally {
        await ctx.fiber.dispose();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
  console.log("DSH history restored, continued and reopened from " + version.name);
}
console.log("Verified " + official.length + " direct DSH/Cordis packages and " + productionPackages + " installed production packages with Node " + process.versions.node);
