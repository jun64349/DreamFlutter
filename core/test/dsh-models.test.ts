import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { dshModelPlugin } from "../src/dsh/models.ts";
import { installDshSessions } from "../src/dsh/session.ts";
import type { ChannelInput, Gateway } from "../src/gateway/gateway.ts";
import { ledgerContext, withLedgerContext } from "../src/ledger/types.ts";
import { completeModel, Llm } from "../src/modules/llm.ts";
import { runMemoryAgent } from "../src/memory/agent.ts";
import { startTestCore } from "./harness.ts";

const modelDetails = { contextWindow: 32000, maxTokens: 1024, cost: { input: 1, output: 4, cacheRead: 0.2, cacheWrite: 2 } };

function sse(response: ServerResponse, events: { type: string }[]) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	response.end();
}

function respond(response: ServerResponse, path: string, model: string) {
	if (path === "/messages/v1/messages") {
		const events = [
			{ type: "message_start", message: { id: "dsh-primary", model, usage: { input_tokens: 20, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "主渠道回复。" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } },
			{ type: "message_stop" },
		];
		sse(response, events);
		return;
	}
	if (path === "/responses/v1/responses") {
		const text = "备用渠道回复。";
		const item = { id: "msg_dsh", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
		const events = [
			{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { id: "resp_dsh", model, output: [item], status: "completed", usage: {
				input_tokens: 50, input_tokens_details: { cached_tokens: 20 }, output_tokens: 10,
				output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 60,
			} } },
		];
		sse(response, events);
		return;
	}
	if (path === "/chat/v1/chat/completions") {
		response.writeHead(200, { "content-type": "text/event-stream" });
		const common = { id: "chat-dsh", object: "chat.completion.chunk", created: 1, model };
		for (const event of [
			{ ...common, choices: [{ index: 0, delta: { role: "assistant", content: "直连渠道回复。" }, finish_reason: null }] },
			{ ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			{ ...common, choices: [], usage: { prompt_tokens: 25, completion_tokens: 5, total_tokens: 30 } },
		]) response.write(`data: ${JSON.stringify(event)}\n\n`);
		response.end("data: [DONE]\n\n");
		return;
	}
	response.writeHead(404).end();
}

test("official DSH Agent uses existing configured channels, restores a model group, and writes the workspace ledger", async () => {
	const fixture = await startTestCore();
	const ctx = new Context();
	const requests: { path: string; body: Record<string, unknown>; auth: unknown }[] = [];
	const server = createServer(async (request, response) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk as Buffer);
			const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
			const path = new URL(request.url ?? "/", "http://localhost").pathname;
			const auth = request.headers.authorization ?? request.headers["x-api-key"];
			requests.push({ path, body, auth });
			if (auth === "Bearer fixture-invalid-key") {
				response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "invalid API key" } }));
				return;
			}
			respond(response, path, String(body.model));
		} catch { response.destroy(); }
	});
	try {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		const channel = async (name: string, api: ChannelInput["api"], suffix: string, ...secrets: string[]) => {
			const input = { name, api, baseUrl: `${base}/${suffix}`, models: [{ id: `${name}-model`, ...modelDetails }], keys: secrets.map(secret => ({ secret })) };
			const { id } = await fixture.core.call("gateway.saveChannel", input, fixture.client) as { id: string };
			return { ...input, id };
		};
		const primary = await channel("primary", "anthropic-messages", "messages", "fixture-messages-key");
		const secondary = await channel("secondary", "openai-responses", "responses/v1", "fixture-responses-key");
		const direct = await channel("direct", "openai-completions", "chat/v1", "fixture-invalid-key", "fixture-chat-key");
		await fixture.core.call("gateway.saveGroup", { id: "poc-group", name: "模型组", entries: [
			{ channel: secondary.id, model: "secondary-model", priority: 1, weight: 0 },
			{ channel: primary.id, model: "primary-model", priority: 0, weight: 0 },
		] }, fixture.client);
		const gateway = fixture.core.cordis.get("dfGateway") as Gateway;
		assert.ok(gateway);
		const createRuntime = async (signal?: AbortSignal) => {
			const runtime = await ModelRuntime.create({ authPath: join(fixture.agentDir, "auth.json"), modelsPath: join(fixture.agentDir, "models.json"), refreshOnCreate: false });
			signal?.throwIfAborted();
			gateway.installRuntime(runtime);
			return runtime;
		};
		await ctx.plugin(LlmRuntime);
		await ctx.plugin(dshModelPlugin, { runtime: createRuntime });
		const sessions = await installDshSessions(ctx, { root: join(fixture.dir, "official-sessions") });
		const events: SessionEvent[] = [];
		const noOp = () => {};
		const group = { provider: "dreamflutter", model: "poc-group" };
		const start = async (id: string, model: typeof group, resume = false) => {
			await ctx.dreamflutterModels.refresh();
			return sessions.open({ id, model, cwd: fixture.workspace, resume, onEvent: event => { events.push(event); }, onStream: noOp, onStatus: noOp });
		};
		const unbindGroup = ctx.dreamflutterModels.bindSession("dsh-model-group", () => ({ runId: "group-run", slotId: "group-slot", workspace: fixture.workspace }));
		const first = await start("dsh-model-group", group);
		first.send([{ type: "text", text: "首轮内容七号。" }], false);
		await first.agent.whenIdle();
		await first.dispose();
		assert.ok(events.some(event => event.type === "assistant/message" && JSON.stringify(event).includes("主渠道回复。")), JSON.stringify(events.slice(-4)));

		const key = gateway.channel(primary.id)!.keys[0]!;
		await fixture.core.call("gateway.saveChannel", { ...primary, enabled: false, keys: [{ id: key.id }] }, fixture.client);
		const restored = await start("dsh-model-group", group, true);
		restored.send([{ type: "text", text: "恢复后继续。" }], false);
		await restored.agent.whenIdle();
		await restored.dispose();
		assert.ok(JSON.stringify(events).includes("备用渠道回复。"));
		assert.match(JSON.stringify(requests[1]?.body), /首轮内容七号。/);
		assert.match(JSON.stringify(requests[1]?.body), /主渠道回复。/);
		assert.match(JSON.stringify(requests[1]?.body), /恢复后继续。/);
		const routeChange = fixture.messages.find(message => message.event === "gateway.switched");
		assert.equal(routeChange?.sessionId, "dsh-model-group");
		assert.equal(routeChange?.from, "primary · primary-model");
		assert.equal(routeChange?.to, "secondary · secondary-model");
		await fixture.core.call("gateway.saveChannel", { ...primary, enabled: true, keys: [{ id: key.id }] }, fixture.client);
		const sticky = await start("dsh-model-group", group, true);
		sticky.send([{ type: "text", text: "保持上一轮渠道。" }], false);
		await sticky.agent.whenIdle();
		await sticky.dispose();
		unbindGroup();
		assert.equal(requests[2]?.body.model, "secondary-model", "resumed branch should stay on its last successful route");

		const guardedRuntime = await createRuntime();
		const stream = guardedRuntime.streamSimple.bind(guardedRuntime);
		let guardAllows = false;
		guardedRuntime.streamSimple = (...args) => {
			assert.equal(ledgerContext().slotId, "guarded-slot");
			if (!guardAllows) throw new Error("会话请求未通过预算检查");
			return stream(...args);
		};
		const unbindDirect = ctx.dreamflutterModels.bindSession("dsh-direct", () => ({ slotId: "guarded-slot" }), () => guardedRuntime);
		const physical = await start("dsh-direct", { provider: `df-${direct.id}`, model: "direct-model" });
		physical.send([{ type: "text", text: "请求应被既有传输守卫拦截。" }], false);
		await physical.agent.whenIdle();
		assert.match(JSON.stringify(events.at(-1)), /会话请求未通过预算检查/);
		assert.equal(requests.length, 3);
		assert.equal(fixture.core.ledger!.entries().length, 3);
		guardAllows = true;
		physical.send([{ type: "text", text: "使用直连。" }], false);
		await physical.agent.whenIdle();
		await physical.dispose();
		unbindDirect();
		assert.ok(JSON.stringify(events).includes("直连渠道回复。"));
		assert.deepEqual(requests.map(request => [request.path, request.body.model, request.auth]), [
			["/messages/v1/messages", "primary-model", "fixture-messages-key"],
			["/responses/v1/responses", "secondary-model", "Bearer fixture-responses-key"],
			["/responses/v1/responses", "secondary-model", "Bearer fixture-responses-key"],
			["/chat/v1/chat/completions", "direct-model", "Bearer fixture-invalid-key"],
			["/chat/v1/chat/completions", "direct-model", "Bearer fixture-chat-key"],
		]);
		const ledger = fixture.core.ledger!.entries();
		assert.equal(ledger.length, 5);
		assert.ok(ledger.some(row => row.channel === direct.id && row.state === "missing" && row.success === 0));
		assert.deepEqual(fixture.core.db.all<{ group_id: string; session_id: string }>("SELECT group_id,session_id FROM gateway_requests WHERE channel=? ORDER BY id", secondary.id)
			.map(row => [row.group_id, row.session_id]), [["poc-group", "dsh-model-group"], ["poc-group", "dsh-model-group"]]);
		const fallback = ledger.find(row => row.channel === secondary.id);
		assert.deepEqual([fallback?.session_id, fallback?.run_id, fallback?.slot_id, fallback?.workspace, fallback?.purpose],
			["dsh-model-group", "group-run", "group-slot", fixture.workspace, "conversation"]);
		assert.deepEqual([fallback?.input, fallback?.output, fallback?.reasoning, fallback?.cache_read, fallback?.amount, fallback?.amount_source],
			[30, 10, 2, 20, 0.000074, "price_estimate"]);
	} finally {
		await ctx.fiber.dispose();
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
		await fixture.cleanup();
	}
});

test("auxiliary tasks use the official local LLM, scope image bytes to the request, and bill memory tools exactly once", async t => {
	const fixture = await startTestCore(undefined, { dshWorkbench: true });
	t.after(() => fixture.cleanup());
	const slot = await fixture.core.openSlot({ slotId: "aux-test", cwd: fixture.workspace, client: fixture.client });
	const runtime = slot.session.modelRuntime;
	const model = runtime.getModel("faux", "faux-1")! as Model<never>;
	const service = t.mock.method(fixture.core.cordis.llm, "stream");
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==";
	const llm = new Llm(fixture.core, () => runtime);
	const storedFiles = async () => (await readdir(join(fixture.sessionDir, ".dsh"), { recursive: true }).catch((): string[] => []))
		.filter(file => /\.(?:png|jpe?g|webp|jsonl)$/i.test(file)).sort();
	const before = await storedFiles();
	fixture.respond(context => {
		assert.ok(context.messages.some(message => message.role === "system" && JSON.stringify(message.content).includes("Read exactly one figure")));
		assert.ok(context.messages.some(message => message.role === "user" && Array.isArray(message.content) &&
			message.content.some(block => block.type === "image" && block.data === png)));
		return fauxAssistantMessage("  figure seen  ");
	});
	const answer = await llm.complete([{ type: "text", text: "See attached" }, { type: "image", mimeType: "image/png", data: png }],
		{ model, runtime, system: "Read exactly one figure", maxTokens: 37, context: { purpose: "vision", runId: "aux-figure" } });
	assert.equal(answer, "figure seen");
	assert.equal(service.mock.calls[0]?.arguments[0].maxTokens, 37);
	assert.equal(service.mock.calls[0]?.arguments[0].sessionId, undefined);
	assert.equal(service.mock.calls[0]?.arguments[0].signal instanceof AbortSignal, true);
	let queried = 0;
	fixture.respond(context => {
		assert.ok(context.messages.some(message => message.role === "system" && message.toolsAdded?.some(tool => tool.name === "memory_query")));
		return fauxAssistantMessage([fauxToolCall("memory_query", { query: "fixture" })], { stopReason: "toolUse" });
	}, context => {
		const tool = context.messages.at(-1);
		assert.equal(tool?.role, "toolResult");
		assert.ok(tool?.role === "toolResult" && tool.toolName === "memory_query" && JSON.stringify(tool.content).includes("fixture-only"));
		return fauxAssistantMessage("finished");
	});
	const memory = await withLedgerContext({ purpose: "memory", runId: "aux-memory" }, () => runMemoryAgent({
		runtime, model, system: "Organize", input: "Search once", handlers: { query: () => { queried++; return "fixture-only"; }, propose: () => "" },
		complete: (context, options) => completeModel(fixture.core, runtime, model, context, options),
	}));
	assert.equal(queried, 1);
	assert.deepEqual([memory.turns, memory.summary], [2, "finished"]);
	assert.equal(service.mock.callCount(), 3);
	assert.deepEqual(fixture.core.ledger!.entries().filter(row => row.run_id?.startsWith("aux-")).map(row => [row.purpose, row.run_id]).sort(),
		[["memory", "aux-memory"], ["memory", "aux-memory"], ["vision", "aux-figure"]]);
	const terminalOnly = t.mock.method(runtime, "streamSimple", () => {
		const stream = createAssistantMessageEventStream();
		const message = fauxAssistantMessage("模型一次性返回的完整回复");
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
		return stream;
	});
	assert.equal(await llm.complete("one complete event", { runtime, model }), "模型一次性返回的完整回复");
	terminalOnly.mock.restore();
	assert.deepEqual(await storedFiles(), before);
});
