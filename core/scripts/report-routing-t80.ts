import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gradeRoutingCase, scoreRouting, type RoutingAttempt, type RoutingDataset } from "../src/modules/skill-routing-eval.ts";

const [folderArg, formalArg, onArg, offArg, outputArg] = process.argv.slice(2);
assert.ok(folderArg && formalArg && onArg && offArg && outputArg);
const folder = resolve(folderArg), dataset = JSON.parse(readFileSync(new URL("../../docs/research/v0.7-routing-draft.json", import.meta.url), "utf8")) as RoutingDataset;
const read = (file: string) => JSON.parse(readFileSync(join(folder, file), "utf8"));
const formal = read(formalArg), on = read(onArg), off = read(offArg);
for (const proof of [formal, on, off]) {
	assert.equal(proof.datasetSha256, "9ad1622f6710d204439a9f50842fbe74e16d8bea05198ff9c0c1b14b16664935");
	assert.equal(proof.sourceConfigUnchanged, true); assert.equal(proof.sourceFreezeUnchanged, true); assert.equal(proof.ownedSandboxRemoved, true); assert.ok(!proof.fixtureScopeViolation && !proof.error);
}
assert.deepEqual(on.sourceFreeze, off.sourceFreeze, "comparison must use identical source");
assert.equal(on.legalCatalogSize, 60); assert.equal(off.legalCatalogSize, 60);
const score = scoreRouting(dataset, formal.attempts); assert.equal(score.complete, true);
const row = (proof: any) => ({ profile: proof.profile, attempts: proof.attempts.length, passedAttempts: proof.attempts.filter((a: RoutingAttempt) => gradeRoutingCase(dataset.cases.find(c => c.id === a.caseId)!, a.observation).passed).length,
	requests: proof.physicalRequests, costUsd: proof.costUsd, naturalCompletions: proof.phases.filter((p: any) => p.naturalCompletion).length,
	prefilterCalls: proof.attempts.filter((a: RoutingAttempt) => a.observation.route?.prefilterCalled).length, prefilterSuccesses: proof.attempts.filter((a: RoutingAttempt) => a.observation.route?.mode === "prefilter").length,
	prefilterFallbacks: proof.attempts.filter((a: RoutingAttempt) => a.observation.route?.prefilterCalled && a.observation.route.mode === "full").length });
const ledger = readdirSync(folder).filter(f => /^T80-live-.*\.json$/.test(f)).map(file => { const p = read(file); return { file, profile: p.profile, round: p.round, attempts: p.attempts.length, requests: p.physicalRequests, costUsd: p.costUsd, strictPassed: p.score?.strictPassed, formalPassed: p.score?.formalPassed, temporaryRoot: p.root, ownedSandboxRemoved: p.ownedSandboxRemoved, error: p.error ?? null }; });
const costUsd = ledger.reduce((sum, p) => sum + p.costUsd, 0), requests = ledger.reduce((sum, p) => sum + p.requests, 0);
assert.ok(costUsd <= 1 && requests <= 900);
const comparisonSourceDifferences = Object.keys(formal.sourceFreeze).filter(file => formal.sourceFreeze[file] !== on.sourceFreeze[file]);
const report = { datasetSha256: formal.datasetSha256, scoringVersion: score.scoringVersion, formal: { evidence: formalArg, round: formal.round, ...row(formal), score }, comparison: { round: on.round, on: { evidence: onArg, ...row(on) }, off: { evidence: offArg, ...row(off) }, sameSourcesBetweenArms: true, sameSourcesAsFinalFormal: comparisonSourceDifferences.length === 0, sourceDifferencesFromFinalFormal: comparisonSourceDifferences,
	measurement: "30 original prompts once per arm on the initial frozen version; not a formal 3-repeat score or final revised-guide accuracy. Recorded gateway costs may omit cancellation usage; concurrent fixture runs do not establish latency performance." }, ledger, total: { costUsd, requests, withinBudget: true, temporaryDataCopiesRetained: "Automatic cleanup review rejected recursive deletion with blocked by policy; no retry or workaround." } };
writeFileSync(resolve(outputArg), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ formalPassed: score.formalPassed, strictPassed: score.strictPassed, security: score.security, comparison: report.comparison, total: report.total }));
