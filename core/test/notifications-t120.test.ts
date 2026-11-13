import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { CardsModule } from "../src/cards/cards.ts";
import { Gateway, type ChannelInfo } from "../src/gateway/gateway.ts";
import { MemoryModule } from "../src/modules/memory.ts";
import type { NoticeCategory } from "../src/modules/notices/journal.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { SkillsModule } from "../src/modules/skills.ts";
import { TasksModule } from "../src/modules/tasks.ts";
import type { Run } from "../src/runs.ts";
import { MemorySpaceGuard } from "../src/storage/memory-maintenance.ts";
import { startTestCore, type TestCore } from "./harness.ts";

type Receipt = { key: string; state: string; reason: string | null; category: NoticeCategory; item_id: string | null };
type Metrics = { quietSuppressed: number; duplicateSuppressed: number; sentByCategory: Record<NoticeCategory, number> };
let t: TestCore;
beforeEach(async () => { t = await startTestCore(); mode("on"); });
afterEach(async () => { await t.cleanup(); });

function mode(value: "on" | "off" | "quiet"): void {
	const clock = (offset: number) => new Date(Date.now() + offset * 3_600_000).toTimeString().slice(0, 5);
	t.core.settings.update({ notifications: value !== "off", patrolQuietEnabled: value === "quiet",
		patrolQuietStart: clock(-1), patrolQuietEnd: clock(1) });
}

function receipts(prefix: string): Receipt[] {
	return t.core.db.all("SELECT key,state,reason,category,item_id FROM notification_receipts WHERE key LIKE ? ORDER BY rowid", `${prefix}%`);
}

async function metrics(): Promise<Metrics> {
	return ((await t.core.call("attention.metrics", { days: 1 })) as Metrics[])[0]!;
}

function states(prefix: string): (string | null)[] {
	return receipts(prefix).map(row => row.reason ?? row.state);
}

it("T120 task limit emits one system notification with a receipt and keeps its attention card", async () => {
	await t.core.call("slot.open", { slotId: "limits", cwd: t.workspace }, t.client);
	const slot = t.core.slot("limits"), tasks = t.core.module(TasksModule)!;
	Object.defineProperty(slot, "sandboxed", { value: true, configurable: true });
	await t.core.call("notifications.presence", { foreground: false, slotId: null }, t.client);
	const pause = (id: string) => tasks["pauseRun"](slot, { id, taskId: null } as Run, "limit_turns", "轮数已到", "可以继续或者停止");
	try {
		mode("off"); pause("off");
		mode("on"); pause("off");
		mode("quiet"); pause("quiet");
		mode("on"); pause("quiet");
		assert.equal(t.notifier.sent.length, 0);
		pause("day"); pause("day");
		await Promise.resolve();
		assert.deepEqual(t.notifier.sent, [{ title: "轮数已到", body: slot.cwd }]);
		assert.equal(t.messages.filter(event => event.event === "notification").length, 0);
		assert.deepEqual(states("task-limit:"), ["notifications_disabled", "quiet_hours", "sent"]);
		const items = await t.core.call("attention.prioritized", {}) as { target: { itemId: string }; notified: boolean }[];
		assert.ok(items.some(item => item.target.itemId === receipts("task-limit:day")[0]!.item_id && item.notified));
		assert.equal((await metrics()).sentByCategory.blocked, 1);
	} finally { Reflect.deleteProperty(slot, "sandboxed"); }
});

it("T120 a task and its goal share a budget warning while the original quiet queue survives", async () => {
	await t.core.call("slot.open", { slotId: "goal-limit", cwd: t.workspace }, t.client);
	const slot = t.core.slot("goal-limit"), tasks = t.core.module(TasksModule)!;
	const { id: goalId } = await t.core.call("goals.create", { title: "测试预算", originText: "测试预算", mandateRef: "user:t120" }) as { id: string };
	t.core.db.run("UPDATE goals SET status='paused',reason='budget_cost' WHERE id=?", goalId);
	const key = t.core.notifications.activeBudgetKey(goalId)!;
	assert.ok(key);
	const warning = { key, category: "blocked" as const, objectRef: goalId, object: "测试预算", situation: "预算触顶",
		impact: "目标暂停", action: "查看预算", target: { page: "goals", goalId } };
	const pause = (id: string) => tasks["pauseRun"](slot, { id, taskId: null } as Run, "goal_budget", "目标预算已用完", "请先放宽预算", goalId);
	mode("quiet");
	t.core.notifications.deferQuiet(warning, Date.now());
	pause("quiet-budget");
	assert.deepEqual(states("task-limit:quiet-budget"), ["quiet_hours"]);
	assert.deepEqual(states(`notify:${goalId}:`), ["queued"]);
	mode("on");
	pause("day-budget");
	assert.equal((await t.core.notifications.send(warning)).reason, "duplicate");
	assert.deepEqual(t.notifier.sent.map(notice => notice.title), ["目标预算已用完"]);
	assert.deepEqual(states(`notify:${goalId}:`), ["sent"]);
});

it("T120 gateway gates both reminder channels and keeps quota health and new periods", async () => {
	const gateway = t.core.module(Gateway)!;
	const channel = { id: "fake-gateway", name: "测试渠道", lowBalance: 10 } as ChannelInfo;
	const at = Date.now();
	const plan = (usedPercent: number, period: number) => gateway["applyReading"](channel, "test-key", {
		type: "plan", checkedAt: at, windows: [{ label: "本周期", usedPercent, resetAt: at + period * 3_600_000 }],
	});
	const balance = (amount: number, seq: number) => gateway["applyReading"](channel, "test-key", {
		type: "balance", checkedAt: at + seq, amount, currency: "CNY",
	});
	mode("off"); plan(100, 1);
	assert.equal(gateway["reading"](channel.id)?.type, "plan");
	mode("on"); plan(20, 1); plan(90, 1);
	mode("quiet"); plan(90, 2); balance(5, 1);
	mode("on"); plan(20, 2); plan(90, 2);
	assert.equal(t.notifier.sent.length, 0);
	assert.equal(t.messages.filter(message => message.event === "gateway.alert").length, 0);
	plan(91, 3); plan(20, 3); plan(99, 3);
	balance(15, 2); balance(5, 3); balance(4, 4);
	await Promise.resolve();
	assert.deepEqual(t.notifier.sent.map(notice => notice.title), ["测试渠道 额度已用 91%", "测试渠道 余额不足"]);
	assert.equal(t.messages.filter(message => message.event === "gateway.alert").length, 2);
	assert.deepEqual(states("gateway:"), ["notifications_disabled", "quiet_hours", "quiet_hours", "sent", "sent"]);
	const day = await metrics();
	assert.equal(day.quietSuppressed, 2);
	assert.equal(day.duplicateSuppressed, 3);
	assert.equal(day.sentByCategory.decision, 2);
});

it("T120 card binding reports actual delivery and deduplicates the same card request after restart", async () => {
	const card = t.core.module(CardsModule)!.mint({ title: "卡片", cwd: t.workspace,
		code: '<script type="application/json" data-card-manifest>{"toolBindings":{"toast":{"tool":"notify.send"}}}</script><p>提醒</p>' });
	const invoke = async (title: string) => {
		const input = { id: card.id, capability: "invoke", payload: { bindingId: "toast", input: { title, body: "保留原文" } } };
		const asked = await t.core.call("cards.request", input) as { ask: { epoch: number; digest: string } };
		assert.ok(asked.ask);
		return t.core.call("cards.request", { ...input, answer: { ...asked.ask, grant: "once" } });
	};
	const result = (sent: boolean) => ({ ok: true, result: { sent } });
	mode("off"); assert.deepEqual(await invoke("关闭时"), result(false));
	mode("on"); assert.deepEqual(await invoke("关闭时"), result(false));
	mode("quiet"); assert.deepEqual(await invoke("静默时"), result(false));
	mode("on"); assert.deepEqual(await invoke("静默时"), result(false));
	assert.deepEqual(await invoke("可以发"), result(true));
	assert.deepEqual(t.notifier.sent, [{ title: "可以发", body: "保留原文" }]);
	t = await t.reopen();
	assert.deepEqual(await invoke("可以发"), result(false));
	assert.deepEqual(t.notifier.sent, []);
	assert.deepEqual(states("card:"), ["notifications_disabled", "quiet_hours", "sent"]);
	assert.equal((await metrics()).sentByCategory.reminder, 1);
});

it("T120 offline skill proposals use their persisted IDs and preserve the connected-window behavior", async () => {
	const skills = t.core.module(SkillsModule)!;
	const propose = (name: string) => skills.propose({ name, scope: "user", description: "测试技能",
		content: `---\nname: ${name}\ndescription: 测试技能\n---\n测试内容` });
	propose("t120-connected");
	assert.deepEqual(receipts("skill:"), []);
	t.core.removeClient(t.client);
	const post = t.core.notifications.post.bind(t.core.notifications);
	// Simulate re-dispatch of the same persisted proposal at the notification boundary.
	t.core.notifications.post = (input, options) => { post(input, options); post(input, options); };
	mode("off"); const off = propose("t120-off");
	mode("quiet"); const quiet = propose("t120-quiet");
	mode("on");
	assert.deepEqual(t.notifier.sent, []);
	const day = propose("t120-day");
	await Promise.resolve();
	assert.deepEqual(t.notifier.sent, [{ title: "Agent 建议保存一个技能", body: "t120-day" }]);
	assert.deepEqual(receipts("skill:").map(row => row.item_id), [off.id, quiet.id, day.id]);
	assert.deepEqual(states("skill:"), ["notifications_disabled", "quiet_hours", "sent"]);
	const current = await metrics();
	assert.equal(current.sentByCategory.decision, 1);
	assert.equal(current.quietSuppressed, 1);
	assert.equal(current.duplicateSuppressed, 2);
});

it("T120 memory watchdog suppresses the same incident across restart and announces real transitions", async ({ mock }) => {
	let paused = false;
	mock.method(MemorySpaceGuard.prototype, "status", () => ({ paused, freeBytes: paused ? 0 : 100, minimumBytes: 10,
		reason: paused ? "磁盘空间不足" : null }));
	const set = (next: boolean) => { paused = next; t.core.module(MemoryModule)!["checkSpace"](); };
	mode("off"); set(true);
	mode("on"); t = await t.reopen();
	assert.deepEqual(t.notifier.sent, []);
	mode("quiet"); set(false); set(true);
	mode("on"); t = await t.reopen();
	assert.deepEqual(t.notifier.sent, []);
	// A healthy start updates the baseline silently, allowing the next independent low-space incident.
	paused = false; t = await t.reopen();
	assert.deepEqual(t.notifier.sent, []);
	set(true); set(true); set(false);
	await Promise.resolve();
	assert.deepEqual(t.notifier.sent, [{ title: "记忆存储", body: "磁盘空间不足" },
		{ title: "记忆存储", body: "磁盘空间已恢复，记忆写入已继续。" }]);
	assert.deepEqual(states("memory:storage:"), ["notifications_disabled", "quiet_hours", "quiet_hours", "initial_state", "sent", "sent"]);
	const day = await metrics();
	assert.equal(day.quietSuppressed, 2);
	assert.equal(day.sentByCategory.blocked, 1);
	assert.equal(day.sentByCategory.done, 1);
});

it("T120 startup storage notification can finish after attention starts", async ({ mock }) => {
	mock.method(MemorySpaceGuard.prototype, "status", () => ({ paused: true, freeBytes: 0, minimumBytes: 10, reason: "空间不足" }));
	let release: ((result: "delivered") => void) | undefined;
	mock.method(RecordingNotifier.prototype, "deliver", () => new Promise(resolve => { release = resolve; }));
	t = await t.reopen();
	assert.deepEqual(states("memory:storage:"), ["queued"]);
	assert.ok(release);
	release("delivered");
	await Promise.resolve();
	assert.deepEqual(states("memory:storage:"), ["sent"]);
});

function rawNotificationAccess(file: string, source: string): number[] {
	const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const lines: number[] = [];
	function visit(node: ts.Node): void {
		const member = ts.isPropertyAccessExpression(node) ? node.name.text :
			ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
		const injection = file === "core.ts" && node.parent && ts.isBinaryExpression(node.parent) && node.parent.getText(ast) === "this.notifier = options.notifier";
		const composition = file === "main.ts" && ts.isNewExpression(node) && node.expression.getText(ast) === "WindowsNotifier"
			|| file === "update/recover-entry.ts" && ts.isNewExpression(node) && node.expression.getText(ast) === "RecordingNotifier";
		const transport = ts.isNewExpression(node) && /^(?:Windows|Recording)Notifier$/.test(node.expression.getText(ast));
		const legacyCall = ts.isCallExpression(node) && /(?:^|\.)deliverNotification$/.test(node.expression.getText(ast));
		const rawEvent = ts.isPropertyAssignment(node) && node.name.getText(ast) === "event" && ts.isStringLiteral(node.initializer) && node.initializer.text === "notification";
		if (member === "notifier" && !injection || transport && !composition || legacyCall || rawEvent) {
			lines.push(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1);
		}
		ts.forEachChild(node, visit);
	}
	visit(ast);
	return lines;
}

it("T120 only NotificationCenter can call the system transport", () => {
	const src = fileURLToPath(new URL("../src/", import.meta.url));
	const offenders = ts.sys.readDirectory(src, [".ts"]).flatMap(path => {
		const file = relative(src, path).replaceAll("\\", "/");
		if (file === "notify.ts") return [];
		return rawNotificationAccess(file, readFileSync(path, "utf8")).map(line => `${file}:${line}`);
	});
	assert.deepEqual(offenders, []);
	assert.deepEqual(rawNotificationAccess("candidate.ts", [
		"core.notifier.notify(title, body);", 'core["notifier"].deliver(title, body);',
		"new WindowsNotifier(log);", 'core.broadcast({ event: "notification" });',
		"deliverNotification(core, title, body);", "core.notifications.post(notice);",
	].join("\n")), [1, 2, 3, 4, 5]);
});
