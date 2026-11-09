import assert from "node:assert/strict";
import { test } from "node:test";
import { explicitSkillNames, SkillRouter } from "../src/modules/skill-routing.ts";
import { readFileSync } from "node:fs";
import { gradeRoutingCase, productionBoundaries, type ObservedCall, type RoutingDataset } from "../src/modules/skill-routing-eval.ts";

test("T80 ordinary Chinese multi-skill lists match dollar syntax, preserve order and never drop unknown list members", async () => {
	const known = ["office-pdf", "office-xlsx", "showcard-pro", "技能甲", "技能乙"];
	for (const prompt of ["使用 office-pdf 和 office-xlsx 技能", "使用office-pdf和office-xlsx技能", "使用 `office-pdf`、`office-xlsx` 技能", "调用 office-pdf 与 office-xlsx", "用技能 office-pdf，office-xlsx", "use office-pdf and office-xlsx skills", "使用 office-pdf 和 $office-xlsx 技能", "使用 $office-pdf 和 $office-xlsx 技能"]) assert.deepEqual(explicitSkillNames(prompt, known), ["office-pdf", "office-xlsx"], prompt);
	assert.deepEqual(explicitSkillNames("用技能 技能甲 和 技能乙", known), ["技能甲", "技能乙"]);
	assert.deepEqual(explicitSkillNames("使用 office-pdf 和 absent-skill 技能", known), ["office-pdf", "absent-skill"]);
	assert.deepEqual(explicitSkillNames("使用 absent-skill 和 office-xlsx 技能", known), ["absent-skill", "office-xlsx"]);
	assert.deepEqual(explicitSkillNames("用名叫 absent-skill 的技能处理材料", known), ["absent-skill"]);
	for (const prompt of ["用本周记录做个报告", "费用 $100，继续", "use office-pdf-extra", "用 Python 和 SQL 处理数据"]) assert.deepEqual(explicitSkillNames(prompt, known), [], prompt);
	const router = new SkillRouter(); let aux = 0;
	const catalog = Array.from({ length: 60 }, (_, i) => ({ name: i === 0 ? "office-pdf" : i === 1 ? "office-xlsx" : `noise-${i}`, description: "fixture", enabled: true, trust: "trusted" }));
	const select = () => router.select(catalog, { window: 120000, scope: "fixture" }, async () => { aux++; return {}; });
	router.observe("使用 office-pdf 和 office-xlsx 技能"); assert.deepEqual((await select()).names, ["office-pdf", "office-xlsx"]); assert.equal(aux, 0);
	router.observe("使用 office-pdf 和 absent-skill 技能"); assert.equal((await select()).error?.code, "not_found"); assert.deepEqual((await select()).names, []);
	catalog[1]!.enabled = false; router.observe("使用 office-pdf 和 office-xlsx 技能"); assert.equal((await select()).error?.code, "disabled"); assert.equal(aux, 0);
	delete (catalog[1] as { enabled?: boolean }).enabled; catalog[1]!.trust = "untrusted"; assert.equal((await select()).error?.code, "untrusted");
	const baseline = new SkillRouter(); baseline.observe("a general task without explicit names");
	assert.equal((await baseline.select(catalog, { window: 120000, scope: "fixture", prefilterEnabled: false }, async () => { aux++; return {}; })).mode, "full"); assert.equal(aux, 0);
});

test("T80 R81 changes only multiple deadlines, allowing input/environment reads before later skills but not production", () => {
	const dataset = JSON.parse(readFileSync(new URL("../../docs/research/v0.7-routing-draft.json", import.meta.url), "utf8")) as RoutingDataset;
	const item = dataset.cases.find((value) => value.id === "RT19")!;
	const call = (toolName: string, args: Record<string, unknown> = {}): ObservedCall => ({ toolName, args, isError: false, known: true });
	const selected = (name: string) => call("skill", { name });
	const input = call("read", { file_path: "sales.csv" }), environment = call("pwsh", { command: "node --version" });
	const calculate = call("pwsh", { command: "python -c \"import csv; rows=list(csv.DictReader(open('sales.csv'))); print(rows)\"" });
	const render = call("pwsh", { command: "node render-report.mjs input.json result.html" });
	const good = [selected("showcard-pro"), input, environment, selected("data-analysis"), calculate, render];
	assert.equal(gradeRoutingCase(item, { calls: good, answer: "done" }).passed, true);
	assert.equal(gradeRoutingCase(item, { calls: [input, ...good], answer: "done" }).passed, false, "one required skill still precedes the first substantive action");
	const late = [selected("showcard-pro"), input, calculate, selected("data-analysis"), render];
	assert.ok(gradeRoutingCase(item, { calls: late, answer: "done" }).failures.includes("late-skill-before-production:data-analysis"));
	const saved = [selected("showcard-pro"), call("write", { file_path: "process.py", content: "import csv\nrows=list(csv.DictReader(open('sales.csv')))" }), call("pwsh", { command: "python process.py" }), selected("data-analysis")];
	assert.equal(productionBoundaries(saved)["data-analysis"], 2); assert.equal(gradeRoutingCase(item, { calls: saved, answer: "done" }).passed, false);
	const oldCategory = { ...item, category: "hit" };
	assert.equal(gradeRoutingCase(oldCategory, { calls: good, answer: "done" }).passed, false, "other categories keep the original all-before-first-action rule");
});
