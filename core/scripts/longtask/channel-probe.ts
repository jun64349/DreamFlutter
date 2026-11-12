import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { normalizeContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildCore } from "../../src/app.ts";
import type { Core } from "../../src/core.ts";
import { Gateway, type Transport } from "../../src/gateway/gateway.ts";
import { Logger } from "../../src/log.ts";
import { SecretStore, secretFileOf } from "../../src/modules/secrets.ts";
import { RecordingNotifier } from "../../src/notify.ts";
import { corePaths } from "../../src/paths.ts";
import { configurePiNetworking } from "../../src/pi/http.ts";
import { estimate } from "../../src/ledger/rules.ts";
import { copyOpenCodeGoChannel, LIVE_MODEL } from "./channel-config.ts";
import { priced } from "./live-budget.ts";
import { hasFinalUsageFrame, requestEnd, requestFailure } from "./request-evidence.ts";

const MAX_TOKENS = 32;
const COST_LIMIT = 0.01 / 3;
type Key = { id: string; secret: string };
type Channel = { api: string; base_url: string; models: string; headers: string | null; auth_header: number };

const pathKey = (value: string) => resolve(value).toLowerCase();
const shape = (value: unknown): unknown => Array.isArray(value) ? value.map(shape) : value !== null && typeof value === "object"
	? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, shape(item)]))
	: [typeof value, value !== null && value !== ""];

function inspect(data: string, id: string) {
	const db = new DatabaseSync(corePaths(data).dbFile, { readOnly: true });
	const store = new SecretStore(data);
	try {
		const channel = db.prepare("SELECT api,base_url,models,headers,auth_header FROM gateway_channels WHERE id=?").get(id) as Channel;
		const keys = db.prepare("SELECT id,secret FROM gateway_keys WHERE channel_id=? AND enabled=1 ORDER BY sort,created_at").all(id) as Key[];
		return { channel, keys, store, schema: shape({ ...channel, models: JSON.parse(channel.models), headers: JSON.parse(channel.headers ?? "null") }),
			keyLocal: keys.map(key => {
				const file = secretFileOf(key.secret);
				return !!file && pathKey(file) === pathKey(store.fileFor(`gateway-${key.id}`));
			}), keyPresent: keys.map(key => existsSync(store.fileFor(`gateway-${key.id}`))) };
	} finally { db.close(); }
}

export async function probeChannel(source: string) {
	const root = mkdtempSync(join(tmpdir(), "df-t105-probe-"));
	const data = join(root, "data"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
	let core: Core | undefined;
	try {
		mkdirSync(agentDir);
		mkdirSync(sessionDir);
		const channel = copyOpenCodeGoChannel(source, data), provider = `df-${channel}`;
		const from = inspect(source, channel), copy = inspect(data, channel);
		const isolatedKeys = await Promise.all(copy.keys.map(key => copy.store.get(`gateway-${key.id}`).catch(() => "")));
		const comparison = { sameStructure: JSON.stringify(from.schema) === JSON.stringify(copy.schema),
			sameApi: from.channel.api === copy.channel.api, sameAuthMode: from.channel.auth_header === copy.channel.auth_header,
			sameKeyOrder: from.keys.map(key => key.id).join(",") === copy.keys.map(key => key.id).join(","),
			sourceReferencesLocal: from.keyLocal, copyReferencesLocal: copy.keyLocal, sourceFilesPresent: from.keyPresent,
			copyFilesPresent: copy.keyPresent, copiedKeysDecryptable: isolatedKeys.map(Boolean) };
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
		const log = new Logger();
		await configurePiNetworking(agentDir, log);
		let attempts = 0, httpAttempts = 0, finalUsage = false, keyMatches = false, placeholder = false;
		let httpStatus: number | undefined;
		let estimatedLimit: number | undefined;
		let payload: { modelMatches: boolean; maxTokens?: number; usageRequested: boolean } | undefined;
		const transport: Transport = (model, context, options) => {
			const url = URL.parse(model.baseUrl);
			if (attempts || model.provider !== provider || model.id !== LIVE_MODEL || !priced(model)
				|| url?.origin !== "https://opencode.ai" || url.username || url.password || model.api !== "openai-completions") {
				throw new Error("诊断请求未通过发送前检查");
			}
			const input = Buffer.byteLength(JSON.stringify(context)) + 1024;
			estimatedLimit = (input * Math.max(model.cost.input, model.cost.cacheRead, model.cost.cacheWrite) + MAX_TOKENS * model.cost.output) / 1e6;
			if (estimatedLimit > COST_LIMIT) throw new Error("诊断请求预留超过单次额度");
			attempts++;
			keyMatches = !!options?.apiKey && isolatedKeys.includes(options.apiKey);
			placeholder = options?.apiKey === "dreamflutter-gateway";
			return streamSimple(model, context, { ...options, maxTokens: MAX_TOKENS, maxRetries: 0,
				fetch: async (input, init) => {
					if (httpAttempts++) throw new Error("诊断只允许一次 HTTP 请求");
					const response = await (options?.fetch ?? globalThis.fetch)(input, { ...init, redirect: "error" });
					httpStatus = response.status;
					return response;
				},
				onPayload: (value, selected) => {
					const body = value as { model?: string; max_tokens?: number; stream_options?: { include_usage?: boolean } };
					payload = { modelMatches: body.model === LIVE_MODEL, maxTokens: body.max_tokens, usageRequested: body.stream_options?.include_usage === true };
					return options?.onPayload?.(value, selected);
				},
				onProviderStreamEvent: (event, selected) => {
					finalUsage ||= hasFinalUsageFrame(event);
					return options?.onProviderStreamEvent?.(event, selected);
				} });
		};
		core = buildCore({ paths: corePaths(data), agentDir, sessionDir, log, notifier: new RecordingNotifier(), modelRuntime: () => runtime,
			piMigration: { automatic: false }, gatewayTransport: transport });
		core.settings.update({ autoTitle: false, memoryAutoExtract: false, notifications: false, goalProposalEnabled: false });
		await core.start();
		core.module(Gateway)!.installRuntime(runtime);
		const model = runtime.getModel(provider, LIVE_MODEL);
		if (!model) throw new Error("诊断模型未载入");
		const resolved = core.resolveModel(model);
		const signal = AbortSignal.timeout(30_000);
		const context = normalizeContext({ messages: [{ role: "user", content: "Reply with the single word OK.", timestamp: Date.now() }] });
		const message = await runtime.streamSimple(resolved, context, { maxTokens: MAX_TOKENS, maxRetries: 0, signal }).result();
		const status = requestEnd(message?.stopReason, message?.errorMessage, signal);
		const row = core.db.get<{ key_id: string | null }>("SELECT key_id FROM gateway_requests WHERE channel=? ORDER BY id DESC LIMIT 1", channel);
		const selected = isolatedKeys[copy.keys.findIndex(key => key.id === row?.key_id)] ?? "";
		const maskedKey = /^[A-Za-z0-9_-]{8,}$/.test(selected) ? `****${selected.slice(-2)}` : "未取得尾号";
		return { channel: /^[\w-]+$/.test(channel) ? `OpenCode Go (${provider})` : "OpenCode Go", model: LIVE_MODEL, maskedKey,
			comparison, attempts, httpAttempts, httpStatus, payload, keyMatches, placeholder, status, finalUsage,
			answered: message?.content.some(block => block.type === "text" && !!block.text.trim()) === true,
			failure: status === "正常结束" ? undefined : requestFailure({ message: message?.errorMessage, status: httpStatus }, attempts > 0),
			estimatedLimit, estimatedUsage: finalUsage && message?.usage ? estimate(resolved, message.usage) : null };
	} finally {
		try { await core?.shutdown(); }
		finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (!process.argv[2]) throw new Error("缺少只读来源数据目录");
		console.log(JSON.stringify(await probeChannel(resolve(process.argv[2])), null, 2));
	} catch {
		console.error("短请求诊断未完成，请检查隔离配置和本机运行环境。");
		process.exitCode = 1;
	}
}
