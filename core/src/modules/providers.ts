import { existsSync, readFileSync, renameSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Core } from "../core.ts";
import { RpcError, requireStr, str } from "../core.ts";
import type { Llm } from "./llm.ts";
import { isSecretReference, SecretStore } from "./secrets.ts";

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	api: string | null;
	contextWindow: number | null;
	maxTokens: number | null;
	reasoning: boolean;
	input: string[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
}

export interface ProviderInfo {
	id: string;
	name: string;
	baseUrl: string | null;
	api: string | null;
	/** Credentials are available (stored key, environment, OAuth...). */
	configured: boolean;
	authSource: string | null;
	/** Defined (or overridden) in models.json. */
	custom: boolean;
	/** The key lives in DreamFlutter's encrypted store. */
	encryptedKey: boolean;
	models: ModelInfo[];
}

/** A custom provider as the settings form edits it. */
export interface CustomProviderInput {
	id: string;
	name?: string;
	baseUrl: string;
	api: string;
	/** New key; omitted or empty keeps the stored one. */
	apiKey?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
	models: {
		id: string;
		name?: string;
		reasoning?: boolean;
		input?: string[];
		contextWindow?: number;
		maxTokens?: number;
		cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
	}[];
}

export const PROVIDER_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;

type Json = Record<string, unknown>;

/**
 * Model providers and credentials, editing Pi's own files so the CLI sees the
 * same configuration: custom providers in models.json, keys for built-in
 * providers in auth.json. New keys are stored DPAPI-encrypted and referenced
 * with Pi's "!command" syntax.
 */
export class Providers {
	private readonly core: Core;
	private readonly llm: Llm;
	readonly secrets: SecretStore;

	constructor(core: Core, llm: Llm) {
		this.core = core;
		this.llm = llm;
		this.secrets = new SecretStore(core.paths.dataDir);
		this.register();
		// Backups made before keys were redacted may still hold plain-text keys.
		for (const path of [this.modelsPath, this.authPath]) redactBackup(`${path}.before-dreamflutter`);
	}

	private get modelsPath(): string {
		return join(this.core.agentDir, "models.json");
	}

	private get authPath(): string {
		return join(this.core.agentDir, "auth.json");
	}

	async list(): Promise<ProviderInfo[]> {
		const runtime = await this.llm.runtime();
		// The credential snapshot fills in asynchronously: wait for it before reading statuses.
		await runtime.getAvailable();
		const custom = (readJson(this.modelsPath).providers ?? {}) as Record<string, Json>;
		const auth = readJson(this.authPath) as Record<string, Json>;
		const out: ProviderInfo[] = [];
		for (const provider of runtime.getProviders()) {
			const status = runtime.getProviderAuthStatus(provider.id);
			const models = runtime.getModels(provider.id).map(toModelInfo);
			const customEntry = custom[provider.id];
			out.push({
				id: provider.id,
				name: provider.name,
				baseUrl: provider.baseUrl ?? null,
				api: (customEntry?.api as string | undefined) ?? models[0]?.api ?? null,
				configured: status.configured,
				authSource: status.label ?? status.source ?? null,
				custom: customEntry !== undefined,
				encryptedKey: isSecretReference(customEntry?.apiKey) || isSecretReference(auth[provider.id]?.key),
				models,
			});
		}
		return out.sort((a, b) => Number(b.configured) - Number(a.configured) || Number(b.custom) - Number(a.custom) || a.name.localeCompare(b.name));
	}

	async availableModels(): Promise<ModelInfo[]> {
		const runtime = await this.llm.runtime();
		return (await runtime.getAvailable()).map(toModelInfo);
	}

	async saveCustom(input: CustomProviderInput): Promise<void> {
		const id = input.id.trim();
		if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new RpcError("bad_request", "服务商 ID 只能用字母、数字、点、横线和下划线");
		if (!/^https?:\/\//.test(input.baseUrl.trim())) throw new RpcError("bad_request", "接口地址需要以 http:// 或 https:// 开头");
		if (!PROVIDER_APIS.includes(input.api as never)) throw new RpcError("bad_request", `不支持的接口类型：${input.api}`);
		if (!input.models.length) throw new RpcError("bad_request", "至少需要一个模型");

		const config = readJson(this.modelsPath);
		const providers = { ...((config.providers ?? {}) as Record<string, Json>) };
		const previous = providers[id] ?? {};
		const entry: Json = {
			...previous,
			name: input.name?.trim() || id,
			baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
			api: input.api,
			models: input.models.map((m) => ({
				id: m.id.trim(),
				name: m.name?.trim() || m.id.trim(),
				reasoning: m.reasoning ?? false,
				input: m.input?.length ? m.input : ["text"],
				contextWindow: m.contextWindow ?? 128_000,
				maxTokens: m.maxTokens ?? 16_384,
				cost: {
					input: m.cost?.input ?? 0,
					output: m.cost?.output ?? 0,
					cacheRead: m.cost?.cacheRead ?? 0,
					cacheWrite: m.cost?.cacheWrite ?? 0,
				},
			})),
		};
		if (input.headers && Object.keys(input.headers).length) entry.headers = input.headers;
		else delete entry.headers;
		if (input.authHeader !== undefined) entry.authHeader = input.authHeader;
		if (input.apiKey?.trim()) entry.apiKey = await this.secrets.put(`provider-${id}`, input.apiKey.trim());
		if (entry.apiKey === undefined) throw new RpcError("bad_request", "请填写 API Key");
		providers[id] = entry;
		this.writeJson(this.modelsPath, { ...config, providers });
		this.changed();
	}

	removeCustom(id: string): void {
		const config = readJson(this.modelsPath);
		const providers = { ...((config.providers ?? {}) as Record<string, Json>) };
		if (!(id in providers)) return;
		if (isSecretReference(providers[id]!.apiKey)) this.secrets.remove(`provider-${id}`);
		delete providers[id];
		this.writeJson(this.modelsPath, { ...config, providers });
		this.changed();
	}

	/** Stores a key for a built-in provider (auth.json). */
	async setKey(provider: string, apiKey: string): Promise<void> {
		if (!apiKey.trim()) throw new RpcError("bad_request", "API Key 不能为空");
		const auth = readJson(this.authPath);
		auth[provider] = { ...((auth[provider] as Json | undefined) ?? {}), type: "api_key", key: await this.secrets.put(`auth-${provider}`, apiKey.trim()) };
		this.writeJson(this.authPath, auth);
		this.changed();
	}

	removeKey(provider: string): void {
		const auth = readJson(this.authPath);
		if (!(provider in auth)) return;
		if (isSecretReference((auth[provider] as Json).key)) this.secrets.remove(`auth-${provider}`);
		delete auth[provider];
		this.writeJson(this.authPath, auth);
		this.changed();
	}

	/** The API key Pi would send for [provider] (balance queries for channels from Pi's config). */
	async apiKeyOf(provider: string): Promise<string | undefined> {
		const runtime = await this.llm.runtime();
		return (await runtime.getAuth(provider).catch(() => undefined))?.auth.apiKey;
	}

	/** Sends a tiny request to check the provider answers with the stored credentials. */
	async test(provider: string, modelId?: string): Promise<{ ok: boolean; latencyMs: number; model: string | null; reply?: string; error?: string }> {
		const runtime = await this.llm.runtime();
		const model = modelId ? runtime.getModel(provider, modelId) : runtime.getModels(provider)[0];
		if (!model) return { ok: false, latencyMs: 0, model: null, error: "这个服务商没有可用的模型" };
		const started = Date.now();
		try {
			const reply = await this.llm.complete("Reply with the single word OK.", { model: model as never, maxTokens: 32, timeoutMs: 30_000, runtime });
			return { ok: true, latencyMs: Date.now() - started, model: `${model.provider}/${model.id}`, reply: reply.slice(0, 80) };
		} catch (error) {
			return { ok: false, latencyMs: Date.now() - started, model: `${model.provider}/${model.id}`, error: friendlyError(error) };
		}
	}

	/** Lists the models an endpoint offers (OpenAI-compatible `/models`, Anthropic `/v1/models`). */
	async fetchModels(params: { baseUrl?: string; api?: string; apiKey?: string; provider?: string }): Promise<{ id: string; name: string }[]> {
		let baseUrl = params.baseUrl?.trim().replace(/\/+$/, "");
		let api = params.api;
		let apiKey = params.apiKey?.trim();
		if (params.provider) {
			const runtime = await this.llm.runtime();
			const provider = runtime.getProvider(params.provider);
			baseUrl ??= provider?.baseUrl;
			api ??= runtime.getModels(params.provider)[0]?.api;
			if (!apiKey) apiKey = (await runtime.getAuth(params.provider).catch(() => undefined))?.auth.apiKey;
		}
		if (!baseUrl) throw new RpcError("bad_request", "缺少接口地址");
		const anthropic = api === "anthropic-messages";
		const url = anthropic ? `${baseUrl.replace(/\/v1$/, "")}/v1/models?limit=1000` : `${baseUrl}/models`;
		const headers: Record<string, string> = anthropic
			? { "anthropic-version": "2023-06-01", ...(apiKey ? { "x-api-key": apiKey } : {}) }
			: apiKey
				? { Authorization: `Bearer ${apiKey}` }
				: {};
		let response: Response;
		try {
			response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
		} catch (error) {
			throw new RpcError("network", `连接失败：${friendlyError(error)}`);
		}
		if (!response.ok) throw new RpcError("http", `接口返回 ${response.status}${response.status === 401 ? "（API Key 不对或已失效）" : ""}`);
		const body = (await response.json()) as { data?: { id?: string; display_name?: string; name?: string }[]; models?: { id?: string; name?: string; display_name?: string }[] };
		const items = body.data ?? body.models ?? [];
		return items
			.filter((m) => typeof m.id === "string")
			.map((m) => ({ id: m.id!, name: m.display_name ?? m.name ?? m.id! }))
			.sort((a, b) => a.id.localeCompare(b.id));
	}

	private readonly listeners: (() => void)[] = [];

	onChanged(listener: () => void): void {
		this.listeners.push(listener);
	}

	private changed(): void {
		this.core.broadcast({ event: "providers.changed" });
		for (const listener of this.listeners) listener();
	}

	/**
	 * Atomic write; the first change keeps a backup of the user's original file,
	 * with plain-text keys removed (they move to encrypted storage).
	 */
	private writeJson(path: string, value: Json): void {
		const backup = `${path}.before-dreamflutter`;
		if (existsSync(path) && !existsSync(backup)) {
			copyFileSync(path, backup);
			redactBackup(backup);
		}
		const temp = `${path}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		renameSync(temp, path);
	}

	private register(): void {
		const core = this.core;
		core.register("providers.list", () => this.list());
		core.register("providers.available", () => this.availableModels());
		core.register("providers.saveCustom", async (params) => {
			await this.saveCustom(params as unknown as CustomProviderInput);
			return { ok: true };
		});
		core.register("providers.removeCustom", (params) => {
			this.removeCustom(requireStr(params.id, "id"));
			return { ok: true };
		});
		core.register("providers.setKey", async (params) => {
			await this.setKey(requireStr(params.provider, "provider"), requireStr(params.apiKey, "apiKey"));
			return { ok: true };
		});
		core.register("providers.removeKey", (params) => {
			this.removeKey(requireStr(params.provider, "provider"));
			return { ok: true };
		});
		core.register("providers.test", (params) => this.test(requireStr(params.provider, "provider"), str(params.model)));
		core.register("providers.fetchModels", (params) =>
			this.fetchModels({ baseUrl: str(params.baseUrl), api: str(params.api), apiKey: str(params.apiKey), provider: str(params.provider) }),
		);
	}
}

function readJson(path: string): Json {
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object" ? (value as Json) : {};
	} catch {
		return {};
	}
}

function toModelInfo(model: ReturnType<ModelRuntime["getModels"]>[number]): ModelInfo {
	const m = model as unknown as Json;
	const cost = m.cost as ModelInfo["cost"] | undefined;
	return {
		id: String(m.id),
		name: String(m.name ?? m.id),
		provider: String(m.provider),
		api: typeof m.api === "string" ? m.api : null,
		contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : null,
		maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : null,
		reasoning: m.reasoning === true,
		input: Array.isArray(m.input) ? (m.input as string[]) : ["text"],
		cost: cost ? { input: cost.input ?? 0, output: cost.output ?? 0, cacheRead: cost.cacheRead ?? 0, cacheWrite: cost.cacheWrite ?? 0 } : null,
	};
}

export function friendlyError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/401|unauthori[sz]ed|invalid.*api.?key|authentication/i.test(message)) return `API Key 无效或没有权限（${message}）`;
	if (/429|rate.?limit|quota/i.test(message)) return `请求太频繁或额度用完了（${message}）`;
	if (/timeout|timed out|aborted/i.test(message)) return `请求超时（${message}）`;
	if (/ENOTFOUND|ECONNREFUSED|connection|fetch failed|network/i.test(message)) return `连不上服务器（${message}）`;
	return message;
}

const SECRET_FIELD = /^(api_?key|key|token|access_?token|refresh_?token|secret|password)$/i;

/** Replaces plain-text credentials in a JSON backup (references like "!cmd" or "$VAR" stay). */
export function redactBackup(path: string): void {
	if (!existsSync(path)) return;
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return;
	}
	let changed = false;
	const walk = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (typeof v === "string" && SECRET_FIELD.test(k) && v && !v.startsWith("!") && !v.startsWith("$") && v !== REDACTED) {
				(value as Record<string, unknown>)[k] = REDACTED;
				changed = true;
			} else walk(v);
		}
	};
	walk(data);
	if (changed) writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

const REDACTED = "<已移除，DreamFlutter 不在备份里保存密钥>";
