import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { test } from "node:test";
import { fauxAssistantMessage, type Model, type Usage } from "@earendil-works/pi-ai";
import { CATALOG_VERSION, PRICE_RULES, ruleMultiplier } from "../src/ledger/rules.ts";
import { PURPOSES, withLedgerContext } from "../src/ledger/types.ts";
import { Llm } from "../src/modules/llm.ts";
import { settledCount, startTestCore } from "./harness.ts";

const model = { id: "model", provider: "synthetic", api: "openai-completions", name: "Synthetic", baseUrl: "https://opencode.ai/inference/openai/v1", reasoning: true, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 2 } } as Model<any>;
const usage: Usage = { input: 100, output: 30, cacheRead: 50, cacheWrite: 10, reasoning: 20, totalTokens: 190, cost: { input: 0.0001, output: 0.00012, cacheRead: 0.000005, cacheWrite: 0.00002, total: 0.000245 } };
function answer(at: number, values: Usage = structuredClone(usage)) { return { ...fauxAssistantMessage("Synthetic OK"), provider: model.provider, model: model.id, timestamp: at, usage: values }; }

test("ledger splits cross-day and cross-month long runs by request time, without run-summary double counting or mixed-currency addition", async () => {
	const t = await startTestCore();
	try {
		const ledger = t.core.ledger!, before = Date.parse("2026-10-31T23:59:59+08:00"), after = before + 2000;
		for (const at of [before, after]) { const id = ledger.begin(model, { purpose: "conversation", runId: "long-run" }, at); ledger.finish(id, model, answer(at), {}, after + 1000); }
		ledger.tool("search", { at: after, completedAt: after + 1, provider: "deepseek", purpose: "web_search", success: true, amount: 0.005, currency: "CNY", source: "official-2026-11-07" });
		const rows = ledger.summary({ period: "month", groupBy: "all", timeZone: "Asia/Taipei" }).rows;
		assert.deepEqual(rows.map((r) => r.period), ["2026-10", "2026-11"]); assert.equal(rows[0]!.requests, 1); assert.equal(rows[1]!.requests, 2);
		assert.equal(rows[1]!.amounts.CNY, 0.005); assert.equal(rows[1]!.amounts.USD, 0.000245);
		assert.equal(t.core.runs.costSince(after), 0.000245); assert.equal(rows[0]!.reasoning, 20); assert.equal(rows[0]!.output, 30, "reasoning is already included in output");
	} finally { await t.cleanup(); }
});

test("ledger uses provider actual cost once, plan allowance separately and records missing final usage without invented tokens", async () => {
	const t = await startTestCore();
	try {
		const ledger = t.core.ledger!, at = Date.now();
		const actual = ledger.begin(model, {}, at); ledger.finish(actual, model, answer(at), { actual: 0.0007, currency: "USD", opencode: { billing_source: "balance" } });
		ledger.finish(actual, model, answer(at), { actual: 0.0007, currency: "USD" });
		const plan = ledger.begin(model); ledger.finish(plan, model, answer(at), { actual: 0, currency: "USD", opencode: { allowance: 0.12, billing_source: "go" } });
		const missing = ledger.begin(model); ledger.finish(missing, model, { ...answer(at), stopReason: "aborted", usage: { ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
		const rows = ledger.entries(); assert.equal(rows.length, 3);
		assert.equal(rows.find((r) => r.id === actual)!.amount, 0.0007); assert.equal(rows.find((r) => r.id === actual)!.amount_source, "provider_actual");
		assert.equal(rows.find((r) => r.id === plan)!.allowance, 0.12); assert.equal(rows.find((r) => r.id === plan)!.amount, 0); assert.equal(rows.find((r) => r.id === plan)!.amount_source, "plan_occupancy");
		assert.equal(rows.find((r) => r.id === missing)!.amount, null); assert.equal(rows.find((r) => r.id === missing)!.input, null); assert.equal(rows.find((r) => r.id === missing)!.amount_source, "missing");
	} finally { await t.cleanup(); }
});

test("official GLM plan off-peak boundaries use UTC+8 weekdays and never discount actual money or other providers", async () => {
	const r = PRICE_RULES[0]!;
	for (const [date, factor] of [["2026-11-09T13:59:59+08:00", 0.5], ["2026-11-09T14:00:00+08:00", 1], ["2026-11-09T17:59:59+08:00", 1], ["2026-11-09T18:00:00+08:00", 0.5], ["2026-11-07T14:30:00+08:00", 0.5], ["2026-11-09T06:00:00Z", 1]] as const) assert.equal(ruleMultiplier(Date.parse(date), r), factor, date);
	assert.equal(r.timeZone, "Asia/Shanghai"); assert.match(r.source, /^https:\/\/docs.bigmodel.cn\//);
	const t = await startTestCore();
	try {
		const ledger = t.core.ledger!;
		const id = ledger.begin(model, {}, Date.parse("2026-11-09T13:59:59+08:00")); ledger.finish(id, model, answer(Date.now()), { actual: 1, currency: "USD" });
		assert.equal(ledger.entries()[0]!.amount, 1); assert.equal(ledger.entries()[0]!.price_version, CATALOG_VERSION);
	} finally { await t.cleanup(); }
});

test("history import is idempotent across copies/forks and links live metadata without charging a rebuilt index", async () => {
	const t = await startTestCore();
	try {
		const ledger = t.core.ledger!, at = Date.now(), id = ledger.begin(model, {}, at), message = answer(at); ledger.finish(id, model, message);
		for (const [path, entry, time, u] of [["copy-a", "live", at, message.usage], ["copy-b", "live", at, message.usage], ["old-a", "historical", at - 10000, usage], ["old-b", "historical", at - 10000, usage]] as const) {
			ledger.linkIndex(entry, time, model.provider, model.id, u);
			t.core.db.run("INSERT INTO usage_records VALUES(?,?,?,?,?,?,?,?,?,?,?)", path, entry, time, "synthetic workspace", model.provider, model.id, u.input, u.output, u.cacheRead, u.cacheWrite, u.cost.total);
		}
		assert.equal(ledger.importHistory().imported, 1); assert.equal(ledger.importHistory().imported, 0); assert.equal(ledger.entries().length, 2);
		t.core.db.run("DELETE FROM usage_records"); assert.equal(ledger.entries().length, 2, "rebuilding/deleting the source index never deletes request facts");
		assert.equal(ledger.entries().filter((r) => r.origin === "historical").length, 1);
	} finally { await t.cleanup(); }
});

test("public runtime observes all purposes once, with retry IDs and real session/run associations", async () => {
	const t = await startTestCore();
	try {
		await t.core.call("slot.open", { slotId: "accounted", cwd: t.workspace }, t.client);
		t.respond({ ...fauxAssistantMessage("Synthetic main"), usage: { ...usage } });
		await t.send("accounted", { id: "p", type: "prompt", message: "synthetic request" }); await t.waitFor(() => settledCount(t.records("accounted")) === 1);
		const main = t.core.ledger!.entries().find((r) => r.purpose === "conversation")!;
		assert.ok(main); assert.ok(main.run_id); assert.ok(main.session_id); assert.equal(main.workspace, t.workspace);
		const runtime = t.core.slots.get("accounted")!.session.modelRuntime, faux = runtime.getModel("faux", "faux-1")!;
		for (const purpose of PURPOSES.filter((p) => !["web_fetch", "web_search", "conversation"].includes(p))) {
			t.respond({ ...fauxAssistantMessage("Synthetic auxiliary"), usage: { ...usage } });
			await withLedgerContext({ purpose, workspace: t.workspace, sessionId: null, runId: `synthetic-${purpose}` }, () => runtime.completeSimple(faux, { messages: [] }));
		}
		t.respond({ ...fauxAssistantMessage("Synthetic retry"), usage: { ...usage } }, { ...fauxAssistantMessage("Synthetic retry"), usage: { ...usage } });
		const llm = new Llm(t.core, () => runtime); await llm.complete("synthetic"); await llm.complete("synthetic");
		const rows = t.core.ledger!.entries(); assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
		for (const purpose of PURPOSES.filter((p) => !p.startsWith("web_"))) assert.ok(rows.some((r) => r.purpose === purpose), purpose);
		await t.core.call("usage.summary", { groupBy: "day" }); assert.equal(t.core.ledger!.entries().length, rows.length, "fresh assistant history links to the existing request");
	} finally { await t.cleanup(); }
});

test("pending requests become missing on restart instead of estimating an interrupted invoice", async () => {
	const t = await startTestCore();
	try {
		const id = t.core.ledger!.begin(model); t.core.ledger!.start(); const row = t.core.ledger!.entries().find((r) => r.id === id)!;
		assert.equal(row.state, "missing"); assert.equal(row.amount, null); assert.equal(row.input, null); assert.equal(row.error_code, "process_interrupted");
	} finally { await t.cleanup(); }
});

test("real local SSE supplies official raw cost/allowance once; a truncated stream remains missing", async () => {
	let calls = 0;
	const server = createServer(async (_request, response) => {
		calls++; response.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (data: unknown) => response.write(`data: ${JSON.stringify(data)}\n\n`);
		chunk({ id: "synthetic-response", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] });
		if (calls === 2) { setTimeout(() => response.destroy(), 10); return; }
		chunk({ id: "synthetic-response", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
		chunk({ id: "synthetic-response", object: "chat.completion.chunk", created: 1, model: "model", choices: [], usage: { prompt_tokens: 150, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 50 }, completion_tokens_details: { reasoning_tokens: 20 }, cost: 0.00412, opencode: { billing_source: "go", allowance: 0.12, tokens: { input: 100, output: 30, reasoning: 20, cache_read: 50, cache_write_5m: 0, cache_write_1h: 0 } } } });
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const t = await startTestCore();
	try {
		const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(t.agentDir, "sse-auth.json"), refreshOnCreate: false });
		const localUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
		runtime.registerProvider("opencode-go", { api: "openai-completions", baseUrl: localUrl, apiKey: "T68_SYNTHETIC_SSE_KEY", models: [{ ...model, baseUrl: localUrl, name: "Synthetic", input: ["text"], cost: model.cost }] });
		t.core.ledger!.install(runtime, () => ({ purpose: "auxiliary" }));
		const physical = runtime.getModel("opencode-go", "model")!;
		assert.equal(new URL(physical.baseUrl).hostname, "127.0.0.1");
		const localOnly = { maxRetries: 0, onPayload: (_payload: unknown, actual: Model<any>) => { assert.equal(new URL(actual.baseUrl).hostname, "127.0.0.1", "mock requests must never leave localhost"); } };
		await runtime.completeSimple(physical, { messages: [{ role: "user", content: "synthetic", timestamp: Date.now() }] }, localOnly);
		await runtime.completeSimple(physical, { messages: [{ role: "user", content: "synthetic", timestamp: Date.now() }] }, localOnly);
		const rows = t.core.ledger!.entries(); assert.equal(rows.length, 2); assert.equal(calls, 2);
		const success = rows.find((r) => r.success === 1)!; assert.equal(success.amount, 0.00412); assert.equal(success.amount_source, "provider_actual"); assert.equal(success.allowance, 0.12);
		assert.equal(success.input, 100); assert.equal(success.cache_read, 50); assert.equal(success.output, 30); assert.equal(success.reasoning, 20); assert.ok(success.ttft_ms !== null);
		const missing = rows.find((r) => r.success === 0)!; assert.equal(missing.amount, null); assert.equal(missing.input, null); assert.equal(missing.state, "missing");
	} finally { await t.cleanup(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
});

test("official off-peak rules estimate GLM plan points only, with immutable request-time rule versions", async () => {
	const t = await startTestCore();
	try {
		t.core.db.run("INSERT INTO gateway_channels(id,name,platform,kind,api,base_url,created_at) VALUES('glm-rule','Synthetic','glm-coding','plan','openai-completions','https://example.invalid',1)");
		const glm = { ...model, provider: "df-glm-rule", id: "glm-5.3" }, u = { ...structuredClone(usage), cacheWrite: 0 };
		const peak = Date.parse("2026-11-09T14:00:00+08:00"), off = peak - 1;
		for (const at of [off, peak]) { const id = t.core.ledger!.begin(glm, {}, at); t.core.ledger!.finish(id, glm, { ...answer(at, { ...u }), provider: glm.provider, model: glm.id }, {}, peak + 100); }
		const rows = t.core.ledger!.entries().sort((a, b) => a.requested_at - b.requested_at);
		assert.equal(rows[0]!.allowance, 0.07475); assert.equal(rows[1]!.allowance, 0.1495); assert.equal(rows[0]!.allowance_unit, "GLM_POINTS");
		assert.equal(rows[0]!.amount, null); assert.equal(rows[0]!.allowance_source, "local_estimate"); assert.equal(rows[0]!.price_version, PRICE_RULES[0]!.version);
	} finally { await t.cleanup(); }
});
