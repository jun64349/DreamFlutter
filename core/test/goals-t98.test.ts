import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createBackup } from "../src/backup/export.ts";
import { stageBackup } from "../src/backup/restore.ts";
import type { Core } from "../src/core.ts";
import { Db } from "../src/db.ts";
import { GoalScheduler, GoalsModule } from "../src/modules/goals.ts";
import type { Goal } from "../src/modules/goals/types.ts";
import { TasksModule } from "../src/modules/tasks.ts";
import { startTestCore, type TestCore } from "./harness.ts";

type Detail = ReturnType<GoalScheduler["detail"]>;
type History = ReturnType<GoalScheduler["history"]>;
type Intent = { id: string; status: string; revision: number; generation: number; idem_key: string };
let t: TestCore;
beforeEach(async () => {
	t = await startTestCore();
	// These tests drive the persisted state machine without claiming work in the live executor.
	t.core.module(GoalsModule)!.executor.stop();
});
afterEach(async () => { await t.cleanup(); });
const scheduler = () => t.core.module(GoalsModule)!.scheduler;
const spec = { objective: "整理记录", acceptance: [{ id: "report", text: "报告已生成", layer: "program", check: { kind: "file_exists", args: { path: "report.md" } } }] };
const params = (extra: Record<string, unknown> = {}) => ({
	title: "记录", originText: "  帮我整理记录\n保留原文。  ", mandateRef: "user:m1",
	scope: { cwd: t.workspace, partition: "workbench", sandbox: false }, spec, ...extra,
});
const create = async (extra?: Record<string, unknown>) => await t.core.call("goals.create", params(extra)) as Detail;
const get = async (id: string) => await t.core.call("goals.get", { id }) as Detail;
const control = (id: string | undefined, action: string, operationId?: string) => t.core.call("goals.control", { id, action, operationId });
const intents = (id: string) => t.core.db.all<Intent>("SELECT * FROM goal_intents WHERE goal_id=? AND action='run' ORDER BY rowid", id);
const pending = (id: string) => intents(id).find(intent => intent.status === "pending")!;
function finish(s: GoalScheduler, goal: Goal, runId: string, reportedComplete = false) {
	return s.post(goal.id, "run.finished", `run:${runId}`, {
		runId, taskId: "test-task", status: "done", revision: goal.revision, generation: goal.leaseGeneration, reportedComplete,
	});
}
function request(id: string, amount: number | null, runId: string | null = null) {
	t.core.db.run(`INSERT INTO request_ledger(id, requested_at, state, provider, model, purpose, run_id, amount, currency, amount_source, price_version, origin, input, output, duration_ms)
		VALUES(?, 1, 'complete', 'faux', 'faux-1', 'conversation', ?, ?, 'USD', 'price_estimate', 'test', 'live', 9, 4, 100)`, id, runId, amount);
}

it("creates and revises goals with the original words, history, and configurable defaults", async () => {
	const first = await create();
	assert.match(first.id, /^g_[0-9a-f]{8}$/);
	assert.equal(first.revision, 1);
	assert.equal(first.status, "queued");
	assert.deepEqual(first.budgetStatus.limits, { maxCostUsd: 2, maxTokens: null, maxActiveMs: 7_200_000, maxRuns: 30, maxParallel: 2 });
	const edited = await t.core.call("goals.update", {
		id: first.id, expectedRevision: 1, originText: "替换原话", spec: { objective: "按主题整理", constraints: [{ kind: "must", text: "保留原文" }] },
	}) as Detail;
	assert.equal(edited.revision, 2);
	assert.equal(edited.originText, params().originText);
	assert.equal(edited.spec.objective, "按主题整理");
	assert.deepEqual(edited.spec.acceptance[0], spec.acceptance[0]);
	const history = await t.core.call("goals.history", { id: first.id }) as History;
	assert.deepEqual(history.map(row => [row.revision, row.originText]), [[2, params().originText], [1, params().originText]]);
	assert.deepEqual((await t.core.call("goals.list", { status: "queued" }) as Goal[]).map(row => row.id), [first.id]);
	assert.ok(t.messages.some(m => m.event === "goals.changed" && m.id === first.id && m.revision === 2));
	t.core.settings.update({ goalDefaultBudget: { costUsd: 4, activeMinutes: 120, runs: 30, concurrency: 2 } });
	const auto = await create({ source: "rule", mandateRef: "rule:automatic@1", scope: { cwd: t.core.paths.butterflyDir, partition: "butterfly", sandbox: true } });
	assert.deepEqual(auto.budgetStatus.limits, { maxCostUsd: 2, maxTokens: null, maxActiveMs: 3_600_000, maxRuns: 15, maxParallel: 1 });
	assert.equal(t.core.sessionSlots().length, 0);
	assert.equal(t.core.db.get("SELECT 1 FROM request_ledger"), undefined);
});

it("deduplicates completion and continues only while a deterministic check is outstanding", async () => {
	const goal = await create();
	assert.ok(scheduler().claimIntent(pending(goal.id).id, current => current.mandateRef === "user:m1"));
	const first = finish(scheduler(), goal, "r1");
	const replay = finish(scheduler(), goal, "r1");
	assert.equal(replay.id, first.id);
	assert.notEqual(first.handledAt, null);
	assert.equal(t.core.db.get<{ n: number }>("SELECT count(*) n FROM goal_events WHERE dedupe_key='run:r1'")?.n, 1);
	assert.deepEqual(intents(goal.id).map(row => row.status), ["done", "pending"]);
	writeFileSync(join(t.workspace, "report.md"), "报告");
	assert.ok(scheduler().claimIntent(pending(goal.id).id, () => true));
	finish(scheduler(), goal, "r2");
	assert.equal((await get(goal.id)).status, "reviewing");
	assert.deepEqual(intents(goal.id).map(row => row.status), ["done", "done"]);
	assert.equal(t.core.db.get("SELECT 1 FROM goal_reviews"), undefined);
});

it("discards a decision read before the user paused", async () => {
	const live = scheduler();
	const worker = new GoalScheduler(t.core, () => Date.now(), goal => {
		live.control(goal.id, "pause", "stop-during-read");
		return true;
	});
	const goal = worker.create(params());
	assert.ok(worker.claimIntent(pending(goal.id).id, () => true));
	finish(worker, goal, "raced");
	assert.equal((await get(goal.id)).status, "paused");
	assert.equal((await get(goal.id)).stopIntent, "pause");
	assert.deepEqual(intents(goal.id).map(row => row.status), ["dropped"]);
});

it("drops the old intent and waits while user input remains unhandled", async () => {
	const goal = await create();
	const first = pending(goal.id);
	scheduler().post(goal.id, "user.input", "message-2", { text: "再加一项" });
	const event = finish(scheduler(), goal, "blocked-by-input");
	assert.equal(event.handledAt, null);
	assert.deepEqual(intents(goal.id).map(row => row.status), ["dropped"]);
	assert.equal(scheduler().claimIntent(first.id, () => true), null);
	assert.equal(scheduler().post(goal.id, "user.input", "message-2", { text: "再加一项" }).dedupeKey, "message-2");
});

it("queues one intent and rechecks its lease, user stop and live authorization before claiming", async () => {
	const goal = await create();
	const intent = pending(goal.id);
	scheduler().process(goal.id);
	assert.deepEqual(intents(goal.id).map(i => i.idem_key), [intent.idem_key]);
	assert.equal(new GoalScheduler(t.core).claimIntent(intent.id, () => true), null);
	assert.equal(scheduler().claimIntent(intent.id, current => {
		scheduler().control(current.id, "stop_run");
		return true;
	}), null);
	assert.equal((await get(goal.id)).stopIntent, "stop_run");
	await control(goal.id, "resume");
	assert.equal(scheduler().claimIntent(pending(goal.id).id, () => false), null);
	assert.equal((await get(goal.id)).reason, "needs_permission");
	assert.ok(intents(goal.id).every(i => i.status === "dropped"));

	let at = 1_000_000;
	const owner = new GoalScheduler(t.core, () => at);
	const nextOwner = new GoalScheduler(t.core, () => at);
	const leased = owner.create(params());
	const old = pending(leased.id);
	nextOwner.process(leased.id);
	assert.equal(pending(leased.id).id, old.id);
	at += 60_001;
	nextOwner.process(leased.id);
	assert.equal(intents(leased.id)[0]?.status, "dropped");
	assert.ok(pending(leased.id).generation > old.generation);
	assert.equal(owner.claimIntent(old.id, () => true), null);
	assert.ok(nextOwner.claimIntent(pending(leased.id).id, () => true));
});

it("sees concurrent reservations, settles against the unchanged request ledger and preserves usage across restart", async () => {
	const goal = await create({ budget: { maxCostUsd: 1 } });
	const otherDb = new Db(t.core.paths.dbFile);
	try {
		const other = new GoalScheduler(Object.create(t.core, { db: { value: otherDb } }) as Core);
		const [accepted, refused] = await Promise.all([
			Promise.resolve().then(() => scheduler().reserve(goal.id, { id: "charge-1", kind: "main", costUsd: 0.7, runId: "r1", inputTokens: 20 })),
			Promise.resolve().then(() => other.reserve(goal.id, { id: "charge-2", kind: "subagent", costUsd: 0.4 })),
		]);
		assert.equal(accepted.ok, true);
		assert.deepEqual(refused, { ok: false, reason: "budget_cost" });
	} finally { otherDb.close(); }
	assert.equal((await get(goal.id)).budgetStatus.reserved.costUsd, 0.7);
	assert.equal((await get(goal.id)).reason, "budget_cost");
	await assert.rejects(control(goal.id, "resume"), { code: "conflict" });
	request("req-1", 0.4, "r1");
	const receipt = scheduler().settle("charge-1", "req-1");
	assert.equal(receipt.cost, 0.4);
	assert.equal(receipt.requestId, "req-1");
	assert.deepEqual(scheduler().settle("charge-1", "req-1"), receipt);
	assert.equal(t.core.db.get<{ amount: number }>("SELECT amount FROM request_ledger WHERE id='req-1'")?.amount, 0.4);
	await t.core.call("goals.budget", { id: goal.id, budget: { maxCostUsd: 1.2 }, operationId: "raised" });
	assert.equal((await get(goal.id)).status, "paused");
	t = await t.reopen();
	const reloaded = await get(goal.id);
	assert.equal(reloaded.budgetStatus.used.costUsd, 0.4);
	assert.equal(reloaded.budgetStatus.used.tokens, 13);
	assert.equal(reloaded.budgetStatus.reserved.costUsd, 0);
	assert.ok(Math.abs(reloaded.budgetStatus.remaining.costUsd - 0.8) < 1e-9);
	assert.equal((await t.core.call("goals.ledger", { id: goal.id }) as unknown[]).length, 1);
	await control(goal.id, "resume");
	assert.equal((await get(goal.id)).status, "queued");
	assert.ok(scheduler().reserve(goal.id, { id: "at-cap", kind: "main", costUsd: 0.1, runId: "r2" }).ok);
	request("actual-over-cap", 1, "r2");
	scheduler().settle("at-cap", "actual-over-cap");
	assert.equal((await get(goal.id)).reason, "budget_cost");
});

it("preserves stop intent across restart and prevents a cancelled goal from being revived", async () => {
	const paused = await create();
	const cancelled = await create();
	await control(paused.id, "pause", "pause-once");
	await control(cancelled.id, "cancel");
	t = await t.reopen();
	await control(paused.id, "pause", "pause-once");
	assert.deepEqual([(await get(paused.id)).status, (await get(paused.id)).stopIntent], ["paused", "pause"]);
	finish(scheduler(), cancelled, "old-after-cancel", true);
	assert.deepEqual([(await get(cancelled.id)).status, (await get(cancelled.id)).stopIntent], ["cancelled", "cancel"]);
	assert.ok(intents(cancelled.id).every(i => i.status === "dropped"));
});

it("emergency drops pending intents and requires clear and explicit resume", async () => {
	const a = await create(), b = await create();
	const old = pending(a.id).id;
	await control(undefined, "emergency", "emergency-button");
	assert.deepEqual((await t.core.call("goals.list", {}) as Goal[]).map(row => row.stopIntent), ["emergency", "emergency"]);
	assert.ok([...intents(a.id), ...intents(b.id)].every(i => i.status === "dropped"));
	assert.equal(scheduler().claimIntent(old, () => true), null);
	t = await t.reopen();
	await assert.rejects(control(a.id, "resume"), { code: "conflict" });
	await control(undefined, "clear_emergency");
	assert.equal((await get(a.id)).status, "paused");
	await control(a.id, "resume");
	assert.ok(scheduler().claimIntent(pending(a.id).id, () => true));
	assert.equal((await get(b.id)).status, "paused");
});

it("pauses an unclaimed intention on restart and reconciles only linked request facts", async () => {
	const goal = await create();
	const old = pending(goal.id).id;
	request("known", 0.25);
	assert.ok(scheduler().reserve(goal.id, { id: "known-hold", kind: "memory", requestId: "known", costUsd: 0.3 }).ok);
	assert.ok(scheduler().reserve(goal.id, { id: "unknown-hold", kind: "memory", costUsd: 0.5 }).ok);
	t = await t.reopen();
	const restored = await get(goal.id);
	assert.deepEqual([restored.status, restored.reason], ["paused", "restart_check"]);
	assert.equal(restored.budgetStatus.used.costUsd, 0.25);
	assert.equal(restored.budgetStatus.reserved.costUsd, 0.5);
	assert.equal(scheduler().claimIntent(old, () => true), null);
	assert.deepEqual(intents(goal.id).map(row => row.status), ["dropped"]);
});

it("imports an active goal as paused and keeps goal rows, budgets and workspace paths", async () => {
	const target = await startTestCore();
	try {
		const goal = await create();
		t.core.db.run("UPDATE goals SET status='running' WHERE id=?", goal.id); // T-99 state represented in a backup.
		request("backed-up", 0.2);
		assert.ok(scheduler().reserve(goal.id, { id: "backed-up-hold", kind: "main", costUsd: 0.25 }).ok);
		scheduler().settle("backed-up-hold", "backed-up");
		const file = join(t.dir, "goals.dfbackup");
		await createBackup({ paths: t.core.paths, agentDir: t.agentDir, sessionsDir: t.sessionDir, db: t.core.db.raw, appVersion: "0.8.3" },
			{ out: file, kind: "manual", credentials: "none", includeMaterials: false });
		const stage = await stageBackup(file, { paths: target.core.paths, agentDir: target.agentDir, sessionsDir: target.sessionDir, appVersion: "0.8.3" },
			{ parts: target.core.backupParts, workspaces: [{ from: t.workspace, to: target.workspace }] });
		const db = new Db(join(stage.dir, "raw", "data", "appdata", "core.db"));
		try {
			const row = db.get<{ status: string; reason: string; scope: string }>("SELECT status,reason,scope FROM goals WHERE id=?", goal.id);
			assert.deepEqual([row?.status, row?.reason, JSON.parse(row!.scope).cwd], ["paused", "imported", target.workspace]);
			assert.equal(db.get<{ cost: number }>("SELECT cost FROM goal_ledger WHERE id='backed-up-hold'")?.cost, 0.2);
			assert.equal(db.get("SELECT 1 FROM goal_intents WHERE goal_id=? AND status='pending'", goal.id), undefined);
		} finally { db.close(); }
	} finally { await target.cleanup(); }
});

it("tasks publish only goal-linked completions, keep their attempt count, and launch no continuation", async () => {
	const goal = await create({ spec: { objective: "一轮后验收" } });
	const tasks = t.core.module(TasksModule)!;
	const normal = tasks.create({ cwd: t.workspace, goal: "普通任务", source: "chat" });
	const linked = tasks.create({ cwd: t.workspace, goal: "目标的一步", source: "chat", goalId: goal.id });
	assert.equal(Object.hasOwn(normal, "goalId"), false);
	for (const task of [normal, linked]) {
		const slot = await t.core.openSlot({ cwd: t.workspace, taskId: task.id, client: t.client });
		t.respond(fauxAssistantMessage("这一步已完成"));
		await t.send(slot.slotId, { id: task.id, type: "prompt", message: task.goal });
		await t.waitFor(() => t.records(slot.slotId).some(r => r.type === "agent_settled"));
	}
	assert.equal(tasks.get(normal.id)?.status, "done");
	assert.equal(Object.hasOwn(tasks.get(normal.id)!, "attempt"), false);
	assert.equal(tasks.get(linked.id)?.attempt, 1);
	const state = await get(goal.id);
	assert.equal(state.status, "reviewing");
	assert.equal(state.currentTaskId, linked.id);
	assert.equal(state.recentEvents.filter(e => e.kind === "run.finished").length, 1);
	assert.equal(t.core.db.get<{ n: number }>("SELECT count(*) n FROM goal_events WHERE kind='run.finished'")?.n, 1);
	assert.equal(t.core.sessionSlots().length, 2);
	assert.equal(t.faux.state.callCount, 2);
});

it("discards an old completion after revision and preserves the new intent", async () => {
	const first = await create();
	const revised = await t.core.call("goals.update", { id: first.id, spec: { objective: "改按日期整理" } }) as Detail;
	const valid = pending(first.id);
	const stale = finish(scheduler(), first, "old-revision", true);
	assert.notEqual(stale.handledAt, null);
	assert.equal((await get(first.id)).status, "queued");
	assert.equal(pending(first.id).id, valid.id);
	assert.equal(valid.revision, revised.revision);
});
