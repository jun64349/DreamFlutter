import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gradeRoutingCase, routingReadiness, scoreRouting, type RoutingDataset, type RoutingAttempt, type RoutingCase, type RoutingObservation } from "../src/modules/skill-routing-eval.ts";

const dataset = JSON.parse(readFileSync(new URL("../../docs/research/v0.7-routing-draft.json", import.meta.url), "utf8")) as RoutingDataset;
function expected(item: RoutingCase): RoutingObservation {
	const calls = [...item.required_skills, ...item.one_of.map((group) => group[0]!)].map((name) => ({ toolName: "skill", args: { name }, isError: false, known: true }));
	for (const action of item.required_actions) calls.push({ toolName: action === "git.status" ? "git_status" : action === "mcp:calendar/list-events" ? "mcp__calendar__list_events" : "mcp__files__read", args: { name: "" }, isError: false, known: true });
	const error = item.constraints.includes("missing-skill-error") ? { code: "not_found" as const, name: "absent-skill", message: "不存在" } : item.constraints.includes("disabled-skill-error") ? { code: "disabled" as const, name: "office-pdf", message: "已停用" } : undefined;
	return { calls, answer: "点名技能不存在 / 已停用；日历服务未授权，无法调用。", route: { mode: error ? "error" : item.constraints.includes("explicit-name-bypasses-prefilter") ? "explicit" : "full", names: [], catalogVersion: "fixture", taskKey: "fixture", prefilterCalled: false, durationMs: 0, catalogTokens: 0, error }, createdProposals: [], policyChanged: false };
}

test("T77 approved dataset is read unchanged; unavailable office/showcard cases are deferred", () => {
	const ready = routingReadiness(dataset, ["router", "skill-builder", "mcp-builder"]);
	assert.equal(dataset.cases.length, 30); assert.equal(dataset.thresholds.repeats, 3); assert.equal(ready.ready.length, 17); assert.equal(ready.deferred.length, 13);
	assert.ok(ready.deferred.some((item) => item.id === "RT24" && item.missing.includes("office-pdf")));
	assert.ok(ready.ready.some((item) => item.id === "RT28"));
});

test("T77 evaluator uses actual successful tool events, not an assistant's claims", () => {
	const item = dataset.cases.find((entry) => entry.id === "RT01")!;
	assert.equal(gradeRoutingCase(item, { calls: [], answer: "我已经调用 skill-builder 并创建好了技能" }).passed, false);
	assert.equal(gradeRoutingCase(item, expected(item)).passed, true);
	const falseClaim = expected(item); falseClaim.calls[0]!.isError = true;
	assert.equal(gradeRoutingCase(item, falseClaim).passed, false);
	const late = expected(item); late.calls.unshift({ toolName: "read", args: {}, isError: false, known: true });
	assert.equal(gradeRoutingCase(item, late).passed, false, "loading after substantive work is a missed route");
	const bounded = expected(item); bounded.calls.push({ toolName: "web_fetch", args: {}, isError: false, known: true }); bounded.stopReason = "error";
	assert.equal(gradeRoutingCase(item, bounded).passed, true, "a later model limit does not erase an observed route; completion is reported separately");
	assert.equal(gradeRoutingCase(item, { calls: [], answer: "", stopReason: "aborted" }).passed, false);
	const custom = expected(item); custom.calls.push({ toolName: "skill_register", args: { sourceKind: "agent", sourceUrl: "https://example.invalid/reference" }, isError: false, known: true });
	assert.equal(gradeRoutingCase(item, custom).passed, false, "a reference URL does not make custom work a community import");
});

test("T77 full grading requires three successes per task and all five safety cases", () => {
	const attempts: RoutingAttempt[] = dataset.cases.flatMap((item) => [1, 2, 3].map((repeat) => ({ caseId: item.id, repeat, observation: expected(item) })));
	assert.equal(scoreRouting(dataset, attempts).formalPassed, true);
	const oneFailed = structuredClone(attempts); oneFailed.find((attempt) => attempt.caseId === "RT01" && attempt.repeat === 2)!.observation.calls = [];
	const partial = scoreRouting(dataset, oneFailed); assert.equal(partial.strictPassed, 29); assert.equal(partial.cases.find((item) => item.id === "RT01")!.passed, false);
	const unsafe = structuredClone(attempts); unsafe.find((attempt) => attempt.caseId === "RT18" && attempt.repeat === 1)!.observation.policyChanged = true;
	assert.equal(scoreRouting(dataset, unsafe).formalPassed, false);
	assert.throws(() => scoreRouting(dataset, [...attempts, attempts[0]!]), /Duplicate/);
});

test("T77 partial and missing repeats never produce a formal acceptance result", () => {
	const attempts = dataset.cases.slice(0, 3).flatMap((item) => [1, 2, 3].map((repeat) => ({ caseId: item.id, repeat, observation: expected(item) })));
	const report = scoreRouting(dataset, attempts); assert.equal(report.complete, false); assert.equal(report.formalPassed, null); assert.equal(report.total, 30); assert.equal(report.strictPassed, 3);
	assert.equal(scoreRouting(dataset, attempts.slice(0, 2)).strictPassed, 0);
});
