import { existsSync, mkdirSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildCore } from "../app.ts";
import { CORE_VERSION } from "../core.ts";
import { Logger } from "../log.ts";
import { RecordingNotifier } from "../notify.ts";
import { corePaths, defaultAgentDir } from "../paths.ts";
import { stageBackup } from "../backup/restore.ts";
import { applyPendingRestore, writeSwitchRecord } from "../backup/switch.ts";
import { JournalStore } from "./state.ts";

const config = JSON.parse(await readFile(process.argv[2]!, "utf8")), store = new JournalStore(config.dataRoot);
const journal = store.read();
if (!journal || journal.id !== config.id || journal.nonce !== config.nonce || journal.acceptedWrites || journal.phase !== "rollback-needed") throw Error("Recovery stage does not permit restoring a backup");
if (!resolve(config.guardDir).startsWith(resolve(config.dataRoot) + "\\updates\\runs\\") || !existsSync(config.backup)) throw Error("Missing retained recovery files");
// Obtain existing backup path declarations from an isolated metadata DB, never open the live failed DB.
const metadata = join(config.guardDir, "restore-metadata"); mkdirSync(metadata, { recursive: true });
const scratch = buildCore({ paths: corePaths(metadata), agentDir: defaultAgentDir(metadata), sessionDir: join(metadata, "sessions"), piMigration: { automatic: false }, log: new Logger(), notifier: new RecordingNotifier() });
try {
  const paths = corePaths(config.dataRoot);
  if (!existsSync(join(paths.dataDir, "restore-switch.json"))) {
    const staged = await stageBackup(config.backup, { paths, agentDir: config.agentDir, sessionsDir: config.sessionsDir, appVersion: CORE_VERSION }, { parts: scratch.backupParts });
    if (store.read()?.acceptedWrites) throw Error("New user data forbids restoration");
    writeSwitchRecord(paths, config.agentDir, staged, { kind: "update-rollback", backup: config.backup });
  }
  const outcome = applyPendingRestore(paths);
  if (!outcome?.ok) throw Error("Existing backup switch did not complete");
  store.patch({ phase: "rolled-back", recoveryPid: undefined, error: "新版本未通过启动验证，已恢复旧版本和更新前备份。" });
} finally {
  await scratch.shutdown();
  if (!resolve(metadata).startsWith(resolve(config.guardDir) + "\\")) throw Error("Unsafe metadata cleanup");
  await rm(metadata, { recursive: true, force: true });
}
