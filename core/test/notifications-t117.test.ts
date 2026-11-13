import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { applyPendingRestore } from "../src/backup/switch.ts";
import { Db } from "../src/db.ts";
import { type Notice } from "../src/notify.ts";
import { GoalsModule } from "../src/modules/goals.ts";
import { recordGoalNotice } from "../src/modules/goals/notices.ts";
import { localDay } from "../src/modules/session-index.ts";
import { startTestCore, type TestCore } from "./harness.ts";

type Metric = {
	day: string; quietSuppressed: number; duplicateSuppressed: number;
	blockedNotifications: { key: string; objectRef: string; count: number }[];
	followUpsByDelivery: { goalId: string; count: number }[];
};
let t: TestCore;
let at: number;
beforeEach(async () => {
	at = Date.now();
	t = await startTestCore(undefined, { personaClock: () => at });
	t.core.settings.update({ patrolQuietEnabled: false });
});
afterEach(async () => { await t.cleanup(); });

function sandbox(): void {
	t.core.sandboxProvider = () => ({ distro: "df-t117-fake", ready: async () => {}, online: () => false });
	const resolve = t.core.resolveModel;
	t.core.resolveModel = model => {
		const resolved = resolve(model);
		return resolved.provider === "faux" ? { ...resolved, cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } } : resolved;
	};
}
function notice(key: string, extra: Partial<Notice> = {}): Notice {
	return { key, category: "blocked", objectRef: "资料整理", object: "资料整理", situation: "遇到阻塞",
		impact: "3 条来源待你确认", action: "查看争议", target: { page: "attention", itemId: key }, ...extra };
}
function send(key: string, extra: Partial<Notice> = {}) {
	return t.core.notifications.send(notice(key, extra), { at });
}
function row(key: string) {
	return t.core.db.get<{ state: string; attempts: number; reason: string | null }>("SELECT state,attempts,reason FROM notification_receipts WHERE key=?", key);
}
async function metrics(days = 30): Promise<Metric[]> { return t.core.call("attention.metrics", { days }) as Promise<Metric[]>; }

it("T117 delivers one structured notification per state key, including after restart", async () => {
	const [one, duplicate] = await Promise.all([send("issue:block"), send("issue:block")]);
	assert.equal(one.state, "sent");
	assert.equal(duplicate.reason, "duplicate");
	assert.deepEqual(t.notifier.sent, [{ title: "资料整理 · 遇到阻塞", body: "3 条来源待你确认\n查看争议 · 等你处理" }]);
	assert.equal(row("issue:block")?.attempts, 1);
	assert.equal(t.faux.state.callCount, 0);
	t = await t.reopen();
	assert.equal((await send("issue:block", { impact: "只有进度有一点变化" })).reason, "duplicate");
	assert.deepEqual(t.notifier.sent, []);
	await send("issue:done", { category: "done", situation: "已生成", action: "打开结果", target: { page: "butterfly" } });
	assert.equal(t.notifier.sent.length, 1);
	const today = (await metrics(1))[0]!;
	assert.equal(today.duplicateSuppressed, 2);
	assert.deepEqual(today.blockedNotifications, [{ key: "issue:block", objectRef: "资料整理", count: 1 }]);
});

it("T117 keeps muted and non-queued quiet notices silent and resumes only the owner's original queue", async () => {
	t.core.settings.update({ notifications: false });
	assert.equal((await send("off")).reason, "notifications_disabled");
	t.core.settings.update({ notifications: true, patrolQuietEnabled: true, patrolQuietStart: "23:00", patrolQuietEnd: "07:00" });
	const night = new Date(at);
	night.setDate(night.getDate() - 1);
	night.setHours(23, 0, 0, 0);
	at = night.getTime();
	assert.equal((await send("night")).reason, "quiet_hours");
	for (const _ of [0, 1]) t.core.notifications.deferQuiet(notice("queued"), at);
	t.core.notifications.deferQuiet(notice("queued-then-off"), at);
	assert.equal(row("queued")?.state, "queued");
	t.core.settings.update({ notifications: false });
	assert.equal(row("queued-then-off")?.state, "muted");
	t.core.settings.update({ notifications: true });
	// The already muted queues do not revive. A later independent queue keeps its owner.
	t.core.notifications.deferQuiet(notice("still-queued"), at);
	const quiet = (await metrics(2)).find(day => day.day === localDay(at))!;
	assert.equal(quiet.quietSuppressed, 4);
	const morning = new Date(at);
	morning.setDate(morning.getDate() + 1);
	morning.setHours(7, 0, 0, 0);
	at = morning.getTime();
	for (const key of ["off", "night", "queued", "queued-then-off"]) assert.equal((await send(key)).state, "muted");
	assert.equal((await send("still-queued")).state, "sent");
	assert.equal(t.notifier.sent.length, 1);
});

it("T117 ignores a renewed blockage lease, preserves pre-upgrade receipts and allows a real state change", async () => {
	const goal = await t.core.call("goals.create", { title: "资料整理", originText: "资料整理", mandateRef: "user:t117" }) as { id: string };
	const block = (generation: number) => `notify:${goal.id}:1:blocked:${generation}:missing_input`;
	recordGoalNotice(t.core.db, goal.id, block(1), "goal", "sent", at);
	assert.equal((await send(block(2), { objectRef: goal.id })).reason, "duplicate");
	recordGoalNotice(t.core.db, goal.id, `notify:${goal.id}:1:budget:1:budget_cost`, "goal", "muted", at);
	assert.equal((await send(`notify:${goal.id}:1:budget:2:budget_cost`, { objectRef: goal.id })).state, "muted");
	assert.equal(t.notifier.sent.length, 0);
	const later = (generation: number) => `notify:${goal.id}:2:blocked:${generation}:missing_input`;
	assert.equal((await send(later(4), { objectRef: goal.id })).state, "sent");
	assert.equal((await send(later(5), { objectRef: goal.id, impact: "进度刚更新" })).reason, "duplicate");
	await send(`notify:${goal.id}:2:completed`, { category: "done", objectRef: goal.id, situation: "已完成" });
	assert.equal(t.notifier.sent.length, 2);
});

it("T117 keeps the T-112 failed native fallback and treats uncertain delivery as non-replayable", async () => {
	let fail = true;
	Object.defineProperty(t.notifier, "deliver", { value: async (title: string, body: string) => {
		if (fail) return "undelivered";
		t.notifier.notify(title, body);
		return "delivered";
	} });
	assert.equal((await send("native-failure")).state, "failed");
	assert.equal(t.core.notifications.maySupplement("native-failure"), true);
	fail = false;
	await t.core.notifications.send(notice("patrol-batch"), { at, related: [notice("native-failure")] });
	assert.equal(row("native-failure")?.state, "sent");
	assert.equal(row("native-failure")?.attempts, 2);
	assert.equal(t.core.notifications.maySupplement("native-failure"), false);
	t.core.db.run("INSERT INTO notification_receipts(key,category,state,attempts,created_at) VALUES('interrupted','blocked','queued',1,?)", at);
	t = await t.reopen();
	assert.equal(row("interrupted")?.reason, "interrupted");
	assert.equal(t.core.notifications.maySupplement("interrupted"), false);
	assert.equal((await send("interrupted")).reason, "duplicate");
	assert.deepEqual(t.notifier.sent, []);
});

it("T117 lets explicit human acceptance notify, keeps general review quiet and suppresses duplicate proactive chat", async () => {
	sandbox();
	t.core.settings.update({ butterflyPersona: "lively" });
	const center = t.core.notifications;
	assert.equal((await send("review", { category: "review" })).reason, "review_only");
	assert.equal((await center.send(notice("human-review", { category: "review" }), { at, humanReview: true })).state, "sent");
	const slot = await t.core.openSlot({ cwd: t.core.paths.butterflyDir, sandbox: true, client: t.client });
	t.respond(fauxAssistantMessage("你好。"));
	await slot.prompt("你好，蝶君");
	await t.waitFor(() => t.records(slot.slotId).some(record => record.type === "agent_settled"));
	await send("report:done", { category: "done", objectRef: "report-identity" });
	const previous = t.faux.state.callCount;
	assert.deepEqual(await t.core.persona.proactive.request({ reason: "换个说法也还是这一件事", refId: "report-identity" }),
		{ ok: false, reason: "already_notified" });
	assert.equal(t.faux.state.callCount, previous);
	assert.ok(!t.records(slot.slotId).some(record => (record.message as { dfProactiveRef?: string } | undefined)?.dfProactiveRef === "report-identity"));
	t.respond(fauxAssistantMessage("这是一件新事。"));
	assert.equal((await t.core.persona.proactive.request({ reason: "这是真正的新发现", refId: "different-topic" })).ok, true);
});

it("T117 ranks the existing attention sources and supplies truthful notification state", async () => {
	const module = t.core.module(GoalsModule)!;
	module.executor.stop();
	const create = (title: string) => t.core.call("goals.create", { title, originText: title, mandateRef: "user:t117" }) as Promise<{ id: string }>;
	const review = await create("检查交付物");
	const blocked = await create("缺原始记录");
	t.core.db.run("UPDATE goals SET status='waiting_user',reason='acceptance',updated_at=? WHERE id=?", at - 10, review.id);
	t.core.db.run("INSERT INTO goal_approvals(id,goal_id,revision,kind,status,payload,created_at) VALUES('human-review',?,1,'acceptance','pending','{}',?)", review.id, at);
	t.core.db.run("UPDATE goals SET status='blocked',reason='missing_input',resume_when='补齐原始记录',updated_at=? WHERE id=?", at - 20, blocked.id);
	await send(`notify:${blocked.id}:1:blocked:0:missing_input`, { objectRef: blocked.id });
	const slot = await t.core.openSlot({ cwd: t.workspace, client: t.client });
	const answer = slot.ui.context().confirm("批准操作", "修改报告？");
	try {
		const existing = await t.core.call("attention.list", {}) as { now: { id: string }[] };
		assert.equal(existing.now.some(item => item.id === `goal_blocked:${blocked.id}`), false);
		const sorted = await t.core.call("attention.prioritized", {}) as { category: string; object: string; occurredAt: number; actions: string[]; notified: boolean }[];
		assert.deepEqual(sorted.map(item => item.category), ["decision", "blocked", "review"]);
		assert.deepEqual(sorted[1], { ...sorted[1], object: "缺原始记录", occurredAt: at - 20, actions: ["open"], notified: true });
		assert.equal(sorted[2]!.notified, false);
	} finally { slot.ui.cancelAll(); await answer; }
});

it("T117 gives a durable queued goal notice precedence without marking it as delivered", async () => {
	const module = t.core.module(GoalsModule)!;
	module.executor.stop();
	const goal = await t.core.call("goals.create", { title: "即将通知的交付", originText: "即将通知的交付", mandateRef: "user:t117" }) as { id: string };
	const key = `notify:${goal.id}:1:completed`;
	t.core.db.run("UPDATE goals SET status='completed',ended_at=? WHERE id=?", at, goal.id);
	t.core.db.run(`INSERT INTO goal_intents(id,goal_id,revision,generation,idem_key,action,status,reason,created_at)
		VALUES('queued-notice',?,1,0,?,'notify','pending','completed',?)`, goal.id, key, at);
	recordGoalNotice(t.core.db, goal.id, key, "goal", "queued", at);
	assert.equal(t.core.notifications.topicNotified(goal.id), false);
	assert.deepEqual(await t.core.persona.proactive.request({ reason: "交付已经完成", refId: goal.id }), { ok: false, reason: "already_notified" });
	assert.equal(t.faux.state.callCount, 0);
	assert.deepEqual(t.notifier.sent, []);
});

it("T117 counts actual T-115 follow-ups by delivery without counting transport retries or normal chat", async () => {
	sandbox();
	t.core.module(GoalsModule)!.executor.stop();
	const slot = await t.core.openSlot({ cwd: t.core.paths.butterflyDir, sandbox: true, client: t.client });
	const prompt = (id: string, message: string) => t.send(slot.slotId, { id, type: "prompt", message });
	await prompt("assignment", "请先核对给定资料，再汇总，最后交付 report.md。");
	const [task] = await t.core.call("butterfly.chat.tasks", { sessionFile: slot.session.sessionFile }) as { goalId: string }[];
	assert.ok(task);
	await prompt("progress-1", "做到哪了");
	await prompt("progress-1", "做到哪了");
	await prompt("progress-2", "还要多久");
	t.respond(fauxAssistantMessage("普通回答"));
	await prompt("ordinary", "你好呀");
	await t.waitFor(() => t.records(slot.slotId).some(record => record.type === "agent_settled"));
	assert.equal((await metrics(100)).length, 30);
	assert.deepEqual((await metrics(1))[0]!.followUpsByDelivery, [{ goalId: task.goalId, count: 2 }]);
	t = await t.reopen();
	assert.deepEqual((await metrics(1))[0]!.followUpsByDelivery, [{ goalId: task.goalId, count: 2 }]);
});

it("T117 preserves delivery identity and attention counts in a restored backup", async () => {
	await send("backup-key");
	await send("backup-key");
	const archive = join(t.dir, "notice-test.dfbackup");
	type Job = { id: string; status: string };
	async function job(core: TestCore, method: string, params: Record<string, unknown>) {
		const start = await core.core.call(method, params) as Job;
		const completed = await core.waitFor(() => core.messages.map(event => event.job as Job | undefined)
			.find(item => item?.id === start.id && ["done", "failed", "cancelled"].includes(item.status)), 30_000);
		assert.equal(completed.status, "done");
	}
	await job(t, "backup.export", { path: archive, kind: "manual", credentials: "none" });
	const target = await startTestCore();
	try {
		await job(target, "backup.stage", { path: archive });
		await job(target, "backup.apply", {});
		const paths = target.core.paths;
		await target.core.shutdown();
		assert.equal(applyPendingRestore(paths)?.ok, true);
		const db = new Db(paths.dbFile);
		try {
			assert.equal(db.get<{ state: string }>("SELECT state FROM notification_receipts WHERE key='backup-key'")?.state, "sent");
			assert.equal(db.get<{ duplicate_suppressed: number }>("SELECT duplicate_suppressed FROM notification_metrics WHERE day=?", localDay(at))?.duplicate_suppressed, 1);
		} finally { db.close(); }
	} finally { await target.cleanup(); }
});
