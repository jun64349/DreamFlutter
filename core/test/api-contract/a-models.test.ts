import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Gateway, channelProvider, type Transport } from "../../src/gateway/gateway.ts";
import type { Providers } from "../../src/modules/providers.ts";
import { PiMigration } from "../../src/gateway/pi-migration.ts";
import { expectKeys, expectRpcError, startContractHarness, type ContractHarness } from "./harness.ts";

const win32 = process.platform === "win32";
const modelFields = ["id", "name", "provider", "api", "contextWindow", "maxTokens", "reasoning", "input", "cost"];
const providerFields = ["id", "name", "baseUrl", "api", "configured", "authSource", "custom", "encryptedKey", "models"];
const provider = { provider: "faux", model: "faux-1" };

test("gateway models, channel groups, request logs and ledger contracts", async t => {
	const api = await startContractHarness(t);
	const platforms = await api.call<Record<string, unknown>[]>("gateway.platforms");
	assert.ok(platforms.length);
	for (const row of platforms) expectKeys(row, ["id", "name", "kind", "endpoints", "modelDetails"], ["quota", "windows", "sharedEndpoints", "models", "modelsUrl", "catalog", "compat"]);
	expectKeys(await api.call("gateway.modelWindow", provider), ["value", "source"]);
	await expectRpcError(api.call("gateway.modelWindow"), "bad_request");
	await expectRpcError(api.call("gateway.saveChannel"), "bad_request");
	await expectRpcError(api.call("gateway.removeChannel"), "bad_request");
	await expectRpcError(api.call("gateway.testChannel"), "bad_request");
	await expectRpcError(api.call("gateway.testChannel", { channel: "missing" }), "not_found");
	await expectRpcError(api.call("gateway.resetHealth"), "bad_request");
	await expectRpcError(api.call("gateway.setCommonModels", { channel: "missing", models: 1 }), "bad_request");
	await expectRpcError(api.call("gateway.saveGroup"), "bad_request");
	await expectRpcError(api.call("gateway.removeGroup"), "bad_request");
	await expectRpcError(api.call("gateway.reorderGroups", { ids: ["missing"] }), "bad_request");

	const changes = api.events.length;
	assert.deepEqual(await api.call("gateway.saveGroup", { id: "test-group", name: "合同模型组", entries: [] }), { id: "test-group" });
	assert.deepEqual(await api.call("gateway.groups"), [{ id: "test-group", name: "合同模型组", entries: [], allowPaidOverflow: true }]);
	assert.deepEqual(await api.call("gateway.reorderGroups", { ids: ["test-group"] }), { ok: true });
	assert.deepEqual(await api.call("gateway.removeGroup", { id: "test-group" }), { ok: true });
	assert.deepEqual(await api.call("gateway.resetHealth", { channel: "missing" }), { ok: true });
	assert.equal(api.events.slice(changes).filter(event => event.event === "gateway.changed").length, 4);
	for (const event of api.events.slice(changes).filter(event => event.event === "gateway.changed")) expectKeys(event, ["event"]);
	assert.deepEqual(await api.call("gateway.groups"), []);
	assert.deepEqual(await api.call("gateway.requests"), []);
	assert.deepEqual(await api.call("gateway.status"), await api.call("gateway.refreshQuota", { channel: "missing" }));
	assert.deepEqual(await api.call("ledger.entries"), []);
	for (const rule of await api.call<unknown[]>("ledger.rules")) expectKeys(rule, ["version", "definition"]);
	expectKeys(await api.call("ledger.importHistory"), ["imported", "linked", "web"]);
	const summary = await api.call("ledger.summary", { period: "all", groupBy: "channel" });
	expectKeys(summary, ["since", "until", "period", "groupBy", "timeZone", "rows"]);
	assert.deepEqual(summary.rows, []);
	assert.deepEqual(await api.call("usage.summary"), []);
});

test("gateway channel lifecycle uses only synthetic credentials and a faux model", { skip: !win32 }, async t => {
	const api = await startContractHarness(t);
	const data = { name: "Wire fixture", kind: "relay", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1",
		models: [{ id: "fake", name: "Fake", contextWindow: 8192 }], keys: [{ secret: "T132A_FIXTURE_KEY" }] };
	await expectRpcError(api.call("gateway.saveChannel", { ...data, id: "missing" }), "not_found");
	await expectRpcError(api.call("gateway.saveChannel", { ...data, keys: [] }), "bad_request");
	api.core.maintenance = "正在迁移 Pi 服务商";
	try {
		await expectRpcError(api.call("gateway.saveChannel", data), "busy");
		await expectRpcError(api.call("gateway.saveGroup", { name: "fixture" }), "busy");
		await expectRpcError(api.call("gateway.removeChannel", { id: "missing" }), "busy");
		await expectRpcError(api.call("gateway.removeGroup", { id: "missing" }), "busy");
		await expectRpcError(api.call("gateway.reorderGroups", { ids: [] }), "busy");
	} finally { api.core.maintenance = undefined; }
	const created = await api.call<{ id: string }>("gateway.saveChannel", data);
	expectKeys(created, ["id"]);
	const channel = (await api.call<Record<string, unknown>[]>("gateway.channels")).find(row => row.id === created.id);
	expectKeys(channel, ["id", "source", "provider", "name", "platform", "kind", "api", "baseUrl", "models", "authHeader", "enabled", "topUp", "lowBalance", "keys", "unavailable", "common"], ["origin", "headers"]);
	assert.doesNotMatch(JSON.stringify(channel), /T132A_FIXTURE_KEY/);
	assert.deepEqual(await api.call("gateway.modelWindow", { provider: channel.provider, model: "fake" }), { value: 8192, source: "channel" });
	assert.deepEqual(await api.call("gateway.setCommonModels", { channel: created.id, models: ["fake"] }), { ok: true });
	expectKeys(await api.call("setup.recommendModels", { channel: created.id }), ["conversation", "small", "large", "vision"]);
	const status = (await api.call<Record<string, unknown>[]>("gateway.status")).find(row => row.id === created.id);
	expectKeys(status, ["id", "name", "kind", "platform", "source", "unavailable", "quota", "quotaError", "localUsage", "canQuery", "today", "last5h", "spent", "remaining", "lastError"]);
	for (const method of ["setup.testChannel", "gateway.testChannel"]) {
		const failed = await api.call(method, { channel: created.id, model: "not-a-model" });
		expectKeys(failed, ["ok", "latencyMs", "model", "error"]);
		assert.deepEqual([failed.ok, failed.model], [false, null]);
	}
	assert.deepEqual(await api.call("gateway.removeChannel", { id: created.id }), { ok: true });
});

test("legacy providers and both model-list methods use an isolated HTTP endpoint", async t => {
	const api = await startContractHarness(t);
	const fixture = createServer((req, res) => {
		if (req.url !== "/v1/models") { res.writeHead(401).end(); return; }
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ data: [{ id: "wire-model", name: "Wire Model" }] }));
	});
	fixture.listen(0, "127.0.0.1");
	await once(fixture, "listening");
	t.after(() => { fixture.closeAllConnections(); return new Promise<void>(resolve => fixture.close(() => resolve())); });
	const baseUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
	for (const method of ["providers.fetchModels", "gateway.fetchModels"]) {
		assert.deepEqual(await api.call(method, { baseUrl: baseUrl + "/v1" }), [{ id: "wire-model", name: "Wire Model" }]);
		await expectRpcError(api.call(method), "bad_request");
		await expectRpcError(api.call(method, { baseUrl }), "http");
	}
	const providers = await api.call<Record<string, unknown>[]>("providers.list");
	assert.ok(providers.length);
	for (const item of providers) expectKeys(item, providerFields);
	const available = await api.call<Record<string, unknown>[]>("providers.available");
	for (const model of available) expectKeys(model, modelFields);
	assert.ok(available.some(model => model.id === "faux-1"));
	api.respond(fauxAssistantMessage("OK"));
	const checked = await api.call("providers.test", provider);
	expectKeys(checked, ["ok", "latencyMs", "model", "reply"]);
	assert.equal(checked.reply, "OK");
	await expectRpcError(api.call("providers.test"), "bad_request");
	await expectRpcError(api.call("providers.setKey"), "bad_request");
	await expectRpcError(api.call("providers.removeKey"), "bad_request");
	await expectRpcError(api.call("providers.removeCustom"), "bad_request");
	await expectRpcError(api.call("providers.saveCustom", { id: "!" }), "bad_request");
	if (win32) {
		const at = api.events.length;
		assert.deepEqual(await api.call("providers.setKey", { provider: "fixture", apiKey: "T132A_PROVIDER_KEY" }), { ok: true });
		assert.deepEqual(await api.call("providers.removeKey", { provider: "fixture" }), { ok: true });
		assert.deepEqual(await api.call("providers.saveCustom", { id: "fixture", baseUrl: baseUrl + "/v1", api: "openai-completions", apiKey: "T132A_FIXTURE_CUSTOM", models: [{ id: "wire-model" }] }), { ok: true });
		assert.deepEqual(await api.call("providers.removeCustom", { id: "fixture" }), { ok: true });
		assert.equal(api.events.slice(at).filter(event => event.event === "providers.changed").length, 4);
	}
	(api.core.module(Gateway)! as unknown as { providers: Providers }).providers.channelsAuthoritative = true;
	for (const [method, params] of [
		["providers.removeCustom", { id: "fixture" }],
		["providers.removeKey", { provider: "fixture" }],
		["providers.setKey", { provider: "fixture", apiKey: "T132A_PROVIDER_KEY" }],
		["providers.saveCustom", { id: "fixture", baseUrl, api: "openai-completions", models: [{ id: "wire-model" }] }],
	] as const) await expectRpcError(api.call(method, params), "migrated");
	fixture.closeAllConnections();
	await new Promise<void>(resolve => fixture.close(() => resolve()));
	for (const method of ["providers.fetchModels", "gateway.fetchModels"])
		await expectRpcError(api.call(method, { baseUrl }), "network");
});

test("Pi migration queries and synthetic OAuth flow never use a real login", async t => {
	const api = await startContractHarness(t);
	const migration = api.core.module(PiMigration)!;
	// The normal test core disables automatic migration. Replace only the OAuth runtime seam.
	const options = (migration as unknown as { options: { oauthRuntime: () => Promise<unknown> } }).options;
	options.oauthRuntime = async () => ({
		async login(_provider: string, _kind: string, context: { prompt(input: object): Promise<string> }) {
			await context.prompt({ message: "fixture challenge" });
		},
		async logout() {},
	});
	const keys = ["status", "path", "folder", "busy", "externalModified", "defaultImportFolder", "command", "mappings"];
	const extras = ["attempts", "version", "at", "backup", "error", "hashes", "generatedHash", "generatedAt", "externalBackup", "unresolved", "oauthProviders", "results"];
	expectKeys(await api.call("piMigration.status"), keys, extras);
	expectKeys(await api.call("piMigration.generate"), keys, extras);
	await expectRpcError(api.call("piMigration.import"), "bad_request");
	const from = join(api.dir, "import");
	mkdirSync(from);
	writeFileSync(join(from, "auth.json"), "{}");
	writeFileSync(join(from, "models.json"), '{"providers":{}}');
	await expectRpcError(api.call("piMigration.import", { folder: from }), "not_ready");
	const changedFrom = api.events.length;
	expectKeys(await api.call("piMigration.retry"), keys, extras);
	expectKeys(await api.call("piMigration.import", { folder: from }), keys, extras);
	const changes = api.events.slice(changedFrom).filter(e => e.event === "piMigration.changed");
	assert.ok(changes.length >= 2);
	for (const event of changes) { expectKeys(event, ["event", "status"]); expectKeys(event.status, keys, extras); }
	await expectRpcError(api.call("piMigration.oauthStart"), "bad_request");
	await expectRpcError(api.call("piMigration.oauthStart", { provider: "fixture" }), "oauth_login_disabled");
	await expectRpcError(api.call("piMigration.oauthAnswer", { id: "missing" }), "not_ready");
	await expectRpcError(api.call("piMigration.oauthAnswer"), "bad_request");
	await expectRpcError(api.call("piMigration.oauthStatus"), "bad_request");
	await expectRpcError(api.call("piMigration.oauthCancel"), "bad_request");
	assert.deepEqual(await api.call("piMigration.oauthStatus", { id: "missing" }), { status: "missing" });
	await expectRpcError(api.call("piMigration.oauthLogout", { provider: "fixture" }), "bad_request");
	const controlled = migration as unknown as { busy: boolean };
	controlled.busy = true;
	try {
		await expectRpcError(api.call("piMigration.retry"), "busy");
		await expectRpcError(api.call("piMigration.import", { folder: from }), "busy");
		await expectRpcError(api.call("piMigration.oauthLogout", { provider: "openai" }), "busy");
	} finally { controlled.busy = false; }

	const start = api.events.length;
	const flow = await api.call<{ id: string }>("piMigration.oauthStart", { provider: "openai" });
	expectKeys(flow, ["id", "provider", "status"]);
	await api.waitForEvent("piMigration.oauth", event => !!(event.login as Record<string, unknown>).prompt, start);
	await expectRpcError(api.call("piMigration.oauthStart", { provider: "openai" }), "busy");
	assert.deepEqual(await api.call("piMigration.oauthAnswer", { id: flow.id, value: "test-response" }), { ok: true });
	const complete = await api.waitForEvent("piMigration.oauth", event => (event.login as Record<string, unknown>).status === "done", start);
	expectKeys(complete, ["event", "login"]);
	assert.deepEqual(await api.call("piMigration.oauthStatus", { id: flow.id }), { id: flow.id, provider: "openai", status: "done" });
	const next = await api.call<{ id: string }>("piMigration.oauthStart", { provider: "openai" });
	const cancelledAt = api.events.length;
	assert.deepEqual(await api.call("piMigration.oauthCancel", { id: next.id }), { ok: true });
	const cancelled = await api.waitForEvent("piMigration.oauth", e => (e.login as { status: string }).status === "cancelled", cancelledAt);
	expectKeys(cancelled.login, ["id", "provider", "status", "error"]);
	assert.equal(cancelled.login.id, next.id);
	assert.deepEqual(await api.call("piMigration.oauthLogout", { provider: "openai" }), { ok: true });
});

const webStatus = ["configured", "state", "lastError", "backend", "keyMasked", "pendingToolRefresh", "month", "usage"];

test("gateway failover and quota notices are emitted once through the window connection", { skip: !win32 }, async t => {
	let api: ContractHarness;
	const transport: Transport = (model, context, options) => api.faux.streamSimple(model as never, context as never, options);
	api = await startContractHarness(t, { gatewayTransport: transport });
	const gateway = api.core.module(Gateway)! as unknown as { fetch: typeof fetch };
	gateway.fetch = async url => {
		assert.equal(new URL(String(url)).hostname, "127.0.0.1");
		return Response.json({ balance_infos: [{ currency: "CNY", total_balance: "5.00" }] });
	};
	const save = (name: string, platform: string) => api.call<{ id: string }>("gateway.saveChannel", {
		name, platform, api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1",
		models: [{ id: "wire-model", contextWindow: 200_000 }], keys: [{ secret: "T132A_" + name }], lowBalance: 10,
	});
	const plan = await save("Fixture Plan", "glm-coding");
	const paid = await save("Fixture Paid", "deepseek");
	await api.call("gateway.saveGroup", { id: "wire-group", name: "Wire group", entries: [
		{ channel: plan.id, model: "wire-model", priority: 0 },
		{ channel: paid.id, model: "wire-model", priority: 1 },
	] });
	await api.call("settings.update", { defaultModel: "dreamflutter/wire-group", notifications: true, patrolQuietEnabled: false });
	const reply: Parameters<ContractHarness["respond"]>[0] = (_context, _options, _state, model) =>
		model.provider === channelProvider(plan.id)
			? { ...fauxAssistantMessage(""), stopReason: "error", errorMessage: "402 Insufficient Balance" }
			: fauxAssistantMessage("Fixture success");
	api.respond(reply, reply);
	const slot = await api.call<{ sessionId: string }>("slot.open", { slotId: "wire-gateway", cwd: api.workspace });
	const at = api.events.length;
	await api.call("slot.send", { slotId: "wire-gateway", record: { type: "prompt", message: "Run the fixture" } });
	await api.waitForEvent("slot.record", e => (e.record as { type?: string }).type === "agent_settled", at);
	const switched = await api.waitForEvent("gateway.switched", undefined, at);
	expectKeys(switched, ["event", "sessionId", "group", "from", "to", "reason", "toPaid"]);
	assert.deepEqual([switched.sessionId, switched.group, switched.from, switched.to, switched.toPaid],
		[slot.sessionId, "Wire group", "Fixture Plan · wire-model", "Fixture Paid · wire-model", true]);
	assert.equal(api.events.slice(at).filter(e => e.event === "gateway.switched").length, 1);
	const alertsFrom = api.events.length;
	await api.call("gateway.refreshQuota", { channel: paid.id });
	const alert = await api.waitForEvent("gateway.alert", undefined, alertsFrom);
	expectKeys(alert, ["event", "title", "body"]);
	assert.equal(alert.title, "Fixture Paid 余额不足");
	await api.call("gateway.refreshQuota", { channel: paid.id });
	assert.equal(api.events.slice(alertsFrom).filter(e => e.event === "gateway.alert").length, 1);
});

test("web search validates settings and serializes the mock search/fetch service", async t => {
	const api = await startContractHarness(t, { webSearch: { fetch: async url =>
		String(url).includes("fetch") ? Response.json({ title: "Fixture", content: "Synthetic page" }) :
			Response.json({ results: [{ title: "Fixture", url: "https://example.invalid", summary: "Synthetic result" }] }),
	} });
	expectKeys(await api.call("webSearch.status"), webStatus);
	await expectRpcError(api.call("webSearch.saveKey", { key: "" }), "bad_request");
	await expectRpcError(api.call("webSearch.setBackend", { backend: "invalid" }), "bad_request");
	await expectRpcError(api.call("webSearch.setBackend", { backend: "deepseek" }), "not_configured");
	await expectRpcError(api.call("webSearch.test"), "not_configured");
	await expectRpcError(api.call("webSearch.search"), "bad_request");
	await expectRpcError(api.call("webSearch.fetch"), "bad_request");
	const rejected = await api.call<Record<string, unknown>[]>("webSearch.usage");
	assert.deepEqual(rejected.map(row => [row.status, row.error_code]), [["error", "not_configured"]]);
	if (win32) {
		const at = api.events.length;
		expectKeys(await api.call("webSearch.saveKey", { key: "T132A_WEB_KEY" }), webStatus);
		expectKeys(await api.call("webSearch.setBackend", { backend: "deepseek" }), webStatus);
		const result = await api.call<{ results: unknown[]; retrievedAt: string }>("webSearch.search", { query: "fixture" });
		expectKeys(result, ["results", "retrievedAt"]);
		expectKeys(result.results[0], ["title", "url", "site_name", "summary", "snippet", "content", "date"]);
		const fetched = await api.call("webSearch.fetch", { url: "https://8.8.8.8/" });
		expectKeys(fetched, ["content", "details"]);
		expectKeys(fetched.details, ["provider", "url", "status", "title", "retrievedAt", "estimated"]);
		expectKeys(await api.call("webSearch.test"), ["ok", "count", "retrievedAt", "estimated", "estimatedCostCny"]);
		assert.equal((await api.call<unknown[]>("webSearch.usage")).length, 4);
		expectKeys(await api.call("webSearch.deleteKey"), webStatus);
		const changes = api.events.slice(at).filter(event => event.event === "webSearch.changed");
		assert.equal(changes.length, 6);
		for (const event of changes) { expectKeys(event, ["event", "status"]); expectKeys(event.status, webStatus); }
		assert.deepEqual(changes.map(e => (e.status as { configured: boolean }).configured), [true, true, true, true, true, false]);
	} else expectKeys(await api.call("webSearch.deleteKey"), webStatus);
});
