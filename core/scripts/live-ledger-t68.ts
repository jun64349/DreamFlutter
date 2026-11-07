/** T-68: read-only source snapshot, idempotent history import, exactly two explicitly authorized short calls. */
import assert from "node:assert/strict";
import { backup, DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { Core } from "../src/core.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { withLedgerContext } from "../src/ledger/types.ts";
import { Gateway, modelConfig } from "../src/gateway/gateway.ts";
import { Providers } from "../src/modules/providers.ts";
import { Llm } from "../src/modules/llm.ts";
import { SecretStore, isSecretReference, relocateSecretRef, secretFileOf } from "../src/modules/secrets.ts";
import { corePaths, defaultAgentDir } from "../src/paths.ts";
import { fileHash } from "../src/gateway/pi-config.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";

// The first direct preparation failed locally before onPayload/fetch. This branch may consume only
// the second authorized physical request, after the separately recorded offline proof confirms that.
if (process.argv[2] === "--resume-direct") { await resumeDirect(process.argv[3]!); process.exit(process.exitCode ?? 0); }
async function resumeDirect(file: string) {
	const p = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(p.source.toLowerCase(), resolve("E:/DreamFlutter测试版/data").toLowerCase());
	assert.equal(p.results.length, 1); assert.equal(p.results[0].path, "gateway");
	assert.equal(p.offlineDiagnostic.credentialCommandFailed, true); assert.equal(p.offlineDiagnostic.reachedPayload, false); assert.equal(p.offlineDiagnostic.blockedFetches, 0);
	assert.ok(!p.recoveredDirectStarted, "one recovery preparation only"); p.recoveredDirectStarted = true;
	const save = () => writeFileSync(file, JSON.stringify(p, null, 2)); save();
	const core = new Core({ paths: corePaths(join(p.isolatedRoot, "data")), agentDir: join(p.isolatedRoot, "agent"), log: new Logger(), notifier: new RecordingNotifier() });
	const ledger = new Ledger(core); core.use(ledger); const llm = new Llm(core), providers = new Providers(core, llm), gateway = new Gateway(core, providers); core.use(gateway);
	const hashes = () => Object.fromEntries(["models.json", "auth.json", "settings.json"].map((name) => [name, fileHash(join(defaultAgentDir(p.source), name))]));
	const beforeHashes = hashes(); let message: AssistantMessage | undefined, vendor: Record<string, any> = {};
	try {
		const channel = gateway.channels().find((c) => c.provider === p.results[0].ledger.provider)!, selected = channel.models.find((m) => m.id === "mimo-v2.6-flash")!;
		const key = core.db.get<{ secret: string }>("SELECT secret FROM gateway_keys WHERE channel_id=? AND enabled=1 ORDER BY sort,created_at LIMIT 1", channel.id)!;
		const copiedKeyFile = secretFileOf(key.secret)!; assert.equal(resolve(copiedKeyFile).toLowerCase(), resolve(join(providers.secrets.dir, basename(copiedKeyFile))).toLowerCase());
		const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(p.isolatedRoot, "agent", "auth.json"), refreshOnCreate: false });
		runtime.registerProvider(channel.provider, { api: channel.api, baseUrl: channel.baseUrl, apiKey: "T68_RUNTIME_MEMORY_KEY", headers: channel.headers ?? {}, authHeader: channel.authHeader, models: [modelConfig(channel, selected)] as never });
		await runtime.setRuntimeApiKey(channel.provider, await providers.secrets.get(basename(copiedKeyFile).replace(/\.dpapi$/, "")));
		const context = { purpose: "auxiliary" as const, workspace: join(p.isolatedRoot, "workspace"), sessionId: "t68-direct", runId: "t68-direct" };
		ledger.install(runtime, () => context); const original = runtime.completeSimple.bind(runtime);
		runtime.completeSimple = async (model, transcript, options) => {
			message = await original(model, transcript, { ...options, maxRetries: 0, headers: { ...options?.headers, "x-opencode-session": "dreamflutter-t68-direct" },
				onPayload: async (payload, actual) => { assert.equal(new URL(actual.baseUrl).hostname, "opencode.ai"); assert.ok(!p.recoveredDirectDispatched, "no retries or third physical request"); p.recoveredDirectDispatched = true; p.physicalRequests = 2; save(); return options?.onPayload?.(payload, actual); },
				onProviderStreamEvent: async (data, actual) => { const e = data as Record<string, any>, u = e?.usage ?? e?.response?.usage ?? e?.message?.usage; if (u?.opencode) vendor = { billingSource: u.opencode.billing_source, allowance: u.opencode.allowance, cost: u.cost, estimated: u.opencode.estimated, tokens: u.opencode.tokens }; await options?.onProviderStreamEvent?.(data, actual); } }); return message;
		};
		const gatewayBefore = core.db.get<{ n: number }>("SELECT COUNT(*) n FROM gateway_requests")!.n;
		const model = runtime.getModel(channel.provider, selected.id)!;
		const text = await llm.complete("只回复 OK，不使用工具。", { runtime, model: model as Model<never>, maxTokens: 1024, timeoutMs: 90000, context });
		assert.ok(message); const u = message.usage, tokens = vendor.tokens ?? {}, entry = ledger.entries({ limit: 1000 }).find((r) => r.id === (u as unknown as { dreamflutterRequestId: string }).dreamflutterRequestId)!; assert.ok(entry);
		assert.equal(entry.input, tokens.input ?? u.input); assert.equal(entry.output, tokens.output ?? u.output); assert.equal(entry.cache_read, tokens.cache_read ?? u.cacheRead); assert.equal(entry.cache_write, tokens.cache_write_5m === undefined && tokens.cache_write_1h === undefined ? u.cacheWrite : (tokens.cache_write_5m ?? 0) + (tokens.cache_write_1h ?? 0));
		if (typeof vendor.cost === "number") { assert.equal(entry.amount, vendor.cost); assert.equal(entry.currency, "USD"); } if (typeof vendor.allowance === "number") assert.equal(entry.allowance, vendor.allowance);
		assert.equal(core.db.get<{ n: number }>("SELECT COUNT(*) n FROM gateway_requests")!.n, gatewayBefore);
		p.results.push({ path: "non_gateway", model: model.id, text, stopReason: message.stopReason, sdkUsage: u, vendor, ledger: entry, gatewayRowsAdded: 0 });
		p.stage = "complete"; delete p.error; assert.deepEqual(hashes(), beforeHashes); p.sourceConfigUnchangedDuringRecovery = true;
	} catch { p.recoveryError = "validation_failed_no_further_attempts"; process.exitCode = 1; }
	finally { await core.shutdown(); save(); console.log(JSON.stringify({ stage: p.stage, physicalRequests: p.physicalRequests, sourceConfigUnchangedDuringRecovery: p.sourceConfigUnchangedDuringRecovery, recoveryError: p.recoveryError, results: p.results.map((r: any) => ({ path: r.path, sdkUsage: r.sdkUsage, vendor: r.vendor, amount: r.ledger.amount, source: r.ledger.amount_source, allowance: r.ledger.allowance })) })); }
}

const source = resolve(process.argv[2] ?? ""), evidence = process.argv[3];
assert.equal(source.toLowerCase(), resolve("E:/DreamFlutter测试版/data").toLowerCase(), "only the authorized data source may be copied"); assert.ok(evidence);
assert.ok(!existsSync(evidence) || !JSON.parse(readFileSync(evidence, "utf8")).realAttempts, "do not rerun after any authorized attempt has been counted");
const root = mkdtempSync(join(tmpdir(), "df-t68-real-")), data = join(root, "data"), agent = join(root, "agent"), workspace = join(root, "workspace");
for (const path of [data, agent, workspace]) mkdirSync(path, { recursive: true });
const sourceAgent = defaultAgentDir(source), sourceHashes = Object.fromEntries(["models.json", "auth.json", "settings.json"].map((name) => [name, fileHash(join(sourceAgent, name))]));
const readonly = new DatabaseSync(corePaths(source).dbFile, { readOnly: true });
try { await backup(readonly, corePaths(data).dbFile); } finally { readonly.close(); }
const fromSecrets = new SecretStore(source), toSecrets = new SecretStore(data); mkdirSync(toSecrets.dir, { recursive: true });
for (const entry of existsSync(fromSecrets.dir) ? readdirSync(fromSecrets.dir) : []) if (entry.endsWith(".dpapi")) copyFileSync(join(fromSecrets.dir, entry), join(toSecrets.dir, entry));
const core = new Core({ paths: corePaths(data), agentDir: agent, sessionDir: join(root, "sessions"), log: new Logger(), notifier: new RecordingNotifier() });
const ledger = new Ledger(core); core.use(ledger);
const llm = new Llm(core), providers = new Providers(core, llm), gateway = new Gateway(core, providers); core.use(gateway);
const proof: Record<string, any> = { at: new Date().toISOString(), source, isolatedRoot: root, sourceReadOnly: true, realAttempts: 0, results: [] };
function save() { writeFileSync(evidence!, JSON.stringify(proof, null, 2)); }
const numeric = (rows: Record<string, any>[]) => rows.reduce((sum, row) => ({ input: sum.input + row.input, output: sum.output + row.output, cacheRead: sum.cacheRead + row.cache_read, cacheWrite: sum.cacheWrite + row.cache_write }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
function relocated(value: any): any {
	if (typeof value === "string") { if (isSecretReference(value)) return relocateSecretRef(value, toSecrets.dir); if (value.startsWith("!")) throw new Error("non_SecretStore_command_not_executed"); return value; }
	if (Array.isArray(value)) return value.map(relocated);
	return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, relocated(v)])) : value;
}
try {
	// Only the temporary copy is reset, to test a first import even if its source already contains a ledger.
	core.db.raw.exec("DELETE FROM request_ledger_sources; DELETE FROM request_ledger;");
	const rows = core.db.all<Record<string, any>>("SELECT * FROM usage_records ORDER BY at");
	const unique = [...new Map(rows.map((r) => [JSON.stringify([r.provider, r.model, r.entry_id, r.at]), r])).values()];
	const before = numeric(rows), expected = numeric(unique);
	const imported = ledger.importHistory(), repeated = ledger.importHistory();
	const after = core.db.get<Record<string, number>>("SELECT COALESCE(SUM(input),0) input,COALESCE(SUM(output),0) output,COALESCE(SUM(cache_read),0) cacheRead,COALESCE(SUM(cache_write),0) cacheWrite FROM request_ledger WHERE origin='historical'")!;
	assert.deepEqual({ ...after }, expected); assert.equal(repeated.imported, 0); assert.equal(repeated.web, 0);
	proof.history = { sourceRows: rows.length, uniqueRequests: unique.length, duplicateHistoryRows: rows.length - unique.length, before, expectedAfterDeduplication: expected, after, imported, repeated, reasonForDifference: rows.length === unique.length ? null : "same provider/model/entry_id/time copied between histories counts once" }; save();
	for (const row of core.db.all<{ id: string; secret: string }>("SELECT id,secret FROM gateway_keys")) core.db.run("UPDATE gateway_keys SET secret=? WHERE id=?", relocated(row.secret), row.id);
	const channel = gateway.channels().find((c) => c.source === "df" && c.enabled && c.platform === "opencode-go" && c.models.some((m) => m.id === "mimo-v2.6-flash"))!;
	assert.ok(channel, "authorized copied OpenCode channel unavailable");
	const selected = channel.models.find((m) => m.id === "mimo-v2.6-flash")!, key = core.db.get<{ secret: string }>("SELECT secret FROM gateway_keys WHERE channel_id=? AND enabled=1 ORDER BY sort,created_at LIMIT 1", channel.id)!;
	assert.ok(isSecretReference(key.secret), "real validation only uses copied DPAPI credential references");
	for (const viaGateway of [true, false]) {
		assert.ok(proof.realAttempts < 2); proof.realAttempts++; proof.stage = viaGateway ? "gateway_call" : "non_gateway_call"; save();
		const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(agent, "auth.json"), refreshOnCreate: false });
		if (viaGateway) gateway.installRuntime(runtime);
		else {
			runtime.registerProvider(channel.provider, { name: channel.name, api: channel.api, baseUrl: channel.baseUrl, apiKey: "T68_RUNTIME_MEMORY_KEY", authHeader: channel.authHeader, headers: relocated(channel.headers ?? {}), models: [relocated(modelConfig(channel, selected))] });
			const file = secretFileOf(key.secret)!; assert.equal(resolve(file).toLowerCase(), resolve(join(toSecrets.dir, basename(file))).toLowerCase());
			await runtime.setRuntimeApiKey(channel.provider, await toSecrets.get(basename(file).replace(/\.dpapi$/, "")));
		}
		const model = runtime.getModel(channel.provider, selected.id)!; assert.ok(model);
		const callLedgerContext = { purpose: viaGateway ? "conversation" as const : "auxiliary" as const, workspace, sessionId: `t68-${viaGateway ? "gateway" : "direct"}`, runId: `t68-${viaGateway ? "gateway" : "direct"}` };
		ledger.install(runtime, () => callLedgerContext);
		let message: AssistantMessage | undefined, vendor: Record<string, any> = {};
		const original = runtime.completeSimple.bind(runtime);
		runtime.completeSimple = async (m, context, options) => {
			message = await original(m, context, { ...options, maxRetries: 0, headers: { ...options?.headers, "x-opencode-session": `dreamflutter-t68-${viaGateway ? "gateway" : "direct"}` }, onProviderStreamEvent: async (data, actual) => {
				const event = data as Record<string, any>, u = event?.usage ?? event?.response?.usage ?? event?.message?.usage;
				if (u?.opencode) vendor = { billingSource: u.opencode.billing_source, allowance: u.opencode.allowance, cost: u.cost, estimated: u.opencode.estimated, tokens: u.opencode.tokens };
				await options?.onProviderStreamEvent?.(data, actual);
			}, onPayload: async (payload, actual) => { assert.equal(new URL(actual.baseUrl).hostname, "opencode.ai", "the authorized short check must use the copied official channel"); return options?.onPayload?.(payload, actual); } }); return message;
		};
		const beforeGateway = core.db.get<{ n: number }>("SELECT COUNT(*) n FROM gateway_requests")!.n;
		const observer = new Llm(core, () => runtime);
		const text = await withLedgerContext(callLedgerContext, () => observer.complete("只回复 OK，不使用工具。", { model: model as Model<never>, runtime, maxTokens: 1024, timeoutMs: 90000, context: callLedgerContext }));
		assert.ok(message); const id = (message.usage as unknown as { dreamflutterRequestId: string }).dreamflutterRequestId;
		const entry = ledger.entries({ limit: 1000 }).find((r) => r.id === id)!; assert.ok(entry, "final usage must have exactly one ledger row");
		const u = message.usage, tokens = vendor.tokens ?? {};
		assert.equal(entry.input, tokens.input ?? u.input); assert.equal(entry.output, tokens.output ?? u.output); assert.equal(entry.cache_read, tokens.cache_read ?? u.cacheRead);
		assert.equal(entry.cache_write, tokens.cache_write_5m === undefined && tokens.cache_write_1h === undefined ? u.cacheWrite : (tokens.cache_write_5m ?? 0) + (tokens.cache_write_1h ?? 0));
		if (typeof vendor.cost === "number") { assert.equal(entry.amount, vendor.cost); assert.equal(entry.currency, "USD"); }
		if (typeof vendor.allowance === "number") assert.equal(entry.allowance, vendor.allowance);
		const gatewayDelta = core.db.get<{ n: number }>("SELECT COUNT(*) n FROM gateway_requests")!.n - beforeGateway; assert.equal(gatewayDelta, Number(viaGateway));
		proof.results.push({ path: viaGateway ? "gateway" : "non_gateway", model: model.id, text, stopReason: message.stopReason, sdkUsage: u, vendor, ledger: entry, gatewayRowsAdded: gatewayDelta }); save();
	}
	assert.equal(proof.results.length, 2); assert.equal(proof.realAttempts, 2); proof.stage = "complete";
	assert.deepEqual(Object.fromEntries(["models.json", "auth.json", "settings.json"].map((name) => [name, fileHash(join(sourceAgent, name))])), sourceHashes); proof.sourceConfigUnchanged = true;
} catch { proof.error = "validation_failed_without_exposing_provider_error_body"; process.exitCode = 1; }
finally { await core.shutdown(); save(); console.log(JSON.stringify({ stage: proof.stage, realAttempts: proof.realAttempts, history: proof.history, results: proof.results.map((r: any) => ({ path: r.path, model: r.model, sdkUsage: r.sdkUsage, amount: r.ledger.amount, currency: r.ledger.currency, source: r.ledger.amount_source, allowance: r.ledger.allowance, allowanceUnit: r.ledger.allowance_unit })), sourceConfigUnchanged: proof.sourceConfigUnchanged, error: proof.error })); }
