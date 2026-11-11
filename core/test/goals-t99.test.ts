import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { ActionReceipt, AttentionItem } from "../src/modules/attention.ts";
import { GoalScheduler, GoalsModule } from "../src/modules/goals.ts";
import type { Schedule } from "../src/modules/scheduler.ts";
import { TasksModule } from "../src/modules/tasks.ts";
import { startTestCore, type TestCore } from "./harness.ts";

type Detail = ReturnType<GoalScheduler["detail"]>;
let t: TestCore;
beforeEach(async () => {
	t = await startTestCore();
	const resolve = t.core.resolveModel;
	t.core.resolveModel = model => ({ ...resolve(model), cost: { input: 0.5, output: 1, cacheRead: 0.1, cacheWrite: 0.5 } });
});
afterEach(async () => { await t.cleanup(); });
const service = () => t.core.module(GoalsModule)!;
const get = (id: string) => service().scheduler.detail(id);
const create = (extra: Record<string, unknown> = {}) => t.core.call("goals.create", {
	title: "核对并交付报告", originText: "按约定核对材料。", mandateRef: "user:t99",
	scope: { cwd: t.workspace, partition: "workbench", sandbox: false }, spec: { objective: "交付报告" }, ...extra,
}) as Promise<Detail>;
const until = (id: string, condition: (goal: Detail) => boolean) => t.waitFor(() => {
	const detail = get(id);
	return condition(detail) && detail;
}, 5_000).catch(error => {
	const { status, reason, resumeWhen, checks } = get(id);
	const runs = t.core.db.all("SELECT status,error,tool_calls FROM runs");
	throw new Error(`${error.message}; ${JSON.stringify({ status, reason, resumeWhen, checks, runs })}`, { cause: error });
});
const write = (path: string, content = "报告") => fauxAssistantMessage([fauxToolCall("write", { file_path: path, content })], { stopReason: "toolUse" });
const file = (path: string) => ({ id: path, text: `生成 ${path}`, layer: "program", check: { kind: "file_exists", args: { path } } });
const human = { id: "human", text: "用户确认报告", layer: "user" };
const review = (verdict: "done" | "continue" = "done"): FauxResponseFactory => context => {
	const content = context.messages.at(-1)?.content;
	const { revision, evidence_version } = JSON.parse(typeof content === "string" ? content : content?.map(part => "text" in part ? part.text : "").join("") ?? "");
	return fauxAssistantMessage(JSON.stringify({ verdict, revision, evidence_version, next: "", missing: [], questions: [] }));
};
const control = (id: string | undefined, action: string) => t.core.call("goals.control", { id, action });
const inbox = async () => (await t.core.call("attention.list", {}) as { now: AttentionItem[] }).now;
const resolve = (id: string, action: "accept" | "reject", reason?: string) =>
	t.core.call("attention.resolve", { id, action, response: reason ? { reason } : undefined }) as Promise<ActionReceipt>;
function holdResponse(factory: FauxResponseFactory) {
	let release!: () => void;
	let signalEntered!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const entered = new Promise<void>(resolve => { signalEntered = resolve; });
	const step: FauxResponseFactory = async (...args) => {
		signalEntered();
		await gate;
		return factory(...args);
	};
	return { step, entered, release };
}

it("T99 advances three times in the same session, verifies output, and notifies only once", async () => {
	t.respond(fauxAssistantMessage("先核对材料"), write("part.md"), fauxAssistantMessage("已核对第一份"),
		write("report.md"), fauxAssistantMessage("已交付报告"), review());
	const goal = await create({ spec: { objective: "交付报告", acceptance: [file("report.md")] } });
	const done = await until(goal.id, detail => detail.completed);
	assert.deepEqual([done.executionEnded, done.artifactsGenerated, done.machineAccepted, done.awaitingAcceptance], [true, true, true, false]);
	assert.equal(done.budgetStatus.used.runs, 3);
	assert.ok(existsSync(join(t.workspace, "report.md")));
	const rows = t.core.db.all<{ session_file: string }>("SELECT r.session_file FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.goal_id=?", goal.id);
	assert.equal(new Set(rows.map(row => row.session_file)).size, 1);
	await t.waitFor(() => t.notifier.sent.length > 0);
	assert.deepEqual(t.notifier.sent.map(n => n.title), ["目标已完成"]);
	const charges = service().scheduler.ledger.entries(goal.id, 20);
	assert.equal(charges.filter(charge => charge.kind === "review" && charge.state === "settled").length, 1);
	assert.equal(charges.filter(charge => charge.kind === "main" && charge.requestId).length, 5);
});

it("T99 lists missing files and rejects a claimed test without a tool receipt", async () => {
	writeFileSync(join(t.workspace, "found.md"), "已交付");
	t.respond(fauxAssistantMessage("全部生成了，测试都跑过了。"));
	const goal = await create({ spec: { objective: "核对文件", acceptance: [file("found.md"), file("absent.md"),
		{ id: "test", text: "测试通过", layer: "program", check: { kind: "tests_pass", args: { command: "npm test" } } }] } });
	const checked = await until(goal.id, detail => detail.checks.length > 0);
	await control(goal.id, "pause");
	assert.deepEqual(checked.checks.map(c => [c.id, c.status]), [["found.md", "passed"], ["absent.md", "missing"], ["test", "unverified"]]);
	assert.deepEqual(checked.missing.map(c => c.id), ["absent.md", "test"]);
	assert.equal(checked.machineAccepted, false);
	assert.equal(service().scheduler.ledger.entries(goal.id, 20).some(charge => charge.kind === "review"), false);
});

it("T99 verifies structured command receipts and parses files before review", async () => {
	const command = "Get-Item -LiteralPath report.json";
	t.respond(write("report.json", '{"ready":true}'),
		fauxAssistantMessage([fauxToolCall("pwsh", { command, description: "检查报告测试夹具", timeoutMs: 6000 })], { stopReason: "toolUse" }),
		fauxAssistantMessage("产物和测试已交付"), review());
	const goal = await create({
		scope: { cwd: t.workspace, externalActions: [{ tool: "pwsh", command }] },
		spec: { objective: "核对报告", acceptance: [
			{ id: "json", text: "报告可解析", layer: "program", check: { kind: "file_parses", args: { path: "report.json" } } },
			{ id: "exit", text: "命令退出成功", layer: "program", check: { kind: "command_ok", args: { command } } },
		] },
	});
	const completed = await until(goal.id, detail => detail.completed);
	assert.deepEqual(completed.checks.map(check => check.detail), ["格式已验证", "退出码 0"]);
	assert.match(JSON.stringify(completed.irreversible), /Get-Item -LiteralPath report.json/);
});

for (const action of ["pause", "revision"] as const) {
	it(`T99 discards a review returned after ${action}`, async () => {
		const old = holdResponse(review());
		const next = holdResponse(() => fauxAssistantMessage("新修订继续"));
		t.respond(fauxAssistantMessage("[目标已完成]\n已交付"), old.step, next.step);
		const goal = await create();
		try {
			await until(goal.id, detail => detail.stillRunning.some(item => item.kind === "review"));
			await old.entered;
			if (action === "pause") await control(goal.id, "pause");
			else await t.core.call("goals.update", { id: goal.id, spec: { objective: "修订后再交付" } });
			old.release();
			await until(goal.id, detail => !detail.stillRunning.some(item => item.kind === "review"));
			const current = get(goal.id);
			assert.equal(current.completed, false);
			assert.equal(current.machineAccepted, false);
			if (action === "pause") assert.equal(current.status, "paused");
			else assert.equal(current.revision, 2);
			assert.equal(t.core.db.get("SELECT 1 FROM goal_reviews WHERE goal_id=? AND layer='model'", goal.id), undefined);
		} finally {
			old.release();
			next.release();
		}
	});
}

it("T99 retries invalid reviews twice and records review_unparsable", async () => {
	t.respond(fauxAssistantMessage("[目标已完成]\n做完"), fauxAssistantMessage("无效"), fauxAssistantMessage("{}"), fauxAssistantMessage("仍无效"));
	const goal = await create();
	await until(goal.id, detail => detail.reason === "review_unparsable");
	const attempts = service().scheduler.ledger.entries(goal.id, 20).filter(charge => charge.kind === "review");
	assert.equal(attempts.length, 3);
	assert.ok(attempts.every(charge => charge.state === "settled" && charge.requestId));
});

it("T99 waits for human acceptance and passes rejection feedback into a new revision", async () => {
	const prompts: string[] = [];
	t.respond(fauxAssistantMessage("[目标已完成]\n做完"), review(),
		context => { prompts.push(JSON.stringify(context.messages.at(-1))); return fauxAssistantMessage("[目标已完成]\n已补充"); }, review());
	const goal = await create({ spec: { objective: "报告", acceptance: [human] } });
	const waiting = await until(goal.id, detail => detail.awaitingAcceptance);
	assert.equal(waiting.machineAccepted, true);
	assert.equal(waiting.completed, false);
	assert.deepEqual(waiting.approvals.map(a => [a.kind, a.actions]), [["acceptance", ["accept", "reject"]]]);
	const first = (await inbox()).find(item => item.kind === "goal_acceptance" && item.data.goalId === goal.id);
	assert.ok(first);
	assert.deepEqual(first.actions, ["accept", "reject"]);
	await assert.rejects(resolve(first.id, "reject"), /请填写退回原因/);
	assert.equal((await resolve(first.id, "reject", "补充第二组数据")).status, "applied");
	const again = await until(goal.id, detail => detail.awaitingAcceptance && detail.revision === 2);
	assert.match(prompts[0]!, /补充第二组数据/);
	const second = (await inbox()).find(item => item.target.itemId === again.approvals[0]!.id);
	assert.ok(second);
	assert.equal((await resolve(second.id, "accept")).status, "applied");
	const accepted = get(goal.id);
	assert.equal(accepted.completed, true);
	assert.equal(accepted.approvals.length, 0);
	assert.equal((await inbox()).some(item => item.kind === "goal_acceptance"), false);
});

it("T99 asks for a different route once before stopping repeated plans", async () => {
	const prompts: string[] = [];
	const repeat: FauxResponseFactory = context => {
		prompts.push(JSON.stringify(context.messages.at(-1)));
		return fauxAssistantMessage("我打算先制订计划");
	};
	t.respond(repeat, repeat, repeat, repeat);
	const goal = await create({ spec: { objective: "报告", acceptance: [file("never.md")] } });
	const blocked = await until(goal.id, detail => detail.reason === "stalled");
	assert.match(blocked.resumeWhen ?? "", /反复规划/);
	assert.equal(blocked.budgetStatus.used.runs, 4);
	assert.equal(prompts.filter(prompt => prompt.includes("换一条路线")).length, 1);
});

it("T99 stop_run aborts a live run and rejects its late completion", async () => {
	const held = holdResponse(() => fauxAssistantMessage("已经做完"));
	const resumed = holdResponse(() => fauxAssistantMessage("[目标已完成]\n第二次执行结束"));
	t.respond(held.step, resumed.step, review());
	const goal = await create();
	try {
		await until(goal.id, detail => detail.stillRunning.some(item => item.kind === "run"));
		await held.entered;
		const stop = () => t.core.call("goals.control", { id: goal.id, action: "stop_run", operationId: "stop-once" });
		await stop();
		held.release();
		const stopped = await until(goal.id, detail => detail.stillRunning.length === 0);
		assert.equal(stopped.status, "paused");
		assert.equal(stopped.stopIntent, "stop_run");
		assert.equal(t.core.db.get<{ status: string }>("SELECT status FROM runs")?.status, "aborted");
		assert.equal(stopped.completed, false);
		assert.equal(service().scheduler.pendingIntents().length, 0);
		await control(goal.id, "resume");
		await until(goal.id, detail => detail.status === "running");
		await resumed.entered;
		await stop();
		resumed.release();
		await until(goal.id, detail => detail.completed);
	} finally { held.release(); resumed.release(); }
});

it("T99 emergency stops both live goals and reports completed file changes", async () => {
	const one = holdResponse(() => fauxAssistantMessage("迟到的结果一"));
	const two = holdResponse(() => fauxAssistantMessage("迟到的结果二"));
	t.respond(write("written.md"), one.step, two.step);
	const first = await create();
	try {
		await until(first.id, detail => detail.irreversible.length > 0);
		await one.entered;
		const second = await create({ title: "第二个目标" });
		await until(second.id, detail => detail.stillRunning.length > 0);
		await two.entered;
		await control(undefined, "emergency");
		one.release();
		two.release();
		const [a, b] = await Promise.all([until(first.id, d => !d.stillRunning.length), until(second.id, d => !d.stillRunning.length)]);
		assert.equal(a.stopIntent, "emergency");
		assert.equal(b.stopIntent, "emergency");
		assert.match(JSON.stringify(a.irreversible), /written.md/);
		assert.deepEqual(t.core.db.all<{ status: string }>("SELECT status FROM runs").map(r => r.status), ["aborted", "aborted"]);
	} finally { one.release(); two.release(); }
});

it("T99 linked schedules post one event while ordinary schedules launch their own task", async () => {
	const goal = await create({ spec: { objective: "" } });
	const save = (name: string) => t.core.call("schedules.save", { name, prompt: "检查", cwd: t.workspace,
		trigger: { type: "interval", everyMs: 10 * 60_000 }, kind: "report" }) as Promise<Schedule>;
	const linked = await save("目标日程");
	t.core.db.run("UPDATE schedules SET goal_id=? WHERE id=?", goal.id, linked.id);
	const plain = await save("普通日程");
	t.respond(fauxAssistantMessage("普通日程已完成"));
	const at = Math.max(linked.nextRunAt!, plain.nextRunAt!);
	await t.core.call("schedules.tick", { now: at });
	await t.core.call("schedules.tick", { now: at });
	await t.waitFor(() => t.core.db.get("SELECT 1 FROM schedule_runs WHERE schedule_id=? AND task_id IS NOT NULL AND status='done'", plain.id));
	assert.equal(t.core.db.get<{ n: number }>("SELECT count(*) n FROM goal_events WHERE goal_id=? AND kind='schedule.fired'", goal.id)?.n, 1);
	assert.equal(t.core.db.get<{ task_id: string | null }>("SELECT task_id FROM schedule_runs WHERE schedule_id=?", linked.id)?.task_id, null);
	assert.equal(get(goal.id).status, "draft");
});

it("T99 butterfly goals require the sandbox and stay in that partition", async () => {
	const scope = { cwd: t.core.paths.butterflyDir, partition: "butterfly", sandbox: true };
	const unavailable = await create({ scope });
	await until(unavailable.id, detail => detail.reason === "prep_failed");
	assert.equal(t.core.sessionSlots().length, 0);
	let prepared = 0;
	t.core.sandboxProvider = () => ({ distro: "df-goal-test", ready: async () => { prepared++; }, online: () => false });
	t.respond(fauxAssistantMessage("[目标已完成]\n已完成"), review());
	const ready = await create({ scope });
	await until(ready.id, detail => detail.completed);
	assert.ok(prepared > 0);
	assert.equal(t.core.sessionSlots().length, 1);
	assert.equal(t.core.sessionSlots()[0]!.sandboxed, true);
	assert.equal(t.core.sessionSlots()[0]!.cwd, t.core.paths.butterflyDir);
});

it("T99 restart releases unsent reservations and preserves estimates of started runs", async () => {
	service().executor.stop();
	const goal = await create();
	const task = t.core.module(TasksModule)!.create({ cwd: t.workspace, goalId: goal.id, goal: "已登记", source: "chat" });
	const at = Date.now();
	t.core.db.run("INSERT INTO runs(id,cwd,task_id,status,started_at,ended_at) VALUES('started',?,?,'interrupted',?,?)", t.workspace, task.id, at - 100, at);
	service().scheduler.reserve(goal.id, { id: "hold-unsent", kind: "main", runId: "unsent", taskId: task.id, costUsd: 0.1 });
	service().scheduler.reserve(goal.id, { id: "hold-started", kind: "main", runId: "started", taskId: task.id, costUsd: 0.2 });
	t = await t.reopen();
	const ledger = new Map(service().scheduler.ledger.entries(goal.id, 10).map(charge => [charge.id, charge]));
	assert.equal(ledger.get("hold-unsent")?.state, "released");
	assert.equal(ledger.get("hold-unsent")?.releaseReason, "restart_unsent");
	assert.equal(ledger.get("hold-started")?.state, "reserved");
	assert.equal(ledger.get("hold-started")?.costEstimated, true);
	assert.equal(get(goal.id).budgetStatus.reserved.costUsd, 0.2);
	assert.equal(get(goal.id).budgetStatus.used.runs, 1);
});

it("T99 counts overlapping run time once and includes cache tokens and no-request runs", async () => {
	service().executor.stop();
	const goal = await create();
	const task = t.core.module(TasksModule)!.create({ cwd: t.workspace, goalId: goal.id, goal: "账本样本", source: "chat" });
	const at = Date.now();
	for (const [id, start, end] of [["a", at - 1000, at - 500], ["b", at - 600, at - 100]] as const) {
		t.core.db.run("INSERT INTO runs(id,cwd,task_id,status,started_at,ended_at) VALUES(?,?,?,'done',?,?)", id, t.workspace, task.id, start, end);
	}
	t.core.db.run(`INSERT INTO request_ledger(id,requested_at,state,provider,model,purpose,run_id,amount,currency,amount_source,price_version,origin,input,output,cache_read,cache_write)
		VALUES('usage',?,'complete','faux','faux-1','conversation','a',0.1,'USD','provider_actual','test','live',10,5,20,30)`, at);
	service().scheduler.reserve(goal.id, { id: "charged", kind: "main", runId: "a", taskId: task.id, costUsd: 0.2, requestId: "usage" });
	service().scheduler.settle("charged", "usage");
	assert.deepEqual(get(goal.id).budgetStatus.used, { costUsd: 0.1, tokens: 65, activeMs: 900, runs: 2, parallel: 0 });
});

it("T102 sends unpriced requests under the other limits", async () => {
	t.core.resolveModel = model => model;
	t.respond(fauxAssistantMessage("[目标已完成]\n无价格模型已交付"), review());
	const goal = await create({ budget: { maxCostUsd: 0 } });
	const done = await until(goal.id, detail => detail.completed);
	assert.equal(done.costUnknown, true);
	assert.equal(done.budgetStatus.used.runs, 1);
	assert.ok(done.budgetStatus.used.tokens > 0);
	assert.ok(service().scheduler.ledger.entries(goal.id, 10).every(charge => charge.cost === null && charge.costUnknown));
	const limited = await create({ budget: { maxCostUsd: 0, maxTokens: 1 } });
	await until(limited.id, detail => detail.reason === "budget_tokens");
	assert.equal(service().scheduler.ledger.entries(limited.id, 10).length, 0);
	t.respond(fauxAssistantMessage("这次还需继续"));
	const capped = await create({ budget: { maxCostUsd: 0, maxRuns: 1 } });
	const paused = await until(capped.id, detail => detail.reason === "budget_runs");
	assert.equal(paused.costUnknown, true);
	assert.equal(paused.budgetStatus.used.runs, 1);
});

it("T99 holds expanded authorization until explicit approval", async () => {
	service().executor.stop();
	const goal = await create({ scope: { cwd: t.workspace, allowedTools: ["read"], allowedPaths: ["."] } });
	const expand = () => t.core.call("goals.update", { id: goal.id, scope: { allowedTools: ["read", "write"], allowedPaths: [".", "../outside"] } }) as Promise<Detail>;
	const expanded = await expand();
	assert.equal(expanded.reason, "needs_permission");
	assert.deepEqual(expanded.scope.allowedTools, ["read"]);
	assert.equal(expanded.revision, 1);
	assert.deepEqual(service().scheduler.pendingIntents().map(intent => intent.action), ["notify"]);
	assert.equal(expanded.approvals[0]?.kind, "scope");
	const pending = (await inbox()).find(item => item.kind === "goal_scope" && item.data.goalId === goal.id);
	assert.ok(pending);
	assert.deepEqual(pending.actions, ["accept", "reject"]);
	assert.equal((await resolve(pending.id, "reject")).status, "applied");
	assert.deepEqual(get(goal.id).scope.allowedTools, ["read"]);
	await expand();
	const next = (await inbox()).find(item => item.kind === "goal_scope" && item.data.goalId === goal.id);
	assert.ok(next);
	assert.notEqual(next.id, pending.id);
	assert.equal((await resolve(next.id, "accept")).status, "applied");
	const approved = get(goal.id);
	assert.deepEqual(approved.scope.allowedTools, ["read", "write"]);
	assert.equal(approved.revision, 2);
	assert.equal(approved.status, "queued");
	assert.equal((await inbox()).some(item => item.kind === "goal_scope"), false);
});
