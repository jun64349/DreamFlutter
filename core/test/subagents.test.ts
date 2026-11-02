import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { BUILT_IN_ROLES, roleTools } from "../src/agent/roles.ts";
import { ALLOW } from "../src/pi/dialogs.ts";
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
