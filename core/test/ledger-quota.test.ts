import assert from "node:assert/strict";
import { test } from "node:test";
import { MINIMAX_CURRENT, MINIMAX_LEGACY, readQuota } from "../src/gateway/quota.ts";
import { Gateway } from "../src/gateway/gateway.ts";
import { startTestCore } from "./harness.ts";

const response = (body: unknown): typeof fetch => async () => Response.json(body);
test("F60-03 rejects absent, null, string, NaN, infinity and out-of-range percentages instead of 0 percent", async () => {
	for (const percentage of [undefined, null, "20", NaN, Infinity, -1, 101]) {
		const r = await readQuota("glm-quota", "https://example.invalid", "SYNTHETIC", response({ data: { limits: [{ percentage, unit: 3, number: 5 }] } }));
		assert.equal(r.type, "error"); if (r.type === "error") { assert.match(r.message, /未知/); assert.equal(r.observed?.windows?.[0]?.usedPercent, null); }
	}
	const zero = await readQuota("glm-quota", "https://example.invalid", "SYNTHETIC", response({ data: { limits: [{ percentage: 0 }] } }));
	assert.equal(zero.type, "plan"); if (zero.type === "plan") assert.equal(zero.windows[0]!.usedPercent, 0);
});

test("F60-04 preserves all currencies and exposes malformed amounts without coercing missing values to zero", async () => {
	const multi = await readQuota("deepseek-balance", "https://example.invalid", "SYNTHETIC", response({ balance_infos: [{ currency: "CNY", total_balance: "12.30" }, { currency: "USD", total_balance: "1.25" }] }));
	assert.equal(multi.type, "balance"); if (multi.type === "balance") assert.deepEqual(multi.balances, [{ currency: "CNY", amount: 12.3 }, { currency: "USD", amount: 1.25 }]);
	for (const bad of [undefined, null, "", " ", "bad", "NaN", "Infinity", -1, Number.MAX_SAFE_INTEGER + 1, false]) {
		const r = await readQuota("deepseek-balance", "https://example.invalid", "SYNTHETIC", response({ balance_infos: [{ currency: "CNY", total_balance: bad }, { currency: "USD", total_balance: "2" }] }));
		assert.equal(r.type, "error"); if (r.type === "error") { assert.equal(r.observed?.balances?.[0]?.amount, null); assert.equal(r.observed?.balances?.[1]?.amount, 2); }
	}
});

test("F60-02 keeps a working legacy endpoint and probes only availability at the official new endpoint", async () => {
	const urls: string[] = [];
	const legacy: typeof fetch = async (url) => { urls.push(String(url)); return Response.json({ data: { current_interval_total_count: 100, current_interval_usage_count: 25 } }); };
	const good = await readQuota("minimax-remains", "https://example.invalid", "SYNTHETIC", legacy);
	assert.equal(good.type, "plan"); assert.deepEqual(urls, [MINIMAX_LEGACY]);
	urls.length = 0;
	const probe: typeof fetch = async (url) => { urls.push(String(url)); return String(url) === MINIMAX_LEGACY ? new Response("", { status: 404 }) : Response.json({ data: { current_interval_total_count: 100, current_interval_usage_count: 25, unknown_new_window: "synthetic" } }); };
	const next = await readQuota("minimax-remains", "https://example.invalid", "SYNTHETIC", probe);
	assert.deepEqual(urls, [MINIMAX_LEGACY, MINIMAX_CURRENT]); assert.equal(next.type, "error");
	if (next.type === "error") { assert.match(next.message, /未知/); assert.equal(next.capability?.available, true); assert.equal(next.capability?.schema, "undocumented"); }
});

test("F60-02 malformed legacy counts and expired windows never produce a fabricated zero percent", async () => {
	for (const data of [{ current_interval_total_count: 0, current_interval_usage_count: 0 }, { current_interval_total_count: 10, current_interval_usage_count: 20 }, { current_interval_total_count: 10, current_interval_usage_count: null }, { current_interval_total_count: 10, current_interval_usage_count: 5, expired_time: 1 }]) {
		const r = await readQuota("minimax-remains", "https://example.invalid", "SYNTHETIC", response({ data })); assert.equal(r.type, "error");
	}
});

test("quota errors preserve the last valid cached reading and are independently visible", async () => {
	let broken = false;
	const t = await startTestCore(undefined, { gatewayTransport: undefined });
	try {
		const gateway = t.core.module(Gateway)!;
		// Use the existing public refresh path with a local mock server, never real credentials or endpoints.
		const { createServer } = await import("node:http");
		const server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: broken ? "invalid" : "8.00" }] })); });
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		try {
			const id = await gateway.saveChannel({ name: "Synthetic", platform: "deepseek", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, api: "openai-completions", models: [{ id: "model" }], keys: [{ secret: "T68_SYNTHETIC_QUOTA_KEY" }] });
			await gateway.refreshQuotas(id); assert.equal(gateway.status().find((r) => r.id === id)!.quota?.type, "balance");
			broken = true; await gateway.refreshQuotas(id);
			const status = gateway.status().find((r) => r.id === id)!;
			assert.equal(status.quota?.type, "balance"); if (status.quota?.type === "balance") assert.equal(status.quota.amount, 8);
			assert.equal(status.quotaError?.type, "error"); assert.match(status.quotaError!.message, /未知/);
		} finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
	} finally { await t.cleanup(); }
});
