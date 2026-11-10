import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { secretFileOf } from "../modules/secrets.ts";
import { piApi, piPresets } from "./pi-presets.ts";
import { REQUEST_LEDGER_ID } from "../ledger/types.ts";
import { type Api, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, createAssistantMessageEventStream, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import type { ExtensionAPI, ExtensionFactory, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Core, CoreModule } from "../core.ts";
import { num, RpcError, requireStr, str } from "../core.ts";
import { json, now, parseJson } from "../db.ts";
import type { Providers } from "../modules/providers.ts";
import { classifyFailure, FAILURE_LABEL, type FailureKind, isChannelFailure } from "./classify.ts";
import { catalogModel, describeCatalogModel, levelMap, selectedLevelMap, THINKING_LEVELS } from "./catalog.ts";
import { HealthBook } from "./health.ts";
import { type QuotaReading, readQuota } from "./quota.ts";
import { type ChannelApi, type ChannelKind, hostOf, PLATFORMS, platform, platformForUrl } from "./platforms.ts";
import { describe, type Unavailable } from "./router.ts";

/** Provider id the retired model groups used; old references to it are mapped to a channel model. */
export const GROUP_PROVIDER = "dreamflutter";
/** Pi provider id of a DreamFlutter channel. */
export const channelProvider = (channelId: string) => `df-${channelId}`;
/** Pi's own providers show up as channels with this id prefix. */
const PI_PREFIX = "pi:";
/** Pi needs a key on the provider to call it available; the wrapper sends the real one. */
const KEY_PLACEHOLDER = "dreamflutter-gateway";
const QUOTA_INTERVAL_MS = 10 * 60_000;
/** OpenCode's per-conversation routing header (required by OpenCode Go). */
const OPENCODE_SESSION = "x-opencode-session";

export interface ChannelModel {
	/** Complete Pi model metadata retained through import and editing. */
	[key: string]: unknown;
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
	/** The model's own thinking values, from the model list (e.g. low/high/max). */
	efforts?: string[];
	/** User-confirmed capabilities for models absent from the catalog. */
	thinkingLevels?: string[];
}

export interface ChannelKeyInfo {
	id: string;
	label: string;
	enabled: boolean;
	/** Last four characters, for telling keys apart. */
	hint: string;
	unavailable: Unavailable | null;
}

export interface ChannelInfo {
	origin?: string;
	oauth?: boolean;
	id: string;
	/** "df": stored here; "pi": a provider configured in Pi (keys stay in Pi's files). */
	source: "df" | "pi";
	provider: string;
	name: string;
	platform: string | null;
	kind: ChannelKind;
	api: string;
	baseUrl: string;
	models: ChannelModel[];
	headers?: Record<string, string>;
	authHeader: boolean;
	enabled: boolean;
	topUp: number | null;
	/** Remind when the balance falls below this. */
	lowBalance: number | null;
	keys: ChannelKeyInfo[];
	unavailable: Unavailable | null;
}

export interface ChannelInput {
	id?: string;
	name: string;
	platform?: string;
	kind?: ChannelKind;
	api: ChannelApi;
	baseUrl: string;
	models: ChannelModel[];
	headers?: Record<string, string>;
	authHeader?: boolean;
	enabled?: boolean;
	topUp?: number | null;
	lowBalance?: number | null;
	/** Keys: existing ones by id (label/enabled edits), new ones with [secret]. Omitted keys are removed. */
	keys: { id?: string; label?: string; secret?: string; enabled?: boolean }[];
}

export interface ChannelStatus {
	quotaError?: Extract<QuotaReading, { type: "error" }> | null;
	localUsage?: { label: string; allowance: Record<string, number>; amounts: Record<string, number>; amountSources: Record<string, number> };
	id: string;
	name: string;
	kind: ChannelKind;
	platform: string | null;
	source: "df" | "pi";
	unavailable: Unavailable | null;
	quota: QuotaReading | null;
	/** The platform has a balance or allowance query. */
	canQuery: boolean;
	today: { requests: number; failures: number; cost: number; avgFirstTokenMs: number | null };
	last5h: { requests: number; tokens: number };
	/** All-time spend through the gateway; with [remaining] for relays the user tops up by hand. */
	spent: number;
	remaining: number | null;
	lastError: { at: number; kind: string; message: string } | null;
}

/** A model stream (pi-ai's streamSimple; tests pass a faux one). */
export type Transport = (model: Model<Api>, context: Parameters<typeof streamSimple>[1], options?: SimpleStreamOptions) => AssistantMessageEventStream;

interface ChannelRow {
	id: string;
	name: string;
	platform: string | null;
	kind: string;
	api: string;
	base_url: string;
	models: string;
	headers: string | null;
	auth_header: number;
	enabled: number;
	top_up: number | null;
	low_balance: number | null;
}

interface KeyRow {
	id: string;
	channel_id: string;
	label: string | null;
	secret: string;
	enabled: number;
}

/** A retired model group's stored entries (0.8.1: groups are gone; old references are mapped, see [retiredGroupTarget]). */
interface RetiredGroupRow {
	id: string;
	entries: string;
}

/** What registration needs from a session's extension API or a bare model runtime. */
interface Target {
	registerProvider(id: string, config: Record<string, unknown>): void;
	unregisterProvider(id: string): void;
	unregisterVirtualModel?(provider: string, id: string): void;
}

interface Registered {
	providers: Set<string>;
	find: (provider: string, id: string) => Model<Api> | undefined;
}

/**
 * The personal model gateway (docs/v0.2-gateway.md). Channels become Pi
 * providers whose stream goes through [wrap]: it picks the key, records each
 * request and keeps the circuit breaker. Model groups were retired in 0.8.1
 * (the user's decision, docs/REVIEW-2026-11-10.md): a setting or an old
 * conversation that chose one now uses the group's first model whose channel
 * still exists.
 */
export class Gateway implements CoreModule {
	configChanged?: () => Promise<unknown>;
	async refreshConfiguration(): Promise<void> { await this.refreshPiChannels(); }
	/** Subagents pick channel models like any session. */
	readonly forSubagents = true;
	private readonly core: Core;
	private readonly providers: Providers;
	private readonly transport: Transport;
	private readonly clock: () => number;
	private readonly fetch: typeof fetch;
	private quotaTimer: NodeJS.Timeout | undefined;
	private stopped = false;
	readonly health: HealthBook;
	/** Channels from Pi's own configuration, refreshed when providers change. */
	private piChannels: ChannelInfo[] = [];
	private readonly piWindows = new Map<string, number | null>();
	/** What each session's extension API has registered (kept current on changes). */
	private readonly targets = new Map<Target, Registered>();
	/** What a model runtime used outside sessions has registered. */
	private readonly runtimes = new WeakMap<ModelRuntime, Registered>();
	/** The last failed balance or allowance query per channel (the good reading stays). */
	private readonly quotaErrors = new Map<string, QuotaReading>();
	/** The entry a session's latest group request went to, so the wrapper knows it may switch. */
	/** Key each session uses per channel (one account keeps its prompt cache). */
	private readonly sessionKeys = new Map<string, string>();
	private readonly secrets = new Map<string, string>();
	/** Round-robin position per channel, for sessions that have no key yet. */
	private readonly keyTurns = new Map<string, number>();

	constructor(core: Core, providers: Providers, options: { transport?: Transport; clock?: () => number; fetch?: typeof fetch } = {}) {
		this.core = core;
		this.providers = providers;
		core.declareBackup({
			id: "gateway",
			title: "模型渠道、模型组、请求记录",
			tables: ["gateway_channels", "gateway_keys", "gateway_groups", "gateway_requests", "gateway_quota"],
			paths: { gateway_keys: { secret: "secretRef" } },
		});
		this.transport = options.transport ?? (streamSimple as Transport);
		this.clock = options.clock ?? Date.now;
		this.fetch = options.fetch ?? fetch;
		this.health = new HealthBook(this.clock);
		providers.onChanged(() => void this.refreshPiChannels());
		core.resolveModel = (model) => this.resolveModel(model);
		core.modelWindow = (model) => this.window(model.provider, model.id, model.contextWindow) === null ? null : model.contextWindow;
		core.settings.onChange((_settings, keys) => {
			if (keys.includes("modelContextWindows")) this.changed();
		});
		this.register();
	}

	async start(): Promise<void> {
		await this.refreshPiChannels();
		this.retireGroupSettings();
		this.quotaTimer = setInterval(() => void this.refreshQuotas(), QUOTA_INTERVAL_MS);
		this.quotaTimer.unref();
	}

	stop(): void {
		this.stopped = true;
		clearInterval(this.quotaTimer);
	}

	// ---- balances and plan allowances ----------------------------------------------

	/** Reads the balance or allowance of [channelId] (or every channel that has a query). */
	async refreshQuotas(channelId?: string): Promise<void> {
		const channels = this.channels().filter((c) => (channelId ? c.id === channelId : c.enabled) && platform(c.platform)?.quota);
		await Promise.all(
			channels.map(async (channel) => {
				const key = channel.source === "df" ? await this.firstKey(channel) : { id: "pi", secret: await this.providers.apiKeyOf(channel.provider) };
				if (!key?.secret) return;
				const reading = await readQuota(platform(channel.platform)!.quota!, channel.baseUrl, key.secret, this.fetch, this.clock);
				this.applyReading(channel, key.id, reading.type === "error" ? { ...reading, message: redact(reading.message, [key.secret]) } : reading);
			}),
		);
		if (channels.length) this.core.broadcast({ event: "gateway.changed" });
	}

	/** The key a channel's balance is read with: its first usable one. */
	private async firstKey(channel: ChannelInfo): Promise<{ id: string; secret: string } | undefined> {
		const key = channel.keys.find((k) => k.enabled && k.unavailable?.kind !== "auth") ?? channel.keys.find((k) => k.enabled);
		return key ? { id: key.id, secret: await this.secret(key.id) } : undefined;
	}

	private async firstSecret(channel: ChannelInfo): Promise<string | undefined> {
		return (await this.firstKey(channel))?.secret;
	}

	/**
	 * A reading is about the account of the key it was read with ([keyId]):
	 * other keys of the channel may belong to other accounts. A failed query
	 * keeps the last good reading (and so the reminders' memory).
	 */
	private applyReading(channel: ChannelInfo, keyId: string, reading: QuotaReading): void {
		if (this.stopped) return;
		if (reading.type === "error") {
			this.quotaErrors.set(channel.id, reading);
			return;
		}
		this.quotaErrors.delete(channel.id);
		const previous = this.reading(channel.id);
		this.core.db.run(
			"INSERT INTO gateway_quota(channel, data, checked_at) VALUES(?, ?, ?) ON CONFLICT(channel) DO UPDATE SET data = excluded.data, checked_at = excluded.checked_at",
			channel.id,
			json(reading),
			reading.checkedAt,
		);
		const keys = [`${channel.id}#${keyId}`];
		if (reading.type === "plan") {
			const full = reading.windows.filter((w) => w.usedPercent >= 100);
			if (full.length) {
				const until = Math.max(...full.map((w) => w.resetAt ?? 0)) || undefined;
				for (const key of keys) this.health.fail(key, "quota", `${full.map((w) => w.label).join("、")}额度用完`, until);
			} else {
				this.health.clearQuota(keys[0]!);
			}
			// Remind once per window period at 80 %.
			for (const window of reading.windows) {
				const before = previous?.type === "plan" ? previous.windows.find((w) => w.label === window.label && w.resetAt === window.resetAt) : undefined;
				if (window.usedPercent >= 80 && (before?.usedPercent ?? 0) < 80) {
					this.alert(`${channel.name} 额度已用 ${Math.round(window.usedPercent)}%`, `${window.label}${window.resetAt ? `，${describe({ kind: "quota", message: "", until: window.resetAt }).replace(/^额度用完，/, "")}` : ""}`);
				}
			}
		} else if (reading.type === "balance") {
			const balances = reading.balances ?? [reading];
			if (balances.every((b) => b.amount !== null && b.amount <= 0)) for (const key of keys) this.health.fail(key, "balance", "所有货币余额均为 0");
			else this.health.clearQuota(keys[0]!);
			const low = channel.lowBalance;
			const wasAbove = previous?.type !== "balance" || low === null || previous.amount >= low;
			if (balances.length === 1 && low !== null && reading.amount < low && wasAbove) this.alert(`${channel.name} 余额不足`, `剩余 ${reading.amount.toFixed(2)} ${reading.currency}，低于你设的 ${low}`);
		}
	}

	private alert(title: string, body: string): void {
		this.core.notifier.notify(title, body);
		this.core.broadcast({ event: "gateway.alert", title, body });
	}

	private reading(channelId: string): QuotaReading | undefined {
		const row = this.core.db.get<{ data: string }>("SELECT data FROM gateway_quota WHERE channel = ?", channelId);
		const value = row ? parseJson<QuotaReading | undefined>(row.data, undefined) : undefined;
		if (value?.type === "balance" && (!Number.isFinite(value.amount) || value.amount < 0)) return undefined;
		if (value?.type === "plan" && value.windows.some((w) => typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100)) return undefined;
		return value;
	}

	/** What the dashboard shows per channel: state, allowance or balance, today's traffic, last error. */
	status(): ChannelStatus[] {
		const time = this.clock();
		const dayStart = new Date(time).setHours(0, 0, 0, 0);
		const locals = new Map((this.core.ledger?.summary({ period: "all", groupBy: "channel" }).rows ?? []).map((row) => [row.key, row]));
		return this.channels().map((channel) => {
			const today = this.core.db.get<{ requests: number; failures: number; cost: number; ttft: number | null }>(
				"SELECT COUNT(*) AS requests, SUM(success = 0) AS failures, COALESCE(SUM(CASE WHEN currency='USD' THEN amount END),0) AS cost, AVG(ttft_ms) AS ttft FROM request_ledger WHERE channel = ? AND requested_at >= ?",
				channel.id,
				dayStart,
			)!;
			const recent = this.core.db.get<{ requests: number; tokens: number }>(
				"SELECT COUNT(*) AS requests, COALESCE(SUM(input + output + cache_read + cache_write), 0) AS tokens FROM request_ledger WHERE channel = ? AND requested_at >= ?",
				channel.id,
				time - 5 * 3_600_000,
			)!;
			const spent = this.core.db.get<{ cost: number }>("SELECT COALESCE(SUM(amount),0) AS cost FROM request_ledger WHERE channel=? AND currency='USD'", channel.id)!.cost;
			const local = locals.get(channel.id);
			const lastError = this.core.db.get<{ at: number; kind: string; message: string }>(
				"SELECT at, error_kind AS kind, error AS message FROM gateway_requests WHERE channel = ? AND ok = 0 AND error_kind IS NOT NULL ORDER BY at DESC LIMIT 1",
				channel.id,
			);
			return {
				id: channel.id,
				name: channel.name,
				kind: channel.kind,
				platform: channel.platform,
				source: channel.source,
				unavailable: channel.unavailable,
				quota: this.reading(channel.id) ?? this.quotaErrors.get(channel.id) ?? null,
				quotaError: this.quotaErrors.get(channel.id) as Extract<QuotaReading, { type: "error" }> | undefined ?? null,
				localUsage: { label: "本机累计用量（估算）", allowance: local?.allowance ?? {}, amounts: local?.amounts ?? {}, amountSources: local?.amountSources ?? {} },
				canQuery: platform(channel.platform)?.quota !== undefined,
				today: { requests: Number(today.requests), failures: Number(today.failures ?? 0), cost: today.cost, avgFirstTokenMs: today.ttft === null ? null : Math.round(today.ttft) },
				last5h: { requests: Number(recent.requests), tokens: Number(recent.tokens) },
				spent,
				remaining: channel.kind === "plan" || channel.topUp === null ? null : channel.topUp - spent,
				lastError: lastError ? { at: lastError.at, kind: lastError.kind, message: lastError.message } : null,
			};
		});
	}

	// ---- channels ------------------------------------------------------------------

	channels(): ChannelInfo[] {
		const rows = this.core.db.all<ChannelRow>("SELECT * FROM gateway_channels ORDER BY sort, created_at");
		const keys = this.core.db.all<KeyRow>("SELECT * FROM gateway_keys ORDER BY sort, created_at");
		const own = rows.map((row): ChannelInfo => {
			const imported = this.core.db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pi_channel_map'").get() ? this.core.db.get<{ source: string }>("SELECT source FROM pi_channel_map WHERE channel_id=?", row.id) : undefined;
			const channelKeys = keys
				.filter((k) => k.channel_id === row.id)
				.map((k) => ({
					id: k.id,
					label: k.label ?? "",
					enabled: k.enabled === 1,
					hint: this.secrets.get(k.id)?.slice(-4) ?? "",
					unavailable: this.health.status(`${row.id}#${k.id}`),
				}));
			const channel: ChannelInfo = {
				id: row.id,
				origin: imported?.source,
				source: "df",
				provider: channelProvider(row.id),
				name: row.name,
				platform: row.platform,
				kind: row.kind as ChannelKind,
				api: row.api,
				baseUrl: row.base_url,
				models: parseJson<ChannelModel[]>(row.models, []),
				headers: parseJson<Record<string, string> | undefined>(row.headers, undefined),
				authHeader: row.auth_header === 1,
				enabled: row.enabled === 1,
				topUp: row.top_up,
				lowBalance: row.low_balance,
				keys: channelKeys,
				unavailable: null,
			};
			channel.unavailable = this.channelStatus(channel);
			return channel;
		});
		const pi = this.piChannels.map((c) => ({ ...c, keys: c.keys.map((k) => ({ ...k, unavailable: this.health.status(`${c.id}#${k.id}`) })), unavailable: this.health.status(`${c.id}#pi`) }));
		return [...own, ...pi];
	}

	channel(id: string): ChannelInfo | undefined {
		return this.channels().find((c) => c.id === id);
	}

	async saveChannel(input: ChannelInput): Promise<string> {
		if (this.core.maintenance === "正在迁移 Pi 服务商") throw new RpcError("busy", "Pi 迁移正在进行，请完成后再修改渠道。");
		const name = input.name?.trim();
		if (!name) throw new RpcError("bad_request", "请填写渠道名称");
		const baseUrl = input.baseUrl?.trim().replace(/\/+$/, "");
		if (!baseUrl || !/^https?:\/\//.test(baseUrl)) throw new RpcError("bad_request", "接口地址需要以 http:// 或 https:// 开头");
		if (!piApi(input.api)) throw new RpcError("bad_request", `不支持的接口类型：${input.api}`);
		const previousModels = input.id ? this.channel(input.id)?.models ?? [] : [];
		const models = (input.models ?? []).filter((m) => m.id?.trim()).map((m) => ({ ...previousModels.find((old) => old.id === m.id), ...m, id: m.id.trim() }));
		if (!models.length) throw new RpcError("bad_request", "至少需要一个模型");
		for (const model of models) {
			if (model.contextWindow !== undefined && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0)) throw new RpcError("bad_request", "上下文窗口需要是正整数");
			const levels = model.thinkingLevels;
			if (levels !== undefined) {
				if (!Array.isArray(levels) || !levels.length || new Set(levels).size !== levels.length || levels.some((l) => !THINKING_LEVELS.includes(l as never))) throw new RpcError("bad_request", "请至少选择一个有效的思考档位");
				model.reasoning = levels.some((l) => l !== "off");
			}
		}
		const id = input.id ?? `c${randomUUID().slice(0, 8)}`;
		if (input.id && !this.core.db.get("SELECT id FROM gateway_channels WHERE id = ?", input.id)) throw new RpcError("not_found", "找不到这个渠道");
		const kind = input.kind ?? platform(input.platform)?.kind ?? "relay";
		const existingKeys = this.core.db.all<KeyRow>("SELECT * FROM gateway_keys WHERE channel_id = ?", id);
		const keep = new Set(input.keys.map((k) => k.id).filter((k): k is string => !!k));
		if (!input.keys.some((k) => (k.id && existingKeys.some((e) => e.id === k.id)) || k.secret?.trim())) throw new RpcError("bad_request", "请至少填写一个 API Key");

		// Encrypt new keys before touching the database (DPAPI runs a process).
		const fresh: { id: string; label: string; ref: string; secret: string; enabled: boolean; sort: number }[] = [];
		for (const [sort, key] of input.keys.entries()) {
			if (key.id || !key.secret?.trim()) continue;
			const keyId = `k${randomUUID().slice(0, 8)}`;
			fresh.push({ id: keyId, label: key.label?.trim() ?? "", ref: await this.providers.secrets.put(`gateway-${keyId}`, key.secret.trim()), secret: key.secret.trim(), enabled: key.enabled !== false, sort });
		}
		const time = now();
		this.core.db.transaction(() => {
			this.core.db.run(
				`INSERT INTO gateway_channels(id, name, platform, kind, api, base_url, models, headers, auth_header, enabled, top_up, low_balance, created_at)
				 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET name = excluded.name, platform = excluded.platform, kind = excluded.kind, api = excluded.api,
				   base_url = excluded.base_url, models = excluded.models, headers = excluded.headers, auth_header = excluded.auth_header,
				   enabled = excluded.enabled, top_up = excluded.top_up, low_balance = excluded.low_balance`,
				id,
				name,
				input.platform ?? null,
				kind,
				input.api,
				baseUrl,
				json(models),
				input.headers && Object.keys(input.headers).length ? json(input.headers) : null,
				input.authHeader ? 1 : 0,
				input.enabled === false ? 0 : 1,
				input.topUp ?? null,
				input.lowBalance ?? null,
				time,
			);
			for (const old of existingKeys) {
				if (keep.has(old.id)) continue;
				this.core.db.run("DELETE FROM gateway_keys WHERE id = ?", old.id);
				this.providers.secrets.remove(`gateway-${old.id}`);
				this.secrets.delete(old.id);
			}
			for (const [sort, key] of input.keys.entries()) {
				if (!key.id || !keep.has(key.id)) continue;
				this.core.db.run("UPDATE gateway_keys SET label = COALESCE(?, label), enabled = ?, sort = ? WHERE id = ? AND channel_id = ?", key.label?.trim() ?? null, key.enabled === false ? 0 : 1, sort, key.id, id);
			}
			for (const key of fresh) {
				this.core.db.run("INSERT INTO gateway_keys(id, channel_id, label, secret, enabled, sort, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)", key.id, id, key.label, key.ref, key.enabled ? 1 : 0, key.sort, time);
			}
		});
		for (const key of fresh) this.secrets.set(key.id, key.secret);
		this.health.reset(id);
		await this.configChanged?.();
		this.changed();
		return id;
	}

	async removeChannel(id: string): Promise<void> {
		if (this.core.maintenance === "正在迁移 Pi 服务商") throw new RpcError("busy", "Pi 迁移正在进行，请完成后再修改渠道。");
		if (id.startsWith(PI_PREFIX)) throw new RpcError("bad_request", "来自 Pi 配置的渠道请在「Pi 配置」里删除");
		for (const key of this.core.db.all<KeyRow>("SELECT * FROM gateway_keys WHERE channel_id = ?", id)) {
			this.providers.secrets.remove(`gateway-${key.id}`);
			this.secrets.delete(key.id);
		}
		this.core.db.run("DELETE FROM gateway_channels WHERE id = ?", id);
		this.health.reset(id);
		await this.configChanged?.();
		this.changed();
	}

	private channelStatus(channel: ChannelInfo): Unavailable | null {
		if (!channel.enabled) return { kind: "disabled", message: "已停用" };
		if (channel.source === "pi") return this.health.status(`${channel.id}#pi`);
		const enabled = channel.keys.filter((k) => k.enabled);
		if (!enabled.length) return { kind: "no_key", message: "没有可用的 Key" };
		const resting = enabled.map((k) => k.unavailable);
		if (resting.some((r) => r === null)) return null;
		// Every key rests: report the one back soonest (a stopped key never comes back by itself).
		return resting.filter((r): r is Unavailable => r !== null).sort((a, b) => (a.until ?? Infinity) - (b.until ?? Infinity))[0]!;
	}

	private async refreshPiChannels(): Promise<void> {
		try {
			const list = await this.providers.list();
			this.piWindows.clear();
			for (const provider of list) for (const model of provider.models) this.piWindows.set(`${provider.id}/${model.id}`, model.contextWindow);
			this.piChannels = list
				.filter((p) => (p.configured || p.authSource === "oauth") && p.id !== GROUP_PROVIDER && !p.id.startsWith("df-") && !!p.api)
				.map((p) => {
					const known = platformForUrl(p.baseUrl);
					return {
						id: `${PI_PREFIX}${p.id}`,
						oauth: p.authSource === "oauth",
						source: "pi" as const,
						provider: p.id,
						name: p.name,
						platform: known?.id ?? null,
						kind: known?.kind ?? "payg",
						api: p.api!,
						baseUrl: p.baseUrl ?? "",
						models: p.models.map((m) => ({ id: m.id, name: m.name, reasoning: m.reasoning, input: m.input, contextWindow: m.contextWindow ?? undefined, maxTokens: m.maxTokens ?? undefined, cost: m.cost ?? undefined })),
						authHeader: false,
						enabled: p.authSource === "oauth" ? p.configured : true,
						topUp: null,
						lowBalance: null,
						keys: [{ id: "pi", label: p.authSource ?? "Pi 配置", enabled: true, hint: "", unavailable: null }],
						unavailable: null,
					};
				});
		} catch (error) {
			this.core.log.warn(`gateway: could not read Pi providers: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.changed();
	}

	// ---- retired model groups (0.8.1) ----------------------------------------------

	/**
	 * Where an old reference to a model group goes now: the group's first entry
	 * (by priority) whose channel and model still exist, as a "provider/model" key;
	 * null when none is left (then the default model is used). [ref] that is not a
	 * group reference gives undefined. The old fallback chain was group "auto".
	 */
	retiredGroupTarget(ref: string): string | null | undefined {
		const prefix = `${GROUP_PROVIDER}/`;
		if (!ref.startsWith(prefix)) return undefined;
		const id = ref.slice(prefix.length);
		const row = this.core.db.get<RetiredGroupRow>("SELECT id, entries FROM gateway_groups WHERE id = ?", id);
		const entries = row
			? parseJson<{ channel: string; model: string; priority?: number }[]>(row.entries, []).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
			: id === "auto"
				? this.core.settings.get().fallbackModels.map((key) => { const slash = key.indexOf("/"); const provider = key.slice(0, slash); return { channel: provider.startsWith("df-") ? provider.slice(3) : `${PI_PREFIX}${provider}`, model: key.slice(slash + 1) }; })
				: [];
		for (const entry of entries) {
			const channel = this.channel(entry.channel);
			if (channel?.models.some((m) => m.id === entry.model)) return `${channel.provider}/${entry.model}`;
		}
		return null;
	}

	/** Settings that chose a model group now name the model it would have used first. */
	private retireGroupSettings(): void {
		const settings = this.core.settings.get() as unknown as Record<string, unknown>;
		const patch: Record<string, unknown> = {};
		for (const key of ["defaultModel", "smallTaskModel", "largeTaskModel", "visionModel", "auxModel", "memoryModel"]) {
			const value = settings[key];
			if (typeof value !== "string") continue;
			const target = this.retiredGroupTarget(value);
			if (target !== undefined) patch[key] = target;
		}
		const overrides = settings.modelOverrides;
		if (overrides && typeof overrides === "object") {
			let changed = false;
			const next = Object.fromEntries(Object.entries(overrides as Record<string, unknown>).map(([purpose, ref]) => {
				const target = typeof ref === "string" ? this.retiredGroupTarget(ref) : undefined;
				if (target === undefined) return [purpose, ref];
				changed = true;
				return [purpose, target];
			}));
			if (changed) patch.modelOverrides = next;
		}
		const windows = settings.modelContextWindows as Record<string, number> | undefined;
		if (windows && Object.keys(windows).some((k) => k.startsWith(`${GROUP_PROVIDER}/`))) patch.modelContextWindows = Object.fromEntries(Object.entries(windows).filter(([k]) => !k.startsWith(`${GROUP_PROVIDER}/`)));
		if (Object.keys(patch).length) {
			this.core.settings.update(patch as never);
			this.core.log.info(`gateway: model groups retired; settings now use their first model (${Object.keys(patch).join(", ")})`);
		}
	}

	/** null means unknown. The SDK's existing 128K fallback is only for execution. */
	window(provider: string, id: string, fallback?: number, sourceOnly = false): number | null {
		const key = `${provider}/${id}`;
		const override = this.core.settings.get().modelContextWindows[key];
		if (!sourceOnly && override !== undefined) return override;
		if (provider.startsWith("df-")) {
			const channel = this.channel(provider.slice(3));
			const model = channel?.models.find((m) => m.id === id);
			return model?.contextWindow ?? catalogModel(platform(channel?.platform)?.catalog, id)?.contextWindow ?? null;
		}
		return this.piWindows.has(key) ? this.piWindows.get(key)! : (fallback || null);
	}

	resolveModel(model: Model<Api>): Model<Api> {
		const contextWindow = this.window(model.provider, model.id, model.contextWindow) ?? 128_000;
		return contextWindow === model.contextWindow ? model : { ...model, contextWindow };
	}

	// ---- registration --------------------------------------------------------------

	/** The session extension: registers the channels, and keeps them current. */
	extensions(): ExtensionFactory[] {
		return [
			(pi: ExtensionAPI) => {
				const target: Target = {
					registerProvider: (id, config) => pi.registerProvider(id, config as never),
					unregisterProvider: (id) => pi.unregisterProvider(id),
				};
				pi.on("session_shutdown", () => void this.targets.delete(target));
				const registered: Registered = { providers: new Set(), find: () => undefined };
				this.targets.set(target, registered);
				this.apply(target, registered);
			},
		];
	}

	/** Registers the channels on a model runtime used outside sessions (titles, memory, tests). */
	installRuntime(runtime: ModelRuntime): void {
		this.core.ledger?.install(runtime, () => ({ purpose: "auxiliary" }));
		// One-off runtimes (a title, a connection test) are not kept for later
		// changes; registering again on a reused one replaces what it had.
		const target: Target = {
			registerProvider: (id: string, config: Record<string, unknown>) => runtime.registerProvider(id, config as never),
			unregisterProvider: (id: string) => runtime.unregisterProvider(id),
		};
		const registered = this.runtimes.get(runtime) ?? { providers: new Set<string>(), find: (provider, id) => runtime.getModel(provider, id) as Model<Api> | undefined };
		this.runtimes.set(runtime, registered);
		this.apply(target, registered);
	}

	private apply(target: Target, registered: Registered): void {
		const providers = new Set<string>();
		for (const channel of this.channels()) {
			// Pi's own providers stay Pi's; only DreamFlutter channels are registered (and their stream wrapped).
			if (channel.source !== "df" || !channel.enabled || !channel.keys.some((k) => k.enabled)) continue;
			providers.add(channel.provider);
			this.safely(() =>
				target.registerProvider(channel.provider, {
					name: channel.name,
					baseUrl: channel.baseUrl,
					apiKey: KEY_PLACEHOLDER,
					api: channel.api,
					headers: channel.headers ?? {},
					authHeader: channel.authHeader,
					streamSimple: this.wrap(channel.id),
					models: channel.models.map((m) => ({ ...modelConfig(channel, m), contextWindow: this.window(channel.provider, m.id) ?? 128_000 })),
				}),
			);
		}
		for (const old of registered.providers) {
			if (!providers.has(old) && old.startsWith("df-")) this.safely(() => target.unregisterProvider(old));
		}
		registered.providers = providers;
	}

	private safely(action: () => void): void {
		try {
			action();
		} catch (error) {
			this.core.log.warn(`gateway: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private changed(): void {
		for (const [target, registered] of this.targets) this.apply(target, registered);
		this.core.broadcast({ event: "gateway.changed" });
	}

	// ---- the channel stream ----------------------------------------------------------

	private wrap(channelId: string): Transport {
		return (model, context, options) => {
			const out = createAssistantMessageEventStream();
			void this.relay(channelId, model, context, options, out);
			return out;
		};
	}

	private async relay(channelId: string, model: Model<Api>, context: Parameters<Transport>[1], options: SimpleStreamOptions | undefined, out: AssistantMessageEventStream): Promise<void> {
		const channel = this.channel(channelId);
		const sessionId = options?.sessionId;
		const started = this.clock();
		let key: { id: string; secret: string } | undefined;
		let firstToken: number | undefined;
		let streamed = false;

		const fail = (failure: AssistantMessage, reason: "aborted" | "error") => {
			this.core.ledger?.timing((options as (SimpleStreamOptions & { [REQUEST_LEDGER_ID]?: string }) | undefined)?.[REQUEST_LEDGER_ID], firstToken === undefined ? undefined : started + firstToken);
			failure = { ...failure, errorMessage: failure.errorMessage === undefined ? undefined : redact(failure.errorMessage, [key?.secret, options?.apiKey]) };
			const kind = reason === "aborted" ? "other" : classifyFailure(failure.errorMessage);
			this.record(channelId, key?.id, model.id, undefined, sessionId, started, firstToken, failure, reason === "aborted" ? undefined : kind);
			if (reason !== "aborted" && isChannelFailure(kind)) {
				this.health.fail(`${channelId}#${key?.id ?? "pi"}`, kind, failure.errorMessage ?? "");
			}
			// Pi does not retry quota, balance or key errors. When this channel has another
			// key that is still healthy, say it so that Pi retries: [pickKey] then takes that key.
			const otherKey = key && this.channel(channelId)?.keys.some((k) => k.enabled && k.id !== key!.id && k.unavailable === null);
			if (otherKey && !streamed && reason !== "aborted" && isChannelFailure(kind) && !isRetryableAssistantError(failure)) {
				out.push({ type: "error", reason: "error", error: { ...failure, errorMessage: `渠道「${channel?.name ?? channelId}」的这个 Key ${FAILURE_LABEL[kind]}，换同渠道的另一个 Key（service temporarily unavailable）` } });
			} else {
				out.push({ type: "error", reason, error: failure });
			}
		};

		try {
			key = channel?.source === "df" ? await this.pickKey(channel, sessionId) : undefined;
			if (this.stopped) { out.end(); return; }
			let request = options;
			if (key) {
				// Pi built its auth header from the placeholder key (authHeader channels): put the real one in.
				const secret = key.secret;
				const headers = options?.headers ? Object.fromEntries(Object.entries(options.headers).map(([k, v]) => [k, typeof v === "string" ? v.split(KEY_PLACEHOLDER).join(secret) : v])) : undefined;
				request = { ...options, apiKey: secret, ...(headers ? { headers } : {}) };
			}
			// OpenCode rejects requests without a conversation header. Pi adds it from the
			// session; background work (titles, memory) has none, so it gets a steady one.
			if (hostOf(model.baseUrl) === "opencode.ai" && !Object.keys(request?.headers ?? {}).some((h) => h.toLowerCase() === OPENCODE_SESSION)) {
				request = { ...request, headers: { ...request?.headers, [OPENCODE_SESSION]: `dreamflutter-${channelId}` } };
			}
			const inner = this.transport(model, context, request);
			for await (const event of inner as AsyncIterable<AssistantMessageEvent>) {
				if (event.type === "done") {
					this.core.ledger?.timing((options as (SimpleStreamOptions & { [REQUEST_LEDGER_ID]?: string }) | undefined)?.[REQUEST_LEDGER_ID], firstToken === undefined ? undefined : started + firstToken);
					this.health.succeed(`${channelId}#${key?.id ?? "pi"}`);
					this.record(channelId, key?.id, model.id, undefined, sessionId, started, firstToken, event.message, undefined);
					out.push(event);
					continue;
				}
				if (event.type === "error") {
					fail(event.error, event.reason);
					continue;
				}
				// Only real output counts: an empty block opened before an error leaves nothing to lose.
				if ((event.type.endsWith("_delta") && (event as { delta?: string }).delta) || event.type === "toolcall_end") {
					firstToken ??= this.clock() - started;
					streamed = true;
				}
				out.push(event);
			}
		} catch (error) {
			fail(errorMessage(model, error instanceof Error ? error.message : String(error)), "error");
		}
		out.end();
	}

	private async pickKey(channel: ChannelInfo, sessionId: string | undefined): Promise<{ id: string; secret: string }> {
		const enabled = channel.keys.filter((k) => k.enabled);
		if (!enabled.length) throw new Error(`渠道「${channel.name}」没有可用的 Key`);
		const healthy = enabled.filter((k) => k.unavailable === null);
		const stickyKey = sessionId ? this.sessionKeys.get(`${sessionId}|${channel.id}`) : undefined;
		let chosen = healthy.find((k) => k.id === stickyKey);
		if (!chosen) {
			// None healthy: a resting key is still tried (one key per channel is common), a rejected one never.
			const pool = healthy.length ? healthy : enabled.filter((k) => k.unavailable?.kind !== "auth");
			if (!pool.length) throw new Error(`渠道「${channel.name}」的 Key 都被拒绝了（${describe(enabled[0]!.unavailable!)}），请在设置里检查 Key`);
			const turn = this.keyTurns.get(channel.id) ?? 0;
			this.keyTurns.set(channel.id, turn + 1);
			chosen = pool[turn % pool.length]!;
			if (sessionId) this.sessionKeys.set(`${sessionId}|${channel.id}`, chosen.id);
		}
		return { id: chosen.id, secret: await this.secret(chosen.id) };
	}

	private async secret(keyId: string): Promise<string> {
		const cached = this.secrets.get(keyId);
		if (cached !== undefined) return cached;
		const stored = this.core.db.get<{ secret: string; channel_id: string }>("SELECT secret,channel_id FROM gateway_keys WHERE id=?", keyId);
		const file = stored && secretFileOf(stored.secret);
		if (stored && (!file || !existsSync(file) || resolve(file).toLowerCase() !== resolve(this.providers.secrets.fileFor(basename(file).replace(/\.dpapi$/, ""))).toLowerCase())) {
			const resolved = await this.providers.apiKeyOf(channelProvider(stored.channel_id));
			if (!resolved) throw new RpcError("missing_credential", "渠道凭据引用当前不可用，请检查对应命令或环境变量。");
			return resolved;
		}
		if (file) return this.providers.secrets.get(basename(file).replace(/\.dpapi$/, ""));
		const value = await this.providers.secrets.get(`gateway-${keyId}`);
		// The key may have been deleted while it was being decrypted: then do not keep it.
		if (!this.stopped && this.core.db.get("SELECT id FROM gateway_keys WHERE id = ?", keyId)) this.secrets.set(keyId, value);
		return value;
	}

	private record(
		channel: string,
		keyId: string | undefined,
		model: string,
		group: string | undefined,
		sessionId: string | undefined,
		started: number,
		firstToken: number | undefined,
		message: AssistantMessage,
		failure: FailureKind | undefined,
	): void {
		// A transport can ignore abort and finish after the memory shutdown deadline.
		if (this.stopped) return;
		const usage = message.usage;
		try {
			this.core.db.run(
				`INSERT INTO gateway_requests(at, channel, key_id, model, group_id, session_id, ok, error_kind, error, ttft_ms, duration_ms, input, output, cache_read, cache_write, cost)
				 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				started,
				channel,
				keyId ?? null,
				model,
				group ?? null,
				sessionId ?? null,
				message.stopReason === "error" ? 0 : 1,
				failure ?? null,
				message.stopReason === "error" ? (message.errorMessage ?? null) : null,
				firstToken ?? null,
				this.clock() - started,
				usage?.input ?? 0,
				usage?.output ?? 0,
				usage?.cacheRead ?? 0,
				usage?.cacheWrite ?? 0,
				usage?.cost?.total ?? 0,
			);
		} catch (error) {
			this.core.log.warn(`gateway: could not record a request: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// ---- methods -------------------------------------------------------------------

	private register(): void {
		const core = this.core;
		// Suggested models come with what the catalog knows (limits, prices, thinking levels).
		core.register("gateway.platforms", () =>
			[...PLATFORMS.map((p) => ({ ...p, modelDetails: (p.models ?? []).map((id) => mapOr(catalogModel(p.catalog, id), describeCatalogModel, { id, name: id })) })), ...piPresets()],
		);
		core.register("gateway.channels", () => this.channels());
		core.register("gateway.modelWindow", (params) => {
			const provider = requireStr(params.provider, "provider");
			const id = requireStr(params.model, "model");
			const configured = provider.startsWith("df-") && this.channel(provider.slice(3))?.models.find((m) => m.id === id)?.contextWindow;
			return { value: this.window(provider, id, undefined, true), source: provider === GROUP_PROVIDER ? "group" : configured ? "channel" : "catalog" };
		});
		core.register("gateway.saveChannel", async (params) => ({ id: await this.saveChannel(params as unknown as ChannelInput) }));
		core.register("gateway.removeChannel", async (params) => {
			await this.removeChannel(requireStr(params.id, "id"));
			return { ok: true };
		});
		core.register("gateway.resetHealth", (params) => {
			this.health.reset(requireStr(params.channel, "channel"));
			this.changed();
			return { ok: true };
		});
		core.register("gateway.fetchModels", async (params) => {
			const channel = str(params.channel) ? this.channel(str(params.channel)!) : undefined;
			const apiKey = str(params.apiKey) ?? (channel?.source === "df" ? await this.firstSecret(channel) : undefined);
			const modelsUrl = platform(str(params.platform) ?? channel?.platform)?.modelsUrl;
			return this.providers.fetchModels({ baseUrl: str(params.baseUrl), api: str(params.api), apiKey, provider: channel?.source === "pi" ? channel.provider : undefined, modelsUrl });
		});
		core.register("gateway.testChannel", async (params) => {
			const channel = this.channel(requireStr(params.channel, "channel"));
			if (!channel) throw new RpcError("not_found", "找不到这个渠道");
			this.health.reset(channel.id);
			const result = await this.providers.test(channel.provider, str(params.model) ?? channel.models[0]?.id);
			this.core.broadcast({ event: "gateway.changed" });
			return result;
		});
		core.register("gateway.status", () => this.status());
		core.register("gateway.refreshQuota", async (params) => {
			await this.refreshQuotas(str(params.channel));
			return this.status();
		});
		core.register("gateway.requests", (params) => {
			const since = num(params.since) ?? now() - 24 * 3600_000;
			const channel = str(params.channel);
			return this.core.db.all(
				`SELECT * FROM gateway_requests WHERE at >= ? ${channel ? "AND channel = ?" : ""} ORDER BY at DESC LIMIT 200`,
				...(channel ? [since, channel] : [since]),
			);
		});
	}
}

/** Removes keys from text that leaves the wrapper (records, rest reasons, the window). */
export function redact(text: string, secrets: (string | undefined)[]): string {
	let out = text;
	for (const secret of secrets) {
		if (secret && secret.length >= 8 && secret !== KEY_PLACEHOLDER) out = out.split(secret).join(`****${secret.slice(-4)}`);
	}
	return out;
}

/**
 * What Pi registers for a channel's model. Thinking levels and compatibility
 * settings come from Pi's catalog for the platform when it knows the model
 * (served by the same API), else from the model list's efforts and the
 * platform's defaults; Pi guesses the rest from the address.
 */
export function modelConfig(channel: ChannelInfo, m: ChannelModel): Record<string, unknown> {
	const preset = platform(channel.platform) ?? piPresets().find((p) => p.id === channel.platform);
	const known = catalogModel(preset?.catalog, m.id);
	const sameApi = known?.api === channel.api;
	const thinkingLevelMap = m.thinkingLevels ? selectedLevelMap(m.thinkingLevels) : m.thinkingLevelMap ?? (sameApi ? known?.thinkingLevelMap : undefined) ?? levelMap(m.efforts);
	const compat = m.compat ?? (channel.api === "openai-completions" && (preset?.compat || (sameApi && known?.compat)) ? { ...preset?.compat, ...(sameApi ? known?.compat : {}) } : undefined);
	return {
		...m,
		id: m.id,
		name: m.name || m.id,
		reasoning: m.reasoning ?? known?.reasoning ?? false,
		input: m.input?.length ? m.input : (known?.input ?? ["text"]),
		contextWindow: m.contextWindow ?? known?.contextWindow ?? 128_000,
		maxTokens: m.maxTokens ?? known?.maxTokens ?? 16_384,
		cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0, cacheRead: m.cost?.cacheRead ?? 0, cacheWrite: m.cost?.cacheWrite ?? 0 },
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		...(compat ? { compat } : {}),
	};
}

function mapOr<T, R>(value: T | undefined, map: (value: T) => R, fallback: R): R {
	return value === undefined ? fallback : map(value);
}

function errorMessage(model: Model<Api>, message: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
}
