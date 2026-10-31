import { FAILURE_LABEL, type FailureKind } from "./classify.ts";
import type { ChannelKind } from "./platforms.ts";

/** One model of a channel inside a model group. */
export interface GroupEntry {
	channel: string;
	model: string;
	/** Lower goes first. Entries sharing a priority are one tier. */
	priority: number;
	/** Share within its tier; 0 everywhere in the tier = take them in list order. */
	weight: number;
}

export interface ModelGroup {
	id: string;
	name: string;
	entries: GroupEntry[];
	/** When the plan channels are used up, go on with pay-as-you-go ones. */
	allowPaidOverflow: boolean;
}

/** Where a session's group requests go: kept on the session branch (Pi's router state). */
export interface RouteState {
	channel: string;
	model: string;
}

/** Why a channel or key cannot take requests right now. */
export interface Unavailable {
	kind: FailureKind | "disabled" | "no_key" | "missing";
	message: string;
	/** Usable again from this time (ms); absent = until the user changes something. */
	until?: number;
}

export interface CandidateInfo {
	kind: ChannelKind;
	name: string;
	/** Null when the entry can take a request now. */
	unavailable: Unavailable | null;
}

export type RouteDecision =
	| { ok: true; entry: GroupEntry; state: RouteState; switchedFrom?: GroupEntry; toPaid: boolean }
	| { ok: false; message: string };

const same = (a: { channel: string; model: string }, b: { channel: string; model: string } | undefined) =>
	b !== undefined && a.channel === b.channel && a.model === b.model;

/**
 * Picks the entry of [group] for one request. A session stays on the entry in
 * [state] while it works (the platform's prompt cache is per channel); it
 * moves only when that entry failed ([failed]) or became unavailable.
 */
export function pickEntry(
	group: ModelGroup,
	info: (entry: GroupEntry) => CandidateInfo,
	state: RouteState | undefined,
	failed: { channel: string; model: string } | undefined,
	random: () => number = Math.random,
): RouteDecision {
	const entries = group.entries.map((entry, index) => ({ entry, index, info: info(entry) }));
	const usable = entries.filter((e) => e.info.unavailable === null && !same(e.entry, failed));
	const current = state && entries.find((e) => same(e.entry, state));

	const hasPlan = entries.some((e) => e.info.kind === "plan");
	const plansLeft = usable.some((e) => e.info.kind === "plan");
	const allowed = usable.filter((e) => e.info.kind === "plan" || !hasPlan || plansLeft || group.allowPaidOverflow);

	const decide = (chosen: (typeof entries)[number]): RouteDecision => {
		const from = failed ? entries.find((e) => same(e.entry, failed)) : current && !same(chosen.entry, current.entry) ? current : undefined;
		return {
			ok: true,
			entry: chosen.entry,
			state: { channel: chosen.entry.channel, model: chosen.entry.model },
			switchedFrom: from?.entry,
			toPaid: from !== undefined && from.info.kind === "plan" && chosen.info.kind !== "plan",
		};
	};

	if (current && !same(current.entry, failed) && allowed.includes(current)) return decide(current);
	if (allowed.length === 0) return { ok: false, message: explain(group, entries, failed, hasPlan && !plansLeft && usable.length > 0) };

	const tier = Math.min(...allowed.map((e) => e.entry.priority));
	const inTier = allowed.filter((e) => e.entry.priority === tier).sort((a, b) => a.index - b.index);
	const total = inTier.reduce((sum, e) => sum + Math.max(0, e.entry.weight), 0);
	if (total <= 0) return decide(inTier[0]!);
	let roll = random() * total;
	for (const e of inTier) {
		roll -= Math.max(0, e.entry.weight);
		if (roll < 0) return decide(e);
	}
	return decide(inTier[inTier.length - 1]!);
}

/** "智谱：额度用完，16:20 恢复；DeepSeek：余额不足" */
function explain(
	group: ModelGroup,
	entries: { entry: GroupEntry; info: CandidateInfo }[],
	failed: { channel: string; model: string } | undefined,
	blockedPaid: boolean,
): string {
	if (entries.length === 0) return `模型组「${group.name}」里还没有模型`;
	const seen = new Set<string>();
	const parts: string[] = [];
	for (const { entry, info } of entries) {
		if (seen.has(entry.channel)) continue;
		seen.add(entry.channel);
		const why = info.unavailable ?? (same(entry, failed) ? { kind: "other" as const, message: "刚刚出错" } : null);
		if (why) parts.push(`${info.name}：${describe(why)}`);
		else if (blockedPaid && info.kind !== "plan") parts.push(`${info.name}：本组不允许套餐用完后转到付费渠道`);
	}
	return `模型组「${group.name}」暂时没有可用的渠道。${parts.join("；")}`;
}

export function describe(why: Unavailable): string {
	const label = why.kind === "disabled" ? "已停用" : why.kind === "no_key" ? "没有可用的 Key" : why.kind === "missing" ? "找不到这个渠道或模型" : FAILURE_LABEL[why.kind];
	if (!why.until) return label;
	const at = new Date(why.until);
	const pad = (n: number) => String(n).padStart(2, "0");
	const sameDay = at.toDateString() === new Date().toDateString();
	return `${label}，${sameDay ? "" : `${at.getMonth() + 1}月${at.getDate()}日 `}${pad(at.getHours())}:${pad(at.getMinutes())} 恢复`;
}
