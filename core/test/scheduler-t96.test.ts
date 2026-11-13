import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, it, mock, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { RpcError, type Client } from "../src/core.ts";
import type { ActionReceipt, AttentionItem } from "../src/modules/attention.ts";
import { SchedulerModule, type Schedule, type ScheduleRun } from "../src/modules/scheduler.ts";
import { MIGRATIONS } from "../src/schema.ts";
import type { Slot } from "../src/slots/slot.ts";
import { startTestCore, type TestCore } from "./harness.ts";

const MINUTE = 60_000;
const DAY = 86_400_000;
const MORNING = Date.UTC(2026, 10, 11, 1, 1); // 09:01 in Taipei
const NOON = Date.UTC(2026, 10, 11, 4);
const daily = { type: "cron", cron: "0 9,12,15,18 * * *", timezone: "Asia/Taipei" };
const interval = { type: "interval", everyMs: 30 * MINUTE };

type ScheduleView = Schedule & { everyDay: { times: string[] } | { everyMs: number } | null; describe: string };
type RunView = ScheduleRun & { deliveries: { status: string; channel: string }[] };
type Change = { id: string; actor: string; reason: string; status: string; before: Schedule | null; after: Schedule | null; summary: string; undoneAt: number | null; versionAfter: number };
type Occurrences = { items: { scheduleId: string; at: number; status: string; runId: string | null; result: string | null }[]; schedules: ScheduleView[] };
type ToolResult = { content: { text: string }[]; details: { scheduleId?: string; action?: string; line?: string; items?: ScheduleView[] } };

let t: TestCore;
let now: number;
beforeEach(async () => {
	t = await startTestCore();
	now = MORNING;
	mock.method(t.core.module(SchedulerModule)!, "clock", () => now);
});
afterEach(async () => {
	mock.restoreAll();
	await t.cleanup();
});

async function save(p: Record<string, unknown> = {}) {
	return await t.core.call("schedules.save", { name: "提醒吃药", kind: "reminder", trigger: daily, ...p }) as ScheduleView;
}
async function get(id: string) {
	return await t.core.call("schedules.get", { id }) as ScheduleView & { runs: RunView[] };
}
async function history(id: string) {
	return await t.core.call("schedules.history", { id }) as Change[];
}
async function occurrences(from: number, to: number, everyDay?: boolean) {
	return await t.core.call("schedules.occurrences", { from, to, everyDay }) as Occurrences;
}
async function openButterfly() {
	t.core.sandboxProvider = () => ({ distro: "df-t96-test", ready: async () => {}, online: () => false });
	return t.core.openSlot({ cwd: t.core.paths.butterflyDir, sandbox: true, client: t.client });
}
let requestNumber = 0;
async function tool(slot: Slot, name: string, params: Parameters<typeof fauxToolCall>[1]) {
	const id = `test-tool-${++requestNumber}`;
	let client!: Client;
	const settled = new Promise<void>((resolve, reject) => {
		client = t.core.addClient(message => {
			if (message.event !== "slot.record" || message.slotId !== slot.slotId) return;
			const record = message.record as Record<string, unknown>;
			if (record.type === "agent_settled") resolve();
			if (record.type === "response" && record.id === id && record.success === false) {
				reject(new Error(`${name}: ${String(record.error)}`));
			}
		});
		client.attached.add(slot.slotId);
	});
	t.respond(fauxAssistantMessage([fauxToolCall(name, params, { id })], { stopReason: "toolUse" }), fauxAssistantMessage("已处理"));
	try {
		await Promise.all([
			settled,
			t.send(slot.slotId, { id, type: "prompt", message: "请处理这个日程" }),
		]);
	} finally {
		t.core.removeClient(client);
	}
	const result = [...slot.session.messages].reverse().find(message => message.role === "toolResult" && message.toolCallId === id);
	assert.ok(result, `${name} should produce a tool result`);
	return result as unknown as ToolResult;
}
async function attention() {
	const result = await t.core.call("attention.list", {}) as { now: AttentionItem[]; later: AttentionItem[] };
	return [...result.now, ...result.later].filter(item => item.kind === "schedule_change");
}
async function resolve(ctx: TestContext, id: string, action: "approve" | "reject") {
	ctx.mock.timers.enable({ apis: ["setTimeout"] });
	let receipt: ActionReceipt;
	try {
		receipt = await t.core.call("attention.resolve", { id, action }) as ActionReceipt;
		ctx.mock.timers.tick(5000);
	} finally { ctx.mock.timers.reset(); }
	return await t.waitFor(() => {
		const event = t.messages.find(message => message.event === "attention.action"
			&& (message.receipt as ActionReceipt).id === receipt.id && (message.receipt as ActionReceipt).status !== "pending");
		return event && event.receipt as ActionReceipt;
	});
}

it("delivers a reminder at noon exactly once without a session, task, model request, or cost", async () => {
	const schedule = await save({ prompt: "饭后" });
	assert.equal(schedule.nextRunAt, NOON);
	now = NOON;
	await Promise.all([t.core.call("schedules.tick", { now }), t.core.call("schedules.tick", { now })]);
	const [run, extra] = (await get(schedule.id)).runs;
	assert.equal(extra, undefined);
	assert.deepEqual(t.notifier.sent, [{ title: "提醒", body: "提醒吃药\n饭后" }]);
	assert.deepEqual([run?.status, run?.result, run?.cost, run?.taskId, run?.sessionFile], ["done", "已提醒", 0, null, null]);
	assert.deepEqual(run?.deliveries.map(delivery => [delivery.channel, delivery.status]), [["toast", "delivered"]]);
	assert.equal(t.core.sessionSlots().length, 0);
	assert.equal(t.core.db.get("SELECT 1 FROM tasks WHERE schedule_id = ?", schedule.id), undefined);
	assert.equal(t.core.db.get("SELECT 1 FROM request_ledger"), undefined);
});

it("uses the missed default for new reminders and records undelivered when notifications are off", async () => {
	const skipped = await save({ trigger: { type: "once", at: NOON } });
	assert.equal(skipped.missedPolicy, "skip");
	t.core.settings.update({ scheduleMissedDefault: "latest", notifications: false });
	t.core.settings.update({ scheduleMissedDefault: "invalid" });
	const latest = await save({ trigger: { type: "once", at: NOON } });
	assert.equal(latest.missedPolicy, "latest");
	now = NOON + 5 * MINUTE;
	await t.core.call("schedules.tick", { now });
	assert.equal((await get(skipped.id)).runs[0]?.status, "skipped");
	const [run] = (await get(latest.id)).runs;
	assert.equal(run?.status, "done");
	assert.equal(run?.deliveries[0]?.status, "undelivered");
	assert.deepEqual(t.notifier.sent, []);
});

it("lists daily times and sub-day intervals, and preserves different minutes in one cron schedule", async () => {
	const a = await save();
	const b = await save({ trigger: { ...daily, cron: "0 9 * * 1" } });
	const c = await save({ trigger: interval });
	const mixed = await save({ trigger: { type: "cron", crons: ["10 9 * * *", "20 12 * * *"], timezone: daily.timezone } });
	const rows = await t.core.call("schedules.list", {}) as ScheduleView[];
	assert.deepEqual(rows.find(s => s.id === a.id)?.everyDay, { times: ["09:00", "12:00", "15:00", "18:00"] });
	assert.equal((await get(b.id)).everyDay, null);
	assert.deepEqual((await get(c.id)).everyDay, { everyMs: 30 * MINUTE });
	assert.deepEqual((await get(mixed.id)).everyDay, { times: ["09:10", "12:20"] });
	const { next } = await t.core.call("schedules.preview", { trigger: mixed.trigger }) as { next: number[] };
	assert.deepEqual(next, [MORNING + 9 * MINUTE, NOON + 20 * MINUTE, MORNING + DAY + 9 * MINUTE]);
});

it("returns real past runs and future preview times, with bounds, paused and daily filtering", async () => {
	const a = await save();
	const weekly = await save({ name: "周三", trigger: { ...daily, cron: "0 16 * * 3" } });
	const paused = await save({ name: "暂停", trigger: { type: "once", at: NOON + 2 * 60 * MINUTE } });
	await t.core.call("schedules.setStatus", { id: paused.id, status: "paused", expectedVersion: paused.version });
	now = NOON;
	await t.core.call("schedules.tick", { now });
	now += 60 * MINUTE;
	const { next } = await t.core.call("schedules.preview", { trigger: daily }) as { next: number[] };
	const from = MORNING, to = now + 22 * 60 * MINUTE;
	const all = await occurrences(from, to);
	const past = all.items.find(item => item.scheduleId === a.id && item.status === "done");
	assert.equal(past?.at, NOON);
	assert.equal(past?.runId, (await get(a.id)).runs[0]?.id);
	assert.equal(past?.result, "已提醒");
	assert.deepEqual(all.items.filter(item => item.scheduleId === a.id && item.status === "upcoming").map(item => item.at), next);
	assert.deepEqual(all.items.map(item => item.at), all.items.map(item => item.at).sort((x, y) => x - y));
	assert.deepEqual((await occurrences(from, to, false)).items.map(item => item.scheduleId), [weekly.id]);
	assert.ok(!all.schedules.some(s => s.id === paused.id));
	await assert.rejects(occurrences(from, from + 45 * DAY + 1), { code: "bad_request" });
	await assert.rejects(occurrences(to, from), { code: "bad_request" });
	await t.core.call("schedules.remove", { id: a.id });
	const afterRemoval = await occurrences(from, to);
	assert.ok(afterRemoval.schedules.some(s => s.id === a.id && s.name === a.name));
	assert.deepEqual(afterRemoval.items.filter(item => item.scheduleId === a.id), [past]);
});

it("rejects an update based on the same version another writer already changed", { timeout: 60_000 }, async () => {
	const slot = await openButterfly();
	const created = await tool(slot, "schedule_create", { name: "旧名", kind: "reminder", trigger: "interval", every_minutes: 30 });
	const original = await get(created.details.scheduleId!);
	const first = await t.core.call("schedules.save", { id: original.id, name: "用户先改", expectedVersion: original.version }) as ScheduleView;
	const stale = await tool(slot, "schedule_update", { id: original.id, version: original.version, name: "蝶君后改" });
	assert.match(stale.content[0]!.text, /这件事刚被改过，请先用 schedule_list 重新读一次/);
	for (const [method, params] of [
		["schedules.save", { name: "过期" }], ["schedules.setStatus", { status: "paused" }], ["schedules.remove", {}],
	] as const) {
		await assert.rejects(t.core.call(method, { id: original.id, expectedVersion: original.version, ...params }), error => {
			assert.ok(error instanceof RpcError);
			assert.equal(error.code, "version_conflict");
			assert.equal((error as RpcError & { data: ScheduleView }).data.name, first.name);
			return true;
		});
	}
	assert.equal((await get(original.id)).name, "用户先改");
});

it("records edits and undo, restores a deleted schedule with a new version, and rejects stale undo", async () => {
	const original = await save();
	const first = await t.core.call("schedules.save", { id: original.id, name: "早餐", expectedVersion: original.version }) as ScheduleView;
	const second = await t.core.call("schedules.save", { id: original.id, trigger: interval, expectedVersion: first.version }) as ScheduleView;
	const [latest, earlier, creation] = await history(original.id);
	assert.deepEqual([latest?.versionAfter, earlier?.versionAfter, creation?.summary], [3, 2, "新建"]);
	assert.match(latest!.summary, /把时间从每天 9:00、12:00、15:00、18:00改成每 30 分钟/);
	const undone = await t.core.call("schedules.undo", { changeId: latest!.id }) as ScheduleView;
	assert.equal(undone.name, first.name);
	assert.deepEqual(undone.trigger, first.trigger);
	assert.equal(undone.version, second.version + 1);
	const [undoRow, undoneRow] = await history(original.id);
	assert.equal(undoRow?.actor, "user");
	assert.equal(undoRow?.reason, "undo");
	assert.equal(undoneRow?.undoneAt, now);
	await assert.rejects(t.core.call("schedules.undo", { changeId: earlier!.id }), { code: "version_conflict" });
	await t.core.call("schedules.remove", { id: original.id, expectedVersion: undone.version });
	const [deletion] = await history(original.id);
	assert.equal(deletion?.after, null);
	assert.equal(deletion?.summary, "删除");
	await assert.rejects(get(original.id), { code: "not_found" });
	const restored = await t.core.call("schedules.undo", { changeId: deletion!.id }) as ScheduleView;
	assert.deepEqual([restored.id, restored.name, restored.version], [original.id, first.name, undone.version + 2]);
	await assert.rejects(t.core.call("schedules.undo", { changeId: deletion!.id }), { code: "version_conflict" });
	const newSchedule = await save();
	const [created] = await history(newSchedule.id);
	assert.equal(created?.before, null);
	await t.core.call("schedules.undo", { changeId: created!.id });
	await assert.rejects(get(newSchedule.id), { code: "not_found" });
	assert.ok(t.messages.some(message => message.event === "schedules.changed" && (message.versions as Record<string, number>)?.[original.id] === restored.version && (message.ids as string[])?.includes(original.id)));
});

it("requires approval for changes to a user's schedule, handles rejection and voids a stale approval", { timeout: 60_000 }, async ctx => {
	const user = await save({ name: "晨跑" });
	const slot = await openButterfly();
	const proposed = await tool(slot, "schedule_update", { id: user.id, version: user.version, name: "早起散步" });
	assert.deepEqual(proposed.details, { scheduleId: user.id, action: "proposed", line: "想改你建的「晨跑」，已放进等你处理" });
	assert.equal((await get(user.id)).name, "晨跑");
	const [item] = await attention();
	assert.deepEqual(item?.actions, ["approve", "reject"]);
	assert.equal(item?.origin.role, "butterfly");
	assert.equal((item?.data.before as Schedule)?.name, "晨跑");
	assert.equal((item?.data.after as Schedule)?.name, "早起散步");
	assert.equal(item?.data.summary, "把名称从「晨跑」改成「早起散步」");
	assert.equal((await history(user.id))[0]?.status, "proposed");
	assert.equal((await resolve(ctx, item!.id, "approve")).status, "applied");
	assert.equal((await get(user.id)).name, "早起散步");
	assert.equal((await history(user.id))[0]?.status, "applied");
	assert.deepEqual(await attention(), []);

	await tool(slot, "schedule_remove", { id: user.id, version: user.version + 1 });
	const [removal] = await attention();
	assert.equal(removal?.data.after, null);
	assert.equal((await resolve(ctx, removal!.id, "reject")).status, "applied");
	assert.equal((await get(user.id)).name, "早起散步");
	assert.equal((await history(user.id))[0]?.status, "rejected");

	await tool(slot, "schedule_remove", { id: user.id, version: user.version + 1 });
	const [stale] = await attention();
	await t.core.call("schedules.save", { id: user.id, name: "用户刚改过", expectedVersion: user.version + 1 });
	const failed = await resolve(ctx, stale!.id, "approve");
	assert.equal(failed.status, "failed");
	assert.equal(failed.error, "这件事在你同意前又被改过");
	assert.equal((await get(user.id)).name, "用户刚改过");
	assert.deepEqual(await attention(), []);
});

it("does not offer any schedule_* tools to a workbench conversation", async () => {
	const slot = await t.core.openSlot({ cwd: t.core.paths.butterflyDir });
	assert.ok(!slot.session.getAllTools().some(tool => tool.name.startsWith("schedule_")));
});

it("creates immediately, lists by range and status, edits and removes its own schedule with ready-to-display lines", { timeout: 60_000 }, async () => {
	const slot = await openButterfly();
	const created = await tool(slot, "schedule_create", { name: "提醒吃药", kind: "reminder", trigger: "daily", times: ["9:00", "12:00", "15:00", "18:00"], timezone: daily.timezone });
	const id = created.details.scheduleId!;
	assert.deepEqual(created.details, { scheduleId: id, action: "created", line: "已加入日程：每天 9:00、12:00、15:00、18:00 提醒吃药" });
	const schedule = await get(id);
	assert.deepEqual([schedule.status, schedule.owner, schedule.createdBy, schedule.createdRole], ["active", "butterfly", "agent", "butterfly"]);
	assert.deepEqual((await attention()), []);
	now = NOON;
	await t.core.call("schedules.tick", { now });
	assert.equal((await get(id)).runs[0]?.result, "已提醒");
	assert.ok(!t.notifier.sent.some(notification => notification.title.includes("想创建")));
	const listed = await tool(slot, "schedule_list", { from: NOON, to: NOON + 60 * MINUTE, status: "active" });
	assert.equal(listed.details.items?.[0]?.id, id);
	assert.equal(listed.details.items?.[0]?.createdRole, "butterfly");
	assert.equal(listed.details.items?.[0]?.describe, "每天 9:00、12:00、15:00、18:00");
	assert.equal(listed.details.items?.[0]?.version, schedule.version);
	assert.deepEqual((await tool(slot, "schedule_list", { status: "paused" })).details.items, []);
	const edit = await tool(slot, "schedule_update", { id, version: schedule.version, trigger: "weekly", weekdays: [1, 3], times: ["09:10", "15:25"], timezone: daily.timezone });
	assert.deepEqual(edit.details, { scheduleId: id, action: "updated", line: "已改：「提醒吃药」改成每周一、三 9:10、15:25" });
	assert.equal((await get(id)).version, schedule.version + 1);
	assert.deepEqual(await attention(), []);
	const ran = await tool(slot, "schedule_run_now", { id });
	assert.deepEqual(ran.details, { scheduleId: id, action: "ran", line: "已提醒：提醒吃药" });
	assert.ok((await get(id)).runs.some(run => run.manual && run.status === "done"));
	const removed = await tool(slot, "schedule_remove", { id, version: schedule.version + 1 });
	assert.deepEqual(removed.details, { scheduleId: id, action: "removed", line: "已删除日程：提醒吃药" });
	await assert.rejects(get(id), { code: "not_found" });
});

it("backfills the creator role after legacy owner detection and keeps pending approvals", async () => {
	const { dbFile, butterflyDir } = t.core.paths;
	await t.core.shutdown();
	unlinkSync(dbFile);
	const old = new DatabaseSync(dbFile);
	try {
		for (const migration of MIGRATIONS.slice(0, 16)) old.exec(migration);
		old.exec("PRAGMA user_version = 16");
		const insert = old.prepare(`INSERT INTO schedules(id, name, prompt, cwd, kind, trigger, missed_policy, session_mode, status, created_by, created_at, updated_at)
			VALUES(?, '旧日程', '检查', ?, 'task', ?, 'latest', 'fresh', 'pending_approval', ?, 1, 1)`);
		insert.run("agent-butterfly", butterflyDir, JSON.stringify(daily), "agent");
		insert.run("agent-workbench", t.workspace, JSON.stringify(daily), "agent");
		insert.run("user-butterfly", butterflyDir, JSON.stringify(daily), "user");
	} finally { old.close(); }
	t = await startTestCore(t.dir);
	const rows = await t.core.call("schedules.list", {}) as ScheduleView[];
	assert.deepEqual(rows.sort((a, b) => a.id.localeCompare(b.id)).map(s => [s.id, s.owner, s.createdBy, s.createdRole, s.status]), [
		["agent-butterfly", "butterfly", "agent", "butterfly", "pending_approval"],
		["agent-workbench", "workbench", "agent", "user", "pending_approval"],
		["user-butterfly", "butterfly", "user", "user", "pending_approval"],
	]);
	assert.equal((await t.core.call("inbox.list", {}) as { kind: string }[]).filter(item => item.kind === "schedule").length, 3);
});
