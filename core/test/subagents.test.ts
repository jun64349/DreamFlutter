import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { BUILT_IN_ROLES, roleTools } from "../src/agent/roles.ts";
import { ALLOW } from "../src/pi/dialogs.ts";
import { SubagentsModule } from "../src/modules/subagents.ts";
import { dialogs, settledCount, startTestCore, type TestCore } from "./harness.ts";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join("") : "";
}

/** Tools a request declares (Pi 1.4 carries them in system messages). */
function toolsOf(context: Context): string[] {
	const tools = new Set<string>();
	for (const m of context.messages as unknown as { role: string; toolsAdded?: { name: string }[]; toolsRemoved?: string[] }[]) {
		if (m.role !== "system") continue;
		for (const t of m.toolsAdded ?? []) tools.add(t.name);
		for (const name of m.toolsRemoved ?? []) tools.delete(name);
	}
	return [...tools];
}

describe("subagents (v0.3 3.4)", () => {
	let t: TestCore;
	beforeEach(async () => {
		t = await startTestCore();
		t.core.settings.update({ approvalMode: "off" });
	});
	afterEach(async () => {
		await t.cleanup();
	});

	it("runs two subagents side by side in fresh contexts and hands their replies back", async () => {
		const childTools: string[][] = [];
		const childTasks: string[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		// One answer for every request: the parent, then the children (in any order), then the parent again.
		const route = async (context: Context) => {
			const messages = context.messages.filter((m) => (m.role as string) !== "system");
			const last = messages.at(-1)!;
			const task = messages.find((m) => m.role === "user" && textOf(m.content).includes("## Task"));
			if (task) {
				const text = textOf(task.content);
				childTools.push(toolsOf(context));
				childTasks.push(text);
				assert.ok(!messages.some((m) => textOf(m.content).includes("分头查")), "a subagent never sees the parent conversation");
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((r) => setTimeout(r, 50));
				inFlight--;
				return fauxAssistantMessage(text.includes("甲") ? "结果甲：在 a.txt" : "结果乙：在 b.txt");
			}
			if (last.role === "toolResult") return fauxAssistantMessage("两个都查完了");
			return fauxAssistantMessage(
				[
					fauxToolCall("agent", { role: "explore", description: "查甲", prompt: "找甲在哪个文件" }),
					fauxToolCall("agent", { role: "explore", description: "查乙", prompt: "找乙在哪个文件" }),
				],
				{ stopReason: "toolUse" },
			);
		};
		t.respond(route as never, route as never, route as never, route as never);
		await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
		await t.send("s1", { id: "p", type: "prompt", message: "分头查一下甲和乙" });
		await t.waitFor(() => settledCount(t.records("s1")) === 1, 15_000);

		assert.equal(maxInFlight, 2, "both ran at the same time");
		assert.equal(childTasks.length, 2);
		for (const tools of childTools) {
			assert.ok(tools.includes("read") && tools.includes("grep"), `explore reads: ${tools}`);
			for (const banned of ["agent", "write", "edit", "pwsh", "ask_user_question", "todo_write"]) assert.ok(!tools.includes(banned), `explore has no ${banned}`);
		}
		const ends = t.records("s1").filter((r) => r.type === "tool_execution_end" && r.toolName === "agent");
		assert.equal(ends.length, 2);
		const results = ends.map((e) => e.result as { content: { text: string }[]; details: { status: string; role: string; turns: number } });
		assert.deepEqual(results.map((r) => r.content[0]!.text).sort(), ["结果乙：在 b.txt", "结果甲：在 a.txt"]);
		for (const r of results) {
			assert.equal(r.details.status, "done");
			assert.equal(r.details.role, "explore");
			assert.equal(r.details.turns, 1);
		}
		const updates = t.records("s1").filter((r) => r.type === "tool_execution_update" && r.toolName === "agent");
		assert.ok(updates.length > 0, "the window sees progress");
	});

	it("asks in the main conversation before a subagent writes, naming the subagent", async () => {
		t.core.settings.update({ approvalMode: "changes" });
		const target = join(t.workspace, "notes.txt");
		const route = (context: Context) => {
			const messages = context.messages.filter((m) => (m.role as string) !== "system");
			const last = messages.at(-1)!;
			const isChild = messages.some((m) => m.role === "user" && textOf(m.content).includes("## Task"));
			if (isChild) {
				return last.role === "toolResult" ? fauxAssistantMessage("写好了 notes.txt") : fauxAssistantMessage([fauxToolCall("write", { file_path: target, content: "hi" })], { stopReason: "toolUse" });
			}
			if (last.role === "toolResult") return fauxAssistantMessage("完成");
			return fauxAssistantMessage([fauxToolCall("agent", { description: "写笔记", prompt: "把 hi 写进 notes.txt" })], { stopReason: "toolUse" });
		};
		t.respond(route as never, route as never, route as never, route as never);
		await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
		await t.send("s1", { id: "p", type: "prompt", message: "记一下" });
		const dialog = await t.waitFor(() => dialogs(t.records("s1"))[0], 10_000);
		assert.match(String(dialog.title), /^Agent 请求执行操作/);
		assert.match(String(dialog.title), /来自子 Agent「通用 · 写笔记」/);
		await t.send("s1", { type: "extension_ui_response", id: dialog.id, value: ALLOW });
		await t.waitFor(() => settledCount(t.records("s1")) === 1, 10_000);
		assert.equal(readFileSync(target, "utf8"), "hi");
		const run = t.core.runs.list({ limit: 1 })[0]!;
		assert.deepEqual(run.files, [target], "the subagent's files count toward the run");
	});

	it("an unknown role is an error the main agent can read", async () => {
		t.respond(fauxAssistantMessage([fauxToolCall("agent", { role: "nobody", description: "x", prompt: "y" })], { stopReason: "toolUse" }), fauxAssistantMessage("好"));
		await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
		await t.send("s1", { id: "p", type: "prompt", message: "试试" });
		await t.waitFor(() => settledCount(t.records("s1")) === 1, 10_000);
		const end = t.records("s1").find((r) => r.type === "tool_execution_end" && r.toolName === "agent")!;
		assert.equal(end.isError, true);
		assert.match(textOf((end.result as { content: unknown }).content), /role/);
	});

	it("role cards never hand out nesting, questions, plans or todos", () => {
		const all = ["agent", "ask_user_question", "edit", "exit_plan_mode", "read", "todo_write", "write", "pwsh"];
		assert.deepEqual(roleTools(BUILT_IN_ROLES.find((r) => r.id === "general")!, all), ["edit", "read", "write", "pwsh"]);
		assert.deepEqual(roleTools(BUILT_IN_ROLES.find((r) => r.id === "explore")!, all), ["read"]);
	});
});

describe("official DSH subagents", () => {
	let t: TestCore;
	beforeEach(async () => { t = await startTestCore(undefined, { dshWorkbench: true }); });
	afterEach(async () => { await t.cleanup(); });

	it("uses an independent in-memory AgentLoop with a role tool list and per-step limit", async () => {
		t.core.settings.update({ approvalMode: "off" });
		const target = join(t.workspace, "role-fixture.txt");
		writeFileSync(target, "子工作结果样本");
		await t.core.call("slot.open", { slotId: "parent", cwd: t.workspace }, t.client);
		t.respond(fauxAssistantMessage("父历史回复"));
		await t.send("parent", { id: "initial", type: "prompt", message: "父会话独有内容" });
		await t.waitFor(() => settledCount(t.records("parent")) === 1, 10_000);
		const root = t.core.sessionDir!;
		const files = () => readdirSync(root, { recursive: true, withFileTypes: true }).filter(file => file.isFile()).map(file => file.name).sort();
		const initial = files();
		const module = t.core.module(SubagentsModule)!;
		const sessions = t.core.dshBackend!.sessions!.temporary!;
		const originalOpen = sessions.open.bind(sessions);
		let nativeCalls = 0;
		sessions.open = options => { nativeCalls++; return originalOpen(options); };
		let modelCalls = 0;
		t.respond((context: Context) => {
			modelCalls++;
			const transcript = JSON.stringify(context.messages);
			assert.match(transcript, /## Task.+仅查看样本/);
			assert.doesNotMatch(transcript, /父会话独有内容|父历史回复/);
			const names = [...(context.tools?.map(tool => tool.name) ?? []), ...toolsOf(context)];
			assert.ok(names.includes("read"));
			for (const banned of ["agent", "write", "edit", "pwsh", "memory_search"]) assert.ok(!names.includes(banned));
			return fauxAssistantMessage([fauxText("已定位 role-fixture.txt"), fauxToolCall("read", { file_path: target })], { stopReason: "toolUse" });
		}, context => {
			modelCalls++;
			assert.match(JSON.stringify(context.messages), /This is your final request/);
			assert.match(JSON.stringify(context.messages), /子工作结果样本/);
			assert.ok(!((context as Context).tools ?? []).some(tool => tool.name === "read"));
			return fauxAssistantMessage([fauxToolCall("read", { file_path: target })], { stopReason: "toolUse" });
		});
		const role = { ...BUILT_IN_ROLES.find(role => role.id === "explore")!, maxTurns: 2 };
		const result = await module.run("parent", "child-budget", role, "受限读取", "仅查看样本", t.workspace, t.core.slot("parent").session.model, undefined, undefined);
		assert.equal(nativeCalls, 1);
		assert.equal(modelCalls, 2);
		assert.equal(result.details.status, "stopped");
		assert.equal(result.details.stoppedBy, "maxTurns");
		assert.equal(result.details.turns, 2);
		assert.equal(result.details.error, undefined, result.details.error);
		assert.equal(result.details.resultKind, "partial");
		assert.match(result.content[0]!.text, /2 轮上限。以下是阶段记录[^]*已定位 role-fixture\.txt/);
		assert.deepEqual(files(), initial);
	});

	it("accepts a final report on the last allowed request", async () => {
		const role = { ...BUILT_IN_ROLES.find(role => role.id === "explore")!, maxTurns: 1 };
		await t.core.call("slot.open", { slotId: "parent", cwd: t.workspace }, t.client);
		t.respond(fauxAssistantMessage("现有证据只支持甲，乙仍需核对。"));
		const result = await t.core.module(SubagentsModule)!.run("parent", "child-final", role, "汇报", "用已有证据汇报", t.workspace,
			t.core.slot("parent").session.model, undefined, undefined);
		assert.equal(result.details.status, "done");
		assert.equal(result.details.turns, 1);
		assert.equal(result.details.stoppedBy, undefined);
		assert.equal(result.details.resultKind, "final");
		assert.equal(result.content[0]!.text, "现有证据只支持甲，乙仍需核对。");
	});

	it("does not list a failed child's write as a changed file", async () => {
		t.core.settings.update({ approvalMode: "off" });
		await t.core.call("slot.open", { slotId: "parent", cwd: t.workspace }, t.client);
		t.respond(
			fauxAssistantMessage([fauxToolCall("agent", { description: "试写", prompt: "尝试写目标" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("write", { file_path: t.workspace, content: "不会写入" })], { stopReason: "toolUse" }),
			context => {
				assert.equal(context.messages.findLast(message => message.role === "toolResult")?.isError, true);
				return fauxAssistantMessage("目标是目录，未写入。");
			},
			fauxAssistantMessage("已收到子 Agent 的结果。"),
		);
		await t.send("parent", { id: "p", type: "prompt", message: "交子 Agent 尝试写入" });
		await t.waitFor(() => settledCount(t.records("parent")) === 1, 10_000);
		assert.deepEqual(t.core.runs.list({ limit: 1 })[0]!.files, []);
	});

	it("requests parental approval for DSH writes and stops a DSH request on cancellation", async () => {
		t.core.settings.update({ approvalMode: "changes" });
		const target = join(t.workspace, "approval-fixture.txt");
		const module = t.core.module(SubagentsModule)!;
		const role = BUILT_IN_ROLES.find(role => role.id === "general")!;
		await t.core.call("slot.open", { slotId: "parent", cwd: t.workspace }, t.client);
		const model = t.core.slot("parent").session.model;
		t.respond(fauxAssistantMessage([fauxToolCall("write", { file_path: target, content: "经批准" })], { stopReason: "toolUse" }), fauxAssistantMessage("已完成"));
		const child = module.run("parent", "child-approval", role, "批准样本", "经批准后写入样本", t.workspace, model, undefined, undefined);
		const dialog = await t.waitFor(() => dialogs(t.records("parent"))[0], 10_000);
		assert.match(String(dialog.title), /来自子 Agent「通用 · 批准样本」/);
		assert.equal(existsSync(target), false);
		await t.send("parent", { type: "extension_ui_response", id: dialog.id, value: ALLOW });
		const done = await child;
		assert.equal(done.details.turns, 2);
		assert.equal(done.details.status, "done");
		assert.equal(readFileSync(target, "utf8"), "经批准");
		assert.match(done.content[0]!.text, /已完成/);
		const stop = new AbortController();
		let called!: () => void;
		const dispatched = new Promise<void>(resolve => { called = resolve; });
		t.respond(async (_context, options) => {
			called();
			await new Promise<void>(resolve => {
				if (options?.signal?.aborted) resolve();
				else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return fauxAssistantMessage("取消后的替身回复", { stopReason: "aborted" });
		});
		const pending = module.run("parent", "child-stop", role, "停止样本", "等待取消", t.workspace, model, stop.signal, undefined);
		await dispatched;
		stop.abort();
		const cancelled = await pending;
		assert.equal(cancelled.details.status, "stopped");
		assert.equal(cancelled.details.stoppedBy, "aborted");
	});

	it("returns both children concurrently with replayable role, usage and step details", async () => {
		t.core.settings.update({ approvalMode: "off" });
		let childrenInFlight = 0;
		let peak = 0;
		const route = async (context: Context) => {
			const child = context.messages.find(message => message.role === "user" && textOf(message.content).includes("## Task"));
			if (child) {
				const task = textOf(child.content);
				childrenInFlight++;
				peak = Math.max(peak, childrenInFlight);
				await new Promise(resolve => setTimeout(resolve, 180));
				childrenInFlight--;
				return fauxAssistantMessage(task.includes("甲") ? "结果甲" : "结果乙");
			}
			if (context.messages.some(message => message.role === "toolResult")) return fauxAssistantMessage("父会话完成");
			return fauxAssistantMessage([
				fauxToolCall("agent", { role: "explore", description: "子甲", prompt: "处理甲" }),
				fauxToolCall("agent", { role: "explore", description: "子乙", prompt: "处理乙" }),
			], { stopReason: "toolUse" });
		};
		await t.core.call("slot.open", { slotId: "parent", cwd: t.workspace }, t.client);
		t.respond(route, route, route, route);
		await t.send("parent", { id: "p", type: "prompt", message: "分开处理两个问题" });
		await t.waitFor(() => settledCount(t.records("parent")) === 1, 10_000);
		assert.equal(peak, 2);
		const results = t.records("parent").filter(record => record.type === "tool_execution_end" && record.toolName === "agent");
		assert.equal(results.length, 2);
		for (const response of results) {
			const result = response.result as { content: { text: string }[]; details: { status: string; role: string; turns: number } };
			assert.match(result.content[0]!.text, /结果[甲乙]/);
			assert.equal(result.details.status, "done");
			assert.equal(result.details.role, "explore");
			assert.equal(result.details.turns, 1);
		}
		const run = t.core.runs.list({ limit: 1 })[0]!;
		assert.equal(t.core.db.all("SELECT id FROM request_ledger WHERE purpose='subagent' AND run_id=?", run.id).length, 2);
	});
});
