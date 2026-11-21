import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { GoalsModule, type GoalScheduler } from "../src/modules/goals.ts";
import { settledCount, startTestCore } from "./harness.ts";

type GoalDetail = ReturnType<GoalScheduler["detail"]>;

function reply(response: ServerResponse, delta: Record<string, unknown>, end = "stop") {
	response.writeHead(200, { "content-type": "text/event-stream" });
	const common = { id: "goal-wire", object: "chat.completion.chunk", created: 1, model: "goal-model" };
	for (const event of [
		{ ...common, choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] },
		{ ...common, choices: [{ index: 0, delta: {}, finish_reason: end }] },
		{ ...common, choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
	]) response.write(`data: ${JSON.stringify(event)}\n\n`);
	response.end("data: [DONE]\n\n");
}

function call(index: number, id: string, name: string, args: Record<string, unknown>) {
	return { index, id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

test("the existing goal RPC uses DSH, retains its budget gate and checks permitted file access", { timeout: 45_000 }, async () => {
	const fixture = await startTestCore(undefined, { dshWorkbench: true });
	const allowed = join(fixture.workspace, "allowed");
	const sample = join(allowed, "document.txt");
	const outside = join(fixture.workspace, "outside.txt");
	const requests: { messages: { role: string; content: unknown }[]; tools?: unknown[] }[] = [];
	const server = createServer(async (request, response) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk as Buffer);
			const body = JSON.parse(Buffer.concat(chunks).toString()) as (typeof requests)[number];
			requests.push(body);
			const finalInput = body.messages.at(-1)?.content;
			const text = typeof finalInput === "string" ? finalInput : Array.isArray(finalInput)
				? finalInput.map(block => (block as { text?: string }).text ?? "").join("") : "";
			if (text.includes('"evidence_version"')) {
				const evidence = JSON.parse(text) as { revision: number; evidence_version: number };
				reply(response, { content: JSON.stringify({ verdict: "done", revision: evidence.revision, evidence_version: evidence.evidence_version, next: "", missing: [], questions: [] }) });
			} else if (requests.length === 1) {
				reply(response, { tool_calls: [call(0, "call_goal", "goal_status", {}), call(1, "call_outside", "read", { file_path: outside })] }, "tool_calls");
			} else if (requests.length === 2) {
				reply(response, { tool_calls: [call(0, "call_allowed", "read", { file_path: sample })] }, "tool_calls");
			} else if (requests.length === 3) {
				reply(response, { content: "[目标已完成]\n已核对允许范围内的样本。" });
			} else response.writeHead(400).end();
		} catch { response.destroy(); }
	});
	try {
		await mkdir(allowed);
		await writeFile(sample, "DSH-GOAL-ALLOWED-SAMPLE");
		await writeFile(outside, "DSH-GOAL-OUTSIDE-SENTINEL");
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const { id } = await fixture.core.call("gateway.saveChannel", {
			name: "loopback goal", api: "openai-completions", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
			models: [{ id: "goal-model", contextWindow: 32_000, maxTokens: 2048, cost: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 } }],
			keys: [{ secret: "synthetic-loopback-only" }],
		}, fixture.client) as { id: string };
		fixture.core.settings.update({ defaultModel: `df-${id}/goal-model` });
		const goal = await fixture.core.call("goals.create", {
			title: "核对合成样本", originText: "在授权目录内核对样本", mandateRef: "user:dsh-goal-fixture", spec: { objective: "核对样本" },
			scope: { cwd: fixture.workspace, allowedTools: ["read"], allowedPaths: [allowed] }, budget: { maxCostUsd: 0.000001, maxRuns: 1 },
		}, fixture.client) as GoalDetail;
		const scheduler = fixture.core.module(GoalsModule)!.scheduler;
		const paused = await fixture.waitFor(() => {
			const detail = scheduler.detail(goal.id);
			return detail.reason === "budget_cost" && detail;
		});
		assert.equal(paused.budgetStatus.used.runs, 0);
		assert.equal(requests.length, 0);
		assert.equal(fixture.core.ledger!.entries().length, 0);

		await fixture.core.call("goals.budget", { id: goal.id, budget: { maxCostUsd: 0.15 } }, fixture.client);
		await fixture.core.call("goals.control", { id: goal.id, action: "resume" }, fixture.client);
		const completed = await fixture.waitFor(() => {
			const detail = scheduler.detail(goal.id);
			return detail.completed && detail;
		});
		assert.equal(completed.budgetStatus.used.runs, 1);
		assert.equal(requests.length, 4);
		assert.match(JSON.stringify(requests[0]?.tools), /goal_status/);
	assert.match(JSON.stringify(requests[1]), /工具调用超出目标授权范围/);
		assert.match(JSON.stringify(requests[2]), /DSH-GOAL-ALLOWED-SAMPLE/);
		assert.doesNotMatch(JSON.stringify(requests), /DSH-GOAL-OUTSIDE-SENTINEL/);
	const sessionFile = fixture.core.db.get<{ session_file: string | null }>(
		"SELECT session_file FROM tasks WHERE goal_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", goal.id)?.session_file;
		assert.ok(sessionFile);
	assert.ok((await readFile(sessionFile, "utf8")).includes('"customType":"df.dshSession"'), "goal history must point to the official DSH session");
		const receipts = scheduler.receipts(goal.id, completed.revision);
		assert.ok(receipts.some(receipt => receipt.tool === "goal_status" && receipt.ok));
		assert.ok(receipts.some(receipt => receipt.tool === "read" && receipt.ok));
		const charges = scheduler.ledger.entries(goal.id, 10);
		assert.equal(charges.filter(charge => charge.kind === "main" && charge.state === "settled").length, 3);
		assert.equal(charges.filter(charge => charge.kind === "review" && charge.state === "settled").length, 1);
	} finally {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
		await fixture.cleanup();
	}
});

test("a bound goal borrows an existing DSH conversation and releases its tools when it finishes", async () => {
	const fixture = await startTestCore(undefined, { dshWorkbench: true });
	try {
		const slotId = "goal-overlay";
		await fixture.core.call("slot.open", { slotId, cwd: fixture.workspace, agentMode: "minimal" }, fixture.client);
		fixture.respond(fauxAssistantMessage("目标之前的普通回复"));
		await fixture.send(slotId, { id: "ordinary", type: "prompt", message: "目标之前的普通问题" });
		await fixture.waitFor(() => settledCount(fixture.records(slotId)) === 1);
		const slot = fixture.core.slots.get(slotId)!;
		const sessionFile = slot.info().sessionFile;
		assert.ok(sessionFile && slot.hasDshHistory());

		let goalContext = "";
		fixture.respond(context => {
			goalContext = JSON.stringify(context.messages);
			return fauxAssistantMessage([fauxToolCall("goal_status", {})], { stopReason: "toolUse" });
		}, fauxAssistantMessage("[目标已完成]\n已核对"), context => {
			const last = context.messages.at(-1)?.content;
			const input = typeof last === "string" ? last : last?.map(block => "text" in block ? block.text : "").join("") ?? "";
			const { revision, evidence_version } = JSON.parse(input);
			return fauxAssistantMessage(JSON.stringify({ verdict: "done", revision, evidence_version, next: "", missing: [], questions: [] }));
		});
		const goal = await fixture.core.call("goals.create", { title: "绑定目标", originText: "核对合成材料", sessionFile, mandateRef: "user:overlay-fixture",
			spec: { objective: "核对合成材料" }, scope: { allowedTools: [] } }, fixture.client) as GoalDetail;
		const scheduler = fixture.core.module(GoalsModule)!.scheduler;
		await fixture.waitFor(() => scheduler.detail(goal.id).completed && !slot.running);
		assert.match(goalContext, /目标之前的普通回复/);
		assert.match(goalContext, /goal_status/);
		assert.doesNotMatch(goalContext, /working_directory/);
		assert.ok(scheduler.receipts(goal.id, goal.revision).some(receipt => receipt.tool === "goal_status" && receipt.ok));

		const priorTurns = settledCount(fixture.records(slotId));
		let restoredTools: string[] = [];
		fixture.respond(context => {
			restoredTools = context.messages.filter(message => message.role === "system").flatMap(message => message.toolsAdded?.map(tool => tool.name) ?? []);
			return fauxAssistantMessage("回到普通工作台");
		});
		await fixture.send(slotId, { id: "after-goal", type: "prompt", message: "继续普通对话" });
		await fixture.waitFor(() => settledCount(fixture.records(slotId)) === priorTurns + 1);
		assert.ok(restoredTools.includes("working_directory"));
		assert.equal(restoredTools.some(name => name.startsWith("goal_")), false);
		assert.equal(slot.info().sessionFile, sessionFile);
	} finally { await fixture.cleanup(); }
});
