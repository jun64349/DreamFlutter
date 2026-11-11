/**
 * What a failed request says about the channel that served it. Platforms
 * return most limits as HTTP 429, quota exhaustion included, so the kind comes
 * from business codes and wording, not the status alone (docs/v0.2-gateway.md,
 * appendix B).
 */
export type FailureKind =
	/** Throttled: retry soon. */
	| "rate_limit"
	/** A plan's window or allowance is used up: rest until it resets. */
	| "quota"
	/** Pay-as-you-go money ran out. */
	| "balance"
	/** The key is wrong, expired or used against the wrong endpoint: stop using it. */
	| "auth"
	| "server"
	| "network"
	/** Anything else (bad request, context overflow...): not the channel's fault. */
	| "other";

/**
 * Status or business codes as whole words: a code inside a request id or a
 * redacted key's last four characters ("req_f401b", "****a401") does not count.
 */
const codes = (...list: number[]) => `(?<![0-9A-Za-z])(?:${list.join("|")})(?![0-9A-Za-z])`;

const QUOTA = new RegExp(
	[
		// 智谱: 1309 plan expired, 1310 weekly/monthly limit, 1316 five-hour limit, 1317 seven-day limit.
		codes(1309, 1310, 1316, 1317),
		"exceeded_current_quota",
		"usage.?limit.?(?:exceeded|reached)",
		// ChatGPT sign-in (Pi's Codex provider): "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min."
		"hit your [a-z ]{0,20}usage limit",
		"usage_not_included",
		"usage limit has been reached",
		"quota.?exceeded",
		"insufficient_quota",
		"使用上限",
		"额度(?:已)?(?:用完|用尽|耗尽|不足)",
		"套餐(?:已)?(?:到期|过期)",
	].join("|"),
	"i",
);
const BALANCE = new RegExp(
	[codes(402, 1113), "insufficient.?balance", "payment.?required", "余额不足", "欠费", "arrear"].join("|"),
	"i",
);
const AUTH = new RegExp(
	[
		codes(401, 403),
		"unauthori[sz]ed",
		"invalid.{0,20}(?:api.?key|token|x-api-key)",
		"incorrect api key",
		"authentication",
		"not authorized",
		"token not match group",
		"permission.?denied",
	].join("|"),
	"i",
);
const RATE_LIMIT = new RegExp(
	[codes(429, 1002, 1302, 1305), "rate.?limit", "too many requests", "concurren", "访问量过大", "请求过于频繁"].join("|"),
	"i",
);
const SERVER = new RegExp(
	[codes(500, 502, 503, 504, 520, 524, 529), "overloaded", "server.?(?:error|busy)", "internal.?error", "service.?(?:is.?)?(?:temporarily.?)?unavailable", "upstream"].join("|"),
	"i",
);
const NETWORK = new RegExp(
	["timed? ?out", "ECONN", "ENOTFOUND", "EAI_AGAIN", "fetch failed", "network", "socket", "terminated", "connection", "ended without", "stream ended"].join("|"),
	"i",
);
const CONTEXT = new RegExp(`context.?(?:length|window|overflow)|maximum context|too many tokens|prompt is too long|${codes(1039)}`, "i");

export function classifyFailure(message: string | undefined): FailureKind {
	const text = message ?? "";
	if (!text) return "other";
	if (CONTEXT.test(text)) return "other";
	// Order matters: a quota error usually also says 429.
	if (QUOTA.test(text)) return "quota";
	if (BALANCE.test(text)) return "balance";
	if (AUTH.test(text)) return "auth";
	if (RATE_LIMIT.test(text)) return "rate_limit";
	if (SERVER.test(text)) return "server";
	if (NETWORK.test(text)) return "network";
	return "other";
}

/**
 * When a used-up plan comes back, if the message says so: "Try again in ~42 min"
 * (ChatGPT sign-in), "resets_at": 1767225600 (seconds). Undefined when it does not say.
 */
export function resetAtOf(message: string | undefined, now: number): number | undefined {
	const text = message ?? "";
	const minutes = /try again in ~?\s*(\d+)\s*min/i.exec(text);
	if (minutes) return now + Number(minutes[1]) * 60_000;
	const at = /resets?_at\D{0,4}(\d{10})/i.exec(text);
	if (at) return Number(at[1]) * 1000;
	return undefined;
}

/** A failure that moving to another channel can fix. */
export function isChannelFailure(kind: FailureKind): boolean {
	return kind !== "other";
}

/** Shown to the user, e.g. "已从 A 换到 B：额度用完". */
export const FAILURE_LABEL: Record<FailureKind, string> = {
	rate_limit: "限流",
	quota: "额度用完",
	balance: "余额不足",
	auth: "Key 无效",
	server: "服务器出错",
	network: "连接失败",
	other: "出错",
};
