import assert from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { GoalsModule, type GoalScheduler } from "../src/modules/goals.ts";
import { TasksModule } from "../src/modules/tasks.ts";
import { startTestCore, type TestCore } from "./harness.ts";

type Detail = ReturnType<GoalScheduler["detail"]>;
let t: TestCore;
beforeEach(async () => { t = await startTestCore(); });
afterEach(async () => { await t.cleanup(); });
const goals = () => t.core.module(GoalsModule)!;
const create = (title: string, extra: Record<string, unknown> = {}) => t.core.call("goals.create", {
	title, originText: "交付报告", mandateRef: "user:t106", scope: { cwd: t.workspace }, spec: { objective: "交付报告" }, ...extra,
}) as Promise<Detail>;
const until = (id: string, predicate: (detail: Detail) => boolean) => t.waitFor(() => {
	const detail = goals().scheduler.detail(id);
	return predicate(detail) && detail;
}, 8000);
const done = () => fauxAssistantMessage("[目标已完成]\n已交付");
const verdict = (verdict: string, next = ""): FauxResponseFactory => context => {
	const raw = context.messages.at(-1)?.content;
	const { revision, evidence_version } = JSON.parse(typeof raw === "string" ? raw : raw?.map(part => "text" in part ? part.text : "").join("") ?? "");
	return fauxAssistantMessage(JSON.stringify({ verdict, revision, evidence_version, next, missing: [], questions: [] }));
};

it("T106 maps all six views, orders decide with pending proposals and counts by partition", async () => {
	goals().executor.stop();
	const fixtures = [
		["draft", "missing_input", "workbench", "decide"],
		["waiting_user", "needs_permission", "butterfly", "decide"],
		["blocked", "stalled", "workbench", "blocked"],
		["waiting_user", "acceptance", "butterfly", "accept"],
		["queued", null, "workbench", "running"],
		["running", null, "butterfly", "running"],
		["reviewing", null, "workbench", "running"],
		["waiting_dependency", "waiting_job", "butterfly", "running"],
		["paused", "budget_runs", "workbench", "paused"],
		["completed", null, "workbench", "done"],
		["failed", "prep_failed", "workbench", "done"],
		["cancelled", null, "butterfly", "done"],
	] as const;
	const views = ["decide", "blocked", "accept", "running", "paused", "done"] as const;
	const expected = Object.fromEntries(views.map(view => [view, [] as string[]]));
	for (const [index, [status, reason, partition, view]] of fixtures.entries()) {
		const goal = await create(`goal-${index}`, { spec: {}, scope: { cwd: t.workspace, partition } });
		t.core.db.run("UPDATE goals SET status=?,reason=?,updated_at=? WHERE id=?", status, reason, index + 1, goal.id);
		expected[view]!.unshift(goal.id);
	}
	for (const status of ["pending", "accepted", "rejected"]) {
		t.core.db.run(`INSERT INTO goal_proposals(id,session_file,message_id,origin_text,draft,created_at,status)
			VALUES(?, ?, ?, '原话', '{"title":"提议"}', 100, ?)`, status, join(t.sessionDir, "proposal.jsonl"), status, status);
	}
	expected.decide!.unshift("pending");
	for (const view of views) {
		const items = await t.core.call("goals.list", { view }) as { id: string; view: string; stage: string; next: string }[];
		assert.deepEqual(items.map(item => item.id), expected[view], view);
		assert.ok(items.every(item => item.view === view && item.stage && item.next));
	}
	const butterfly = await t.core.call("goals.list", { view: "decide", partition: "butterfly", limit: 1 }) as { kind: string }[];
	assert.deepEqual(butterfly.map(item => item.kind), ["goal_proposal"]);
	assert.deepEqual(await t.core.call("goals.counts", {}), {
		butterfly: { decide: 2, blocked: 0, accept: 1, running: 2, paused: 0, done: 1 },
		workbench: { decide: 1, blocked: 1, accept: 0, running: 2, paused: 1, done: 2 },
	});
	assert.deepEqual(Object.keys((await t.core.call("goals.counts", {}) as { workbench: object }).workbench), [...views]);
	await assert.rejects(t.core.call("goals.list", { view: "other" }), { code: "bad_request" });
});

it("T106 returns real artifacts across tasks with the producing round and readable labels", async () => {
	goals().executor.stop();
	const goal = await create("整理材料");
	const tasks = t.core.module(TasksModule)!;
	const one = tasks.create({ cwd: t.workspace, goal: "第一轮", source: "chat", goalId: goal.id });
	const two = tasks.create({ cwd: t.workspace, goal: "第二轮", source: "chat", goalId: goal.id });
	const other = tasks.create({ cwd: t.workspace, goal: "其他任务", source: "chat" });
	for (const [task, name] of [[one, "资料.csv"], [two, "报告.docx"], [two, "已删除.md"], [other, "无关.md"]] as const) {
		const path = join(t.workspace, name);
		writeFileSync(path, name);
		tasks.recordArtifact(task.id, path);
	}
	unlinkSync(join(t.workspace, "已删除.md"));
	for (const [id, task, at, files] of [
		["round-1", one, 1, ["资料.csv"]], ["round-2", two, 2, ["报告.docx", "已删除.md"]], ["round-3", two, 3, []],
	] as const) {
		t.core.db.run("INSERT INTO runs(id,cwd,task_id,status,started_at,ended_at,files) VALUES(?,?,?,'done',?,?,?)",
			id, t.workspace, task.id, at, at, JSON.stringify(files));
	}
	t.core.db.run("UPDATE artifacts SET updated_at=CASE WHEN path LIKE '%报告.docx' THEN 2 ELSE 1 END");
	t.core.db.run("UPDATE goals SET status='waiting_dependency',reason='waiting_job',resume_when='测试跑完' WHERE id=?", goal.id);
	const get = () => t.core.call("goals.get", { id: goal.id }) as Promise<Detail>;
	assert.equal((await get()).stage, "第 3 轮 · 等测试跑完");
	t.core.db.run("UPDATE goals SET status='waiting_user',reason='acceptance' WHERE id=?", goal.id);
	const detail = await get();
	assert.equal(detail.stage, "等你验收");
	assert.equal(detail.next, "等你验收：报告.docx");
	assert.deepEqual(detail.artifacts.map(({ path, type, taskId, runId, round }) => [path, type, taskId, runId, round]), [
		[join(t.workspace, "报告.docx"), "docx", two.id, "round-2", 2],
		[join(t.workspace, "资料.csv"), "csv", one.id, "round-1", 1],
	]);
});

it("T106 only notifies on goal completion after three rounds, reviews and a child job", async () => {
	t.respond(fauxAssistantMessage([fauxToolCall("agent", { description: "检查材料", prompt: "回报材料情况" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("子任务已结束"), done(), verdict("continue", "核对第二份材料"),
		fauxAssistantMessage("核对第二份材料"), done(), verdict("done"));
	const goal = await create("三轮报告", { scope: { cwd: t.workspace, allowedTools: ["agent", "read"] } });
	const completed = await until(goal.id, current => current.completed);
	assert.equal(completed.budgetStatus.used.runs, 3);
	assert.equal(t.core.db.get<{ count: number }>("SELECT count(*) count FROM goal_reviews WHERE goal_id=? AND layer='model'", goal.id)?.count, 2);
	assert.ok(t.core.db.get("SELECT 1 FROM jobs WHERE goal_id=? AND kind='subagent' AND status='completed'", goal.id));
	await t.waitFor(() => t.notifier.sent.length > 0);
	const replay = completed.recentEvents.find(event => event.kind === "run.finished")!;
	goals().scheduler.post(goal.id, "run.finished", replay.dedupeKey, replay.payload);
	assert.deepEqual(t.notifier.sent.map(notice => notice.title), ["目标已完成"]);
});

it("T106 notifies once for decision, acceptance, a blockage and budget exhaustion", async () => {
	const permission = await create("确认授权", { spec: {}, scope: { cwd: t.workspace, allowedTools: ["read"] } });
	await t.core.call("goals.update", { id: permission.id, scope: { allowedTools: ["read", "write"] } });
	const untilNotice = (title: string) => t.waitFor(() => t.notifier.sent.some(note => note.title === title), 8000);
	await untilNotice("目标等你决定");
	t.respond(done(), verdict("done"));
	const human = await create("人工验收", { spec: { objective: "报告", acceptance: [{ id: "human", text: "人工确认", layer: "user" }] } });
	await until(human.id, detail => detail.awaitingAcceptance);
	await untilNotice("目标等你验收");
	t.respond(done(), verdict("blocked", "补充原始记录"));
	const blocked = await create("出现阻塞");
	assert.equal((await until(blocked.id, detail => detail.status === "blocked")).next, "补充原始记录");
	await untilNotice("目标遇到阻塞");
	const exhausted = await create("次数已用完", { budget: { maxRuns: 0 } });
	assert.equal((await until(exhausted.id, detail => detail.status === "paused")).stage, "执行次数已用完");
	await untilNotice("目标预算已用完");
	for (const goal of [permission, human, blocked, exhausted]) await t.core.call("goals.budget", { id: goal.id, budget: { maxCostUsd: 2 } });
	assert.equal(goals().scheduler.pendingIntents().filter(intent => intent.action === "notify").length, 0);
	assert.deepEqual(t.notifier.sent.map(notice => notice.title), ["目标等你决定", "目标等你验收", "目标遇到阻塞", "目标预算已用完"]);
});
