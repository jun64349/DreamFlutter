import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ALLOW, APPROVAL_TITLE, DENY, TRUST_ONCE, TRUST_TITLE, workspaceAllowLabel } from "../src/pi/dialogs.ts";
import { type SlotInfo, userBranches } from "../src/slots/slot.ts";
import { dialogs, settledCount, startTestCore, type TestCore } from "./harness.ts";

describe("session slots", () => {
	let t: TestCore;

	beforeEach(async () => {
		t = await startTestCore();
	});

	afterEach(async () => {
		await t.cleanup();
	});

	async function open(slotId = "s1", extra: Record<string, unknown> = {}): Promise<SlotInfo> {
		return (await t.core.call("slot.open", { slotId, cwd: t.workspace, ...extra }, t.client)) as SlotInfo;
	}

	it("runs a prompt and streams Pi RPC records", async () => {
		const info = await open();
		assert.equal(info.cwd, t.workspace);
		assert.ok(info.sessionFile, "a new session gets a file");

		t.respond(fauxAssistantMessage("你好，我是测试模型。"));
		await t.send("s1", { id: "p1", type: "prompt", message: "你好" });
		await t.waitFor(() => settledCount(t.records("s1")) === 1);

		const records = t.records("s1");
		const response = records.find((r) => r.type === "response" && r.id === "p1");
		assert.equal(response?.success, true);
		assert.ok(records.some((r) => r.type === "message_update"));
		const end = records.find((r) => r.type === "message_end" && (r.message as { role?: string }).role === "assistant");
		assert.ok(end, "assistant message_end");

		const runs = t.core.runs.list({ sessionFile: info.sessionFile! });
		assert.equal(runs.length, 1);
		assert.equal(runs[0]!.status, "done");
		assert.equal(runs[0]!.prompt, "你好");
		assert.equal(runs[0]!.turns, 1);
		assert.equal(runs[0]!.model, "faux/faux-1");
	});

	it("answers get_state and get_messages like RPC mode", async () => {
		await open();
		t.respond(fauxAssistantMessage("ok"));
		await t.send("s1", { id: "p", type: "prompt", message: "hi" });
		await t.waitFor(() => settledCount(t.records("s1")) === 1);
		await t.send("s1", { id: "st", type: "get_state" });
		await t.send("s1", { id: "msgs", type: "get_messages" });
		const state = await t.waitFor(() => t.records("s1").find((r) => r.id === "st"));
		const messages = await t.waitFor(() => t.records("s1").find((r) => r.id === "msgs"));
		assert.equal((state.data as { isStreaming: boolean }).isStreaming, false);
		const conversation = (messages.data as { messages: { role: string }[] }).messages.filter((m) => m.role === "user" || m.role === "assistant");
		assert.deepEqual(conversation.map((m) => m.role), ["user", "assistant"]);
	});

	it("asks before writing a file and runs the tool once allowed", async () => {
		const info = await open();
		const target = join(t.workspace, "note.txt");
		t.respond(fauxAssistantMessage([fauxToolCall("write", { file_path: target, content: "hello" })], { stopReason: "toolUse" }), fauxAssistantMessage("写好了"));
		await t.send("s1", { id: "p", type: "prompt", message: "写个文件" });

		const dialog = await t.waitFor(() => dialogs(t.records("s1"))[0]);
		assert.ok(String(dialog.title).startsWith(APPROVAL_TITLE));
		assert.deepEqual((dialog.options as string[]).at(0), ALLOW);
		const pending = t.core.confirmations.list({ status: "pending" });
		assert.equal(pending.length, 1);
		assert.equal(pending[0]!.kind, "approval");
		assert.equal(pending[0]!.sessionFile, info.sessionFile);
		// The window is attached, so no system notification.
		assert.equal(t.notifier.sent.length, 0);

		await t.core.call("confirm.answer", { id: dialog.id, response: { value: ALLOW } }, t.client);
		await t.waitFor(() => settledCount(t.records("s1")) === 1);
		assert.equal(readFileSync(target, "utf8"), "hello");
		assert.equal(t.core.confirmations.get(String(dialog.id))!.status, "answered");
		const run = t.core.runs.list()[0]!;
		assert.equal(run.toolCalls, 1);
		assert.deepEqual(run.files, [target]);
		const steps = t.core.runs.steps(run.id);
		assert.equal(steps[0]!.kind, "tool");
		assert.equal(steps[0]!.status, "done");
	});

	it("blocks the tool when the user declines", async () => {
		await open();
		const target = join(t.workspace, "blocked.txt");
		t.respond(fauxAssistantMessage([fauxToolCall("write", { file_path: target, content: "x" })], { stopReason: "toolUse" }), fauxAssistantMessage("好的，不写了"));
		await t.send("s1", { id: "p", type: "prompt", message: "写个文件" });
		const dialog = await t.waitFor(() => dialogs(t.records("s1"))[0]);
		await t.send("s1", { type: "extension_ui_response", id: dialog.id, value: DENY });
		await t.waitFor(() => settledCount(t.records("s1")) === 1);
		assert.equal(existsSync(target), false);
		const run = t.core.runs.list()[0]!;
		assert.equal(run.toolErrors, 1);
	});

	it("remembers a workspace-wide allow rule", async () => {
		await open();
		const first = join(t.workspace, "a.txt");
		const second = join(t.workspace, "b.txt");
		t.respond(
			fauxAssistantMessage([fauxToolCall("write", { file_path: first, content: "a" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
			fauxAssistantMessage([fauxToolCall("write", { file_path: second, content: "b" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		);
		await t.send("s1", { id: "p1", type: "prompt", message: "one" });
		const dialog = await t.waitFor(() => dialogs(t.records("s1"))[0]);
		await t.send("s1", { type: "extension_ui_response", id: dialog.id, value: workspaceAllowLabel("write") });
		await t.waitFor(() => settledCount(t.records("s1")) === 1);
		await t.send("s1", { id: "p2", type: "prompt", message: "two" });
		await t.waitFor(() => settledCount(t.records("s1")) === 2);
		assert.equal(dialogs(t.records("s1")).length, 1, "second write needs no approval");
		assert.ok(existsSync(second));
	});

	it("notifies when a dialog opens and no window watches the session", async () => {
		await open();
		await t.core.call("slot.detach", { slotId: "s1" }, t.client);
		t.respond(fauxAssistantMessage([fauxToolCall("pwsh", { description: "Write a file", command: "Set-Content x.txt hi" })], { stopReason: "toolUse" }), fauxAssistantMessage("done"));
		await t.core.slot("s1").handle({ id: "p", type: "prompt", message: "run" });
		await t.waitFor(() => t.core.confirmations.list({ status: "pending" })[0]);
		assert.equal(t.notifier.sent.length, 1);
		assert.match(t.notifier.sent[0]!.title, /批准/);

		// Re-attaching replays the pending dialog.
		const attached = (await t.core.call("slot.attach", { slotId: "s1" }, t.client)) as { replay: Record<string, unknown>[] };
		assert.equal(dialogs(attached.replay).length, 1);
	});

	it("reuses the slot that already has a session file open", async () => {
		const info = await open("s1");
		const again = (await t.core.call("slot.open", { slotId: "s2", cwd: t.workspace, sessionFile: info.sessionFile }, t.client)) as SlotInfo;
		assert.equal(again.slotId, "s1");
		assert.equal(t.core.slots.size, 1);
	});

	it("reaps idle slots nobody watches, keeps watched ones", async () => {
		await open("watched");
		await open("orphan");
		await t.core.call("slot.detach", { slotId: "orphan" }, t.client);
		await t.core.reapIdle(Date.now() + 60 * 60_000);
		assert.deepEqual([...t.core.slots.keys()], ["watched"]);
		assert.ok(t.messages.some((m) => m.event === "slot.closed" && m.slotId === "orphan"));
	});

	it("asks for workspace trust through the session's dialog channel", async () => {
		mkdirSync(join(t.workspace, ".pi"), { recursive: true });
		writeFileSync(join(t.workspace, ".pi", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1000 } }));
		const opening = open("trusted");
		const dialog = await t.waitFor(() => dialogs(t.records("trusted"))[0]);
		assert.ok(String(dialog.title).startsWith(TRUST_TITLE));
		const pending = t.core.confirmations.list({ status: "pending" });
		assert.equal(pending[0]!.kind, "trust");
		await t.send("trusted", { type: "extension_ui_response", id: dialog.id, value: TRUST_ONCE });
		const info = await opening;
		assert.equal(info.slotId, "trusted");

		// "Trust once" holds for the rest of this core run: a second session does not ask again.
		await open("second");
		assert.equal(dialogs(t.records("second")).length, 0);
	});

	it("navigates the session tree in place (branch within one session)", async () => {
		await open();
		t.respond(fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer"));
		await t.send("s1", { id: "p1", type: "prompt", message: "first question" });
		await t.waitFor(() => settledCount(t.records("s1")) === 1);
		await t.send("s1", { id: "p2", type: "prompt", message: "second question" });
		await t.waitFor(() => settledCount(t.records("s1")) === 2);

		await t.send("s1", { id: "fm", type: "get_fork_messages" });
		const forkMessages = await t.waitFor(() => t.records("s1").find((r) => r.id === "fm"));
		const second = (forkMessages.data as { messages: { entryId: string; text: string }[] }).messages.find((m) => m.text === "second question")!;
		await t.send("s1", { id: "nav", type: "df_navigate_tree", entryId: second.entryId });
		const nav = await t.waitFor(() => t.records("s1").find((r) => r.id === "nav"));
		assert.equal((nav.data as { editorText: string }).editorText, "second question");

		t.respond(fauxAssistantMessage("alternative answer"));
		await t.send("s1", { id: "p3", type: "prompt", message: "second question, rephrased" });
		await t.waitFor(() => settledCount(t.records("s1")) === 3);
		await t.send("s1", { id: "tree", type: "get_tree" });
		const tree = await t.waitFor(() => t.records("s1").find((r) => r.id === "tree"));
		const text = JSON.stringify(tree.data);
		assert.ok(text.includes("second question, rephrased") && text.includes("second answer"), "both branches stay in the file");
	});

	it("reports edited messages as switchable versions", async () => {
		await open();
		t.respond(fauxAssistantMessage("a1"), fauxAssistantMessage("a2"), fauxAssistantMessage("a2 v2"));
		await t.send("s1", { id: "p1", type: "prompt", message: "q1" });
		await t.waitFor(() => settledCount(t.records("s1")) === 1);
		await t.send("s1", { id: "p2", type: "prompt", message: "q2" });
		await t.waitFor(() => settledCount(t.records("s1")) === 2);

		const branches = async (id: string) => {
			await t.send("s1", { id, type: "df_branches" });
			return ((await t.waitFor(() => t.records("s1").find((r) => r.id === id))).data as { branches: { entryId: string; index: number; total: number; targets: string[] }[] }).branches;
		};
		const before = await branches("b1");
		assert.deepEqual(before.map((b) => b.total), [1, 1]);

		// Edit q2: navigate to it, then send the edited text as a sibling.
		await t.send("s1", { id: "nav", type: "df_navigate_tree", entryId: before[1]!.entryId });
		await t.waitFor(() => t.records("s1").find((r) => r.id === "nav"));
		await t.send("s1", { id: "p3", type: "prompt", message: "q2 edited" });
		await t.waitFor(() => settledCount(t.records("s1")) === 3);

		const after = await branches("b2");
		assert.equal(after.length, 2);
		assert.deepEqual([after[1]!.index, after[1]!.total], [1, 2], "the edited version is current, 2 of 2");
		assert.equal(after[1]!.targets.length, 2);

		// Switch back to version 1: the leaf moves to the end of the original branch.
		await t.send("s1", { id: "back", type: "df_navigate_tree", entryId: after[1]!.targets[0] });
		await t.waitFor(() => t.records("s1").find((r) => r.id === "back"));
		const original = await branches("b3");
		assert.deepEqual([original[1]!.index, original[1]!.total], [0, 2]);
		await t.send("s1", { id: "msgs", type: "get_messages" });
		const msgs = (await t.waitFor(() => t.records("s1").find((r) => r.id === "msgs"))).data as { messages: { role: string; content: unknown }[] };
		assert.match(JSON.stringify(msgs.messages.at(-1)!.content), /a2"/);

		// The whole tree: q1, then q2 and its edited sibling both under q1.
		await t.send("s1", { id: "tree", type: "df_tree" });
		const nodes = ((await t.waitFor(() => t.records("s1").find((r) => r.id === "tree"))).data as { nodes: { entryId: string; parentId: string | null; text: string; active: boolean; target: string }[] }).nodes;
		assert.deepEqual(nodes.map((n) => n.text), ["q1", "q2", "q2 edited"]);
		assert.equal(nodes[0]!.parentId, null);
		assert.deepEqual([nodes[1]!.parentId, nodes[2]!.parentId], [nodes[0]!.entryId, nodes[0]!.entryId]);
		assert.deepEqual(nodes.map((n) => n.active), [true, true, false], "version 1 is shown");
		assert.equal(nodes[2]!.target, after[1]!.targets[1], "opening a node shows its latest continuation");
	});

	it("keeps temporary chats in memory only", async () => {
		const info = (await t.core.call("slot.open", { slotId: "tmp", cwd: t.workspace, incognito: true }, t.client)) as SlotInfo;
		assert.equal(info.incognito, true);
		t.respond(fauxAssistantMessage("ok"));
		await t.send("tmp", { id: "p", type: "prompt", message: "secret stuff" });
		await t.waitFor(() => settledCount(t.records("tmp")) === 1);
		const { readdirSync } = await import("node:fs");
		const files = readdirSync(t.sessionDir, { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl"));
		assert.deepEqual(files, []);
	});

	it("opens a side conversation: the session so far, in memory, the source untouched (0.4)", async () => {
		const info = await open();
		t.respond(fauxAssistantMessage("报告的结论是 A"));
		await t.send("s1", { id: "p", type: "prompt", message: "总结报告" });
		await t.waitFor(() => settledCount(t.records("s1")) === 1);
		const before = readFileSync(info.sessionFile!, "utf8");

		const side = (await t.core.call("slot.open", { slotId: "side", cwd: t.workspace, incognito: true, forkOf: info.sessionFile }, t.client)) as SlotInfo;
		assert.equal(side.incognito, true);
		assert.ok(!side.sessionFile, "nothing on disk");
		assert.equal(side.forkOf, info.sessionFile, "marked as a side conversation, so a window never reattaches it as one of its own");
		assert.equal(info.forkOf, null);
		let seen: string[] = [];
		t.respond((context) => {
			seen = context.messages.map((m) => JSON.stringify(m.content));
			return fauxAssistantMessage("A 的意思是……");
		});
		await t.send("side", { id: "q", type: "prompt", message: "结论 A 是什么意思" });
		await t.waitFor(() => settledCount(t.records("side")) === 1);
		assert.ok(seen.some((c) => c.includes("总结报告")) && seen.some((c) => c.includes("报告的结论是 A")), "the side conversation sees the main one");
		assert.equal(readFileSync(info.sessionFile!, "utf8"), before, "the main session is not written to");
		await t.send("side", { id: "st", type: "get_state" });
		const state = (await t.waitFor(() => t.records("side").find((r) => r.id === "st"))).data as { sessionId: string };
		await t.send("s1", { id: "st", type: "get_state" });
		const main = (await t.waitFor(() => t.records("s1").find((r) => r.id === "st"))).data as { sessionId: string };
		assert.notEqual(state.sessionId, main.sessionId, "its own id");

		await assert.rejects(t.core.call("slot.open", { slotId: "bad", cwd: t.workspace, incognito: true, forkOf: join(t.dir, "nope.jsonl") }, t.client), /不存在/);
	});

	it("exports the conversation as Markdown", async () => {
		await open();
		t.respond(fauxAssistantMessage("答案是 42"));
		await t.send("s1", { id: "p", type: "prompt", message: "问题" });
		await t.waitFor(() => settledCount(t.records("s1")) === 1);
		const out = join(t.dir, "out.md");
		await t.send("s1", { id: "x", type: "df_export", format: "markdown", outputPath: out });
		await t.waitFor(() => t.records("s1").find((r) => r.id === "x"));
		const markdown = readFileSync(out, "utf8");
		assert.match(markdown, /## 用户\n\n问题/);
		assert.match(markdown, /答案是 42/);
	});

	it("sends images to the model even when Pi's settings block them", async () => {
		// The v0.1.1 bug: the user's Pi settings had images.blockImages = true.
		writeFileSync(join(t.agentDir, "settings.json"), JSON.stringify({ images: { blockImages: true } }));
		await open();
		let seen: unknown;
		t.respond((context) => {
			seen = context.messages.findLast((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((c) => c.type === "image"))?.content;
			return fauxAssistantMessage("一张图");
		});
		// A valid 8x8 PNG: Pi decodes images to resize them.
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4IyKCFTEMLQkAmD9BAZzFjLYAAAAASUVORK5CYII=";
		const image = { type: "image", data: png, mimeType: "image/png" };
		await t.send("s1", { id: "p", type: "prompt", message: "看图", images: [image] });
		await t.waitFor(() => settledCount(t.records("s1")) === 1);
		const content = seen as { type: string; text?: string; data?: string }[];
		assert.ok(Array.isArray(content));
		assert.ok(content.some((c) => c.type === "image" && c.data === png), JSON.stringify(content));
		assert.ok(!content.some((c) => c.text === "Image reading is disabled."));
	});
});

describe("recovery", () => {
	it("marks runs and dialogs left by a dead core as interrupted / expired", async () => {
		const first = await startTestCore();
		await first.core.call("slot.open", { slotId: "s1", cwd: first.workspace }, first.client);
		first.respond(fauxAssistantMessage([fauxToolCall("pwsh", { description: "Write a file", command: "Set-Content x.txt hi" })], { stopReason: "toolUse" }));
		await first.send("s1", { id: "p", type: "prompt", message: "运行命令" });
		await first.waitFor(() => first.core.confirmations.list({ status: "pending" })[0]);

		// Simulate a crash: a second core opens the same data dir while the first never shut down.
		const { startTestCore: again } = await import("./harness.ts");
		const second = await again(first.dir);
		try {
			assert.equal(second.core.interruptedAtStartup.length, 1);
			assert.equal(second.core.interruptedAtStartup[0]!.prompt, null);
			const hello = (await second.core.call("core.hello", {}, second.client)) as { interruptedRuns: unknown[]; pendingConfirmations: unknown[] };
			assert.equal(hello.interruptedRuns.length, 1);
			assert.equal(hello.pendingConfirmations.length, 0);
			assert.equal(second.core.confirmations.list({ status: "expired" }).length, 1);
		} finally {
			await first.core.shutdown();
			await second.cleanup();
		}
	});
});

describe("settings", () => {
	it("validates and persists updates", async () => {
		const t = await startTestCore();
		try {
			t.core.settings.update({ approvalMode: "all", memoryBudgetTokens: -5, bogus: 1, fallbackModels: ["a/b"] });
			assert.equal(t.core.settings.get().approvalMode, "all");
			assert.equal(t.core.settings.get().memoryBudgetTokens, 2000);
			assert.deepEqual(t.core.settings.get().fallbackModels, ["a/b"]);
			assert.ok(t.messages.some((m) => m.event === "settings.changed"));
			const reopened = await t.reopen();
			assert.equal(reopened.core.settings.get().approvalMode, "all");
			await reopened.cleanup();
		} catch (error) {
			await t.cleanup();
			throw error;
		}
	});
});

describe("question versions", () => {
	it("an edited question is a version even when a title landed at the branch point", () => {
		const manager = SessionManager.inMemory(tmpdir());
		const user = (text: string) => manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as never);
		const reply = (text: string) => manager.appendMessage(fauxAssistantMessage(text) as never);
		user("q1");
		const a1 = reply("a1");
		user("写星空");
		reply("星空");
		// The user edits the second question: the leaf goes back to a1, and the
		// automatic title arrives right then, before the edited question.
		manager.branch(a1);
		manager.appendSessionInfo("仰望星空");
		user("改成写月亮");
		reply("月亮");
		const branches = userBranches({ sessionManager: manager } as never);
		assert.deepEqual(
			branches.map((b) => [b.index, b.total]),
			[
				[0, 1],
				[1, 2],
			],
		);
	});
});
