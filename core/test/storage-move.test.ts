import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { buildCore } from "../src/app.ts";
import type { Core } from "../src/core.ts";
import { Db } from "../src/db.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { corePaths, defaultAgentDir } from "../src/paths.ts";
import { SecretStore, secretFileOf } from "../src/modules/secrets.ts";
import { SkillsModule } from "../src/modules/skills.ts";
import { SessionIndex } from "../src/modules/session-index.ts";
import { CardsModule } from "../src/cards/cards.ts";
import { initializeLocations, locationFile, storageLocations, type StorageKind } from "../src/storage/locations.ts";
import { moveResultFile, pendingMoveFile, preparePendingMove, remapMovedDatabase, requestMove, rollbackMove, validateMove, type MoveHooks } from "../src/storage/move.ts";
import { checkDatabase } from "../src/storage/memory-maintenance.ts";
import type { WslRunner } from "../src/sandbox/sandbox.ts";
import { officialMoveWithRetry } from "../src/storage/wsl.ts";
import { createBackup } from "../src/backup/export.ts";
import { stageBackup } from "../src/backup/restore.ts";
import { applyPendingRestore, writeSwitchRecord } from "../src/backup/switch.ts";

const roots: string[] = [], cores: Core[] = [];

it("T85 moves the recycle resource, remaps both recovery paths and metadata, and restores with its original deadline", async () => {
  const { root, dir } = fresh(); initializeLocations(root); let core = construct(root); await core.start();
  const source = storageLocations(root).sessions, path = join(source, "recycled.jsonl");
  writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: "recycled", timestamp: new Date().toISOString(), cwd: dir }) + "\n");
  const deleted = await core.call("sessions.delete", { path }) as { batchId: string; expiresAt: number };
  core = await move(core, "sessions", join(dir, "moved-sessions"));
  const [row] = core.module(SessionIndex)!.recycle.list();
  assert.ok(row); assert.equal(row.expires_at, deleted.expiresAt);
  assert.equal(row.original_path, join(dir, "moved-sessions", "recycled.jsonl")); assert.ok(existsSync(row.stored_path));
  assert.equal(JSON.parse(row.metadata).path, row.original_path);
  assert.equal((await core.call("sessions.list", {}) as unknown[]).length, 0);
  await core.call("sessions.restore", { batchId: deleted.batchId }); assert.ok(existsSync(row.original_path));
});
afterEach(async () => {
  for (const core of cores.splice(0)) await core.shutdown();
  for (const root of roots.splice(0)) {
    assert.ok(root.startsWith(join(tmpdir(), "df-storage-move-")));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
function fresh() { const dir = mkdtempSync(join(tmpdir(), "df-storage-move-")); roots.push(dir); const root = join(dir, "data"); mkdirSync(root); return { dir, root }; }
function construct(root: string) {
  const paths = corePaths(root), agentDir = defaultAgentDir(root);
  for (const path of Object.values(storageLocations(root))) mkdirSync(path, { recursive: true });
  const core = buildCore({ paths, agentDir, sessionDir: storageLocations(root).sessions, log: new Logger(), notifier: new RecordingNotifier() });
  cores.push(core); core.settings.update({ autoTitle: false, memoryAutoExtract: false, memoryPaused: true });
  return core;
}
function dbAt(root: string) { const db = new Db(corePaths(root).dbFile); db.close(); }
async function move(core: Core, kind: StorageKind, target: string, hooks: MoveHooks = {}) {
  requestMove(core.paths.dataDir, kind, target, core.agentDir, core.sessionDir, core.paths.dbFile, "df-storage-fixture");
  await core.shutdown();
  const record = await preparePendingMove(core.paths.dataDir, hooks);
  assert.ok(record);
  assert.ok(existsSync(record.backup!));
  const next = construct(core.paths.dataDir);
  remapMovedDatabase(next, record);
  await next.start();
  await validateMove(next, record, hooks);
  return next;
}

it("new installations use three layers; reading and starting an old layout does not rearrange it", async () => {
  const { root } = fresh();
  initializeLocations(root);
  assert.match(corePaths(root).dbFile, /application-data/);
  assert.match(storageLocations(root).sessions, /user-content/);
  assert.equal(defaultAgentDir(root), storageLocations(root).configuration);
  const other = fresh(); dbAt(other.root); mkdirSync(join(other.root, "pi"));
  initializeLocations(other.root);
  assert.equal(existsSync(locationFile(other.root)), false);
  assert.equal(corePaths(other.root).dbFile, join(other.root, "core.db"));
});

it("moves shared DB as one unit, verifies a real new core, retains backup, and deletes old DB only after validation", async () => {
  const { root, dir } = fresh(); const core = construct(root); await core.start();
  core.settings.update({ memoryMinFreeBytes: 12345 });
  const old = core.paths.dbFile;
  const target = join(dir, "database-new");
  requestMove(root, "database", target, core.agentDir, core.sessionDir, old);
  await core.shutdown();
  const record = (await preparePendingMove(root))!;
  assert.ok(existsSync(old), "source survives copy and location switch");
  checkDatabase(join(target, "core.db"));
  const next = construct(root); remapMovedDatabase(next, record); await next.start();
  assert.equal(next.settings.get().memoryMinFreeBytes, 12345);
  assert.ok(existsSync(old), "source survives until complete normal startup");
  await validateMove(next, record);
  assert.equal(existsSync(old), false);
  assert.equal(next.paths.dbFile, join(target, "core.db"));
  assert.equal((await next.call("storage.memory", {}) as any).path, next.paths.dbFile);
  assert.equal(JSON.parse(readFileSync(moveResultFile(root), "utf8")).ok, true);
});

it("startup failure and an interrupted validating restart restore paths, metadata and database", async () => {
  const { root, dir } = fresh(); let core = construct(root); await core.start();
  const source = join(core.agentDir, "skills"); mkdirSync(join(source, "kept"), { recursive: true }); writeFileSync(join(source, "kept", "SKILL.md"), "original");
  requestMove(root, "skills", join(dir, "skills-fail"), core.agentDir, core.sessionDir, core.paths.dbFile);
  await core.shutdown(); const record = (await preparePendingMove(root))!;
  core = construct(root); remapMovedDatabase(core, record);
  core.use({ modelFacing: false, start() { throw new Error("injected new-location startup failure"); } });
  await assert.rejects(() => core.start(), /startup failure/);
  await core.shutdown(); await rollbackMove(root, record, "injected startup failure");
  assert.equal(existsSync(join(dir, "skills-fail")), false);
  assert.equal(readFileSync(join(source, "kept", "SKILL.md"), "utf8"), "original");
  assert.equal(existsSync(locationFile(root)), false);
  core = construct(root); await core.start();
  requestMove(root, "skills", join(dir, "skills-interrupted"), core.agentDir, core.sessionDir, core.paths.dbFile);
  await core.shutdown(); await preparePendingMove(root);
  assert.equal(await preparePendingMove(root), undefined, "recovery rolls back before a second core opens");
  assert.equal(existsSync(join(dir, "skills-interrupted")), false);
  core = construct(root); await core.start(); checkDatabase(core.paths.dbFile);
});

it("copy verification, backup and invalid destinations fail without deleting source or an existing target", async () => {
  const { root, dir } = fresh(); let core = construct(root);
  const source = storageLocations(root).cards; writeFileSync(join(source, "keep.txt"), "keep");
  assert.throws(() => requestMove(root, "cards", source, core.agentDir, core.sessionDir, core.paths.dbFile), /已存在/);
  assert.throws(() => requestMove(root, "cards", join(source, "inside"), core.agentDir, core.sessionDir, core.paths.dbFile), /互相包含/);
  requestMove(root, "cards", join(dir, "corrupt-copy"), core.agentDir, core.sessionDir, core.paths.dbFile);
  await core.shutdown();
  assert.equal(await preparePendingMove(root, { afterCopy() { writeFileSync(join(dir, "corrupt-copy", "keep.txt"), "corrupt"); } }), undefined);
  assert.equal(readFileSync(join(source, "keep.txt"), "utf8"), "keep");
  assert.equal(existsSync(join(dir, "corrupt-copy")), false);
  core = construct(root);
  requestMove(root, "cards", join(dir, "backup-fail"), core.agentDir, core.sessionDir, core.paths.dbFile);
  await core.shutdown();
  rmSync(join(root, "backups"), { recursive: true, force: true }); writeFileSync(join(root, "backups"), "block backup");
  assert.equal(await preparePendingMove(root), undefined);
  assert.equal(existsSync(join(dir, "backup-fail")), false);
  assert.equal(readFileSync(join(source, "keep.txt"), "utf8"), "keep");
});

it("sessions, skills, templates, cards, config, secrets, logs and cache reconnect to their consumers", async () => {
  const { root, dir } = fresh(); let core = construct(root); await core.start();
  const locations = storageLocations(root);
  mkdirSync(join(locations.sessions, "workspace"));
  const oldSession = join(locations.sessions, "workspace", "example.jsonl");
  writeFileSync(oldSession, JSON.stringify({ type: "session", version: 3, id: "isolated", timestamp: new Date().toISOString(), cwd: dir }) + "\n");
  mkdirSync(join(locations.skills, "hello")); writeFileSync(join(locations.skills, "hello", "SKILL.md"), "---\nname: hello\ndescription: isolated\n---\nHello");
  core.module(SkillsModule)!.saveTemplate({ name: "greet", body: "hello" });
  writeFileSync(join(locations.cards, "owned.txt"), "owned");
  writeFileSync(join(locations.cache, "cached"), "cached"); writeFileSync(core.paths.logFile, "old log");
  writeFileSync(join(locations.secrets, "synthetic.dpapi"), "opaque-encrypted-fixture");
  const reference = '!"node" "secret.mjs" "' + join(locations.secrets, "synthetic.dpapi").replaceAll("\\", "/") + '"';
  writeFileSync(join(core.agentDir, "auth.json"), JSON.stringify({ isolated: { type: "api_key", key: reference } }));
  for (const kind of ["sessions", "skills", "templates", "cards", "configuration", "secrets", "logs", "cache"] as const) {
    const source = storageLocations(root)[kind], target = join(dir, `moved-${kind}`);
    core = await move(core, kind, target);
    assert.equal(storageLocations(root)[kind], target);
    if (kind === "configuration") assert.equal(core.agentDir, target);
    if (!["configuration", "logs"].includes(kind)) assert.equal(existsSync(source), false, `${kind} source cleaned`);
  }
  assert.equal(core.module(CardsModule)!.dir, join(dir, "moved-cards"));
  assert.equal(core.module(SkillsModule)!.listTemplates()[0]!.name, "greet");
  assert.ok((await core.module(SkillsModule)!.listSkills(dir)).some((s) => s.filePath.includes("moved-skills")));
  const auth = JSON.parse(readFileSync(join(core.agentDir, "auth.json"), "utf8"));
  assert.equal(secretFileOf(auth.isolated.key), join(dir, "moved-secrets", "synthetic.dpapi").replaceAll("\\", "/"));
  assert.equal(new SecretStore(root).dir, join(dir, "moved-secrets"));
  assert.equal(core.security.roots.secrets, join(dir, "moved-secrets"));
  assert.equal(readFileSync(join(dir, "moved-secrets", "synthetic.dpapi"), "utf8"), "opaque-encrypted-fixture");
  assert.equal((await core.call("storage.locations", {}) as any).memory.moveKind, "database");
});

it("sandbox moves only the registered disk through official WSL, verifies startup, and rolls back via official move", async () => {
  const { root, dir } = fresh(); let core = construct(root); const source = storageLocations(root).sandbox;
  mkdirSync(join(source, "disk")); writeFileSync(join(source, "disk", "ext4.vhdx"), "registered-disk-fixture");
  writeFileSync(join(source, "clean.vhdx"), "reset-template-fixture"); writeFileSync(join(source, "distro.txt"), "df-storage-fixture");
  let disk = join(source, "disk"), failStartup = false; const commands: string[][] = [];
  const wsl: WslRunner = async (args) => {
    commands.push(args);
    if (args[0] === "--help") return { code: 4294967295, stdout: "--manage <Distro> --move <Location>", stderr: "" };
    if (args[0] === "--manage") { renameSync(disk, args[3]!); disk = args[3]!; }
    return { code: args[0] === "-d" && failStartup ? 1 : 0, stdout: "", stderr: "" };
  };
  core = await move(core, "sandbox", join(dir, "sandbox-new"), { wsl });
  assert.equal(readFileSync(join(dir, "sandbox-new", "clean.vhdx"), "utf8"), "reset-template-fixture");
  assert.equal(commands.filter((a) => a[0] === "--manage").length, 1);
  assert.equal(commands.some((a) => a.some((v) => /--(unregister|import|export)/.test(v))), false);
  requestMove(root, "sandbox", join(dir, "sandbox-failed"), core.agentDir, core.sessionDir, core.paths.dbFile, "df-storage-fixture");
  await core.shutdown(); const record = (await preparePendingMove(root, { wsl }))!;
  core = construct(root); remapMovedDatabase(core, record); await core.start(); failStartup = true;
  await assert.rejects(() => validateMove(core, record, { wsl }), /启动验证失败/);
  await core.shutdown(); await rollbackMove(root, record, "startup failed", { wsl });
  assert.equal(disk, join(dir, "sandbox-new", "disk"));
  assert.equal(existsSync(join(dir, "sandbox-failed")), false);
});

it("relocated resources survive the existing backup export, stage and restore switch", async () => {
  const { root, dir } = fresh(); let core = construct(root); await core.start();
  core.module(SkillsModule)!.saveTemplate({ name: "backed-up", body: "keep me" });
  writeFileSync(join(storageLocations(root).cards, "keep.txt"), "card bytes");
  core = await move(core, "cards", join(dir, "cards-new"));
  core = await move(core, "templates", join(dir, "templates-new"));
  const source = { paths: core.paths, agentDir: core.agentDir, sessionsDir: core.sessionDir!, db: core.db.raw, appVersion: "0.5.0" };
  const out = await createBackup(source, { out: join(dir, "test.dfbackup"), kind: "manual", credentials: "none", includeMaterials: false });
  const staged = await stageBackup(out.path, source, { parts: core.backupParts });
  writeFileSync(join(dir, "cards-new", "keep.txt"), "changed");
  writeSwitchRecord(core.paths, core.agentDir, staged, {}); await core.shutdown();
  assert.equal(applyPendingRestore(corePaths(root))?.ok, true);
  assert.equal(readFileSync(join(dir, "cards-new", "keep.txt"), "utf8"), "card bytes");
  core = construct(root); await core.start();
  assert.equal(core.module(SkillsModule)!.listTemplates()[0]!.name, "backed-up");
  assert.equal(storageLocations(root).cards, join(dir, "cards-new"));
});

it("official move retries only a transient sharing violation without stopping other distributions", async () => {
  const commands: string[][] = [];
  const args = ["--manage", "df-only-this-fixture", "--move", "C:\\temporary-test"];
  const result = await officialMoveWithRetry(async (command) => {
    commands.push(command);
    return commands.length < 3 ? { code: 1, stdout: "", stderr: "Wsl/Service/MoveDistro/ERROR_SHARING_VIOLATION" } : { code: 0, stdout: "", stderr: "" };
  }, args, async () => {});
  assert.equal(result.code, 0);
  assert.deepEqual(commands, [args, args, args]);
  let count = 0;
  await officialMoveWithRetry(async () => { count++; return { code: 1, stdout: "", stderr: "unsupported" }; }, args, async () => {});
  assert.equal(count, 1);
});

for (const failure of [
  { name: "stderr sharing violation", stdout: "", stderr: "Wsl/Service/MoveDistro/ERROR_SHARING_VIOLATION", reasonCode: "sandbox_in_use", attempts: 6 },
  { name: "stdout sharing violation", stdout: "Wsl/Service/MoveDistro/ERROR_SHARING_VIOLATION", stderr: "", reasonCode: "sandbox_in_use", attempts: 6 },
  { name: "unrelated access error", stdout: "", stderr: "Wsl/Service/MoveDistro/ERROR_ACCESS_DENIED", reasonCode: undefined, attempts: 1 },
]) it(`failed sandbox move reports ${failure.name} without losing original data or changing WSL operations`, { timeout: 60_000 }, async () => {
  const { root, dir } = fresh(); const core = construct(root), source = storageLocations(root).sandbox;
  mkdirSync(join(source, "disk"));
  const originalDisk = Buffer.from("original sandbox disk remains unchanged\0fixture");
  writeFileSync(join(source, "disk", "ext4.vhdx"), originalDisk);
  writeFileSync(join(source, "clean.vhdx"), "original reset template");
  writeFileSync(join(source, "distro.txt"), "df-storage-fixture");
  const target = join(dir, "occupied-sandbox");
  const requested = requestMove(root, "sandbox", target, core.agentDir, core.sessionDir, core.paths.dbFile, "df-storage-fixture");
  await core.shutdown();
  const commands: string[][] = [];
  const wsl: WslRunner = async (args) => {
    commands.push(args);
    if (args[0] === "--help") return { code: 0, stdout: "--manage <Distro> --move <Location>", stderr: "" };
    if (args[0] === "--terminate") return { code: 0, stdout: "", stderr: "" };
    assert.deepEqual(args, ["--manage", "df-storage-fixture", "--move", join(target, "disk")]);
    return { code: 1, stdout: failure.stdout, stderr: failure.stderr };
  };
  assert.equal(await preparePendingMove(root, { wsl }), undefined);
  const receipt = JSON.parse(readFileSync(moveResultFile(root), "utf8"));
  assert.equal(receipt.reasonCode, failure.reasonCode);
  assert.deepEqual([receipt.id, receipt.ok, receipt.kind, receipt.path, receipt.restartRequired], [requested.id, false, "sandbox", source, false]);
  assert.ok(receipt.error.includes(failure.stderr || failure.stdout), "raw diagnostic remains available");
  assert.ok(existsSync(receipt.backup));
  assert.deepEqual(readFileSync(join(source, "disk", "ext4.vhdx")), originalDisk);
  assert.equal(readFileSync(join(source, "clean.vhdx"), "utf8"), "original reset template");
  assert.equal(readFileSync(join(source, "distro.txt"), "utf8"), "df-storage-fixture");
  assert.equal(storageLocations(root).sandbox, source);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(pendingMoveFile(root)), false);
  assert.equal(commands.filter(args => args[0] === "--manage").length, failure.attempts);
  assert.deepEqual(commands.filter(args => args[0] === "--terminate"), [["--terminate", "df-storage-fixture"]]);
  assert.equal(commands.some(args => args.includes("--shutdown") || args.includes("--unregister") || args[0] === "-d"), false);
  const restarted = construct(root);
  assert.deepEqual((await restarted.call("storage.locations", {}) as any).lastMove, receipt, "persisted reason is returned by the existing RPC after restart");
});

it("a non-sandbox copy failure containing a sharing diagnostic retains its generic receipt", async () => {
  const { root, dir } = fresh(); const core = construct(root), source = storageLocations(root).cards;
  writeFileSync(join(source, "keep.txt"), "original card");
  requestMove(root, "cards", join(dir, "cards-sharing-error"), core.agentDir, core.sessionDir, core.paths.dbFile);
  await core.shutdown();
  assert.equal(await preparePendingMove(root, { afterCopy() { throw new Error("ERROR_SHARING_VIOLATION"); } }), undefined);
  const receipt = JSON.parse(readFileSync(moveResultFile(root), "utf8"));
  assert.equal(receipt.kind, "cards"); assert.equal(receipt.reasonCode, undefined);
  assert.match(receipt.error, /ERROR_SHARING_VIOLATION/);
  assert.equal(readFileSync(join(source, "keep.txt"), "utf8"), "original card");
});

it("a declared path collision aborts the switch and restores the original DB instead of retaining stale source references", async () => {
  const { root, dir } = fresh(); let core = construct(root);
  const source = storageLocations(root).sessions, target = join(dir, "session-collision");
  const old = join(source, "same.jsonl"), next = join(target, "same.jsonl");
  writeFileSync(old, JSON.stringify({ type: "session", id: "collision", version: 3, cwd: dir }) + "\n");
  core.db.run("INSERT INTO session_meta(path) VALUES (?)", old);
  core.db.run("INSERT INTO session_meta(path) VALUES (?)", next);
  requestMove(root, "sessions", target, core.agentDir, core.sessionDir, core.paths.dbFile);
  await core.shutdown(); const record = (await preparePendingMove(root))!;
  core = construct(root);
  assert.throws(() => remapMovedDatabase(core, record), /UNIQUE/);
  await core.shutdown(); await rollbackMove(root, record, "path collision");
  core = construct(root);
  assert.ok(core.db.get("SELECT path FROM session_meta WHERE path = ?", old));
  assert.ok(existsSync(old)); assert.equal(existsSync(target), false);
});

it("a result-file failure after commit never switches back to an already cleaned source", async () => {
  const { root, dir } = fresh(); let core = construct(root); await core.start();
  const old = core.paths.dbFile, target = join(dir, "committed-database");
  requestMove(root, "database", target, core.agentDir, core.sessionDir, old);
  await core.shutdown(); const record = (await preparePendingMove(root))!;
  core = construct(root); remapMovedDatabase(core, record); await core.start();
  mkdirSync(moveResultFile(root)); // Simulate an unwritable result destination after startup verification.
  await validateMove(core, record);
  assert.equal(record.stage, "committed");
  assert.equal(existsSync(old), false);
  await core.shutdown();
  await preparePendingMove(root);
  assert.equal(corePaths(root).dbFile, join(target, "core.db"));
  rmSync(moveResultFile(root), { recursive: true });
  await preparePendingMove(root);
  assert.equal(existsSync(pendingMoveFile(root)), false);
  core = construct(root); await core.start(); checkDatabase(core.paths.dbFile);
});

it("configuration usage excludes a relocated resource directory even when its name changes", async () => {
  const { root } = fresh(); let core = construct(root); await core.start();
  writeFileSync(join(storageLocations(root).skills, "payload.bin"), Buffer.alloc(16384));
  core = await move(core, "skills", join(core.agentDir, "renamed-skills"));
  const rows = (await core.call("storage.locations", {}) as any).rows;
  assert.equal(rows.find((r: any) => r.id === "skills").bytes, 16384);
  assert.ok(rows.find((r: any) => r.id === "configuration").bytes < 16384);
});

it("a three-layer backup restores app-owned and root workspace references into an existing legacy layout", async () => {
  const source = fresh(); initializeLocations(source.root); const core = construct(source.root); await core.start();
  mkdirSync(core.paths.butterflyDir, { recursive: true }); writeFileSync(join(core.paths.butterflyDir, "keep.txt"), "material bytes");
  for (const [id, cwd] of [["material-session", core.paths.butterflyDir], ["root-session", core.paths.dataDir]]) {
    const file = join(core.sessionDir!, `${id}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd }) + "\n");
    core.db.run("INSERT INTO session_meta(path, cwd, session_id) VALUES (?, ?, ?)", file, cwd!, id!);
  }
  const exported = await createBackup({ paths: core.paths, agentDir: core.agentDir, sessionsDir: core.sessionDir!, db: core.db.raw, appVersion: "0.5.0" },
    { out: join(source.dir, "layers.dfbackup"), kind: "manual", credentials: "none", includeMaterials: false });
  const destination = fresh(); let target = construct(destination.root);
  const staged = await stageBackup(exported.path, { paths: target.paths, agentDir: target.agentDir, sessionsDir: target.sessionDir!, appVersion: "0.5.0" }, { parts: target.backupParts });
  writeSwitchRecord(target.paths, target.agentDir, staged, {}); await target.shutdown();
  assert.equal(applyPendingRestore(corePaths(destination.root))?.ok, true);
  target = construct(destination.root); await target.start();
  assert.equal(target.db.get<{ cwd: string }>("SELECT cwd FROM session_meta WHERE session_id = ?", "material-session")!.cwd, target.paths.butterflyDir);
  assert.equal(target.db.get<{ cwd: string }>("SELECT cwd FROM session_meta WHERE session_id = ?", "root-session")!.cwd, target.paths.dataDir);
  assert.equal(readFileSync(join(target.paths.butterflyDir, "keep.txt"), "utf8"), "material bytes");
});
