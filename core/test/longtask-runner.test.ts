import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { allowance, selectCases } from "../scripts/longtask/cases.ts";
import { evaluate } from "../scripts/longtask/checks.ts";
import { dryEvidence, runDryRun } from "../scripts/longtask/dry.ts";
import { generateFixture, sha256 } from "../scripts/longtask/fixtures/generate.ts";

it("runs selected cases without model runs or spending", async () => {
	const rows = await runDryRun(selectCases("L4,L6"));
	assert.deepEqual(rows.map(row => [row.id, row.passed, row.runs, row.costUsd, row.goalStatus]), [
		["L4", true, 0, 0, "paused"], ["L6", true, 0, 0, "paused"],
	]);
	assert.throws(() => selectCases("L4,L4"));
	assert.throws(() => selectCases("L8"));
	assert.equal(allowance(0, 0), 0.5);
	assert.equal(allowance(2.7, 0.2), 0.1);
	assert.equal(allowance(2.8, 0.3), 0);
	assert.equal(allowance(NaN, 0), 0);
});

it("reproduces seeded fixtures and rejects mismatched output or missing evidence", () => {
	const root = mkdtempSync(join(tmpdir(), "df-t105-fixture-"));
	try {
		const first = join(root, "first"), second = join(root, "second");
		const [item] = selectCases("L2");
		const answers = generateFixture(item!.id, first);
		assert.deepEqual(generateFixture(item!.id, second), answers);
		assert.equal(sha256(join(first, "sales.xlsx")), sha256(join(second, "sales.xlsx")));
		const evidence = dryEvidence(item!, first, answers);
		assert.ok(evaluate(item!, first, answers, evidence).every(check => check.passed));
		writeFileSync(join(first, "output", "monthly.csv"), "month,units,revenue_cents\n2026-01,1,2\n");
		evidence.tools.length = 0;
		assert.deepEqual(evaluate(item!, first, answers, evidence).filter(check => !check.passed).map(check => check.id), ["monthly", "screenshot"]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
