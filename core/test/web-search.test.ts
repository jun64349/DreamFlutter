import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { WebSearchModule } from "../src/modules/search.ts";
import { requireRemoteWebUrl } from "../src/modules/web.ts";
import { SecretStore } from "../src/modules/secrets.ts";
import { roleById, roleTools } from "../src/agent/roles.ts";
import { isReadOnlyCall } from "../src/ext/approval.ts";
import { redact } from "../src/security/redaction.ts";
import { Logger } from "../src/log.ts";
import { dialogs, settledCount, startTestCore } from "./harness.ts";

function toolsOf(context: Context): Set<string> {
	const names = new Set<string>();
	for (const message of context.messages as unknown as { role: string; toolsAdded?: { name: string }[]; toolsRemoved?: string[] }[]) {
		if (message.role !== "system") continue;
		for (const item of message.toolsAdded ?? []) names.add(item.name);
		for (const name of message.toolsRemoved ?? []) names.delete(name);
	}
	return names;
}

test("web search: remote target validation rejects private/local/credential URLs before any upload", async () => {
	for (const url of ["file:///tmp/a", "http://localhost/private", "http://127.0.0.1/a", "http://[::1]/a", "http://192.168.1.1/a", "http://169.254.169.254/a", "http://10.0.0.1/a", "http://user:password@example.com/a"]) await assert.rejects(requireRemoteWebUrl(url));
	assert.equal((await requireRemoteWebUrl("https://8.8.8.8/public")).hostname, "8.8.8.8");
});

test("web search: unconfigured tool and guidance are absent; separate key enables existing idle chats, deletion removes it", { skip: process.platform !== "win32" }, async () => {
	let calls = 0;
	const t = await startTestCore(undefined, { webSearch: { fetch: async () => { calls++; return Response.json({ results: [{ title: "Synthetic", url: "https://example.com", summary: "synthetic summary", site_name: "Synthetic source", date: null }] }); } } });
	try {
		t.core.settings.update({ approvalMode: "changes" });
		await t.core.call("slot.open", { slotId: "web", cwd: t.workspace }, t.client);
		const seen: Context[] = [];
		const capture = (context: Context) => { seen.push(context); return fauxAssistantMessage("done"); };
		t.respond(capture); await t.send("web", { id: "p1", type: "prompt", message: "catalogue" }); await t.waitFor(() => settledCount(t.records("web")) === 1);
		assert.equal(toolsOf(seen[0]!).has("web_search"), false); assert.doesNotMatch(seen[0]!.systemPrompt ?? "", /web_search/); assert.equal(calls, 0);
		const key = "T64_SYNTHETIC_SEPARATE_OFFICIAL_KEY";
		const saved = await t.core.call("webSearch.saveKey", { key });
		assert.ok(!JSON.stringify(saved).includes(key));
		assert.ok(!readFileSync(new SecretStore(t.core.paths.dataDir).fileFor("web-search-deepseek-official"), "utf8").includes(key));
		assert.notEqual(redact(key), key);
		t.respond(fauxAssistantMessage([fauxToolCall("web_search", { query: "synthetic", count: 1 })], { stopReason: "toolUse" }), capture);
		await t.send("web", { id: "p2", type: "prompt", message: "search" }); await t.waitFor(() => settledCount(t.records("web")) === 2);
		assert.equal(toolsOf(seen[1]!).has("web_search"), true); assert.match(JSON.stringify(seen[1]), /synthetic summary/); assert.equal(calls, 1);
		assert.equal(dialogs(t.records("web")).length, 0);
		const status = t.core.module(WebSearchModule)!.status(); assert.equal(status.usage.billableCalls, 1); assert.equal(status.usage.estimatedCostCny, 0.005);
		const row = (await t.core.call("webSearch.usage", {})) as { session_id: string; run_id: string; provider: string; estimated: number }[];
		assert.ok(row[0]!.session_id); assert.ok(row[0]!.run_id); assert.equal(row[0]!.provider, "deepseek"); assert.equal(row[0]!.estimated, 1);
		const searchEntries = t.core.ledger!.entries().filter((r) => r.purpose === "web_search");
		assert.equal(searchEntries.length, 1); assert.equal(searchEntries[0]!.amount, 0.005); assert.equal(searchEntries[0]!.currency, "CNY"); assert.equal(searchEntries[0]!.workspace, t.workspace);
		assert.equal(t.core.ledger!.importHistory().web, 0, "the attempt and its historical source are the same charge");
		await t.core.call("webSearch.deleteKey", {});
		t.respond(capture); await t.send("web", { id: "p3", type: "prompt", message: "catalogue after delete" }); await t.waitFor(() => settledCount(t.records("web")) === 3);
		assert.equal(toolsOf(seen[2]!).has("web_search"), false); assert.doesNotMatch(seen[2]!.systemPrompt ?? "", /web_search/);
		assert.equal(t.core.module(WebSearchModule)!.status().backend, "local");
	} finally { await t.cleanup(); }
});

test("web search: no channel borrowing, explicit backend and offline/private refusal, with no fallback after remote failure", { skip: process.platform !== "win32" }, async () => {
	let calls = 0, fail = false;
	const t = await startTestCore(undefined, { webSearch: { fetch: async () => { calls++; return fail ? new Response("synthetic", { status: 402 }) : Response.json({ title: "Synthetic", content: "# Synthetic body" }); } } });
	try {
		const module = t.core.module(WebSearchModule)!;
		assert.equal(module.configured(), false);
		await assert.rejects(t.core.call("webSearch.test", {}), /未配置/); assert.equal(calls, 0);
		await assert.rejects(t.core.call("webSearch.setBackend", { backend: "deepseek" }), /先保存/);
		await t.core.call("webSearch.saveKey", { key: "T64_SYNTHETIC_FETCH_KEY" }); await t.core.call("webSearch.setBackend", { backend: "deepseek" });
		await assert.rejects(module.fetchTool("http://127.0.0.1/secret", undefined, {}), /内网/); assert.equal(calls, 0);
		await assert.rejects(module.fetchTool("http://u:p@example.com", undefined, {}), /用户名或密码/); assert.equal(calls, 0);
		await assert.rejects(module.search({ query: "x" }, undefined, {}, { online: () => false }), /离线/);
		await assert.rejects(module.fetchTool("https://8.8.8.8/", undefined, {}, { online: () => false }), /离线/); assert.equal(calls, 0);
		const result = await module.fetchTool("https://8.8.8.8/", undefined, { requestId: "synthetic-fetch" }); assert.match(JSON.stringify(result), /Synthetic body/); assert.equal(calls, 1);
		fail = true; await assert.rejects(module.fetchTool("https://8.8.8.8/", undefined, {}), /余额不足/); assert.equal(calls, 2);
		assert.equal(module.status().backend, "deepseek"); assert.equal(module.status().usage.estimatedCostCny, 0.005);
	} finally { await t.cleanup(); }
});

test("web search: read-only classification and research-role allow-list match web_fetch", () => {
	assert.equal(isReadOnlyCall("web_search", {}), isReadOnlyCall("web_fetch", {}));
	assert.ok(roleTools(roleById("explore")!, ["web_fetch", "web_search", "write"]).includes("web_search"));
	assert.equal(roleTools(roleById("explore")!, ["web_fetch", "web_search", "write"]).includes("write"), false);
});

test("web search: tool accepts 128 astral Unicode characters and redacts outputs, logs and persisted usage", { skip: process.platform !== "win32" }, async () => {
	const key = "T64_SYNTHETIC_REDACTION_KEY"; let received = "";
	const t = await startTestCore(undefined, { webSearch: { fetch: async (_url, init) => {
		received = JSON.parse(String(init!.body)).query;
		return Response.json({ results: [{ title: "Synthetic", url: "https://example.com", summary: `${key} -----BEGIN PRIVATE KEY-----\nSYNTHETIC_BODY\n-----END PRIVATE KEY-----` }] });
	} } });
	try {
		await t.core.call("webSearch.saveKey", { key }); t.core.settings.update({ approvalMode: "off" });
		await t.core.call("slot.open", { slotId: "unicode", cwd: t.workspace }, t.client);
		let seen = "";
		t.respond(fauxAssistantMessage([fauxToolCall("web_search", { query: "🦋".repeat(128) })], { stopReason: "toolUse" }), (context: Context) => { seen = JSON.stringify(context.messages.filter((m) => m.role === "toolResult")); return fauxAssistantMessage("done"); });
		await t.send("unicode", { id: "p", type: "prompt", message: "Unicode search" }); await t.waitFor(() => settledCount(t.records("unicode")) === 1);
		assert.equal([...received].length, 128, seen); assert.doesNotMatch(seen, /T64_SYNTHETIC_REDACTION_KEY|SYNTHETIC_BODY/); assert.match(seen, /已遮盖/);
		const log = join(t.dir, "web-test.log"); const logger = new Logger(log); logger.warn("web synthetic diagnostic", `Authorization: Bearer ${key}`);
		assert.ok(!readFileSync(log, "utf8").includes(key)); assert.ok(!JSON.stringify(await t.core.call("webSearch.usage", {})).includes(key));
	} finally { await t.cleanup(); }
});

test("web search: default local fetching remains available without a key and records zero supplier fee", async () => {
	const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>Local fixture</title><p>Local readable text</p>"); });
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	let remoteCalls = 0;
	const t = await startTestCore(undefined, { webSearch: { fetch: async () => { remoteCalls++; throw new Error("must not call remote"); } } });
	try {
		const module = t.core.module(WebSearchModule)!;
		const result = await module.fetchTool(`http://127.0.0.1:${(server.address() as { port: number }).port}`, undefined, { requestId: "local-only" });
		assert.match(JSON.stringify(result), /Local readable text/); assert.equal(remoteCalls, 0);
		const status = module.status(); assert.equal(status.usage.calls, 1); assert.equal(status.usage.deepseekCalls, 0); assert.equal(status.usage.estimatedCostCny, 0);
		const entry = t.core.ledger!.entries().find((r) => r.purpose === "web_fetch")!; assert.ok(entry); assert.equal(entry.amount, 0); assert.equal(entry.currency, "CNY");
	} finally { await t.cleanup(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
});

test("web search: shutdown cancels pending work before the database can close", { skip: process.platform !== "win32" }, async () => {
	let began!: () => void; const started = new Promise<void>((done) => began = done);
	const t = await startTestCore(undefined, { webSearch: { fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
		began(); init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
	}) } });
	try {
		await t.core.call("webSearch.saveKey", { key: "T64_SYNTHETIC_CANCEL_KEY" });
		const module = t.core.module(WebSearchModule)!;
		const pending = module.search({ query: "cancel" }, undefined, {}); const rejection = assert.rejects(pending, /取消/);
		await started; await module.stop(); await rejection;
		const rows = (await t.core.call("webSearch.usage", {})) as { status: string; billable: number }[];
		assert.equal(rows[0]!.status, "cancelled"); assert.equal(rows[0]!.billable, 0);
	} finally { await t.cleanup(); }
});

test("web search: deleting a key during a run removes search declarations and guidance from the next model request", { skip: process.platform !== "win32" }, async () => {
	const t = await startTestCore();
	try {
		await t.core.call("webSearch.saveKey", { key: "T64_SYNTHETIC_BUSY_DELETE_KEY" });
		t.core.settings.update({ approvalMode: "off" });
		await t.core.call("slot.open", { slotId: "busy", cwd: t.workspace }, t.client);
		let next: Context | undefined;
		t.respond(async () => {
			await t.core.call("webSearch.deleteKey", {});
			return fauxAssistantMessage([fauxToolCall("working_directory", {})], { stopReason: "toolUse" });
		}, (context: Context) => { next = context; return fauxAssistantMessage("done"); });
		await t.send("busy", { id: "p", type: "prompt", message: "synthetic live deletion" }); await t.waitFor(() => settledCount(t.records("busy")) === 1);
		assert.ok(next); assert.equal(toolsOf(next).has("web_search"), false); assert.doesNotMatch(next.systemPrompt ?? "", /web_search/);
	} finally { await t.cleanup(); }
});
