import type { QuotaSource } from "./platforms.ts";

/** One allowance window of a plan, e.g. "5 小时" at 40 % until 16:20. */
export interface QuotaWindow {
	label: string;
	usedPercent: number;
	resetAt?: number;
}

export interface BalanceValue { amount: number | null; currency: string; }
export interface UnknownWindow { label: string; usedPercent: number | null; resetAt?: number; }

/** What a channel has left, as last read from its platform (or estimated). */
export type QuotaReading =
	| { type: "balance"; amount: number; currency: string; balances?: BalanceValue[]; checkedAt: number }
	| { type: "plan"; windows: QuotaWindow[]; checkedAt: number }
	| { type: "error"; message: string; checkedAt: number; observed?: { balances?: BalanceValue[]; windows?: UnknownWindow[] }; capability?: { endpoint: string; available: boolean; schema: string } };

type Fetch = typeof fetch;

/**
 * Reads a channel's balance or plan allowance. Endpoints and fields come from
 * the 2026-10-31 research (docs/v0.2-gateway.md appendix B); only DeepSeek's
 * was checked live, the others parse defensively and report what they cannot read.
 */
export async function readQuota(source: QuotaSource, baseUrl: string, apiKey: string, fetchImpl: Fetch = fetch, clock: () => number = Date.now): Promise<QuotaReading> {
	const checkedAt = clock();
	try {
		switch (source) {
			case "deepseek-balance": {
				const body = await getJson(fetchImpl, `${originOf(baseUrl)}/user/balance`, { Authorization: `Bearer ${apiKey}` });
				if (!Array.isArray(body.balance_infos) || !body.balance_infos.length) throw new Error("账户余额未知：响应缺少货币余额列表");
				const balances = body.balance_infos.map((item) => { const info = item && typeof item === "object" ? item as Record<string, unknown> : {}; return { amount: money(info.total_balance), currency: typeof info.currency === "string" && /^[A-Z]{3}$/.test(info.currency) ? info.currency : "UNKNOWN" }; });
				if (balances.some((b) => b.amount === null || b.currency === "UNKNOWN")) return { type: "error", message: "账户余额未知：金额或币种缺失、无效或越界；保留上次有效读数。", checkedAt, observed: { balances } };
				return { type: "balance", amount: balances[0]!.amount!, currency: balances[0]!.currency, ...(balances.length > 1 ? { balances } : {}), checkedAt };
			}
			case "moonshot-balance": {
				const body = await getJson(fetchImpl, `${originOf(baseUrl)}/v1/users/me/balance`, { Authorization: `Bearer ${apiKey}` });
				const amount = (body.data as { available_balance?: number } | undefined)?.available_balance;
				if (money(amount) === null) throw new Error("账户余额未知：金额缺失、无效或越界");
				return { type: "balance", amount: money(amount)!, currency: "CNY", checkedAt };
			}
			case "glm-quota": {
				// 智谱's monitor endpoint takes the bare key, without "Bearer".
				const body = await getJson(fetchImpl, `${originOf(baseUrl)}/api/monitor/usage/quota/limit`, { Authorization: apiKey });
				const limits = ((body.data as { limits?: unknown[] } | undefined)?.limits ?? []) as { type?: string; unit?: number; number?: number; percentage?: number; nextResetTime?: number }[];
				if (!Array.isArray(limits) || !limits.length) throw new Error("供应商套餐用量未知：响应没有窗口信息");
				const windows = limits.map((entry) => { const l = entry && typeof entry === "object" ? entry : {}; return { label: glmWindowLabel(l.unit, l.number, l.type), usedPercent: percent(l.percentage), resetAt: typeof l.nextResetTime === "number" && Number.isFinite(l.nextResetTime) && l.nextResetTime > 0 ? l.nextResetTime : undefined }; });
				if (windows.some((w) => w.usedPercent === null)) return { type: "error", message: "供应商套餐用量未知：百分比缺失、无效或越界；保留上次有效读数。", checkedAt, observed: { windows } };
				return {
					type: "plan",
					windows: windows as QuotaWindow[],
					checkedAt,
				};
			}
			case "minimax-remains": {
				try {
					const body = await getJson(fetchImpl, MINIMAX_LEGACY, { Authorization: `Bearer ${apiKey}` });
					const data = body.data as { current_interval_total_count?: number; current_interval_usage_count?: number; expired_time?: number } | undefined;
					const total = data?.current_interval_total_count, used = data?.current_interval_usage_count;
					if (typeof total === "number" && Number.isFinite(total) && total > 0 && typeof used === "number" && Number.isFinite(used) && used >= 0 && used <= total) {
						const resetAt = typeof data?.expired_time === "number" && Number.isFinite(data.expired_time) && data.expired_time > 0 ? (data.expired_time < 1e12 ? data.expired_time * 1000 : data.expired_time) : undefined;
						if (resetAt !== undefined && resetAt <= checkedAt) throw new Error("旧接口周期已过期，用量未知");
						return { type: "plan", windows: [{ label: "当前周期", usedPercent: used / total * 100, resetAt }], checkedAt };
					}
				} catch (error) { if (/401|403/.test(error instanceof Error ? error.message : "")) throw error; }
				// The current official endpoint has no published response schema. Probe availability only.
				await getJson(fetchImpl, MINIMAX_CURRENT, { Authorization: `Bearer ${apiKey}` });
				return { type: "error", message: "MiniMax 新接口可访问，但官方未定义响应字段；供应商套餐用量未知，不套用旧接口字段。", checkedAt, capability: { endpoint: MINIMAX_CURRENT, available: true, schema: "undocumented" } };
			}
		}
	} catch (error) {
		return { type: "error", message: error instanceof Error ? error.message : String(error), checkedAt };
	}
}

async function getJson(fetchImpl: Fetch, url: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
	const response = await fetchImpl(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(15_000) });
	if (!response.ok) throw new Error(`查询接口返回 ${response.status}`);
	try { const value = await response.json(); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
	catch { throw new Error("查询接口响应不是有效 JSON 对象，用量未知"); }
}

function originOf(baseUrl: string): string {
	return new URL(baseUrl).origin;
}

export const MINIMAX_LEGACY = "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains";
export const MINIMAX_CURRENT = "https://www.minimax.cn/v1/token_plan/remains";
function percent(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null; }
function money(value: unknown): number | null { if (typeof value !== "number" && (typeof value !== "string" || !value.trim() || !/^\d+(?:\.\d+)?$/.test(value.trim()))) return null; const amount = Number(value); return Number.isFinite(amount) && amount >= 0 && amount <= Number.MAX_SAFE_INTEGER ? amount : null; }

function glmWindowLabel(unit: number | undefined, count: number | undefined, type: string | undefined): string {
	// Observed: unit 3 + number 5 = the five-hour window. Other units are not documented.
	if (unit === 3 && count) return `${count} 小时`;
	return type === "TIME_LIMIT" ? "调用次数" : "供应商套餐用量";
}
