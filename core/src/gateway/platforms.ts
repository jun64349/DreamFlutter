/**
 * Known platforms: what the "add channel" form fills in, and how to read a
 * channel's balance or plan allowance. From the 2026-10-31 research
 * (docs/v0.2-gateway.md appendix B); change addresses here only.
 */

export type ChannelKind = "payg" | "plan" | "relay";
export type ChannelApi = "openai-completions" | "anthropic-messages";

/** How a channel's remaining money or allowance can be queried. */
export type QuotaSource = "deepseek-balance" | "glm-quota" | "minimax-remains" | "moonshot-balance";

export interface Platform {
	id: string;
	name: string;
	kind: ChannelKind;
	/** First entry is the default. Empty for relays (the user types the address). */
	endpoints: { api: ChannelApi; baseUrl: string }[];
	quota?: QuotaSource;
	/** Plan windows, for display and for estimating when there is no query endpoint. */
	windows?: ("5h" | "week" | "month")[];
	/** Suggested models when the endpoint cannot list them. */
	models?: string[];
}

export const PLATFORMS: Platform[] = [
	{
		id: "deepseek",
		name: "DeepSeek",
		kind: "payg",
		endpoints: [
			{ api: "openai-completions", baseUrl: "https://api.deepseek.com/v1" },
			{ api: "anthropic-messages", baseUrl: "https://api.deepseek.com/anthropic" },
		],
		quota: "deepseek-balance",
		models: ["deepseek-flash", "deepseek-v4-pro"],
	},
	{
		id: "glm-coding",
		name: "智谱 GLM 编程套餐",
		kind: "plan",
		endpoints: [
			{ api: "anthropic-messages", baseUrl: "https://open.bigmodel.cn/api/anthropic" },
			{ api: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
		],
		quota: "glm-quota",
		windows: ["5h", "week"],
		models: ["glm-5.3", "glm-5.3-flash"],
	},
	{
		id: "kimi-coding",
		name: "Kimi Code 会员",
		kind: "plan",
		endpoints: [
			{ api: "anthropic-messages", baseUrl: "https://api.kimi.com/coding" },
			{ api: "openai-completions", baseUrl: "https://api.kimi.com/coding/v1" },
		],
		windows: ["5h", "month"],
		models: ["k3.1-pro", "k3.1-pro-highspeed"],
	},
	{
		id: "minimax-coding",
		name: "MiniMax 编程套餐",
		kind: "plan",
		endpoints: [
			{ api: "anthropic-messages", baseUrl: "https://api.minimaxi.com/anthropic" },
			{ api: "openai-completions", baseUrl: "https://api.minimaxi.com/v1" },
		],
		quota: "minimax-remains",
		windows: ["5h", "week"],
		models: ["MiniMax-M3", "MiniMax-M3.1-Flash"],
	},
	{
		id: "moonshot",
		name: "Kimi 开放平台（按量）",
		kind: "payg",
		endpoints: [
			{ api: "openai-completions", baseUrl: "https://api.moonshot.cn/v1" },
			{ api: "anthropic-messages", baseUrl: "https://api.moonshot.cn/anthropic" },
		],
		quota: "moonshot-balance",
	},
	{ id: "openai-relay", name: "OpenAI 兼容中转", kind: "relay", endpoints: [] },
	{ id: "anthropic-relay", name: "Anthropic 兼容中转", kind: "relay", endpoints: [] },
];

export function platform(id: string | null | undefined): Platform | undefined {
	return PLATFORMS.find((p) => p.id === id);
}

/** The platform an address belongs to (for channels that came from Pi's config). */
export function platformForUrl(baseUrl: string | null | undefined): Platform | undefined {
	if (!baseUrl) return undefined;
	const host = hostOf(baseUrl);
	return PLATFORMS.find((p) => p.endpoints.some((e) => hostOf(e.baseUrl) === host && (p.kind !== "plan" || baseUrl.includes(new URL(e.baseUrl).pathname))));
}

function hostOf(url: string): string {
	try {
		return new URL(url).host.toLowerCase();
	} catch {
		return "";
	}
}
