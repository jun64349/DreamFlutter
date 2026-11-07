import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { UpdateError, type ReleaseAsset } from "./release.ts";

export type UpdatePhase = "prepared" | "applying" | "validating" | "verified" | "accepted" | "rollback-needed" | "rolled-back" | "cancelled" | "manual-recovery";
export interface UpdateJournal {
  id: string; phase: UpdatePhase; at: number; from: string; to: string; installRoot: string; appRoot: string; dataRoot: string;
  agentDir: string; sessionsDir: string; databaseFile: string; backup: string; targetPackage: string; oldPackage: string; asset: ReleaseAsset;
  guardDir: string; guardPid?: number; recoveryPid?: number; windowPid?: number; corePid: number; nonce: string;
  acceptedWrites: boolean; error?: string; attemptedRollback: boolean; memoryWasPaused: boolean; cleaned?: boolean;
}
export class JournalStore {
  readonly file: string;
  constructor(dataRoot: string) { this.file = join(dataRoot, "updates", "journal.json"); }
  read(): UpdateJournal | undefined {
    if (!existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      if (!data || typeof data.id !== "string" || !["prepared", "applying", "validating", "verified", "accepted", "rollback-needed", "rolled-back", "cancelled", "manual-recovery"].includes(data.phase) || typeof data.acceptedWrites !== "boolean") throw Error();
      return data;
    } catch { throw new UpdateError("recovery_required", "更新阶段记录无法读取，已保留现场，请先导出诊断信息。"); }
  }
  /** Shared by the old core, guardian and new core; acceptance cannot race with rollback. */
  mutate(change: (current: UpdateJournal | undefined) => UpdateJournal): UpdateJournal {
    mkdirSync(dirname(this.file), { recursive: true });
    const lock = this.file + ".lock";
    let fd: number | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { fd = openSync(lock, "wx", 0o600); writeFileSync(fd, JSON.stringify({ pid: process.pid })); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try { const owner = JSON.parse(readFileSync(lock, "utf8")); try { process.kill(owner.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") rmSync(lock, { force: true }); } } catch { /* An owner may still be writing its lock. */ }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    if (fd === undefined) throw new UpdateError("busy", "更新阶段正在切换，请稍后重试。");
    try {
      const current = this.read(), next = change(current);
      if (current?.id === next.id && current.acceptedWrites && (!next.acceptedWrites || next.phase === "rollback-needed" || next.phase === "rolled-back")) throw new UpdateError("new_data", "新版本已接受写入，禁止自动恢复旧备份。");
      const temporary = this.file + `.${process.pid}.${randomUUID()}.partial`;
      writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 }); renameSync(temporary, this.file); return next;
    } finally { closeSync(fd); rmSync(lock, { force: true }); }
  }
  patch(change: Partial<UpdateJournal>): UpdateJournal { return this.mutate((current) => { if (!current) throw new UpdateError("missing_stage", "没有待处理更新。"); return { ...current, ...change, at: Date.now() }; }); }
  accepted(): void { const current = this.read(); if (current?.phase === "verified") this.patch({ phase: "accepted", acceptedWrites: true }); }
}
export function pendingValidation(journal: UpdateJournal | undefined): boolean { return !!journal && ["applying", "validating", "rollback-needed"].includes(journal.phase) && !journal.acceptedWrites; }
export function shouldRollback(journal: UpdateJournal): boolean { return !journal.acceptedWrites && !journal.attemptedRollback && ["applying", "validating", "rollback-needed"].includes(journal.phase); }
