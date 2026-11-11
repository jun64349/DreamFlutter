import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { createBackup } from "../src/backup/export.ts";
import { stageBackup } from "../src/backup/restore.ts";
import { Db } from "../src/db.ts";
import { CHECKPOINT_NOT_AUTHORITY } from "../src/agent/harness.ts";
import { GoalsModule, type GoalScheduler } from "../src/modules/goals.ts";
import { JobsModule } from "../src/modules/jobs.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

type Detail = ReturnType<GoalScheduler["detail"]>;
let t: TestCore;
beforeEach(async () => {
	t = await startTestCore();
	t.core.settings.update({ approvalMode: "off" });
});
afterEach(async () => { await t.cleanup(); });
const goals = () => t.core.module(GoalsModule)!;
const get = (id: string) => goals().scheduler.detail(id);
const create = (extra: Record<string, unknown> = {}) => t.core.call("goals.create", {
	title: "核对样例", originText: "请核对合成材料。", mandateRef: "user:t105",
	scope: { cwd: t.workspace }, spec: { objective: "核对材料" }, ...extra,
}) as Promise<Detail>;
const until = (id: string, condition: (goal: Detail) => boolean) =>
	t.waitFor(() => { const current = get(id); return condition(current) && current; }, 5000);
const done = () => fauxAssistantMessage("[目标已完成]\n已核对");
const review: FauxResponseFactory = context => {
	const raw = context.messages.at(-1)?.content;
	const { revision, evidence_version } = JSON.parse(typeof raw === "string" ? raw : raw?.map(part => "text" in part ? part.text : "").join("") ?? "");
	return fauxAssistantMessage(JSON.stringify({ verdict: "done", revision, evidence_version, next: "", missing: [], questions: [] }));
};

it("keeps a cancelled goal cancelled in a staged backup import", async () => {
	goals().executor.stop();
	const goal = await create();
	await t.core.call("goals.control", { id: goal.id, action: "cancel" });
	assert.equal(get(goal.id).status, "cancelled");
	const file = join(t.dir, "cancelled.dfbackup");
	await createBackup({ paths: t.core.paths, agentDir: t.agentDir, sessionsDir: t.sessionDir, db: t.core.db.raw, appVersion: "0.8.3" },
		{ out: file, kind: "manual", credentials: "none", includeMaterials: false });
	const target = await startTestCore();
	try {
		const stage = await stageBackup(file, { paths: target.core.paths, agentDir: target.agentDir, sessionsDir: target.sessionDir, appVersion: "0.8.3" },
			{ parts: target.core.backupParts, workspaces: [{ from: t.workspace, to: target.workspace }] });
		const db = new Db(join(stage.dir, "raw", "data", "appdata", "core.db"));
		try {
			const restored = db.get<{ status: string; stop_intent: string }>("SELECT status,stop_intent FROM goals WHERE id=?", goal.id);
			assert.deepEqual([restored?.status, restored?.stop_intent], ["cancelled", "cancel"]);
			assert.equal(db.get("SELECT 1 FROM goal_intents WHERE goal_id=? AND status='pending'", goal.id), undefined);
		} finally { db.close(); }
	} finally { await target.cleanup(); }
});

it("uses the corrected goal constraints after a saved checkpoint", async () => {
	const slot = await t.core.openSlot({ cwd: t.workspace, client: t.client });
	t.respond(fauxAssistantMessage("记下了"), fauxAssistantMessage("准备材料"));
	await t.send(slot.slotId, { id: "old", type: "prompt", message: "旧要求 OLD-105：改写原件" });
	await t.waitFor(() => settledCount(t.records(slot.slotId)) === 1);
	await t.send(slot.slotId, { id: "kept", type: "prompt", message: "准备核对材料" });
	await t.waitFor(() => settledCount(t.records(slot.slotId)) === 2);
	const manager = slot.session.sessionManager;
	const kept = manager.getBranch().find(entry => entry.type === "message" && JSON.stringify(entry.message).includes("准备核对材料"))!;
	const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	manager.appendCompaction("## Primary Request and Intent\n旧要求 OLD-105：改写原件", kept.id, 1000, undefined, false, usage);
	slot.session.agent.state.messages = manager.buildSessionContext().messages;
	goals().executor.stop();
	const goal = await create({ slotId: slot.slotId, spec: { objective: "核对材料", constraints: [{ text: "OLD-105：改写原件", kind: "must" }] } });
	await t.core.call("goals.update", { id: goal.id, spec: { constraints: [{ text: "NEW-105：保留原件，只读", kind: "must" }] } });
	let messages: unknown[] | undefined;
	t.respond(context => { messages = context.messages; return done(); }, review);
	goals().executor.start();
	await until(goal.id, current => current.completed);
	const rendered = messages!.map(message => JSON.stringify(message));
	assert.ok(rendered.some(message => message.includes("OLD-105") && message.includes(CHECKPOINT_NOT_AUTHORITY)));
	const current = rendered.find(message => message.includes("当前目标、约束和验收项"));
	assert.match(current ?? "", /NEW-105/);
	assert.doesNotMatch(current!, /OLD-105/);
	assert.equal(get(goal.id).revision, 2);
});

it("keeps ordinary workbench chat out of goals, events and goal-linked tasks", async () => {
	const slot = await t.core.openSlot({ cwd: t.workspace, client: t.client });
	t.respond(fauxAssistantMessage("下午好！"));
	await t.send(slot.slotId, { id: "greeting", type: "prompt", message: "下午好" });
	await t.waitFor(() => settledCount(t.records(slot.slotId)) === 1);
	assert.ok(slot.session.messages.some(message => JSON.stringify(message).includes("下午好！")));
	for (const sql of ["SELECT 1 FROM goals", "SELECT 1 FROM goal_events", "SELECT 1 FROM tasks WHERE goal_id IS NOT NULL"]) {
		assert.equal(t.core.db.get(sql), undefined);
	}
});

it("does not create another run, review or notification for a replayed completion", async () => {
	t.respond(done(), review);
	const goal = await create();
	const complete = await until(goal.id, current => current.completed);
	await t.waitFor(() => t.notifier.sent.some(note => note.title === "目标已完成"));
	const event = complete.recentEvents.find(item => item.kind === "run.finished")!;
	const facts = () => ({
		runs: t.core.db.get("SELECT count(*) n FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.goal_id=?", goal.id),
		events: t.core.db.get("SELECT count(*) n FROM goal_events WHERE goal_id=? AND kind='run.finished'", goal.id),
		reviews: t.core.db.get("SELECT count(*) n FROM goal_reviews WHERE goal_id=?", goal.id),
		notices: t.notifier.sent.filter(note => note.title === "目标已完成").length,
	});
	const before = facts();
	goals().scheduler.post(goal.id, "run.finished", event.dedupeKey, event.payload);
	assert.deepEqual(goals().scheduler.pendingIntents().filter(intent => intent.goal_id === goal.id), []);
	assert.deepEqual(facts(), before);
	assert.equal(before.notices, 1);
	assert.equal(get(goal.id).completed, true);
});

it("gives pending user input priority over a queued continuation", async () => {
	const slot = await t.core.openSlot({ cwd: t.workspace, client: t.client });
	t.respond(fauxAssistantMessage("你好"), done(), review);
	await t.send(slot.slotId, { id: "opening", type: "prompt", message: "你好" });
	await t.waitFor(() => settledCount(t.records(slot.slotId)) === 1);
	const goal = await create({ slotId: slot.slotId });
	const intent = goals().scheduler.pendingIntents().find(item => item.goal_id === goal.id)!;
	await t.send(slot.slotId, { id: "insertion", type: "prompt", message: "先按我这句处理" });
	await until(goal.id, current => current.completed);
	assert.equal(t.core.db.get<{ status: string }>("SELECT status FROM goal_intents WHERE id=?", intent.id)?.status, "dropped");
	assert.match(t.core.db.get<{ prompt: string }>("SELECT prompt FROM runs ORDER BY rowid DESC LIMIT 1")?.prompt ?? "", /先按我这句处理/);
});

it("does not repeatedly review while a child is still running", async () => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	t.respond(fauxAssistantMessage([fauxToolCall("agent", { description: "核对样例", prompt: "读取材料" })], { stopReason: "toolUse" }),
		async () => { await gate; return fauxAssistantMessage("子任务结束"); }, done(), review);
	const goal = await create({ scope: { cwd: t.workspace, allowedTools: ["agent", "read"] }, budget: { maxParallel: 3 } });
	try {
		await until(goal.id, current => current.waits.some(wait => wait.kind === "compute"));
		for (let count = 0; count < 3; count++) goals().scheduler.tickWaits();
		assert.ok(get(goal.id).waits.some(wait => wait.kind === "compute"));
		assert.equal(t.core.db.get("SELECT 1 FROM goal_reviews WHERE goal_id=? AND layer='model'", goal.id), undefined);
		release();
		await until(goal.id, current => current.completed);
	} finally { release(); }
});

it("keeps an idle goal in waiting_dependency until its tracked child ends", async () => {
	goals().executor.stop();
	const goal = await create();
	t.core.db.run(`INSERT INTO jobs(id,slot_id,cwd,sandboxed,kind,label,status,started_at,goal_id,goal_revision)
		VALUES('t105-child','fixture',?,0,'subagent','子任务夹具','running',?,?,1)`, t.workspace, Date.now(), goal.id);
	goals().scheduler.jobChanged("t105-child");
	for (let count = 0; count < 3; count++) goals().scheduler.tickWaits();
	assert.equal(get(goal.id).status, "waiting_dependency");
	assert.equal(get(goal.id).waits[0]?.ref, "t105-child");
	assert.deepEqual(goals().scheduler.pendingIntents().filter(intent => intent.goal_id === goal.id), []);
	assert.equal(t.core.db.get("SELECT 1 FROM goal_reviews WHERE goal_id=?", goal.id), undefined);
	t.core.db.run("UPDATE jobs SET status='completed',ended_at=? WHERE id='t105-child'", Date.now());
	goals().scheduler.jobChanged("t105-child");
	assert.equal(get(goal.id).status, "queued");
	assert.equal(goals().scheduler.pendingIntents().filter(intent => intent.goal_id === goal.id && intent.action === "run").length, 1);
});

it("lists a live service without adding a blocking dependency", async () => {
	const command = "Start-Sleep -Seconds 30";
	t.respond(fauxAssistantMessage([fauxToolCall("pwsh", { command, description: "本地服务夹具", run_in_background: true, service: true })],
		{ stopReason: "toolUse" }), done(), review);
	const goal = await create({ scope: { cwd: t.workspace, externalActions: [{ tool: "pwsh", command }] } });
	const finished = await until(goal.id, current => current.completed);
	assert.equal(finished.services.length, 1);
	assert.equal(finished.waits.length, 0);
	await t.core.call("jobs.stop", { id: finished.services[0]!.id });
});

it("pauses a waiting goal with a reason after restart loses its job", async () => {
	goals().executor.stop();
	const goal = await create();
	t.core.db.run(`INSERT INTO jobs(id,slot_id,cwd,sandboxed,kind,label,status,started_at,goal_id,goal_revision)
		VALUES('t105-lost','fixture',?,0,'pwsh','测试夹具','running',?,?,1)`, t.workspace, Date.now(), goal.id);
	goals().scheduler.jobChanged("t105-lost");
	goals().scheduler.recover();
	assert.equal(get(goal.id).status, "waiting_dependency");
	t.core.module(JobsModule)!.start();
	const after = get(goal.id);
	assert.deepEqual([after.status, after.reason], ["paused", "restart_check"]);
	assert.match(after.resumeWhen ?? "", /作业已经不在了/);
});
