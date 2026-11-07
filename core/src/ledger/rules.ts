import type { Model, Usage } from "@earendil-works/pi-ai";
import { finite } from "./types.ts";

/** Official GLM plan points, not currency and not a claim of tool eligibility. No inferred retroactive start. */
export const PRICE_RULES = [{
	version: "glm-plan-points-2026-11-07-v1", provider: "glm-coding", models: {
		"glm-5.3": { input: 6.9, cacheRead: 1.7, output: 24 }, "glm-5.3-flash": { input: 2.3, cacheRead: 0.56, output: 8 },
	} as Record<string, { input: number; cacheRead: number; output: number }>,
	effectiveFrom: Date.parse("2026-11-07T00:00:00+08:00"), effectiveUntil: null, timeZone: "Asia/Shanghai",
	peakWeekdays: [1, 2, 3, 4, 5], peakStartMinute: 14 * 60, peakEndMinute: 18 * 60, offPeakMultiplier: 0.5,
	unit: "GLM_POINTS", divisor: 10000, source: "https://docs.bigmodel.cn/cn/coding-plan/overview", queriedAt: "2026-11-07",
}];
export const CATALOG_VERSION = "pi-catalog-1.4.0-2026-11-07";
export function ruleMultiplier(at: number, rule = PRICE_RULES[0]!): number {
	const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: rule.timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((p) => [p.type, p.value]));
	const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!);
	const minute = Number(parts.hour) * 60 + Number(parts.minute);
	return rule.peakWeekdays.includes(day) && minute >= rule.peakStartMinute && minute < rule.peakEndMinute ? 1 : rule.offPeakMultiplier;
}
export function estimate(model: Model<any>, usage: Usage): number | null {
	const categories = [[usage.input, model.cost?.input], [usage.output, model.cost?.output], [usage.cacheRead, model.cost?.cacheRead], [usage.cacheWrite, model.cost?.cacheWrite]];
	if (categories.some(([tokens, price]) => finite(tokens) === null || finite(price) === null)) return null;
	if (categories.every(([, price]) => price === 0)) return null; // Pi also uses zero for absent pricing; never call that supplier-confirmed free.
	// SDK output already includes reasoning; input excludes cache read/write. Never add either twice.
	return categories.reduce((sum, [tokens, price]) => sum + tokens! * price!, 0) / 1e6;
}
export function planEstimate(platform: string | null, model: string, at: number, usage: Usage) {
	const rule = PRICE_RULES.find((r) => r.provider === platform && r.models[model.toLowerCase()] && at >= r.effectiveFrom && (r.effectiveUntil === null || at < r.effectiveUntil));
	if (!rule || usage.cacheWrite > 0) return null; // No official cache-write coefficient: do not invent one.
	const rates = rule.models[model.toLowerCase()]!;
	return { value: (usage.input * rates.input + usage.cacheRead * rates.cacheRead + usage.output * rates.output) / rule.divisor * ruleMultiplier(at, rule), unit: rule.unit, version: rule.version };
}
