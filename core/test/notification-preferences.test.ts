import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { TasksModule } from "../src/modules/tasks.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

let t: TestCore;
beforeEach(async () => { t = await startTestCore(); });
afterEach(async () => { await t.cleanup(); });

it("keeps the global switch and filters workbench and Butterfly notifications separately", async () => {
	const center = t.core.notifications;
	const notice = (key: string) => ({ key, title: "提示", body: "内容", target: { page: "chat" } });
	assert.equal(t.core.settings.get().workbenchNotifications, false);
	assert.equal(t.core.settings.get().butterflyNotifications, true);
	assert.equal(center.publish("workbench.done", notice("workbench-default")), false);
	assert.equal(center.publish("workbench.approval", notice("approval-default")), false);
	assert.equal(center.publish("butterfly.waiting", notice("butterfly-default")), true);
	t.core.settings.update({ workbenchNotifications: true, butterflyNotifications: false });
	assert.equal(center.publish("workbench.done", notice("workbench-enabled")), true);
	assert.equal(center.publish("butterfly.waiting", notice("butterfly-disabled")), false);
	t.core.settings.update({ notifications: false });
	assert.equal(center.publish("workbench.approval", notice("global-off")), false);
	assert.equal(t.core.db.get<{ reason: string }>("SELECT reason FROM notification_receipts WHERE key='global-off'")?.reason, "notifications_disabled");
	assert.equal(t.messages.filter(m => m.event === "notification").length, 2);
});

it("keeps schedule reminders under the original global switch", async () => {
	const notice = { key: "schedule-reminder", category: "reminder" as const, object: "日程", situation: "即将开始", impact: "请准备", action: "打开日程", target: { page: "schedule" } };
	t.core.settings.update({ workbenchNotifications: false, butterflyNotifications: false });
	assert.equal((await t.core.notifications.send(notice)).state, "sent");
	t.core.settings.update({ notifications: false });
	assert.equal((await t.core.notifications.send({ ...notice, key: "schedule-muted" })).reason, "notifications_disabled");
});

it("mutes deferred Butterfly notices when its switch closes, without replay after reopening", async () => {
	const center = t.core.notifications;
	center.deferQuiet({ key: "patrol:queued-while-quiet", category: "blocked", objectRef: "patrol:queued-while-quiet" }, Date.now());
	assert.equal(t.core.db.get<{ state: string }>("SELECT state FROM notification_receipts WHERE key='patrol:queued-while-quiet'")?.state, "queued");
	t.core.settings.update({ butterflyNotifications: false });
	const receipt = t.core.db.get<{ state: string; reason: string }>(
		"SELECT state,reason FROM notification_receipts WHERE key='patrol:queued-while-quiet'");
	assert.equal(receipt?.state, "muted");
	assert.equal(receipt?.reason, "category_disabled");
	assert.equal((await center.send({ key: "patrol:new-while-off", category: "blocked", object: "巡检", situation: "需关注",
		impact: "查看结果", action: "打开", target: { page: "schedule" } })).reason, "category_disabled");
	t.core.settings.update({ butterflyNotifications: true });
	const result = await center.send({ key: "patrol:queued-while-quiet", category: "blocked", object: "巡检", situation: "需关注",
		impact: "查看结果", action: "打开", target: { page: "schedule" } });
	assert.equal(result.reason, "duplicate");
	assert.equal(t.notifier.sent.length, 0);
});

it("does not notify ordinary Butterfly replies but announces a planned task result", async () => {
	await t.core.call("slot.open", { slotId: "butterfly-notice", cwd: t.core.paths.butterflyDir }, t.client);
	const slot = t.core.slot("butterfly-notice");
	Object.defineProperty(slot, "sandboxed", { value: true, configurable: true });
	t.respond(fauxAssistantMessage("你好"));
	await slot.prompt("你好");
	await t.waitFor(() => settledCount(t.records(slot.slotId)) === 1);
	assert.equal(t.messages.filter(m => m.event === "notification" && m.kind === "butterfly.done").length, 0);
	const task = t.core.module(TasksModule)!.create({ cwd: t.core.paths.butterflyDir, goal: "整理资料", source: "chat" });
	slot.taskId = task.id;
	t.core.db.run("INSERT INTO butterfly_intents(id,slot_id,task_id,goal,restatement,plan,state,created_at) VALUES('notification-plan',?,?,'整理资料','整理资料','整理资料','started',?)", slot.slotId, slot.taskId, Date.now());
	t.respond(fauxAssistantMessage("资料已整理"));
	await slot.prompt("整理资料");
	await t.waitFor(() => settledCount(t.records(slot.slotId)) === 2);
	assert.equal(t.messages.filter(m => m.event === "notification" && m.kind === "butterfly.done").length, 1);
	t.respond(fauxAssistantMessage("好的"));
	await slot.prompt("谢谢");
	await t.waitFor(() => settledCount(t.records(slot.slotId)) === 3);
	assert.equal(t.messages.filter(m => m.event === "notification" && m.kind === "butterfly.done").length, 1);
});

it("notifies a direct Butterfly task with a completed action but not read-only conversation", async () => {
	await t.core.call("slot.open", { slotId: "butterfly-direct", cwd: t.core.paths.butterflyDir }, t.client);
	const slot = t.core.slot("butterfly-direct");
	Object.defineProperty(slot, "sandboxed", { value: true, configurable: true });
	const input = join(t.core.paths.butterflyDir, "input.txt");
	writeFileSync(input, "示例资料");
	t.respond(fauxAssistantMessage([fauxToolCall("read", { file_path: input })], { stopReason: "toolUse" }), fauxAssistantMessage("这是示例资料"));
	await slot.prompt("看看资料说了什么");
	await t.waitFor(() => settledCount(t.records(slot.slotId)) === 1);
	assert.equal(t.messages.filter(m => m.event === "notification" && m.kind === "butterfly.done").length, 0);
	t.respond(fauxAssistantMessage([fauxToolCall("write", { file_path: "result.txt", content: "整理结果" })], { stopReason: "toolUse" }), fauxAssistantMessage("整理结果已写好"));
	await slot.prompt("把资料整理成文件");
	await t.waitFor(() => settledCount(t.records(slot.slotId)) === 2);
	assert.equal(t.messages.filter(m => m.event === "notification" && m.kind === "butterfly.done").length, 1);
});
