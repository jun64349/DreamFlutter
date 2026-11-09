import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, it } from "node:test";
import { buildCore } from "../src/app.ts";
import type { Core } from "../src/core.ts";
import { Db } from "../src/db.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { corePaths, defaultAgentDir } from "../src/paths.ts";
import { pendingMoveFile, requestMove } from "../src/storage/move.ts";
import { localDatabaseTarget } from "../src/storage/target.ts";

const roots: string[] = [], cores: Core[] = [];
afterEach(async () => {
  for (const core of cores.splice(0)) await core.shutdown();
  for (const root of roots.splice(0)) {
    assert.ok(root.startsWith(join(tmpdir(), "df-storage-target-")));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

for (const target of [
  String.raw`\\wsl.localhost\df-temporary\new-db`, String.raw`\\server\share\new-db`,
  "//server/share/new-db", String.raw`\\?\UNC\server\share\new-db`, "//?/UNC/server/share/new-db",
  String.raw`\\?\unc\server\share\new-db`,
]) {
  it(`database preflight refuses a network namespace without probing or accessing it: ${target}`, () => {
    let probes = 0;
    assert.throws(() => localDatabaseTarget(target, () => { probes++; return 3; }, "win32"),
      (error: any) => error.code === "bad_request" && /数据库位置不支持网络路径/.test(error.message));
    assert.equal(probes, 0, "UNC rejection must not touch the network or start a WSL distro");
  });
}

it("checks mapped-drive type using its local drive root and rejects remote and disconnected mappings", () => {
  let probed: string | undefined;
  assert.throws(() => localDatabaseTarget(String.raw`Z:\project\db`, (root) => { probed = root; return 4; }, "win32"), /映射的网络盘/);
  assert.equal(probed, "Z:\\");
  for (const type of [0, 1]) assert.throws(() => localDatabaseTarget("Z:\\project\\db", () => type, "win32"), /无法确认.*本地磁盘/);
  assert.throws(() => localDatabaseTarget("Z:\\project\\db", () => { throw new Error("probe unavailable"); }, "win32"), /无法确认.*本地磁盘/);
});

it("accepts local/removable/RAM drives and normalizes extended local paths rather than treating them as UNC", () => {
  for (const type of [2, 3, 6]) {
    assert.equal(localDatabaseTarget("C:\\temp\\new-db", () => type, "win32"), "C:\\temp\\new-db");
    assert.equal(localDatabaseTarget(String.raw`\\?\C:\temp\new-db`, (root) => { assert.equal(root, "C:\\"); return type; }, "win32"), "C:\\temp\\new-db");
    assert.equal(localDatabaseTarget("//?/C:/temp/new-db", () => type, "win32"), "C:\\temp\\new-db");
  }
});

it("leaves native non-Windows local paths unchanged without invoking a Windows probe", () => {
  assert.equal(localDatabaseTarget("/tmp/new-db", () => { throw new Error("must not probe"); }, "linux"), "/tmp/new-db");
});

it("refuses drive-relative and root-relative database paths instead of inheriting an unchecked current drive", () => {
  for (const target of ["C:relative-db", "\\root-relative-db", "relative-db"]) {
    assert.throws(() => localDatabaseTarget(target, () => { throw new Error("must not probe"); }, "win32"), /完整的本地绝对目录/);
  }
});

it("queries the actual Windows local volume and accepts a real extended local database target", { skip: process.platform !== "win32" }, () => {
  const temporary = mkdtempSync(join(tmpdir(), "df-storage-target-")); roots.push(temporary);
  const root = join(temporary, "data"), target = join(temporary, "local-db"); mkdirSync(root);
  const db = new Db(join(root, "core.db")); db.close();
  assert.equal(localDatabaseTarget(target), target);
  const move = requestMove(root, "database", "\\\\?\\" + target, join(root, "pi"), undefined, join(root, "core.db"));
  assert.equal(move.target, target);
  assert.ok(existsSync(pendingMoveFile(root)));
  assert.equal(existsSync(target), false, "request only schedules; does not copy");
  assert.ok(/^[A-Za-z]:\\$/.test(parse(target).root));
});

it("storage.move rejects UNC at request time with no journal, backup, maintenance, copy or scheduled restart", { skip: process.platform !== "win32" }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "df-storage-target-")); roots.push(temporary);
  const root = join(temporary, "data"); mkdirSync(root);
  const core = buildCore({ paths: corePaths(root), agentDir: defaultAgentDir(root), log: new Logger(), notifier: new RecordingNotifier() });
  cores.push(core);
  let shutdowns = 0, restarts = 0;
  core.onShutdown(() => { shutdowns++; });
  const broadcast = core.broadcast.bind(core);
  core.broadcast = (event) => { if (event.event === "storage.restarting") restarts++; broadcast(event); };
  const before = readFileSync(core.paths.dbFile);
  for (const target of [String.raw`\\wsl.localhost\df-do-not-start\db`, String.raw`\\?\UNC\server\share\db`]) {
    await assert.rejects(() => core.call("storage.move", { kind: "database", target }),
      (error: any) => error.code === "bad_request" && /数据库位置不支持网络路径/.test(error.message));
  }
  await new Promise((done) => setTimeout(done, 350));
  assert.equal(core.maintenance, undefined);
  assert.equal(restarts, 0); assert.equal(shutdowns, 0);
  assert.equal(existsSync(pendingMoveFile(root)), false);
  assert.equal(existsSync(join(root, "backups", "storage")), false);
  assert.deepEqual(readFileSync(core.paths.dbFile), before);
});
