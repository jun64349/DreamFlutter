import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { it } from 'node:test';
import { buildCore } from '../src/app.ts';
import { corePaths, defaultAgentDir } from '../src/paths.ts';
import { Logger } from '../src/log.ts';
import { RecordingNotifier } from '../src/notify.ts';
import { createBackup } from '../src/backup/export.ts';
import { stageBackup } from '../src/backup/restore.ts';
import { applyPendingRestore, Killed, writeSwitchRecord } from '../src/backup/switch.ts';
import { JournalStore, type UpdateJournal } from '../src/update/state.ts';
import { recoverUpdateStartup } from '../src/update/startup.ts';

it('real recovery entry resumes a killed data switch, restores WAL-consistent settings/files once, and refuses accepted writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'df-update-data-recovery-')), paths = corePaths(root), agent = defaultAgentDir(root), sessions = join(agent, 'sessions');
  const guard = join(root, 'updates', 'runs', 'interrupted-data'), config = join(guard, 'guard-config.json'); mkdirSync(guard, { recursive: true }); mkdirSync(sessions, { recursive: true });
  const makeCore = () => buildCore({ paths, agentDir: agent, sessionDir: sessions, log: new Logger(), notifier: new RecordingNotifier(), piMigration: { automatic: false } });
  let core = makeCore(); const store = new JournalStore(root), sentinel = join(root, 'preserved.txt');
  const recover = () => new Promise<void>((done, reject) => execFile(process.execPath, ['--disable-warning=ExperimentalWarning', resolve('src/update/recover-entry.ts'), config], { windowsHide: true, timeout: 30000 }, error => error ? reject(error) : done()));
  try {
    core.settings.update({ notifications: false, memoryPaused: true, autoCheckUpdates: false }); writeFileSync(sentinel, 'pre-update-data');
    assert.equal(Object.values(core.db.raw.prepare('PRAGMA journal_mode').get()!)[0], 'wal');
    const backup = await createBackup({ paths, agentDir: agent, sessionsDir: sessions, db: core.db.raw, appVersion: '0.5.0' }, { out: join(root, 'backups', 'retained.dfbackup'), kind: 'upgrade', credentials: 'local', includeMaterials: false });
    core.settings.update({ notifications: true }); writeFileSync(sentinel, 'partially migrated data');
    const parts = core.backupParts; await core.shutdown();
    const journal = { id: 'interrupted-data', nonce: 'recovery-nonce', phase: 'rollback-needed', acceptedWrites: false, attemptedRollback: true, dataRoot: root, agentDir: agent, sessionsDir: sessions, guardDir: guard, backup: backup.path, at: Date.now() } as UpdateJournal;
    store.mutate(() => journal); writeFileSync(config, JSON.stringify(journal));
    const staged = await stageBackup(backup.path, { paths, agentDir: agent, sessionsDir: sessions, appVersion: '0.5.0' }, { parts });
    writeSwitchRecord(paths, agent, staged, { kind: 'update-rollback', backup: backup.path });
    assert.throws(() => applyPendingRestore(paths, { killAfter: 1 }), Killed);
    await recover(); assert.equal(store.read()?.phase, 'rolled-back'); assert.equal(readFileSync(sentinel, 'utf8'), 'pre-update-data');
    core = makeCore(); assert.equal(core.settings.get().notifications, false); await core.shutdown();
    writeFileSync(sentinel, 'new writes after recovered startup');
    assert.equal(await recoverUpdateStartup(paths), 'continue'); assert.equal(readFileSync(sentinel, 'utf8'), 'new writes after recovered startup');
    store.mutate(() => ({ ...journal, phase: 'accepted', acceptedWrites: true }));
    await assert.rejects(recover()); assert.equal(readFileSync(sentinel, 'utf8'), 'new writes after recovered startup');
  } finally { await core.shutdown(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
