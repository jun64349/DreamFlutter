import type { Db } from "../../db.ts";
import { classifyFailure, type FailureKind } from "../../gateway/classify.ts";
import type { Run } from "../../runs.ts";

const labels = {
	auth: "渠道认证失败", quota: "渠道额度或订阅用完", balance: "渠道余额不足",
	rate_limit: "渠道持续限流", server: "渠道服务器持续出错", network: "渠道连接持续失败",
	unavailable: "没有可用的渠道",
};

export interface ChannelFailure { detail: string; permanent: boolean }

export function goalChannelFailure(error: string | undefined | null, db?: Db, run?: Run): ChannelFailure | null {
	if (!error) return null;
	const unavailable = /暂时没有可用的渠道|没有可用的 Key|Key 都被拒绝了|渠道凭据引用当前不可用|模型组「.*」里还没有模型|这个模型组已被删除/.test(error);
	const rerouted = /^渠道「.*」.*换(?:下一个渠道|同渠道的另一个 Key)（service temporarily unavailable）$/.test(error);
	// Group routing can replace the upstream error. Use the gateway's recorded
	// category only for this run's session and request window.
	const recorded = (unavailable || rerouted) && db && run?.sessionId ? db.get<{ error_kind: FailureKind | null; error: string | null }>(
		"SELECT error_kind,error FROM gateway_requests WHERE session_id=? AND at>=? AND at<=? ORDER BY id DESC LIMIT 1",
		run.sessionId, run.startedAt, run.endedAt ?? Date.now(),
	) : undefined;
	const observed = recorded?.error_kind ?? classifyFailure(error);
	const classified = unavailable && observed !== "auth" && observed !== "quota" && observed !== "balance" ? "other" : observed;
	const kind = classified === "other" ? (unavailable ? "unavailable" : null) : classified;
	if (!kind) return null;
	const permanent = kind === "auth" || kind === "quota" || kind === "balance" || kind === "unavailable";
	const status = /(?:^|\bHTTP(?: status)?\s+|\bstatus(?: code)?\s*[:=]?\s*)(401|402|403|429|500|502|503|504|520|524|529)\b/i.exec(recorded?.error ?? error)?.[1];
	return { permanent, detail: `${labels[kind]}${status ? `（${status}）` : ""}，${permanent ? "检查渠道设置后继续" : "重试后仍不可用，等渠道恢复后继续"}` };
}
