import { createHash, randomUUID } from "node:crypto";
import type { AssistantMessage, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Core, CoreModule } from "../core.ts";
import { RpcError } from "../core.ts";
import { CATALOG_VERSION, estimate, planEstimate, PRICE_RULES } from "./rules.ts";
import { finite, ledgerContext, REQUEST_LEDGER_ID, type LedgerContext, type LedgerRow, type Purpose, type QueryOptions } from "./types.ts";

const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function messageKey(provider: string, model: string, at: number, u: Record<string, any>): string { return digest([provider, model, at, u.input ?? 0, u.output ?? 0, u.cacheRead ?? u.cache_read ?? 0, u.cacheWrite ?? u.cache_write ?? 0, typeof u.cost === "number" ? u.cost : u.cost?.total ?? 0]); }
interface RawUsage { usage?: Record<string, any>; final?: boolean; opencode?: Record<string, any>; actual?: number; currency?: string; estimated?: boolean; }
const installed = new WeakMap<ModelRuntime, { owner: Ledger; original: ModelRuntime["streamSimple"] }>();

/** Request facts outlive index rebuilds, session copies, retries and run summaries. */
export class Ledger implements CoreModule {
	private core: Core;
	private closed = false;
	private sessionContexts = new Map<string, () => LedgerContext>();
	constructor(core: Core) {
		this.core = core; core.ledger = this;
		core.declareBackup({ id: "request-ledger", title: "逐请求账本与价格规则", tables: ["request_ledger", "request_ledger_sources", "ledger_price_rules"], paths: { request_ledger: { workspace: "path" } } });
		for (const rule of PRICE_RULES) core.db.run("INSERT OR IGNORE INTO ledger_price_rules VALUES(?,?)", rule.version, JSON.stringify(rule));
		core.register("ledger.summary", (p) => this.summary(p as QueryOptions));
		core.register("ledger.entries", (p) => this.entries(p as QueryOptions & { limit?: number; before?: number }));
		core.register("ledger.rules", () => core.db.all("SELECT * FROM ledger_price_rules ORDER BY version"));
		core.register("ledger.importHistory", () => this.importHistory());
	}
	start(): void {
		this.core.db.run("UPDATE request_ledger SET state='missing',amount_source='missing',error_code='process_interrupted' WHERE state='pending'");
		this.importHistory();
	}
	stop(): void {
		this.core.db.run("UPDATE request_ledger SET state='missing',amount_source='missing',error_code='shutdown_without_final_usage' WHERE state='pending'");
		this.closed = true;
		this.sessionContexts.clear();
	}
	bindSession(id: string, context: () => LedgerContext): void { this.sessionContexts.set(id, context); }
	private channel(provider: string) {
		return provider.startsWith("df-") ? this.core.db.get<{ id: string; kind: string; platform: string | null }>("SELECT id,kind,platform FROM gateway_channels WHERE id=?", provider.slice(3)) : undefined;
	}
	begin(model: Pick<Model<any>, "provider" | "id">, context: LedgerContext = {}, at = Date.now(), id: string = randomUUID()): string {
		if (this.closed) return id;
		this.insert({ id, requested_at: at, provider: model.provider, model: model.id, channel: this.channel(model.provider)?.id ?? null,
			purpose: context.purpose ?? "auxiliary", workspace: context.workspace ?? null, session_id: context.sessionId ?? null, run_id: context.runId ?? null, slot_id: context.slotId ?? null });
		return id;
	}
	private insert(values: Partial<LedgerRow> & Pick<LedgerRow, "id" | "requested_at" | "provider" | "model">): void {
		const defaults: LedgerRow = { id: "", requested_at: 0, completed_at: null, state: "pending", channel: null, provider: "", model: "", purpose: "auxiliary", workspace: null, session_id: null, run_id: null, slot_id: null,
			success: null, input: null, output: null, cache_read: null, cache_write: null, reasoning: null, amount: null, currency: null, amount_source: "missing", price_version: CATALOG_VERSION, price_snapshot: null,
			allowance: null, allowance_unit: null, allowance_source: null, billing_source: null, ttft_ms: null, duration_ms: null, origin: "live", message_key: null, error_code: null };
		const row = { ...defaults, ...values }, keys = Object.keys(row) as (keyof LedgerRow)[];
		this.core.db.run(`INSERT OR IGNORE INTO request_ledger(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`, ...keys.map((key) => row[key]));
	}
	private update(id: string, values: Partial<Omit<LedgerRow, "id">>): void {
		if (this.closed) return;
		const keys = Object.keys(values) as (keyof typeof values)[];
		this.core.db.run(`UPDATE request_ledger SET ${keys.map((key) => `${key}=?`).join(",")} WHERE id=?`, ...keys.map((key) => values[key] ?? null), id);
	}
	timing(id: string | undefined, firstAt: number | undefined): void {
		if (!id || firstAt === undefined || this.closed) return;
		const row = this.core.db.get<{ requested_at: number; ttft_ms: number | null }>("SELECT requested_at,ttft_ms FROM request_ledger WHERE id=?", id);
		if (row && row.ttft_ms === null) this.update(id, { ttft_ms: Math.max(0, firstAt - row.requested_at) });
	}
	private raw(data: unknown, model: Model<any>, state: RawUsage): void {
		const event = object(data), response = object(event.response), message = object(event.message);
		const value = object(event.usage ?? response.usage ?? message.usage ?? event.usageMetadata);
		if (Object.keys(value).length) {
			// Retain only numeric metering; never persist text, prompts, headers or raw events.
			const usage = state.usage ?? {};
			for (const key of ["input_tokens", "output_tokens", "prompt_tokens", "completion_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "totalTokenCount", "candidatesTokenCount", "promptTokenCount"]) if (finite(value[key]) !== null) usage[key] = value[key];
			state.usage = usage;
			const oc = object(value.opencode);
			if (Object.keys(oc).length) {
				state.opencode = { ...state.opencode };
				for (const key of ["allowance", "list_cost"]) if (finite(oc[key]) !== null) state.opencode[key] = oc[key];
				if (["free", "balance", "go", "go-plus", "byok"].includes(oc.billing_source)) state.opencode.billing_source = oc.billing_source;
				if (typeof oc.estimated === "boolean") state.opencode.estimated = oc.estimated;
				const tokens = object(oc.tokens); state.opencode.tokens = Object.fromEntries(Object.entries(tokens).filter(([key, n]) => ["input", "output", "reasoning", "cache_read", "cache_write_5m", "cache_write_1h"].includes(key) && finite(n) !== null));
			}
			if (finite(value.cost) !== null) {
				state.actual = value.cost;
				let host = ""; try { host = new URL(model.baseUrl).hostname; } catch { /* synthetic adapters may have no URL */ }
				state.currency = typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency) ? value.currency : host === "opencode.ai" || model.provider === "opencode-go" || typeof oc.billing_source === "string" && ["free", "balance", "go", "go-plus", "byok"].includes(oc.billing_source) ? "USD" : "UNKNOWN";
				state.estimated = oc.estimated === true;
			}
			if (typeof value.completion_tokens === "number" || typeof response.usage === "object" && event.type === "response.completed" || event.type === "message_delta" && typeof value.output_tokens === "number") state.final = true;
		}
	}
	finish(id: string, model: Model<any>, message: AssistantMessage | undefined, raw: RawUsage = {}, at = Date.now(), errorCode?: string): void {
		if (this.closed) return;
		const row = this.core.db.get<LedgerRow>("SELECT * FROM request_ledger WHERE id=?", id); if (!row) return;
		const success = message ? !["error", "aborted"].includes(message.stopReason) : false;
		const validEnd = message && (["stop", "length", "toolUse"].includes(message.stopReason) || raw.final);
		const u = message?.usage;
		if (u && Object.isExtensible(u)) Object.assign(u, { dreamflutterRequestId: id });
		const known = validEnd && u && ([u.input, u.output, u.cacheRead, u.cacheWrite].some((n) => n > 0) || raw.usage);
		if (!known) { this.update(id, { state: "missing", completed_at: at, duration_ms: Math.max(0, at - row.requested_at), success: Number(success), error_code: errorCode ?? message?.stopReason ?? "no_final_usage" }); return; }
		const oc = raw.opencode, tokens = object(oc?.tokens);
		const usage = { ...u, input: finite(tokens.input) ?? u.input, output: finite(tokens.output) ?? u.output, cacheRead: finite(tokens.cache_read) ?? u.cacheRead,
			cacheWrite: Object.keys(tokens).some((key) => key.startsWith("cache_write")) ? (finite(tokens.cache_write_5m) ?? 0) + (finite(tokens.cache_write_1h) ?? 0) : u.cacheWrite,
			reasoning: finite(tokens.reasoning) ?? finite(u.reasoning) };
		const plan = this.channel(model.provider), points = planEstimate(plan?.platform ?? null, model.id, row.requested_at, u);
		const isPlan = ["go", "go-plus"].includes(oc?.billing_source) || plan?.kind === "plan";
		const actual = raw.actual !== undefined;
		const amount = actual ? raw.actual! : isPlan ? null : estimate(model, u);
		this.update(id, { state: "complete", completed_at: at, duration_ms: Math.max(0, at - row.requested_at), success: Number(success),
			input: finite(usage.input), output: finite(usage.output), cache_read: finite(usage.cacheRead), cache_write: finite(usage.cacheWrite), reasoning: usage.reasoning,
			amount, currency: actual ? raw.currency ?? "UNKNOWN" : amount === null ? null : "USD", amount_source: actual ? raw.estimated ? "provider_estimate" : isPlan && amount === 0 ? "plan_occupancy" : "provider_actual" : isPlan && (oc?.allowance !== undefined || points) ? "plan_occupancy" : amount === null ? "missing" : "price_estimate",
			price_version: points?.version ?? CATALOG_VERSION, price_snapshot: JSON.stringify({ api: model.api, cost: model.cost, rule: points?.version ?? null }),
			allowance: finite(oc?.allowance) ?? points?.value ?? null, allowance_unit: oc?.allowance !== undefined ? "USD" : points?.unit ?? null,
			allowance_source: oc?.allowance !== undefined ? "provider" : points ? "local_estimate" : null, billing_source: oc?.billing_source ?? null,
			message_key: messageKey(message.provider, message.model, message.timestamp, u), error_code: success ? null : message.stopReason });
	}
	/** Wrap only the public request method. completeSimple delegates to it, including physical virtual-model routes. */
	install(runtime: ModelRuntime, context: () => LedgerContext): void {
		const previous = installed.get(runtime); if (previous?.owner === this) return;
		const original = previous?.original ?? runtime.streamSimple.bind(runtime), ledger = this;
		installed.set(runtime, { owner: this, original });
		runtime.streamSimple = function (model, transcript, options) {
			// The runtime rejects a signal already aborted at entry before invoking a provider.
			// Preserve that cancellation result without creating a billable request record.
			if (model.api === "pi-virtual" || options?.signal?.aborted) return original(model, transcript, options);
			const sessionContext = options?.sessionId ? ledger.sessionContexts.get(options.sessionId)?.() : undefined;
			const id = ledger.begin(model, { ...context(), ...sessionContext, ...ledgerContext() }), raw: RawUsage = {};
			const request: SimpleStreamOptions & { [REQUEST_LEDGER_ID]?: string } = { ...options, [REQUEST_LEDGER_ID]: id,
				onPayload: async (payload, actualModel) => { ledger.update(id, { requested_at: Date.now(), provider: actualModel.provider, model: actualModel.id, channel: ledger.channel(actualModel.provider)?.id ?? null }); return options?.onPayload?.(payload, actualModel); },
				onProviderStreamEvent: async (data, actualModel) => {
					ledger.raw(data, actualModel, raw);
					const event = object(data), delta = object(event.choices?.[0]?.delta ?? event.delta);
					if ([delta.content, delta.reasoning_content, delta.text, delta.thinking, typeof event.delta === "string" ? event.delta : undefined].some((text) => typeof text === "string" && text.length > 0)) ledger.timing(id, Date.now());
					return options?.onProviderStreamEvent?.(data, actualModel);
				} };
			try {
				const stream = original(model, transcript, request);
				const abort = () => ledger.finish(id, model, undefined, raw, Date.now(), "cancelled_without_final_usage");
				options?.signal?.addEventListener("abort", abort, { once: true });
				void stream.result().then((message) => { options?.signal?.removeEventListener("abort", abort); ledger.finish(id, model, message, raw); }, () => ledger.finish(id, model, undefined, raw, Date.now(), "transport_error"));
				return stream;
			} catch (error) { ledger.finish(id, model, undefined, raw, Date.now(), "transport_error"); throw error; }
		};
	}
	tool(id: string, fields: { at: number; completedAt: number; provider: string; purpose: "web_search" | "web_fetch"; success: boolean; amount: number | null; currency: string; source: string; context?: LedgerContext; origin?: string }): void {
		this.begin({ provider: fields.provider, id: fields.purpose }, { ...fields.context, purpose: fields.purpose }, fields.at, id);
		this.update(id, { completed_at: fields.completedAt, state: fields.amount === null ? "missing" : "complete", success: Number(fields.success), amount: fields.amount, currency: fields.currency,
			amount_source: fields.amount === null ? "missing" : "price_estimate", price_version: fields.source, duration_ms: Math.max(0, fields.completedAt - fields.at), origin: fields.origin ?? "live" });
	}
	importHistory(): { imported: number; linked: number; web: number } {
		let imported = 0, linked = 0, web = 0;
		for (const r of this.core.db.all<Record<string, any>>("SELECT * FROM usage_records ORDER BY at,path,entry_id")) {
			const source = `history:${digest([r.provider, r.model, r.entry_id, r.at])}`;
			if (this.core.db.get("SELECT source_key FROM request_ledger_sources WHERE source_key=?", source)) continue;
			const key = messageKey(r.provider ?? "unknown", r.model ?? "unknown", r.at, r);
			const live = this.core.db.get<{ id: string }>("SELECT id FROM request_ledger WHERE message_key=? AND origin='live' LIMIT 1", key);
			if (live) { this.core.db.run("INSERT OR IGNORE INTO request_ledger_sources VALUES(?,?)", source, live.id); linked++; continue; }
			const channel = this.channel(r.provider ?? ""), matches = channel ? this.core.db.all<Record<string, any>>("SELECT * FROM gateway_requests WHERE channel=? AND model=? AND at=? AND input=? AND output=? AND cache_read=? AND cache_write=?", channel.id, r.model, r.at, r.input, r.output, r.cache_read, r.cache_write) : [];
			const match = matches.length === 1 ? matches[0] : undefined;
			const meta = this.core.db.get<{ session_id: string }>("SELECT session_id FROM session_meta WHERE path=?", r.path);
			this.insert({ id: source, requested_at: r.at, completed_at: null, state: "complete", provider: r.provider ?? "unknown", model: r.model ?? "unknown", channel: channel?.id ?? null,
				purpose: r.path === "dreamflutter:memory" || r.path?.startsWith("memory:") || r.path?.includes("memory-agent") ? "memory" : "conversation", workspace: r.cwd, session_id: meta?.session_id ?? r.path, origin: "historical", message_key: key,
				input: r.input, output: r.output, cache_read: r.cache_read, cache_write: r.cache_write, amount: finite(r.cost), currency: "USD", amount_source: finite(r.cost) === null ? "missing" : "price_estimate", price_version: "legacy-import-v1",
				success: match?.ok ?? null, ttft_ms: match?.ttft_ms ?? null, duration_ms: match?.duration_ms ?? null });
			this.core.db.run("INSERT OR IGNORE INTO request_ledger_sources VALUES(?,?)", source, source); imported++;
		}
		if (this.core.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='web_tool_usage'")) for (const r of this.core.db.all<Record<string, any>>("SELECT * FROM web_tool_usage")) {
			const id = `web:${r.id}`; if (this.core.db.get("SELECT id FROM request_ledger WHERE id=?", id)) continue;
			this.tool(id, { at: r.time, completedAt: r.time + r.duration_ms, provider: r.provider, purpose: r.tool === "web_search" ? "web_search" : "web_fetch", success: ["success", "empty"].includes(r.status), amount: r.estimated_cost_cny, currency: "CNY", source: r.price_source, context: { slotId: r.slot_id, sessionId: r.session_id, runId: r.run_id }, origin: "historical" }); web++;
		}
		return { imported, linked, web };
	}
	linkIndex(entryId: string, at: number, provider: string | null, model: string | null, usage: unknown): void {
		const id = object(usage).dreamflutterRequestId;
		if (typeof id !== "string" || !this.core.db.get("SELECT id FROM request_ledger WHERE id=?", id)) return;
		const key = `history:${digest([provider, model, entryId, at])}`;
		this.core.db.run("INSERT OR IGNORE INTO request_ledger_sources VALUES(?,?)", key, id);
	}
	entries(options: QueryOptions & { limit?: number; before?: number } = {}): LedgerRow[] {
		return this.core.db.all("SELECT * FROM request_ledger WHERE requested_at>=? AND requested_at<? ORDER BY requested_at DESC,id LIMIT ?", options.since ?? 0, Math.min(options.until ?? Number.MAX_SAFE_INTEGER, options.before ?? Number.MAX_SAFE_INTEGER), Math.min(1000, Math.max(1, options.limit ?? 100)));
	}
	summary(options: QueryOptions = {}) {
		const since = options.since ?? 0, until = options.until ?? Number.MAX_SAFE_INTEGER;
		if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since) throw new RpcError("bad_request", "请选择有效的统计时间范围。");
		const period = ["day", "month", "all"].includes(options.period ?? "") ? options.period! : "day";
		const dimension = ["channel", "model", "purpose", "workspace", "session", "all"].includes(options.groupBy ?? "") ? options.groupBy! : "purpose";
		const zone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
		let formatter: Intl.DateTimeFormat; try { formatter = new Intl.DateTimeFormat("sv-SE", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }); } catch { throw new RpcError("bad_request", "统计时区无效。"); }
		const groups = new Map<string, any>();
		for (const row of this.core.db.all<LedgerRow>("SELECT * FROM request_ledger WHERE requested_at>=? AND requested_at<? ORDER BY requested_at", since, until)) {
			const date = formatter.format(row.requested_at), bucket = period === "all" ? "全部" : period === "month" ? date.slice(0, 7) : date;
			const group = dimension === "all" ? "全部" : dimension === "model" ? `${row.provider}/${row.model}` : dimension === "channel" ? row.channel ?? row.provider : dimension === "workspace" ? row.workspace ?? "未知" : dimension === "session" ? row.session_id ?? "未知" : row.purpose;
			const key = `${bucket}\0${group}`, value = groups.get(key) ?? { period: bucket, key: group, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, tokenKnown: 0, reasoningKnown: 0, amounts: {} as Record<string, number>, amountSources: {} as Record<string, number>, allowance: {} as Record<string, number>, requests: 0, successes: 0, knownStatuses: 0, historical: 0, missingUsage: 0, latencyTotal: 0, latencyCount: 0 };
			value.requests++; for (const [from, to] of [["input", "input"], ["output", "output"], ["cache_read", "cacheRead"], ["cache_write", "cacheWrite"], ["reasoning", "reasoning"]] as const) value[to] += row[from] ?? 0;
			value.tokenKnown += Number(row.input !== null && row.output !== null); value.reasoningKnown += Number(row.reasoning !== null);
			if (row.amount !== null && row.currency) value.amounts[row.currency] = (value.amounts[row.currency] ?? 0) + row.amount;
			if (row.allowance !== null && row.allowance_unit) { const label = `${row.allowance_unit}:${row.allowance_source}`; value.allowance[label] = (value.allowance[label] ?? 0) + row.allowance; }
			value.amountSources[row.amount_source] = (value.amountSources[row.amount_source] ?? 0) + 1;
			if (row.success !== null) { value.knownStatuses++; value.successes += row.success; }
			if (row.ttft_ms !== null) { value.latencyCount++; value.latencyTotal += row.ttft_ms; }
			value.historical += Number(row.origin === "historical"); value.missingUsage += Number(row.input === null && !["web_search", "web_fetch"].includes(row.purpose)); groups.set(key, value);
		}
		return { since, until, period, groupBy: dimension, timeZone: zone, rows: [...groups.values()].map((value) => ({ ...value, successRate: value.knownStatuses ? value.successes / value.knownStatuses : null, ttftMs: value.latencyCount ? value.latencyTotal / value.latencyCount : null })) };
	}
	costSince(since: number, unattendedOnly = false): number {
		return this.core.db.get<{ total: number }>(`SELECT COALESCE(SUM(l.amount),0) total FROM request_ledger l ${unattendedOnly ? "JOIN runs r ON r.id=l.run_id JOIN tasks t ON t.id=r.task_id" : ""} WHERE l.requested_at>=? AND l.currency='USD' ${unattendedOnly ? "AND t.source='schedule'" : ""}`, since)?.total ?? 0;
	}
}
