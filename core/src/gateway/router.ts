import { FAILURE_LABEL, type FailureKind } from "./classify.ts";

// Model groups and their router were retired in 0.8.1 (docs/REVIEW-2026-11-10.md);
// what is left is how a channel or key says it cannot take requests.

/** Why a channel or key cannot take requests right now. */
export interface Unavailable {
	kind: FailureKind | "disabled" | "no_key" | "missing";
	message: string;
	/** Usable again from this time (ms); absent = until the user changes something. */
	until?: number;
}

export function describe(why: Unavailable): string {
	const label = why.kind === "disabled" ? "已停用" : why.kind === "no_key" ? "没有可用的 Key" : why.kind === "missing" ? "找不到这个渠道或模型" : FAILURE_LABEL[why.kind];
	if (!why.until) return label;
	const at = new Date(why.until);
	const pad = (n: number) => String(n).padStart(2, "0");
	const sameDay = at.toDateString() === new Date().toDateString();
	return `${label}，${sameDay ? "" : `${at.getMonth() + 1}月${at.getDate()}日 `}${pad(at.getHours())}:${pad(at.getMinutes())} 恢复`;
}
