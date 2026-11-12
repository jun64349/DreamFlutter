import type { LedgerRow } from "../../src/ledger/types.ts";
import { classifyFailure } from "../../src/gateway/classify.ts";

export type EndStatus = "正常结束" | "被拒" | "中断" | "超时" | "异常结束";

export interface RequestReceipt {
	status: EndStatus;
	finalUsage: boolean;
	transport: boolean;
	failure?: RequestFailure;
}

type FailureCategory = "认证" | "额度或订阅" | "限流" | "上游错误" | "网络" | "网关已停用渠道" | "无法归类";
type NotSent = "渠道没有可用的 Key" | "渠道的 Key 都已被拒绝" | "渠道凭据引用不可用" | "网关没有可用渠道" | "试跑限制" | "未收到可归类的网关原因";
export interface RequestFailure { category: FailureCategory; httpStatus?: number; notSent?: NotSent }

const categories = {
	auth: "认证", quota: "额度或订阅", balance: "额度或订阅", rate_limit: "限流", server: "上游错误", network: "网络", other: "无法归类",
} as const;

export function requestFailure(error: unknown, sent: boolean): RequestFailure {
	const value = error as (Error & { status?: unknown }) | null;
	const message = typeof error === "string" ? error : typeof value?.message === "string" ? value.message : "";
	if (!sent) {
		const reason = /Key 都被拒绝了/.test(message) ? "渠道的 Key 都已被拒绝" :
			/没有可用的 Key/.test(message) ? "渠道没有可用的 Key" :
			/渠道凭据引用当前不可用/.test(message) ? "渠道凭据引用不可用" :
			/没有可用的渠道|模型组已被删除|模型组.*还没有模型/.test(message) ? "网关没有可用渠道" : undefined;
		if (reason) return { category: "网关已停用渠道", notSent: reason };
		return { category: "无法归类", notSent: "未收到可归类的网关原因" };
	}
	const status = typeof value?.status === "number" ? value.status : Number(
		/^\s*(?:HTTP(?:\s+(?:status(?:\s+code)?|error))?\s*[:=]?\s*)?([45]\d{2})(?=[:\s]|$)/i.exec(message)?.[1]
		?? /^[\w -]+(?:API )?error\s*\(([45]\d{2})\):/i.exec(message)?.[1]);
	const httpStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
	const kind = classifyFailure((httpStatus ? `${httpStatus} ` : "") + message.replace(/\b[45]\d{2}\b/g, ""));
	return { category: kind === "other" && httpStatus ? "上游错误" : categories[kind], httpStatus };
}

export interface TransportReceipt extends RequestReceipt {
	ledgerId?: string;
}

export type RequestLedgerReceipt = Pick<LedgerRow, "id" | "state" | "success" | "error_code" | "amount" | "currency" | "amount_source">;

export function hasFinalUsageFrame(event: unknown): boolean {
	const frame = event as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | undefined;
	return [frame?.usage?.prompt_tokens, frame?.usage?.completion_tokens]
		.every(tokens => typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0);
}

export function requestEnd(stop: string | undefined, message = "", signal?: AbortSignal): EndStatus {
	if (stop === "stop" || stop === "length" || stop === "toolUse") return "正常结束";
	if ((signal?.aborted && signal.reason?.name === "TimeoutError") || /\b(?:timeout|timed? out|ETIMEDOUT)\b|超时/i.test(message)) return "超时";
	if (stop === "aborted" || signal?.aborted) return "中断";
	if (/\b(?:400|401|402|403|404|405|409|413|415|422|429)\b|content_filter|rate limit|quota|unauthorized|forbidden|余额不足|拒绝/i.test(message)) return "被拒";
	return "异常结束";
}

export function requestReceipts(ledger: readonly RequestLedgerReceipt[], transport: readonly TransportReceipt[]): RequestReceipt[] {
	const used = new Set<TransportReceipt>();
	const rows = ledger.map(row => {
		const matched = transport.find(entry => entry.ledgerId === row.id);
		if (matched) {
			used.add(matched);
			return visible(matched);
		}
		const code = row.error_code ?? "";
		const status = row.success ? "正常结束" : code.includes("timeout") ? "超时" :
			row.state === "pending" || /abort|cancel|interrupt|shutdown/.test(code) ? "中断" : "被拒";
		return { status, finalUsage: false, transport: false,
			...(status === "被拒" && { failure: requestFailure(undefined, false) }) } satisfies RequestReceipt;
	});
	return rows.concat(transport.filter(entry => !used.has(entry)).map(visible));
}

function visible({ status, finalUsage, transport, failure }: RequestReceipt): RequestReceipt {
	return { status, finalUsage, transport, ...(failure && { failure }) };
}
