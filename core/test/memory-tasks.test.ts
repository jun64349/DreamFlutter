import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { boundarySignal, saysNewTask } from "../src/memory/tasks.ts";
import type { MemoryItem } from "../src/memory/types.ts";
import { MemoryModule } from "../src/modules/memory.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((c) => (c as { text?: string }).text ?? "").join("") : "";
}

describe("task boundary signals (16.2)", () => {
	it("hears the user say one thing is done and another begins", () => {
		assert.ok(saysNewTask("这件事做完了，接下来帮我写周报"));
		assert.ok(saysNewTask("换个话题，问你点别的"));
		assert.ok(saysNewTask("OK, let's move on to the slides"));
		assert.ok(!saysNewTask("这个函数为什么报错"));
		assert.ok(!saysNewTask("接着改第二章"));
	});

	it("takes a long pause or a long unrelated message only as a signal", () => {
		const task = { lastActiveAt: 0, prompt: "帮我调试登录页的报错，点登录按钮没反应" };
		assert.equal(boundarySignal(task, "好", 3 * 3_600_000), "gap");
		assert.equal(boundarySignal(task, "看看控制台", 60_000), undefined, "short follow-up");
		assert.equal(boundarySignal(task, "登录按钮还是没反应，控制台里报 TypeError，说是 undefined 的属性读不到，帮我再看看登录页", 60_000), undefined, "same matter");
		assert.equal(boundarySignal(task, "我下周要去成都出差三天，帮我列一份要带的东西的清单，包括衣服、电子产品和证件之类的", 60_000), "topic");
	});
});

describe("tasks and snapshots in a session (16.2–16.6)", () => {
	let t: TestCore;
	let memory: MemoryModule;
	let seen: Context["messages"][];

	beforeEach(async () => {
		t = await startTestCore();
		memory = t.core.module(MemoryModule)!;
		seen = [];
		await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
		await t.core.call("memory.save", { content: "用户希望回复简短", kind: "preference" });
	});

	afterEach(async () => {
		await t.cleanup();
	});

	const reply = (text: string) => (context: Context) => {
		seen.push(context.messages);
		return fauxAssistantMessage(text);
	};
	async function prompt(text: string): Promise<void> {
		const before = settledCount(t.records("s1"));
		await t.send("s1", { id: `p-${Math.random()}`, type: "prompt", message: text });
		await t.waitFor(() => settledCount(t.records("s1")) === before + 1);
	}
	const sessionId = () => t.core.slots.get("s1")!.session.sessionId;
	const snapshots = () => t.core.db.all<{ task_id: string | null; reason: string }>("SELECT task_id, reason FROM memory_snapshots WHERE session_id = ? ORDER BY created_at", sessionId());
	const tasks = async () => (await t.core.call("memory.tasks", { sessionId: sessionId() })) as { id: string; reason: string; status: string; endReason: string | null }[];

	it("keeps one snapshot through a task, and starts a new one when the user says the task is done", async () => {
		t.respond(reply("好"), reply("看了"), reply("改好了"));
		await prompt("帮我调试登录页的报错");
		await prompt("看看控制台");
		await prompt("再试一次");
		assert.equal(snapshots().length, 1, "the steps of one task share its snapshot");
		const [first] = await tasks();
		assert.deepEqual([first!.reason, first!.status], ["session_start", "active"]);
		assert.equal(snapshots()[0]!.task_id, first!.id, "the snapshot is the task's");
		t.respond(reply("好的"));
		await prompt("这件事做完了，接下来帮我写周报");
		const list = await tasks();
		assert.deepEqual(list.map((x) => [x.reason, x.status]), [
			["user_said", "active"],
			["session_start", "ended"],
		]);
		assert.equal(snapshots().length, 2);
		assert.equal(snapshots()[1]!.task_id, list[0]!.id);
	});

	it("starts a new task when the user marks it (「作为新任务」)", async () => {
		t.respond(reply("好"), reply("好"));
		await prompt("帮我调试登录页的报错");
		await t.core.call("memory.newTask", { sessionId: sessionId() });
		await prompt("看看这个");
		assert.equal((await tasks())[0]!.reason, "user_marked");
		assert.equal(snapshots().length, 2);
	});

	it("asks a light check after a long pause; a confident 「new task」 suspends the old one, and 「改为继续上一个」 brings it back", async () => {
		t.core.settings.update({ memoryAutoExtract: true });
		let time = Date.now();
		memory.clock = () => time;
		t.respond(reply("好"), fauxAssistantMessage("没有要记的。"));
		await prompt("帮我调试一下登录页面点按钮的报错");
		await t.waitFor(() => t.core.db.get("SELECT 1 FROM memory_jobs WHERE kind = 'extract' AND status = 'done'"));
		time += 3 * 3_600_000;
		let check = "";
		t.respond(
			(context) => {
				check = JSON.stringify(context.messages);
				return fauxAssistantMessage('{"new_task": true, "confidence": 0.9}');
			},
			reply("好"),
			fauxAssistantMessage("没有要记的。"),
		);
		await prompt("帮我列一份出差要带的东西");
		assert.match(check, /登录页面/);
		assert.match(check, /出差/);
		const list = await tasks();
		assert.deepEqual(list.map((x) => [x.reason, x.status]), [
			["guessed", "active"],
			["session_start", "suspended"],
		]);
		await t.core.call("memory.continueTask", { sessionId: sessionId() });
		const after = await tasks();
		assert.deepEqual(after.map((x) => x.status).sort(), ["active", "ended"]);
		assert.equal(after.find((x) => x.status === "active")!.reason, "session_start");
	});

	it("keeps the current task when the light check is unsure, or when background tidying is off (no model call)", async () => {
		t.core.settings.update({ memoryAutoExtract: true });
		let time = Date.now();
		memory.clock = () => time;
		t.respond(reply("好"), fauxAssistantMessage("没有要记的。"));
		await prompt("帮我调试一下登录页面点按钮的报错");
		await t.waitFor(() => t.core.db.get("SELECT 1 FROM memory_jobs WHERE kind = 'extract' AND status = 'done'"));
		time += 3 * 3_600_000;
		t.respond(fauxAssistantMessage('{"new_task": true, "confidence": 0.4}'), reply("好"), fauxAssistantMessage("没有要记的。"));
		await prompt("帮我列一份出差要带的东西");
		assert.equal((await tasks()).length, 1);
		await t.waitFor(() => t.core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_jobs WHERE kind = 'extract' AND status = 'done'")!.n === 2);
		t.core.settings.update({ memoryAutoExtract: false });
		time += 3 * 3_600_000;
		t.respond(reply("好"));
		await prompt("再帮我订一张去成都的火车票");
		assert.equal((await tasks()).length, 1);
		assert.equal(textOf(seen.at(-1)!.at(-1)!.content), "再帮我订一张去成都的火车票", "the only call was the reply");
	});

	it("starts a new task for another workspace and for every scheduled run", async () => {
		t.respond(reply("好"));
		await prompt("帮我调试登录页的报错");
		const set = memory.scopesFor(t.workspace);
		const other = await memory.boundary({ sessionId: sessionId(), prompt: "看看", set: { ...set, key: "workspace:other" }, unattended: false, recent: "", cwd: t.dir });
		assert.deepEqual([other.fresh, other.task.reason], [true, "workspace_switch"]);
		const scheduled = await memory.boundary({ sessionId: sessionId(), prompt: "看看", set: { ...set, key: "workspace:other" }, unattended: true, recent: "", cwd: t.dir });
		assert.deepEqual([scheduled.fresh, scheduled.task.reason], [true, "scheduled"]);
	});

	it("a 「只读记忆」 session reads its snapshot but writes nothing; a 「不记忆」 one does neither (16.6)", async () => {
		t.respond(reply("好"));
		await prompt("你好");
		await t.core.call("memory.setSessionMode", { sessionId: sessionId(), mode: "readonly" });
		const results: string[] = [];
		t.respond(fauxAssistantMessage([fauxToolCall("memory_save", { content: "用户喜欢喝茶", kind: "preference", explicit: true })], { stopReason: "toolUse" }), (context) => {
			results.push(JSON.stringify(context.messages.at(-1)));
			seen.push(context.messages);
			return fauxAssistantMessage("好");
		});
		await prompt("记住我喜欢喝茶");
		assert.match(results[0]!, /只读记忆/);
		assert.equal(memory.store.list().length, 1, "nothing saved");
		assert.ok(seen.at(-1)!.some((m) => textOf(m.content).includes("用户希望回复简短")), "the snapshot is still read");
		await t.core.call("memory.setSessionMode", { sessionId: sessionId(), mode: "off" });
		t.respond(reply("好"));
		await prompt("再说一句");
		assert.ok(!seen.at(-1)!.some((m) => textOf(m.content).includes("用户希望回复简短")), "no snapshot at all");
	});

	it("takes out at once what the user deleted for good or may no longer read, without waiting for a new task (16.4)", async () => {
		const { item } = (await t.core.call("memory.save", { content: "用户在读研究生", kind: "background" })) as { item: MemoryItem };
		t.respond(reply("好"));
		await prompt("聊聊我的研究生课题");
		assert.ok(seen.at(-1)!.some((m) => textOf(m.content).includes("用户在读研究生")));
		await t.core.call("memory.purge", { id: item.id, confirm: true });
		assert.ok(memory.corrected(memory.latestSnapshot(sessionId())!, memory.scopesFor(t.workspace)).includes(item.id), "a deleted item counts as corrected");
		t.respond(reply("好"));
		await prompt("继续说研究生的事");
		assert.ok(!seen.at(-1)!.some((m) => textOf(m.content).includes("用户在读研究生")), "deleted for good: gone from the next call");
		const ws = memory.workspaces.byPath(t.workspace) ?? memory.workspaces.ensure(t.workspace);
		await t.core.call("memory.setWorkspaceBackground", { id: ws.id, on: false });
		const snapshot = memory.latestSnapshot(sessionId())!;
		const background = (await t.core.call("memory.save", { content: "用户住在北京", kind: "background" })) as { item: MemoryItem };
		assert.deepEqual(memory.corrected({ ...snapshot, itemVersions: { ...snapshot.itemVersions, [background.item.id]: 1 } }, memory.scopesFor(t.workspace)), [background.item.id], "global background turned off here: no longer readable");
	});

	it("says 「已保存」 and 「当前任务用上了没有」 apart (16.5)", async () => {
		t.respond(reply("好"));
		await prompt("你好");
		const saved = (await t.core.call("memory.save", { content: "用户喜欢喝茶", kind: "preference" })) as { currentTask: string; item: MemoryItem };
		assert.equal(saved.currentTask, "next_task");
		const pref = memory.store.list().find((m) => m.content === "用户希望回复简短")!;
		const edited = (await t.core.call("memory.update", { id: pref.id, content: "用户希望回复简短，用要点" })) as { currentTask: string };
		assert.equal(edited.currentTask, "next_call", "in the running task's snapshot: replaced before the next model call");
		const results: string[] = [];
		t.respond(fauxAssistantMessage([fauxToolCall("memory_save", { content: "用户每周五交周报", kind: "agreement", explicit: true })], { stopReason: "toolUse" }), (context) => {
			results.push(JSON.stringify(context.messages.at(-1)));
			return fauxAssistantMessage("好");
		});
		await prompt("记住我每周五交周报");
		assert.match(results[0]!, /已保存/);
		assert.match(results[0]!, /下一个任务开始时/);
	});
});
