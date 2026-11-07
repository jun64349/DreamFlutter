import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
const bridge = resolve('Claude Codex Bridge');
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const workspace = json(join(bridge, 'T67-U1-workspace.json')), proof = json(join(bridge, 'T67-product-isolated-live.json'));
assert.equal(proof.passed, true); assert.equal(proof.offlineRollback, true);
for (const path of [proof.run, proof.workspace, proof.profile]) assert.ok(resolve(path).toLowerCase().startsWith((resolve(workspace.temporary) + '\\').toLowerCase()));
const data = join(proof.run, 'data'), journal = json(join(data, 'updates/journal.json')), prefs = json(join(data, 'window/prefs.json'));
assert.equal(prefs['flutter.workspace'], proof.workspace); assert.equal(journal.phase, 'rolled-back');
const db = new DatabaseSync(join(data, 'core.db'), { readOnly: true });
const requests = db.prepare('SELECT COUNT(*) AS n FROM request_ledger').get().n, gatewayRequests = db.prepare('SELECT COUNT(*) AS n FROM gateway_requests').get().n;
db.close(); assert.equal(requests, 0); assert.equal(gatewayRequests, 0);
const frozen = ['module.ts', 'guardian.mjs', 'startup.ts'].map(name => {
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const path = `core/src/update/${name}`, sha256 = hash(path), same = sha256 === hash(join(workspace.temporary, 'product-core-accepted/update', name)); assert.equal(same, true); return { path, sha256, same };
});
const packages = [1, 2, 3].map(n => {
  const root = join(workspace.temporary, `product-accepted-test${n}`), version = `0.6.0-test.${n}`, manifest = json(join(root, 'DreamFlutter/licenses/third-party.json'));
  assert.equal(manifest.entries.find(entry => entry.name === 'DreamFlutter').version, version);
  return { version, packageBytes: statSync(join(root, 'Velopack', `DreamFlutter-${version}-win-x64-full.nupkg`)).size, licenseEntries: manifest.entries.length };
});
const checksFile = join(bridge, 'T67-final-check-exits.json');
const summary = { at: new Date().toISOString(), isolatedRealProductPassed: true, interruptedGuardianRecovered: proof.rows.some(row => row.operation === 'validation-guardian-interrupted-write-gate-retained'), offlineBinaryAndDataRollback: true, run: proof.run, workspace: proof.workspace, profile: proof.profile, backup: journal.backup, backupBytes: statSync(journal.backup).size,
  businessModelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, requestLedgerRows: requests, gatewayRequestRows: gatewayRequests, frozen, packages, sizeProbe: json(join(bridge, 'T67-U1-size-final.json')), checks: existsSync(checksFile) ? json(checksFile) : 'pending' };
writeFileSync(join(bridge, 'T67-final-evidence.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ realProduct: summary.isolatedRealProductPassed, interruptedGuardian: summary.interruptedGuardianRecovered, businessModelCalls: 0, requestLedgerRows: requests, packageBytes: packages.map(pkg => pkg.packageBytes), checks: summary.checks }));
