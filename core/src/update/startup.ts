import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JournalStore, pendingValidation } from "./state.ts";
import { buildInfo } from "./installation.ts";
import { guardianExecDir, launchGuardian, prepareGuardian } from "./bridge.ts";
import { UpdateError } from "./release.ts";
import type { CorePaths } from "../paths.ts";
import { APP_ROOT } from "../paths.ts";
import { execFile } from "node:child_process";

export interface StartupOptions { appRoot?: string; version?: string; alive?: (pid?: number) => boolean; launch?: typeof launchGuardian; prepare?: typeof prepareGuardian; }
export async function recoverUpdateStartup(paths: CorePaths, options: StartupOptions = {}): Promise<"continue" | "guardian-active"> {
  const store = new JournalStore(paths.dataDir), journal = store.read(); if (!journal) return "continue";
  const current = options.version ?? buildInfo().version;
  const alive = options.alive ?? ((pid?: number) => { try { if (!pid) return false; process.kill(pid, 0); return true; } catch { return false; } });
  if (journal.acceptedWrites || ["verified", "accepted", "rolled-back", "cancelled"].includes(journal.phase)) return "continue";
  if (journal.phase === "manual-recovery") throw new UpdateError("recovery_required", `更新未能自动恢复，数据和备份已保留：${journal.backup}`);
  if (journal.phase === "prepared") {
    if (alive(journal.guardPid)) return "guardian-active";
    store.patch({ phase: "cancelled", error: "更新在替换前中断，继续使用原版本；备份已保留。" }); return "continue";
  }
  if (journal.phase === "applying" && current === journal.from && alive(journal.guardPid)) return "guardian-active";
  if (journal.phase === "rollback-needed") {
    if (alive(journal.guardPid) || alive(journal.recoveryPid)) return "guardian-active";
    if (current === journal.from) {
      const config = join(paths.dataDir, "updates", "runs", journal.id, "guard-config.json");
      await new Promise<void>((done, reject) => execFile(process.execPath, ["--disable-warning=ExperimentalWarning", join(options.appRoot ?? APP_ROOT, "core", "src", "update", "recover-entry.ts"), config], { windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 }, (error) => error ? reject(new UpdateError("recovery_required", "数据恢复未能完成，已保留现场和备份。")) : done()));
      return "continue";
    }
  }
  if (pendingValidation(journal) && (current === journal.to || journal.phase === "applying" && current === journal.from) && !alive(journal.guardPid)) {
    const expected = join(paths.dataDir, "updates", "runs", journal.id);
    if (resolve(journal.guardDir).toLowerCase() !== resolve(expected).toLowerCase()) throw new UpdateError("recovery_required", "更新恢复路径不匹配，已保留现场。");
    const config = join(expected, "guard-config.json"); if (!existsSync(config)) throw new UpdateError("recovery_required", "更新守护记录缺失，已保留现场和备份。");
    const data = JSON.parse(await readFile(config, "utf8")); if (data.id !== journal.id || data.nonce !== journal.nonce) throw new UpdateError("recovery_required", "更新守护记录不匹配。");
    // The guardian runs outside the install root (guardianExecDir); temp cleanup may have removed it, so copy it again from this app.
    const execDir = guardianExecDir(journal.id);
    const guard = existsSync(join(execDir, "node.exe")) && existsSync(join(execDir, "guardian.mjs")) && existsSync(data.helper ?? "") ? { node: join(execDir, "node.exe"), script: join(execDir, "guardian.mjs"), helper: data.helper } : await (options.prepare ?? prepareGuardian)(options.appRoot ?? APP_ROOT, execDir);
    if (guard.helper !== data.helper) await writeFile(config, JSON.stringify({ ...data, helper: guard.helper }), { mode: 0o600 });
    const guardPid = (options.launch ?? launchGuardian)(guard.node, guard.script, config); store.patch({ guardPid });
    return "guardian-active";
  }
  if (pendingValidation(journal) && current !== journal.to) throw new UpdateError("recovery_required", "当前程序版本与更新阶段不匹配，已保留现场和备份。");
  return "continue";
}
