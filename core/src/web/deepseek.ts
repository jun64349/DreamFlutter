import { setTimeout as delay } from "node:timers/promises";
import { readLimited } from "../modules/web.ts";
import type { AttemptRecorder } from "./types.ts";

export const DEEPSEEK_WEB_API = "https://api.deepseek.com/v1/tools/";
export interface SearchInput { query: string; count?: number; need_content?: boolean; }
export interface SearchResult { title: string; url: string; site_name: string | null; summary: string; snippet: string; content: string; date: string | null; }
export interface FetchResult { title: string; content: string; }
export interface DeepSeekWebOptions {
	/** Test-only transport injection; the product endpoint is always the official origin. */
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	maxBytes?: number;
	concurrency?: number;
	retryDelayMs?: number;
}
export class WebError extends Error {
	readonly code: string;
	constructor(code: string, message: string) { super(message); this.code = code; }
}

export function validateSearch(input: SearchInput): Required<SearchInput> {
	if (typeof input.query !== "string" || !input.query.trim() || [...input.query].length > 128) throw new WebError("invalid_query", "搜索词须为 1–128 个 Unicode 字符，不能全为空白；请缩短后重试。");
	const count = input.count ?? 10;
	if (!Number.isInteger(count) || count < 1 || count > 50) throw new WebError("invalid_count", "返回条数须为 1–50 的整数。");
	if (input.need_content !== undefined && typeof input.need_content !== "boolean") throw new WebError("invalid_content", "是否请求正文须为布尔值。");
	return { query: input.query, count, need_content: input.need_content ?? false };
}

function httpError(status: number): WebError {
	const messages: Record<number, [string, string]> = {
		400: ["bad_request", "DeepSeek 拒绝了请求参数，请检查输入。"],
		401: ["invalid_key", "DeepSeek 官方密钥无效或已失效，请在联网搜索设置中重新填写。"],
		402: ["insufficient_balance", "DeepSeek 官方账户余额不足，请充值后重试。"],
		403: ["target_denied", "目标网页被安全策略拒绝。"],
		404: ["target_unavailable", "目标站拒绝访问、网页不存在或没有可抓取正文。"],
		408: ["timeout", "DeepSeek 请求超时，请稍后重试。"],
		413: ["request_too_large", "请求内容过大，请缩短后重试。"],
		429: ["rate_limited", "DeepSeek 请求限流，有限重试后仍未成功，请稍后再试。"],
		504: ["timeout", "DeepSeek 抓取目标网页超时，请稍后重试。"],
	};
	const [code, message] = messages[status] ?? ["service_error", "DeepSeek 联网服务暂时不可用，请稍后重试。"];
	return new WebError(code, message);
}
function normalizeError(error: unknown, signal: AbortSignal): WebError {
	if (signal.aborted) return signal.reason?.name === "TimeoutError" ? new WebError("timeout", "联网请求超时，请稍后重试。") : new WebError("cancelled", "联网请求已取消。");
	return error instanceof WebError ? error : new WebError("network_error", "无法连接 DeepSeek 联网服务，请检查网络后重试。");
}

/** Shared, abortable bounded concurrency; waiting calls do not consume a network slot. */
export class DeepSeekWebClient {
	private options: DeepSeekWebOptions;
	private active = 0;
	private waiters: { ready(): void; cancel(): void }[] = [];
	private shutdown = new AbortController();
	constructor(options: DeepSeekWebOptions = {}) { this.options = options; }
	close(): void { this.shutdown.abort(); }
	private acquire(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.reject(signal.reason);
		if (this.active < (this.options.concurrency ?? 3)) { this.active++; return Promise.resolve(); }
		if (this.waiters.length >= 32) return Promise.reject(new WebError("busy", "本地联网请求队列已满，请稍后重试。"));
		return new Promise((resolve, reject) => {
			const entry = {
				ready: () => { signal.removeEventListener("abort", entry.cancel); resolve(); },
				cancel: () => { const index = this.waiters.indexOf(entry); if (index >= 0) this.waiters.splice(index, 1); reject(signal.reason); },
			};
			this.waiters.push(entry); signal.addEventListener("abort", entry.cancel, { once: true });
		});
	}
	private release(): void {
		const next = this.waiters.shift();
		if (next) next.ready(); else this.active--;
	}
	async search(input: SearchInput, key: string, signal: AbortSignal | undefined, record: AttemptRecorder): Promise<SearchResult[]> {
		const payload = validateSearch(input);
		return this.request("search", payload, key, signal, record, (value) => {
			if (!value || typeof value !== "object" || !Array.isArray((value as { results?: unknown }).results)) throw new WebError("invalid_response", "DeepSeek 搜索响应格式无效。");
			return (value as { results: unknown[] }).results.slice(0, payload.count).map((entry) => {
				const item = entry as Record<string, unknown>;
				if (!item || typeof item.title !== "string" || typeof item.url !== "string") throw new WebError("invalid_response", "DeepSeek 搜索结果缺少标题或网址。");
				return { title: item.title, url: item.url, site_name: typeof item.site_name === "string" ? item.site_name : null,
					summary: typeof item.summary === "string" ? item.summary : "", snippet: typeof item.snippet === "string" ? item.snippet : "",
					content: typeof item.content === "string" ? item.content : "", date: typeof item.date === "string" ? item.date : null };
			});
		});
	}
	async fetch(url: string, key: string, signal: AbortSignal | undefined, record: AttemptRecorder): Promise<FetchResult> {
		return this.request("fetch", { url }, key, signal, record, (value) => {
			const page = value as { title?: unknown; content?: unknown };
			if (!page || typeof page.content !== "string") throw new WebError("invalid_response", "DeepSeek 抓取响应缺少网页正文。");
			return { title: typeof page.title === "string" ? page.title : "", content: page.content };
		});
	}
	private async request<T>(tool: "search" | "fetch", payload: unknown, key: string, userSignal: AbortSignal | undefined, record: AttemptRecorder, normalize: (value: unknown) => T): Promise<T> {
		const signal = AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs ?? 30_000), this.shutdown.signal, ...(userSignal ? [userSignal] : [])]);
		let leased = false, dispatched = false;
		try {
			await this.acquire(signal); leased = true;
			for (let index = 1; index <= 3; index++) {
				const at = Date.now(); let status: number | null = null, billable: boolean | null = false;
				try {
					signal.throwIfAborted(); dispatched = true;
					record.started?.(at, index);
					const response = await (this.options.fetch ?? fetch)(DEEPSEEK_WEB_API + tool, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(payload), signal, redirect: "error" });
					status = response.status;
					if (status !== 200) {
						await response.body?.cancel().catch(() => {});
						const error = httpError(status);
						record({ at, attempt: index, httpStatus: status, status: "error", billable: false, errorCode: error.code, errorMessage: error.message, durationMs: Date.now() - at });
						if (status === 429 && index < 3) {
							const seconds = Number(response.headers.get("retry-after"));
							const waitMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(2000, seconds * 1000) : (this.options.retryDelayMs ?? 250) * 2 ** (index - 1);
							await delay(Math.min(waitMs, 2000), undefined, { signal }); continue;
						}
						throw error;
					}
					billable = null;
					const { bytes, truncated } = await readLimited(response, this.options.maxBytes ?? 5 * 1024 * 1024);
					if (truncated) throw new WebError("response_too_large", "DeepSeek 响应超过大小上限，已停止读取。");
					let value: unknown; try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new WebError("invalid_response", "DeepSeek 返回了无法解析的 JSON 响应。"); }
					const data = value as { results?: unknown; content?: unknown };
					billable = tool === "search" ? Array.isArray(data?.results) ? data.results.length > 0 : null : typeof data?.content === "string" ? data.content.trim().length > 0 : null;
					const normalized = normalize(value);
					record({ at, attempt: index, httpStatus: status, status: billable ? "success" : "empty", billable, errorCode: null, errorMessage: null, durationMs: Date.now() - at });
					return normalized;
				} catch (cause) {
					const error = normalizeError(cause, signal);
					// HTTP errors were already recorded once above. Transport/body failures are recorded here.
					if (status === null || status === 200) record({ at, attempt: index, httpStatus: status, status: error.code === "cancelled" ? "cancelled" : "error", billable, errorCode: error.code, errorMessage: error.message, durationMs: Date.now() - at });
					throw error;
				}
			}
			throw new WebError("rate_limited", "DeepSeek 请求限流，请稍后重试。");
		} catch (cause) {
			const error = normalizeError(cause, signal);
			if (!dispatched) record({ at: Date.now(), attempt: 0, httpStatus: null, status: error.code === "cancelled" ? "cancelled" : "error", billable: false, errorCode: error.code, errorMessage: error.message, durationMs: 0 });
			throw error;
		} finally { if (leased) this.release(); }
	}
}
