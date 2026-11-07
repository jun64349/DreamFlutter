import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import { DeepSeekWebClient, validateSearch, type DeepSeekWebOptions } from "../src/web/deepseek.ts";
import type { Attempt } from "../src/web/types.ts";

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>, options: DeepSeekWebOptions = {}) {
	const server = createServer(handler);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const port = (server.address() as { port: number }).port;
	const client = new DeepSeekWebClient({ retryDelayMs: 1, ...options, fetch: (url, init) => {
		assert.match(String(url), /^https:\/\/api\.deepseek\.com\/v1\/tools\/(search|fetch)$/);
		return fetch(`http://127.0.0.1:${port}${new URL(String(url)).pathname}`, init);
	} });
	return { client, close: async () => { client.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } };
}

test("web search: validates Unicode length and count without silently truncating", () => {
	assert.equal(validateSearch({ query: "字".repeat(128) }).query.length, 128);
	assert.equal([...validateSearch({ query: "🦋".repeat(128) }).query].length, 128);
	assert.deepEqual(validateSearch({ query: " x " }), { query: " x ", count: 10, need_content: false });
	for (const input of [{ query: " " }, { query: "x".repeat(129) }, { query: "🦋".repeat(129) }, { query: "x", count: 0 }, { query: "x", count: 51 }, { query: "x", count: 1.5 }]) assert.throws(() => validateSearch(input));
});

test("web search: success, empty search, successful and empty fetch have the documented billing flags", async () => {
	const bodies: unknown[] = [];
	const f = await fixture(async (req, res) => {
		assert.equal(req.headers.authorization, "Bearer T64_SYNTHETIC_KEY");
		let body = ""; for await (const chunk of req) body += chunk;
		const input = JSON.parse(body); bodies.push(input);
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(req.url!.endsWith("search") ? { results: input.query === "empty" ? [] : [{ title: "标题", url: "https://example.com", summary: "摘要", content: input.need_content ? "正文" : "", site_name: "站点", date: null }] } : { title: "抓取", content: input.url.endsWith("empty") ? "" : "正文" }));
	});
	const attempts: Attempt[] = [];
	try {
		const search = await f.client.search({ query: "成功", need_content: true, count: 2 }, "T64_SYNTHETIC_KEY", undefined, (a) => attempts.push(a));
		assert.equal(search[0]!.content, "正文");
		assert.deepEqual(await f.client.search({ query: "empty" }, "T64_SYNTHETIC_KEY", undefined, (a) => attempts.push(a)), []);
		await f.client.fetch("https://example.com/page", "T64_SYNTHETIC_KEY", undefined, (a) => attempts.push(a));
		await f.client.fetch("https://example.com/empty", "T64_SYNTHETIC_KEY", undefined, (a) => attempts.push(a));
		assert.deepEqual(attempts.map((a) => a.billable), [true, false, true, false]);
		assert.deepEqual(bodies[1], { query: "empty", count: 10, need_content: false });
	} finally { await f.close(); }
});

test("web search: maps authentication, balance, target rejection and service errors without echoing credentials", async () => {
	let status = 401;
	const f = await fixture((_req, res) => { res.writeHead(status); res.end('Bearer T64_SYNTHETIC_KEY'); });
	try {
		for (const [code, message] of [[401, "密钥"], [402, "余额不足"], [403, "拒绝"], [404, "不存在"], [408, "超时"], [500, "不可用"], [504, "超时"]] as const) {
			status = code; const attempts: Attempt[] = [];
			await assert.rejects(f.client.search({ query: "synthetic" }, "T64_SYNTHETIC_KEY", undefined, (a) => attempts.push(a)), new RegExp(message));
			assert.equal(attempts.length, 1); assert.equal(attempts[0]!.billable, false); assert.ok(!JSON.stringify(attempts).includes("T64_SYNTHETIC_KEY"));
		}
	} finally { await f.close(); }
});

test("web search: 429 retries at most twice and bills only a later successful result", async () => {
	let requests = 0, recover = true;
	const f = await fixture((_req, res) => {
		requests++;
		if (!recover || requests < 3) { res.writeHead(429).end(); return; }
		res.end(JSON.stringify({ results: [{ title: "result", url: "https://example.com", summary: "text" }] }));
	});
	try {
		const attempts: Attempt[] = [];
		await f.client.search({ query: "retry" }, "synthetic", undefined, (a) => attempts.push(a));
		assert.equal(requests, 3); assert.deepEqual(attempts.map((a) => a.billable), [false, false, true]);
		requests = 0; recover = false;
		await assert.rejects(f.client.search({ query: "retry" }, "synthetic", undefined, () => {}), /限流/); assert.equal(requests, 3);
	} finally { await f.close(); }
});

test("web search: timeout, user cancellation and oversized successful bodies stop reading", async () => {
	let oversize = false;
	const f = await fixture((_req, res) => { if (oversize) res.end(JSON.stringify({ results: ["x".repeat(1000)] })); }, { timeoutMs: 80, maxBytes: 80 });
	try {
		await assert.rejects(f.client.search({ query: "timeout" }, "synthetic", undefined, () => {}), /超时/);
		const abort = new AbortController();
		const cancelled = f.client.search({ query: "cancel" }, "synthetic", abort.signal, () => {}); abort.abort();
		await assert.rejects(cancelled, /取消/);
		oversize = true; const attempts: Attempt[] = [];
		await assert.rejects(f.client.search({ query: "oversize" }, "synthetic", undefined, (a) => attempts.push(a)), /大小上限/);
		assert.equal(attempts[0]!.billable, null, "a 200 body that cannot be inspected must not be advertised as supplier-confirmed free");
	} finally { await f.close(); }
});

test("web search: concurrent network requests are bounded and queued cancellation releases its place", async () => {
	let active = 0, peak = 0;
	const f = await fixture(async (_req, res) => {
		active++; peak = Math.max(peak, active);
		await new Promise((done) => setTimeout(done, 25));
		active--; res.end('{"results":[]}');
	}, { concurrency: 2 });
	try {
		const controller = new AbortController();
		const calls = Array.from({ length: 6 }, (_, index) => f.client.search({ query: String(index) }, "synthetic", index === 5 ? controller.signal : undefined, () => {}));
		controller.abort();
		const results = await Promise.allSettled(calls);
		assert.equal(results.filter((r) => r.status === "fulfilled").length, 5); assert.ok(peak <= 2);
		await f.client.search({ query: "after cancellation" }, "synthetic", undefined, () => {});
	} finally { await f.close(); }
});
