import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Core } from "../core.ts";
import { Db } from "../db.ts";
import { PathMap, isInside, type PathRule } from "../backup/path-map.ts";
import { remapColumns } from "../backup/parts.ts";
import { isSecretReference, relocateSecretRef } from "../modules/secrets.ts";
import { runWsl, type WslRunner } from "../sandbox/sandbox.ts";
import type { CopyInventory } from "./copy.ts";
import { backupDatabase, checkDatabase } from "./memory-maintenance.ts";
import { atomicJson, configureResourcePaths, locationFile, readLocationConfig, storageLocations, type LocationConfig, type StorageKind, type StorageLocations } from "./locations.ts";
import { officialMoveArguments, officialMoveWithRetry } from "./wsl.ts";
import { readPiJson } from "../gateway/pi-config.ts";
import { localDatabaseTarget } from "./target.ts";

export const pendingMoveFile = (root: string) => join(root, "storage-move.json");
export const moveResultFile = (root: string) => join(root, "storage-move-result.json");
const ownerFile = ".dreamflutter-storage-owner";
export interface MoveRecord {
  version: 1; id: string; kind: StorageKind; source: string; target: string; locations: StorageLocations;
  before: LocationConfig | null; stage: "requested" | "copying" | "validating" | "committed";
  dbFile: string; backup?: string; manifest?: CopyInventory; rules: PathRule[];
  edits: { path: string; backup: string | null }[]; distro?: string; diskBytes?: number; wslMoved?: boolean;
}
export interface MoveHooks { wsl?: WslRunner; afterCopy?: () => void; }

/** Keep the raw WSL diagnostic while identifying an occupied disk after rollback succeeds. */
class SandboxInUseError extends Error {
  readonly reasonCode = "sandbox_in_use";
}

function checkTarget(source: string, target: string, kind: StorageKind, locations: StorageLocations, root: string): string {
  if (kind === "database") target = localDatabaseTarget(target);
  if (!isAbsolute(target) || resolve(target) === dirname(resolve(target))) throw new Error("请选择新的绝对目录，不能使用磁盘根目录");
  if (existsSync(target)) throw new Error("目标目录已存在，请选择一个尚不存在的新目录");
  if (realpathSync(dirname(target)).toLowerCase() !== resolve(dirname(target)).toLowerCase()) throw new Error("目标路径不能经过链接");
  if (resolve(source).toLowerCase() === resolve(target).toLowerCase() || isInside(target, root)) throw new Error("新旧位置不能相同，目标不能包含应用数据根目录");
  if (!["database", "logs"].includes(kind) && isInside(source, target)) throw new Error("新旧目录不能互相包含");
  for (const [other, path] of Object.entries(locations)) {
    if (other === kind || ["database", "logs", "configuration"].includes(other)) continue;
    if (isInside(path, target) || isInside(target, path)) throw new Error("目标不能与其他数据类别重叠");
  }
  return target;
}

/** The RPC schedules work; copying starts only after normal shutdown releases writers. */
export function requestMove(root: string, kind: StorageKind, target: string, agentDir: string, sessionsDir: string | undefined, dbFile: string, distro?: string): MoveRecord {
  if (existsSync(pendingMoveFile(root))) throw new Error("已有数据搬迁等待重启完成");
  const locations = storageLocations(root, agentDir, sessionsDir);
  const source = locations[kind];
  target = checkTarget(source, target, kind, locations, root);
  const rules: PathRule[] = ["database", "logs"].includes(kind)
    ? (kind === "database" ? ["core.db"] : ["core.log", "core.log.1"]).map((name) => ({ from: join(source, name), to: join(target, name) }))
    : [{ from: source, to: target }, ...Object.entries(locations).filter(([key, path]) => key !== kind && isInside(source, path) && path !== source).map(([, path]) => ({ from: path, to: path }))];
  const record: MoveRecord = { version: 1, id: randomUUID(), kind, source, target: resolve(target), locations,
    before: readLocationConfig(root) ?? null, stage: "requested", dbFile, rules, edits: [], distro };
  atomicJson(pendingMoveFile(root), record);
  return record;
}

function selected(record: MoveRecord): CopyInventory {
  if (!existsSync(record.source)) return { files: [], directories: [""], bytes: 0 };
  if (realpathSync(record.source).toLowerCase() !== resolve(record.source).toLowerCase()) throw new Error("源目录不能经过链接");
  // A legacy DB/log directory also holds unrelated categories: never copy or delete those.
  const allowed = record.kind === "database" ? ["core.db"] : record.kind === "logs" ? ["core.log", "core.log.1"] : undefined;
  if (allowed) {
    const files = allowed.filter((name) => existsSync(join(record.source, name))).flatMap((name) => {
      const path = join(record.source, name);
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("数据文件不能为链接或目录");
      // Reuse the bounded-memory inventory hasher on just the selected file's parent.
      return inventoryFile(path, name);
    });
    return { files, directories: [""], bytes: files.reduce((sum, f) => sum + f.bytes, 0) };
  }
  const excluded = record.kind === "sandbox" ? ["disk"] : record.kind === "configuration"
    ? Object.entries(record.locations).filter(([key, path]) => key !== "configuration" && path !== record.source && isInside(record.source, path)).map(([, path]) => relative(record.source, path)) : [];
  return inventorySelected(record.source, excluded);
}

function inventoryFile(path: string, name: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("搬迁不接受链接或特殊文件");
  const fd = openSync(path, "r");
  try {
    const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    for (;;) { const n = readSync(fd, buffer); if (!n) return [{ path: name, bytes: stat.size, sha256: hash.digest("hex") }]; hash.update(buffer.subarray(0, n)); }
  } finally { closeSync(fd); }
}
function inventorySelected(source: string, excluded: string[]): CopyInventory {
  const result: CopyInventory = { files: [], directories: [""], bytes: 0 };
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), rel = relative(source, path);
      if (excluded.some((skip) => rel === skip || rel.startsWith(skip + sep))) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`搬迁目录包含链接：${path}`);
      if (stat.isDirectory()) { result.directories.push(rel); walk(path); }
      else { const files = inventoryFile(path, rel); result.files.push(...files); result.bytes += stat.size; }
    }
  };
  walk(source);
  result.directories.sort(); result.files.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

function save(root: string, record: MoveRecord) { atomicJson(pendingMoveFile(root), record); }
function ownedTarget(record: MoveRecord): boolean {
  return existsSync(record.target) && realpathSync(record.target).toLowerCase() === resolve(record.target).toLowerCase()
    && existsSync(join(record.target, ownerFile)) && readFileSync(join(record.target, ownerFile), "utf8") === record.id;
}
function result(root: string, value: Record<string, unknown>) { atomicJson(moveResultFile(root), { at: Date.now(), ...value }); }

/** Called under the normal core instance lock, before opening the live database. */
export async function preparePendingMove(root: string, hooks: MoveHooks = {}): Promise<MoveRecord | undefined> {
  if (!existsSync(pendingMoveFile(root))) return;
  const record = JSON.parse(readFileSync(pendingMoveFile(root), "utf8")) as MoveRecord;
  if (record.version !== 1 || !isAbsolute(record.target) || !isAbsolute(record.source)) throw new Error("搬迁记录损坏，未操作数据");
  if (record.stage === "committed") {
    try { finishMove(root, record); } catch { /* Validated data stays selected; retry cleanup on the next start. */ }
    return;
  }
  if (record.stage !== "requested") { await rollbackMove(root, record, "上次搬迁未完成启动验证，已退回原位置", hooks); return; }
  const wsl = hooks.wsl ?? runWsl;
  try {
    record.target = checkTarget(record.source, record.target, record.kind, record.locations, root);
    const db = new Db(record.dbFile);
    try { record.backup = backupDatabase(db, join(root, "backups", "storage")); }
    finally { db.close(); }
    record.stage = "copying"; save(root, record);
    record.manifest = selected(record);
    mkdirSync(record.target);
    writeFileSync(join(record.target, ownerFile), record.id, { mode: 0o600 });
    for (const path of record.manifest.directories) if (path) mkdirSync(join(record.target, path), { recursive: true });
    for (const file of record.manifest.files) copyFileSync(join(record.source, file.path), join(record.target, file.path), 1);
    hooks.afterCopy?.();
    const after = inventorySelected(record.target, [ownerFile]);
    const expected = { ...record.manifest, directories: [...record.manifest.directories].sort(), files: [...record.manifest.files].sort((a, b) => a.path.localeCompare(b.path)) };
    if (JSON.stringify(after) !== JSON.stringify(expected) || JSON.stringify(selected(record)) !== JSON.stringify(record.manifest)) throw new Error("文件数量、大小或SHA-256校验未通过，原位置保留");
    if (record.kind === "database") checkDatabase(join(record.target, "core.db"));
    if (record.kind === "sandbox" && existsSync(join(record.source, "disk", "ext4.vhdx"))) {
      const help = await wsl(["--help"], { timeoutMs: 20_000 });
      // wsl.exe --help can return -1 even when it prints a complete capability list.
      // The public option itself, rather than the help process's exit code, is the gate.
      const args = officialMoveArguments(help.stdout, record.distro ?? "", join(record.target, "disk"));
      const stopped = await wsl(["--terminate", record.distro!], { timeoutMs: 30_000 });
      if (stopped.code !== 0) throw new Error("无法停止目标沙箱，未执行WSL搬迁");
      record.diskBytes = statSync(join(record.source, "disk", "ext4.vhdx")).size;
      save(root, record);
      const moved = await officialMoveWithRetry(wsl, args);
      if (moved.code !== 0) {
        const message = `WSL官方搬迁失败：${moved.stderr || moved.stdout}`;
        if (/ERROR_SHARING_VIOLATION/.test(moved.stderr + moved.stdout)) throw new SandboxInUseError(message);
        throw new Error(message);
      }
      record.wslMoved = true; save(root, record);
      if (lstatSync(join(record.target, "disk", "ext4.vhdx")).isSymbolicLink() || statSync(join(record.target, "disk", "ext4.vhdx")).size !== record.diskBytes) throw new Error("WSL磁盘大小校验失败");
    }
    record.stage = "validating"; save(root, record);
    atomicJson(locationFile(root), { version: 1, ...(record.before ?? {}), paths: { ...record.locations, [record.kind]: record.target } });
    fixResources(root, record);
    return record;
  } catch (error) { await rollbackMove(root, record, error instanceof Error ? error : String(error), hooks); return; }
}

function captureEdit(root: string, record: MoveRecord, path: string): void {
  if (record.edits.some((e) => e.path === path)) return;
  const backup = existsSync(path) ? join(root, "backups", "storage", `${record.id}-${record.edits.length}.original`) : null;
  if (backup) copyFileSync(path, backup, 1);
  record.edits.push({ path, backup }); save(root, record);
}
function fixResources(root: string, record: MoveRecord): void {
  const map = new PathMap(record.rules);
  const configuration = storageLocations(root).configuration;
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") return record.kind === "secrets" && isSecretReference(value) ? relocateSecretRef(value, record.target)
      : value.startsWith("-") && isAbsolute(value.slice(1)) ? "-" + map.map(value.slice(1)) : map.map(value);
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
    return value;
  };
  for (const name of ["settings.json", "models.json", "models-store.json", "auth.json", "mcp.json", "trust.json"]) {
    const file = join(configuration, name);
    if (!existsSync(file)) continue;
    const original = readPiJson(file);
    const fixed = rewrite(original);
    if (JSON.stringify(fixed) !== JSON.stringify(original)) { captureEdit(root, record, file); atomicJson(file, fixed); }
  }
  captureEdit(root, record, join(configuration, "settings.json"));
  configureResourcePaths(root, configuration);
  if (record.kind === "sessions") {
    for (const file of record.manifest?.files ?? []) {
      if (!file.path.endsWith(".jsonl")) continue;
      const path = join(record.target, file.path), text = readFileSync(path, "utf8"), end = text.indexOf("\n");
      const header = JSON.parse(end < 0 ? text : text.slice(0, end));
      if (header.type !== "session") continue;
      for (const key of ["cwd", "parentSession"]) if (typeof header[key] === "string") header[key] = map.map(header[key]);
      writeFileSync(path, JSON.stringify(header) + (end < 0 ? "" : text.slice(end)));
    }
  }
}

/** Run before core.start: all modules have declared their public path columns. */
export function remapMovedDatabase(core: Core, record: MoveRecord): void {
  core.maintenance = "正在验证搬迁后的数据，暂不启动新任务";
  core.db.transaction(() => remapColumns(core.db, core.backupParts, {
    map: new PathMap(record.rules), secretRef: (ref) => record.kind === "secrets" ? relocateSecretRef(ref, record.target) : ref,
  }, true));
}

/** Full normal module startup has succeeded. No ready/discovery is published before this. */
export async function validateMove(core: Core, record: MoveRecord, hooks: MoveHooks = {}): Promise<void> {
  checkDatabase(core.paths.dbFile);
  await core.call("core.hello", {});
  if (record.wslMoved) {
    const check = await (hooks.wsl ?? runWsl)(["-d", record.distro!, "-u", "root", "--", "sh", "-c", "test -d /workspace && test -d /home/agent"], { timeoutMs: 120_000 });
    if (check.code !== 0) throw new Error("WSL新位置启动验证失败");
  }
  save(core.paths.dataDir, { ...record, stage: "committed" });
  record.stage = "committed";
  try { finishMove(core.paths.dataDir, record); }
  catch (error) { core.log.warn("新位置已验证；清理或回执未完成，保留已提交记录供下次启动重试", error); }
  core.maintenance = undefined;
}

function finishMove(root: string, record: MoveRecord): void {
  let warning: string | undefined;
  try {
    if (record.manifest && JSON.stringify(selected(record)) === JSON.stringify(record.manifest)) {
      for (const file of record.manifest.files) rmSync(join(record.source, file.path));
      if (record.kind === "sandbox" && record.wslMoved && existsSync(join(record.source, "disk"))) {
        try { rmdirSync(join(record.source, "disk")); } catch { warning = "旧沙箱磁盘目录仍有其他文件，已保留供人工核对"; }
      }
      for (const directory of [...record.manifest.directories].sort((a, b) => b.length - a.length)) {
        if (!directory && ["database", "logs", "configuration"].includes(record.kind)) continue;
        try { rmdirSync(join(record.source, directory)); } catch { /* Other categories and unexpected new files stay. */ }
      }
    } else warning = "原位置内容发生变化，已保留旧文件，请人工核对后清理";
  } catch (error) { warning = `新位置已验证，旧文件清理未完成：${error}`; }
  if (ownedTarget(record)) rmSync(join(record.target, ownerFile));
  result(root, { id: record.id, ok: true, kind: record.kind, path: record.target, backup: record.backup, files: record.manifest?.files.length, bytes: record.manifest?.bytes, warning, restartRequired: false });
  rmSync(pendingMoveFile(root), { force: true });
}

/** Core/server must be closed first. Never deletes the source or a pre-existing target. */
export async function rollbackMove(root: string, record: MoveRecord, error: string | Error, hooks: MoveHooks = {}): Promise<void> {
  if (record.kind === "sandbox" && (record.wslMoved || (!existsSync(join(record.source, "disk", "ext4.vhdx")) && existsSync(join(record.target, "disk", "ext4.vhdx"))))) {
    const wsl = hooks.wsl ?? runWsl;
    await wsl(["--terminate", record.distro!], { timeoutMs: 30_000 });
    const oldDisk = join(record.source, "disk");
    if (existsSync(oldDisk) && readdirSync(oldDisk).length === 0) rmdirSync(oldDisk);
    const restored = await officialMoveWithRetry(wsl, ["--manage", record.distro!, "--move", join(record.source, "disk")]);
    if (restored.code !== 0) throw new Error(`WSL官方回滚未完成；保留两端和搬迁记录，请重启重试：${restored.stderr}`);
  }
  for (const edit of [...record.edits].reverse()) {
    if (edit.backup) copyFileSync(edit.backup, edit.path);
    else rmSync(edit.path, { force: true });
  }
  if (record.stage === "validating" && record.backup) {
    for (const suffix of ["-wal", "-shm"]) rmSync(record.dbFile + suffix, { force: true });
    copyFileSync(record.backup, record.dbFile);
    checkDatabase(record.dbFile);
  }
  if (record.before) atomicJson(locationFile(root), record.before); else rmSync(locationFile(root), { force: true });
  if (ownedTarget(record)) rmSync(record.target, { recursive: true, force: true });
  result(root, { id: record.id, ok: false, kind: record.kind, path: record.source, backup: record.backup, error: String(error),
    ...(record.kind === "sandbox" && error instanceof SandboxInUseError ? { reasonCode: error.reasonCode } : {}), restartRequired: false });
  rmSync(pendingMoveFile(root), { force: true });
}
