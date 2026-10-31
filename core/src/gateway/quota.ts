import type { QuotaSource } from "./platforms.ts";

/** One allowance window of a plan, e.g. "5 小时" at 40 % until 16:20. */
export interface QuotaWindow {
	label: string;
	usedPercent: number;
	resetAt?: number;
}

/** What a channel has left, as last read from its platform (or estimated). */
export type QuotaReading =
	| { type: "balance"; amount: number; currency: string; checkedAt: number }
	| { type: "plan"; windows: QuotaWindow[]; checkedAt: number }
	| { type: "error"; message: string; checkedAt: number };

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
				const info = (body.balance_infos as { currency?: string; total_balance?: string }[] | undefined)?.[0];
				if (!info) throw new Error("返回里没有余额");
				return { type: "balance", amount: Number(info.total_balance), currency: info.currency ?? "CNY", checkedAt };
			}
			case "moonshot-balance": {
				const body = await getJson(fetchImpl, `${originOf(baseUrl)}/v1/users/me/balance`, { Authorization: `Bearer ${apiKey}` });
				const amount = (body.data as { available_balance?: number } | undefined)?.available_balance;
				if (typeof amount !== "number") throw new Error("返回里没有余额");
				return { type: "balance", amount, currency: "CNY", checkedAt };
			}
			case "glm-quota": {
				// 智谱's monitor endpoint takes the bare key, without "Bearer".
				const body = await getJson(fetchImpl, `${originOf(baseUrl)}/api/monitor/usage/quota/limit`, { Authorization: apiKey });
				const limits = ((body.data as { limits?: unknown[] } | undefined)?.limits ?? []) as { type?: string; unit?: number; number?: number; percentage?: number; nextResetTime?: number }[];
				if (!limits.length) throw new Error("返回里没有额度信息");
				return {
					type: "plan",
					windows: limits.map((l) => ({ label: glmWindowLabel(l.unit, l.number, l.type), usedPercent: clampPercent(l.percentage), resetAt: typeof l.nextResetTime === "number" ? l.nextResetTime : undefined })),
					checkedAt,
				};
			}
			case "minimax-remains": {
				const body = await getJson(fetchImpl, "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains", { Authorization: `Bearer ${apiKey}` });
				const data = body.data as { current_interval_total_count?: number; current_interval_usage_count?: number; expired_time?: number } | undefined;
				const total = data?.current_interval_total_count;
				const used = data?.current_interval_usage_count;
				if (typeof total !== "number" || typeof used !== "number" || total <= 0) throw new Error("返回里没有额度信息");
				const resetAt = typeof data?.expired_time === "number" ? (data.expired_time < 1e12 ? data.expired_time * 1000 : data.expired_time) : undefined;
				return { type: "plan", windows: [{ label: "当前周期", usedPercent: clampPercent((used / total) * 100), resetAt }], checkedAt };
			}
		}
	} catch (error) {
		return { type: "error", message: error instanceof Error ? error.message : String(error), checkedAt };
	}
}

async function getJson(fetchImpl: Fetch, url: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
	const response = await fetchImpl(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(15_000) });
	if (!response.ok) throw new Error(`查询接口返回 ${response.status}`);
	return (await response.json()) as Record<string, unknown>;
}

function originOf(baseUrl: string): string {
	return new URL(baseUrl).origin;
}

function clampPercent(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function glmWindowLabel(unit: number | undefined, count: number | undefined, type: string | undefined): string {
	// Observed: unit 3 + number 5 = the five-hour window. Other units are not documented.
	if (unit === 3 && count) return `${count} 小时`;
	return type === "TIME_LIMIT" ? "调用次数" : "额度";
}
