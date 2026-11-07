import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { buildCore } from "../src/app.ts";
import { corePaths, defaultAgentDir } from "../src/paths.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { UpdateModule, type UpdateOptions } from "../src/update/module.ts";
import { JournalStore, type UpdateJournal } from "../src/update/state.ts";
import { Archive, writeArchive } from "../src/backup/archive.ts";
import { rememberSecret } from "../src/security/redaction.ts";

const source = "http://127.0.0.1:48125", byteRoot = mkdtempSync(join(tmpdir(), "df-update-zip-")), bytePath = join(byteRoot, "fixture.nupkg");
await writeArchive(bytePath, [], [{ name: "lib/app/fixture.txt", data: Buffer.from("synthetic local package") }]);
const bytes = readFileSync(bytePath); rmSync(byteRoot, { recursive: true, force: true });
function release(version: string) { return { tag_name: "v" + version, body: "fixture notes", assets: [{ name: `DreamFlutter-${version}-win-x64-full.nupkg`, browser_download_url: `${source}/package-${version}`, size: bytes.length, digest: "sha256:" + createHash("sha256").update(bytes).digest("hex") }] }; }
async function fixture(options: Partial<UpdateOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "df-update-module-")), data = join(dir, "data"), app = join(dir, "installed", "current"), calls: string[] = [];
  mkdirSync(data); mkdirSync(app, { recursive: true });
  const fetcher = (async (input: RequestInfo | URL) => { const url = String(input); calls.push(url); return new Response(url.includes("/package-") ? bytes : JSON.stringify(release(url.includes("/tags/") ? "0.6.0-test.1" : "0.6.0-test.2")), { headers: { "content-type": "application/json" } }); }) as typeof fetch;
  const core = buildCore({ paths: corePaths(data), agentDir: defaultAgentDir(data), sessionDir: join(data, "sessions"), piMigration: { automatic: false }, log: new Logger(), notifier: new RecordingNotifier(),
    updates: { testSource: source, appRoot: app, build: { version: "0.6.0-test.1", build: "11", platform: "win32", arch: "x64", signed: false }, fetch: fetcher, ...options } });
  core.settings.update({ memoryPaused: true, autoTitle: false, memoryAutoExtract: false, autoCheckUpdates: false });
  await core.start();
  return { dir, data, app, core, calls, module: core.module(UpdateModule)!, async cleanup() { await core.shutdown(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}
async function waitFor(probe: () => boolean, timeout = 10000) { const end = Date.now() + timeout; while (!probe()) { if (Date.now() > end) throw Error("update test timed out"); await new Promise(done => setTimeout(done, 20)); } }

it("update status causes no network; daily automatic cache and manual check cannot be redirected by RPC", async () => {
  let now = 1000000000; const t = await fixture({ now: () => now });
  try {
    await t.core.call("updates.status", {}); await t.core.call("updates.status", {}); assert.equal(t.calls.length, 0);
    await t.module.check(false); await t.module.check(false); assert.equal(t.calls.length, 1);
    await t.core.call("updates.check", { source: "https://attacker.invalid" }); assert.equal(t.calls.length, 2); assert.ok(t.calls.every(url => url.startsWith(source)));
    now += 24 * 60 * 60 * 1000; await t.module.check(false); assert.equal(t.calls.length, 3);
    assert.equal(t.core.settings.get().closeBehavior, "tray"); assert.equal(t.core.settings.get().startOnLogin, false);
    t.core.settings.update({ closeBehavior: "invalid" }); assert.equal(t.core.settings.get().closeBehavior, "tray");
  } finally { await t.cleanup(); }
});
it("unsigned install needs explicit approval, and backup failure never launches the updater", async () => {
  let launched = 0, backedUp = 0;
  const t = await fixture({ install: { root: "C:\\synthetic-install", current: "C:\\synthetic-install\\current", helper: "synthetic.exe" }, nativeCall: async () => String(process.pid), backup: async () => { backedUp++; throw Error("synthetic backup failure"); }, launchGuard: () => { launched++; return 1; } });
  try {
    await t.module.check(); await t.module.download();
    await assert.rejects(t.core.call("updates.install", { windowPid: 0 }), (e: any) => e.code === "confirmation_required");
    assert.equal(backedUp, 0);
    await t.core.call("updates.install", { windowPid: 0, approveUnsigned: true });
    await waitFor(() => t.module.status().state === "prepare_failed");
    assert.equal(backedUp, 1); assert.equal(launched, 0); assert.equal(t.core.maintenance, undefined);
    assert.equal(existsSync(join(t.data, "updates", "journal.json")), false);
  } finally { await t.cleanup(); }
});
it("startup validation blocks settings and tasks, requires the real window acknowledgement, then records new writes", async () => {
  const t = await fixture({ build: { version: "0.6.0-test.2", build: "12", platform: "win32", arch: "x64", signed: false }, install: { root: "C:\\synthetic-install", current: "C:\\synthetic-install\\current", helper: "synthetic.exe" }, nativeCall: async () => "12345" });
  try {
    const store = new JournalStore(t.data);
    const journal: UpdateJournal = { id: "test-validation", phase: "validating", at: Date.now(), from: "0.6.0-test.1", to: "0.6.0-test.2", installRoot: "C:\\synthetic-install", appRoot: t.app, dataRoot: t.data, databaseFile: t.core.paths.dbFile, agentDir: t.core.agentDir, sessionsDir: t.core.sessionDir!, backup: join(t.data, "retained.dfbackup"), targetPackage: "new", oldPackage: "old", asset: { name: "new", size: 1, sha256: "a".repeat(64), url: source }, guardDir: join(t.data, "updates", "runs", "test-validation"), corePid: process.pid, nonce: "synthetic-nonce", acceptedWrites: false, attemptedRollback: false, memoryWasPaused: true };
    // Reopen with the journal present so startup installs the write gate before any user RPC.
    await t.core.shutdown(); store.mutate(() => journal);
    const next = buildCore({ paths: corePaths(t.data), agentDir: t.core.agentDir, sessionDir: t.core.sessionDir, piMigration: { automatic: false }, log: new Logger(), notifier: new RecordingNotifier(), updates: { appRoot: t.app, build: { version: journal.to, build: "12", platform: "win32", arch: "x64", signed: false }, install: { root: journal.installRoot, current: t.app, helper: "synthetic.exe" }, nativeCall: async () => "12345" } });
    try {
      await next.start();
      await assert.rejects(next.call("settings.update", { notifications: false }), (e: any) => e.code === "update_validation");
      await assert.rejects(next.openSlot({ cwd: t.dir }), (e: any) => e.code === "busy");
      await assert.rejects(next.call("updates.validateReady", { nonce: journal.nonce }));
      await next.call("updates.uiReady", { nonce: journal.nonce, version: journal.to, pid: 12345 });
      await next.call("updates.validateReady", { nonce: journal.nonce });
      assert.equal(store.read()!.phase, "verified"); assert.equal(store.read()!.acceptedWrites, false);
      await next.call("updates.status", {}); assert.equal(store.read()!.acceptedWrites, false);
      await next.call("settings.update", { notifications: false }); assert.equal(store.read()!.acceptedWrites, true);
      assert.throws(() => store.patch({ phase: "rollback-needed" }));
    } finally { await next.shutdown(); }
  } finally { await t.cleanup(); }
});
it("diagnostics ZIP reuses central redaction and exports no credentials or automatic network request", async () => {
  const t = await fixture();
  try {
    rememberSecret("T67_SYNTHETIC_APIKEY_0123456789");
    mkdirSync(join(t.core.paths.logFile, ".."), { recursive: true });
    writeFileSync(t.core.paths.logFile, 'Authorization: Bearer T67_SYNTHETIC_SECRET_0123456789\napi_key=T67_SYNTHETIC_APIKEY_0123456789\n');
    const result = await t.core.call("updates.diagnostics", {}) as { path: string };
    const archive = await Archive.open(result.path);
    try { const logs = await archive.readBuffer("logs/core.log"); assert.doesNotMatch(logs.toString("utf8"), /T67_SYNTHETIC/); } finally { archive.close(); }
    assert.equal(t.calls.length, 0);
  } finally { await t.cleanup(); }
});
