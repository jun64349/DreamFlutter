import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { corePaths } from '../src/paths.ts';
import { JournalStore, type UpdateJournal } from '../src/update/state.ts';
import { recoverUpdateStartup } from '../src/update/startup.ts';

it('interrupted update cancels before replacement, resumes one guardian after replacement, and preserves accepted writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'df-update-restart-')), paths = corePaths(root), store = new JournalStore(root);
  const guard = join(root, 'updates', 'runs', 'recovery-test'); mkdirSync(guard, { recursive: true });
  const journal = { id: 'recovery-test', phase: 'prepared', at: Date.now(), from: '0.6.0-test.1', to: '0.6.0-test.2', guardDir: guard, nonce: 'nonce', acceptedWrites: false, attemptedRollback: false, backup: join(root, 'kept.dfbackup') } as UpdateJournal;
  let launches = 0;
  const options = { version: journal.to, alive: () => false, launch: () => { launches++; return 12345; } };
  try {
    store.mutate(() => journal);
    assert.equal(await recoverUpdateStartup(paths, options), 'continue'); assert.equal(store.read()?.phase, 'cancelled'); assert.equal(launches, 0);
    store.mutate(() => ({ ...journal, phase: 'applying' })); writeFileSync(join(guard, 'guard-config.json'), JSON.stringify(journal));
    assert.equal(await recoverUpdateStartup(paths, { ...options, version: journal.from, alive: () => true }), 'guardian-active'); assert.equal(launches, 0);
    await assert.rejects(recoverUpdateStartup(paths, { ...options, version: '9.9.9' }), /不匹配/);
    assert.equal(await recoverUpdateStartup(paths, options), 'guardian-active'); assert.equal(launches, 1);
    assert.equal(await recoverUpdateStartup(paths, { ...options, alive: () => true }), 'continue'); assert.equal(launches, 1);
    store.patch({ phase: 'validating' });
    writeFileSync(join(guard, 'guard-config.json'), JSON.stringify({ ...journal, nonce: 'wrong' }));
    await assert.rejects(recoverUpdateStartup(paths, options), /不匹配/); assert.equal(launches, 1);
    store.patch({ phase: 'verified' }); store.accepted();
    assert.equal(await recoverUpdateStartup(paths, options), 'continue'); assert.equal(launches, 1); assert.equal(store.read()?.acceptedWrites, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
