import { randomUUID } from "node:crypto";
import { type Api, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, createAssistantMessageEventStream, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Core, CoreModule } from "../core.ts";
import { num, RpcError, requireStr, str } from "../core.ts";
import { json, now, parseJson } from "../db.ts";
import type { Providers } from "../modules/providers.ts";
import { classifyFailure, FAILURE_LABEL, type FailureKind, isChannelFailure } from "./classify.ts";
import { HealthBook } from "./health.ts";
import { type QuotaReading, readQuota } from "./quota.ts";
import { type ChannelApi, type ChannelKind, PLATFORMS, platform, platformForUrl } from "./platforms.ts";
import { type CandidateInfo, describe, type GroupEntry, type ModelGroup, pickEntry, type RouteState, type Unavailable } from "./router.ts";

/** Provider id of the model groups (the old fallback chain lives here too, as group "auto"). */
export const GROUP_PROVIDER = "dreamflutter";
/** Pi provider id of a DreamFlutter channel. */
export const channelProvider = (channelId: string) => `df-${channelId}`;
/** Pi's own providers show up as channels with this id prefix. */
const PI_PREFIX = "pi:";
/** Pi needs a key on the provider to call it available; the wrapper sends the real one. */
const KEY_PLACEHOLDER = "dreamflutter-gateway";
const QUOTA_INTERVAL_MS = 10 * 60_000;

export interface ChannelModel {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
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

export interface GroupInput {
	id?: string;
	name: string;
	entries: GroupEntry[];
	allowPaidOverflow?: boolean;
}

export interface ChannelStatus {
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

interface GroupRow {
	id: string;
	name: string;
	entries: string;
	allow_paid_overflow: number;
}

/** What registration needs from a session's extension API or a bare model runtime. */
interface Target {
	registerProvider(id: string, config: Record<string, unknown>): void;
	unregisterProvider(id: string): void;
	registerVirtualModel(definition: Record<string, unknown>): void;
	unregisterVirtualModel(provider: string, id: string): void;
}

interface Registered {
	providers: Set<string>;
	groups: Set<string>;
	find: (provider: string, id: string) => Model<Api> | undefined;
}

/**
 * The personal model gateway (docs/v0.2-gateway.md). Channels become Pi
 * providers whose stream goes through [wrap]: it picks the key, records each
 * request, keeps the circuit breaker, and turns a switchable failure of a
 * group request into one Pi retries, so the group's router moves on. Model
 * groups are Pi virtual models routed by [pickEntry].
 */
export class Gateway implements CoreModule {
	private readonly core: Core;
	private readonly providers: Providers;
	private readonly transport: Transport;
	private readonly clock: () => number;
	private readonly fetch: typeof fetch;
	private quotaTimer: NodeJS.Timeout | undefined;
	readonly health: HealthBook;
	/** Channels from Pi's own configuration, refreshed when providers change. */
	private piChannels: ChannelInfo[] = [];
	/** Where each target (session extension API, model runtime) has things registered. */
	private readonly targets = new Map<Target, Registered>();
	/** The entry a session's latest group request went to, so the wrapper knows it may switch. */
	private readonly routed = new Map<string, { provider: string; model: string; group: string }>();
	/** Key each session uses per channel (one account keeps its prompt cache). */
	private readonly sessionKeys = new Map<string, string>();
	private readonly lastFailure = new Map<string, FailureKind>();
	private readonly secrets = new Map<string, string>();
	/** Round-robin position per channel, for sessions that have no key yet. */
	private readonly keyTurns = new Map<string, number>();

	constructor(core: Core, providers: Providers, options: { transport?: Transport; clock?: () => number; fetch?: typeof fetch } = {}) {
		this.core = core;
		this.providers = providers;
		this.transport = options.transport ?? (streamSimple as Transport);
		this.clock = options.clock ?? Date.now;
		this.fetch = options.fetch ?? fetch;
		this.health = new HealthBook(this.clock);
		providers.onChanged(() => void this.refreshPiChannels());
		this.register();
	}

	async start(): Promise<void> {
		await this.refreshPiChannels();
		this.migrateFallbackChain();
		this.quotaTimer = setInterval(() => void this.refreshQuotas(), QUOTA_INTERVAL_MS);
		this.quotaTimer.unref();
	}

	stop(): void {
		clearInterval(this.quotaTimer);
	}

	// ---- balances and plan allowances ----------------------------------------------

	/** Reads the balance or allowance of [channelId] (or every channel that has a query). */
	async refreshQuotas(channelId?: string): Promise<void> {
		const channels = this.channels().filter((c) => (channelId ? c.id === channelId : c.enabled) && platform(c.platform)?.quota);
		await Promise.all(
			channels.map(async (channel) => {
				const apiKey = channel.source === "df" ? await this.firstSecret(channel) : await this.providers.apiKeyOf(channel.provider);
				if (!apiKey) return;
				const reading = await readQuota(platform(channel.platform)!.quota!, channel.baseUrl, apiKey, this.fetch, this.clock);
				this.applyReading(channel, reading);
			}),
		);
		if (channels.length) this.core.broadcast({ event: "gateway.changed" });
	}

	private async firstSecret(channel: ChannelInfo): Promise<string | undefined> {
		const key = channel.keys.find((k) => k.enabled && k.unavailable?.kind !== "auth") ?? channel.keys.find((k) => k.enabled);
		return key ? this.secret(key.id) : undefined;
	}

	private applyReading(channel: ChannelInfo, reading: QuotaReading): void {
		const previous = this.reading(channel.id);
		this.core.db.run(
			"INSERT INTO gateway_quota(channel, data, checked_at) VALUES(?, ?, ?) ON CONFLICT(channel) DO UPDATE SET data = excluded.data, checked_at = excluded.checked_at",
			channel.id,
			json(reading),
			reading.checkedAt,
		);
		const keys = channel.source === "df" ? channel.keys.map((k) => `${channel.id}#${k.id}`) : [`${channel.id}#pi`];
		if (reading.type === "plan") {
			const full = reading.windows.filter((w) => w.usedPercent >= 100);
			if (full.length) {
				const until = Math.max(...full.map((w) => w.resetAt ?? 0)) || undefined;
				for (const key of keys) this.health.fail(key, "quota", `${full.map((w) => w.label).join("、")}额度用完`, until);
			} else {
				this.health.clearQuota(channel.id);
			}
			// Remind once per window period at 80 %.
			for (const window of reading.windows) {
				const before = previous?.type === "plan" ? previous.windows.find((w) => w.label === window.label && w.resetAt === window.resetAt) : undefined;
				if (window.usedPercent >= 80 && (before?.usedPercent ?? 0) < 80) {
					this.alert(`${channel.name} 额度已用 ${Math.round(window.usedPercent)}%`, `${window.label}${window.resetAt ? `，${describe({ kind: "quota", message: "", until: window.resetAt }).replace(/^额度用完，/, "")}` : ""}`);
				}
			}
		} else if (reading.type === "balance") {
			if (reading.amount <= 0) for (const key of keys) this.health.fail(key, "balance", "余额为 0");
			else this.health.clearQuota(channel.id);
			const low = channel.lowBalance;
			const wasAbove = previous?.type !== "balance" || low === null || previous.amount >= low;
			if (low !== null && reading.amount < low && wasAbove) this.alert(`${channel.name} 余额不足`, `剩余 ${reading.amount.toFixed(2)} ${reading.currency}，低于你设的 ${low}`);
		}
	}

	private alert(title: string, body: string): void {
		this.core.notifier.notify(title, body);
		this.core.broadcast({ event: "gateway.alert", title, body });
	}

	private reading(channelId: string): QuotaReading | undefined {
		const row = this.core.db.get<{ data: string }>("SELECT data FROM gateway_quota WHERE channel = ?", channelId);
		return row ? parseJson<QuotaReading | undefined>(row.data, undefined) : undefined;
	}

	/** What the dashboard shows per channel: state, allowance or balance, today's traffic, last error. */
	status(): ChannelStatus[] {
		const time = this.clock();
		const dayStart = new Date(time).setHours(0, 0, 0, 0);
		return this.channels().map((channel) => {
			const today = this.core.db.get<{ requests: number; failures: number; cost: number; ttft: number | null }>(
				"SELECT COUNT(*) AS requests, SUM(ok = 0 AND error_kind IS NOT NULL) AS failures, COALESCE(SUM(cost), 0) AS cost, AVG(ttft_ms) AS ttft FROM gateway_requests WHERE channel = ? AND at >= ?",
				channel.id,
				dayStart,
			)!;
			const recent = this.core.db.get<{ requests: number; tokens: number }>(
				"SELECT COUNT(*) AS requests, COALESCE(SUM(input + output + cache_read + cache_write), 0) AS tokens FROM gateway_requests WHERE channel = ? AND at >= ?",
				channel.id,
				time - 5 * 3_600_000,
			)!;
			const spent = this.core.db.get<{ cost: number }>("SELECT COALESCE(SUM(cost), 0) AS cost FROM gateway_requests WHERE channel = ?", channel.id)!.cost;
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
				quota: this.reading(channel.id) ?? null,
				canQuery: platform(channel.platform)?.quota !== undefined,
				today: { requests: Number(today.requests), failures: Number(today.failures ?? 0), cost: today.cost, avgFirstTokenMs: today.ttft === null ? null : Math.round(today.ttft) },
				last5h: { requests: Number(recent.requests), tokens: Number(recent.tokens) },
				spent,
				remaining: channel.topUp === null ? null : channel.topUp - spent,
				lastError: lastError ? { at: lastError.at, kind: lastError.kind, message: lastError.message } : null,
			};
		});
	}

	// ---- channels ------------------------------------------------------------------

	channels(): ChannelInfo[] {
		const rows = this.core.db.all<ChannelRow>("SELECT * FROM gateway_channels ORDER BY sort, created_at");
		const keys = this.core.db.all<KeyRow>("SELECT * FROM gateway_keys ORDER BY sort, created_at");
		const own = rows.map((row): ChannelInfo => {
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
		const name = input.name?.trim();
		if (!name) throw new RpcError("bad_request", "请填写渠道名称");
		const baseUrl = input.baseUrl?.trim().replace(/\/+$/, "");
		if (!baseUrl || !/^https?:\/\//.test(baseUrl)) throw new RpcError("bad_request", "接口地址需要以 http:// 或 https:// 开头");
		if (input.api !== "openai-completions" && input.api !== "anthropic-messages") throw new RpcError("bad_request", `不支持的接口类型：${input.api}`);
		const models = (input.models ?? []).filter((m) => m.id?.trim()).map((m) => ({ ...m, id: m.id.trim() }));
		if (!models.length) throw new RpcError("bad_request", "至少需要一个模型");
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
		this.changed();
		return id;
	}

	removeChannel(id: string): void {
		if (id.startsWith(PI_PREFIX)) throw new RpcError("bad_request", "来自 Pi 配置的渠道请在「Pi 配置」里删除");
		for (const key of this.core.db.all<KeyRow>("SELECT * FROM gateway_keys WHERE channel_id = ?", id)) {
			this.providers.secrets.remove(`gateway-${key.id}`);
			this.secrets.delete(key.id);
		}
		this.core.db.run("DELETE FROM gateway_channels WHERE id = ?", id);
		this.health.reset(id);
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
			this.piChannels = list
				.filter((p) => p.configured && p.id !== GROUP_PROVIDER && !p.id.startsWith("df-") && p.authSource !== "oauth" && (p.api === "openai-completions" || p.api === "anthropic-messages"))
				.map((p) => {
					const known = platformForUrl(p.baseUrl);
					return {
						id: `${PI_PREFIX}${p.id}`,
						source: "pi" as const,
						provider: p.id,
						name: p.name,
						platform: known?.id ?? null,
						kind: known?.kind ?? "payg",
						api: p.api!,
						baseUrl: p.baseUrl ?? "",
						models: p.models.map((m) => ({ id: m.id, name: m.name, reasoning: m.reasoning, input: m.input, contextWindow: m.contextWindow ?? undefined, maxTokens: m.maxTokens ?? undefined, cost: m.cost ?? undefined })),
						authHeader: false,
						enabled: true,
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

	// ---- model groups --------------------------------------------------------------

	groups(): ModelGroup[] {
		return this.core.db.all<GroupRow>("SELECT * FROM gateway_groups ORDER BY sort, created_at").map((row) => ({
			id: row.id,
			name: row.name,
			entries: parseJson<GroupEntry[]>(row.entries, []),
			allowPaidOverflow: row.allow_paid_overflow === 1,
		}));
	}

	saveGroup(input: GroupInput): string {
		const name = input.name?.trim();
		if (!name) throw new RpcError("bad_request", "请填写模型组名称");
		const id = input.id ?? `g${randomUUID().slice(0, 8)}`;
		if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new RpcError("bad_request", "模型组 ID 只能用小写字母、数字和横线");
		const entries = (input.entries ?? []).map((e, index) => ({
			channel: requireStr(e.channel, "channel"),
			model: requireStr(e.model, "model"),
			priority: Number.isFinite(e.priority) ? Math.trunc(e.priority) : index,
			weight: Number.isFinite(e.weight) && e.weight > 0 ? e.weight : 0,
		}));
		this.core.db.run(
			`INSERT INTO gateway_groups(id, name, entries, allow_paid_overflow, created_at) VALUES(?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET name = excluded.name, entries = excluded.entries, allow_paid_overflow = excluded.allow_paid_overflow`,
			id,
			name,
			json(entries),
			input.allowPaidOverflow === false ? 0 : 1,
			now(),
		);
		this.changed();
		return id;
	}

	removeGroup(id: string): void {
		this.core.db.run("DELETE FROM gateway_groups WHERE id = ?", id);
		this.changed();
	}

	/** The old "自动（主模型 + 备用链）" becomes the group "auto" (same model key, so old sessions keep working). */
	private migrateFallbackChain(): void {
		const chain = this.core.settings.get().fallbackModels;
		if (!chain.length || this.core.db.get("SELECT id FROM gateway_groups WHERE id = 'auto'")) return;
		const entries = chain.map((key, priority) => {
			const slash = key.indexOf("/");
			const provider = key.slice(0, slash);
			return { channel: provider.startsWith("df-") ? provider.slice(3) : `${PI_PREFIX}${provider}`, model: key.slice(slash + 1), priority, weight: 0 };
		});
		this.saveGroup({ id: "auto", name: "自动", entries, allowPaidOverflow: true });
	}

	private candidateInfo(entry: GroupEntry, channels: ChannelInfo[]): CandidateInfo {
		const channel = channels.find((c) => c.id === entry.channel);
		if (!channel || !channel.models.some((m) => m.id === entry.model)) return { kind: "payg", name: channel?.name ?? entry.channel, unavailable: { kind: "missing", message: "找不到这个渠道或模型" } };
		return { kind: channel.kind, name: channel.name, unavailable: channel.unavailable };
	}

	// ---- registration --------------------------------------------------------------

	/** The session extension: registers channels and groups, and keeps them current. */
	extensions(): ExtensionFactory[] {
		return [
			(pi: ExtensionAPI) => {
				const target: Target = {
					registerProvider: (id, config) => pi.registerProvider(id, config as never),
					unregisterProvider: (id) => pi.unregisterProvider(id),
					registerVirtualModel: (definition) => pi.registerVirtualModel(definition as never),
					unregisterVirtualModel: (provider, id) => pi.unregisterVirtualModel(provider, id),
				};
				pi.on("session_shutdown", () => void this.targets.delete(target));
				// Session routing looks models up through the context Pi passes to route().
				this.apply(target, () => undefined);
			},
		];
	}

	/** Registers channels and groups on a model runtime used outside sessions (titles, memory, tests). */
	installRuntime(runtime: ModelRuntime): void {
		const existing = [...this.targets.entries()].find(([t]) => (t as unknown as { runtime?: ModelRuntime }).runtime === runtime);
		if (existing) return;
		const target = {
			runtime,
			registerProvider: (id: string, config: Record<string, unknown>) => runtime.registerProvider(id, config as never),
			unregisterProvider: (id: string) => runtime.unregisterProvider(id),
			registerVirtualModel: (definition: Record<string, unknown>) => runtime.registerVirtualModel(definition as never),
			unregisterVirtualModel: (provider: string, id: string) => runtime.unregisterVirtualModel(provider, id),
		};
		this.apply(target, (provider, id) => runtime.getModel(provider, id) as Model<Api> | undefined);
	}

	private apply(target: Target, find: Registered["find"]): void {
		const registered = this.targets.get(target) ?? { providers: new Set<string>(), groups: new Set<string>(), find };
		this.targets.set(target, registered);
		const channels = this.channels();
		const groups = this.groups();
		const inGroups = new Set(groups.flatMap((g) => g.entries.map((e) => e.channel)));

		const providers = new Set<string>();
		for (const channel of channels) {
			if (channel.source === "df") {
				if (!channel.enabled || !channel.keys.some((k) => k.enabled)) continue;
				providers.add(channel.provider);
				this.safely(() =>
					target.registerProvider(channel.provider, {
						name: channel.name,
						baseUrl: channel.baseUrl,
						apiKey: KEY_PLACEHOLDER,
						api: channel.api,
						headers: channel.headers,
						authHeader: channel.authHeader,
						streamSimple: this.wrap(channel.id),
						models: channel.models.map((m) => ({
							id: m.id,
							name: m.name || m.id,
							reasoning: m.reasoning ?? false,
							input: m.input?.length ? m.input : ["text"],
							contextWindow: m.contextWindow ?? 128_000,
							maxTokens: m.maxTokens ?? 16_384,
							cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0, cacheRead: m.cost?.cacheRead ?? 0, cacheWrite: m.cost?.cacheWrite ?? 0 },
						})),
					}),
				);
			} else if (inGroups.has(channel.id) && !registered.providers.has(channel.provider)) {
				// Pi's own provider: only its stream is wrapped (models and key stay Pi's).
				providers.add(channel.provider);
				this.safely(() => target.registerProvider(channel.provider, { api: channel.api, streamSimple: this.wrap(channel.id) }));
			} else if (inGroups.has(channel.id)) {
				providers.add(channel.provider);
			}
		}
		for (const old of registered.providers) {
			if (!providers.has(old) && old.startsWith("df-")) this.safely(() => target.unregisterProvider(old));
		}
		registered.providers = providers;

		const ids = new Set(groups.map((g) => g.id));
		for (const group of groups) {
			const models = group.entries.map((e) => channels.find((c) => c.id === e.channel)?.models.find((m) => m.id === e.model)).filter((m) => m !== undefined);
			this.safely(() =>
				target.registerVirtualModel({
					provider: GROUP_PROVIDER,
					id: group.id,
					name: group.name,
					thinkingLevels: models.some((m) => m.reasoning) ? ["off", "minimal", "low", "medium", "high"] : ["off"],
					input: models.length && models.every((m) => m.input?.includes("image")) ? ["text", "image"] : ["text"],
					contextWindow: models.length ? Math.min(...models.map((m) => m.contextWindow ?? 128_000)) : undefined,
					maxTokens: models.length ? Math.min(...models.map((m) => m.maxTokens ?? 16_384)) : undefined,
					route: (request: Parameters<typeof this.route>[1], ctx?: ExtensionContext) => this.route(group.id, request, registered.find, ctx),
				}),
			);
		}
		for (const old of registered.groups) if (!ids.has(old)) this.safely(() => target.unregisterVirtualModel(GROUP_PROVIDER, old));
		registered.groups = ids;
	}

	private safely(action: () => void): void {
		try {
			action();
		} catch (error) {
			this.core.log.warn(`gateway: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private changed(): void {
		for (const [target, registered] of this.targets) this.apply(target, registered.find);
		this.core.broadcast({ event: "gateway.changed" });
	}

	// ---- routing -------------------------------------------------------------------

	private route(
		groupId: string,
		request: { reason: string; thinkingLevel: string; state?: unknown; failed?: { model: Model<Api>; message: AssistantMessage } },
		find: Registered["find"],
		ctx?: ExtensionContext,
	): { model: Model<Api>; thinkingLevel: string; state: RouteState } {
		const group = this.groups().find((g) => g.id === groupId);
		if (!group) throw new Error("这个模型组已被删除");
		const channels = this.channels();
		const failed = request.failed ? this.entryOf(request.failed.model, channels) : undefined;
		const decision = pickEntry(group, (entry) => this.candidateInfo(entry, channels), request.state as RouteState | undefined, failed);
		if (!decision.ok) throw new Error(decision.message);
		const channel = channels.find((c) => c.id === decision.entry.channel)!;
		const model = ctx ? (ctx.modelRegistry.find(channel.provider, decision.entry.model) as Model<Api> | undefined) : find(channel.provider, decision.entry.model);
		if (!model) throw new Error(`找不到模型 ${channel.name} · ${decision.entry.model}`);
		const sessionId = sessionIdOf(ctx);
		if (sessionId) this.routed.set(sessionId, { provider: model.provider, model: model.id, group: group.id });
		if (decision.switchedFrom) {
			const from = channels.find((c) => c.id === decision.switchedFrom!.channel);
			const reason = from ? (from.unavailable ? describe(from.unavailable) : FAILURE_LABEL[this.lastFailure.get(from.id) ?? "other"]) : "";
			this.core.broadcast({
				event: "gateway.switched",
				sessionId: sessionId ?? null,
				group: group.name,
				from: from ? `${from.name} · ${decision.switchedFrom.model}` : decision.switchedFrom.channel,
				to: `${channel.name} · ${decision.entry.model}`,
				reason,
				toPaid: decision.toPaid,
			});
		}
		return { model, thinkingLevel: request.thinkingLevel, state: decision.state };
	}

	private entryOf(model: { provider: string; id: string }, channels: ChannelInfo[]): { channel: string; model: string } | undefined {
		const channel = channels.find((c) => c.provider === model.provider);
		return channel ? { channel: channel.id, model: model.id } : undefined;
	}

	// ---- the channel stream ----------------------------------------------------------

	private wrap(channelId: string): Transport {
		return (model, context, options) => {
			const out = createAssistantMessageEventStream();
			void this.relay(channelId, model, context, options, out).catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				out.push({ type: "error", reason: "error", error: errorMessage(model, message) });
			});
			return out;
		};
	}

	private async relay(channelId: string, model: Model<Api>, context: Parameters<Transport>[1], options: SimpleStreamOptions | undefined, out: AssistantMessageEventStream): Promise<void> {
		const channel = this.channel(channelId);
		const sessionId = options?.sessionId;
		const routed = sessionId ? this.routed.get(sessionId) : undefined;
		const group = routed && routed.provider === model.provider && routed.model === model.id ? routed.group : undefined;		const key = channel?.source === "df" ? await this.pickKey(channel, sessionId) : undefined;
		const healthKey = `${channelId}#${key?.id ?? "pi"}`;
		const started = this.clock();
		let firstToken: number | undefined;
		let streamed = false;
		const inner = this.transport(model, context, key ? { ...options, apiKey: key.secret } : options);
		for await (const event of inner as AsyncIterable<AssistantMessageEvent>) {
			if (event.type === "done") {
				this.health.succeed(healthKey);
				this.record(channelId, key?.id, model.id, group, sessionId, started, firstToken, event.message, undefined);
				out.push(event);
				continue;
			}
			if (event.type === "error") {
				const failure = event.error;
				const kind = event.reason === "aborted" ? "other" : classifyFailure(failure.errorMessage);
				this.record(channelId, key?.id, model.id, group, sessionId, started, firstToken, failure, event.reason === "aborted" ? undefined : kind);
				if (event.reason !== "aborted" && isChannelFailure(kind)) {
					this.health.fail(healthKey, kind, failure.errorMessage ?? "");
					this.lastFailure.set(channelId, kind);
				}
				// Pi does not retry quota, balance or key errors. Through a group, another
				// channel can take the request: say it so that Pi retries and the router moves on.
				if (group && !streamed && event.reason !== "aborted" && isChannelFailure(kind) && !isRetryableAssistantError(failure)) {
					const name = channel?.name ?? channelId;
					out.push({ type: "error", reason: "error", error: { ...failure, errorMessage: `渠道「${name}」${FAILURE_LABEL[kind]}，换下一个渠道（service temporarily unavailable）` } });
				} else {
					out.push(event);
				}
				continue;
			}
			// Only real output counts: an empty block opened before an error leaves nothing to lose.
			if ((event.type.endsWith("_delta") && (event as { delta?: string }).delta) || event.type === "toolcall_end") {
				firstToken ??= this.clock() - started;
				streamed = true;
			}
			out.push(event);
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
			const pool = healthy.length ? healthy : enabled;
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
		const value = await this.providers.secrets.get(`gateway-${keyId}`);
		this.secrets.set(keyId, value);
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
		core.register("gateway.platforms", () => PLATFORMS);
		core.register("gateway.channels", () => this.channels());
		core.register("gateway.saveChannel", async (params) => ({ id: await this.saveChannel(params as unknown as ChannelInput) }));
		core.register("gateway.removeChannel", (params) => {
			this.removeChannel(requireStr(params.id, "id"));
			return { ok: true };
		});
		core.register("gateway.groups", () => this.groups());
		core.register("gateway.saveGroup", (params) => ({ id: this.saveGroup(params as unknown as GroupInput) }));
		core.register("gateway.removeGroup", (params) => {
			this.removeGroup(requireStr(params.id, "id"));
			return { ok: true };
		});
		core.register("gateway.resetHealth", (params) => {
			this.health.reset(requireStr(params.channel, "channel"));
			this.changed();
			return { ok: true };
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

function sessionIdOf(ctx: ExtensionContext | undefined): string | undefined {
	try {
		return ctx?.sessionManager?.getSessionId();
	} catch {
		return undefined;
	}
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
