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

const QUOTA = new RegExp(
	[
		// 智谱: 1309 plan expired, 1310 weekly/monthly limit, 1316 five-hour limit, 1317 seven-day limit.
		"(?<![0-9])(?:1309|1310|1316|1317)(?![0-9])",
		"exceeded_current_quota",
		"usage.?limit.?(?:exceeded|reached)",
		"quota.?exceeded",
		"insufficient_quota",
		"使用上限",
		"额度(?:已)?(?:用完|用尽|耗尽|不足)",
		"套餐(?:已)?(?:到期|过期)",
	].join("|"),
	"i",
);
const BALANCE = new RegExp(
	["(?<![0-9])(?:402|1113)(?![0-9])", "insufficient.?balance", "payment.?required", "余额不足", "欠费", "arrear"].join("|"),
	"i",
);
const AUTH = new RegExp(
	[
		"(?<![0-9])(?:401|403)(?![0-9])",
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
	["(?<![0-9])(?:429|1002|1302|1305)(?![0-9])", "rate.?limit", "too many requests", "concurren", "访问量过大", "请求过于频繁"].join("|"),
	"i",
);
const SERVER = new RegExp(
	["(?<![0-9])(?:500|502|503|504|520|524|529)(?![0-9])", "overloaded", "server.?(?:error|busy)", "internal.?error", "service.?(?:is.?)?(?:temporarily.?)?unavailable", "upstream"].join("|"),
	"i",
);
const NETWORK = new RegExp(
	["timed? ?out", "ECONN", "ENOTFOUND", "EAI_AGAIN", "fetch failed", "network", "socket", "terminated", "connection", "ended without", "stream ended"].join("|"),
	"i",
);
const CONTEXT = /context.?(?:length|window|overflow)|maximum context|too many tokens|prompt is too long|(?<![0-9])1039(?![0-9])/i;

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
