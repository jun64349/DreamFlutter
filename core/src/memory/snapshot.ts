import { estimateTokens, taskRelevance, trigrams } from "./text.ts";
import type { ItemKind, Level, MemoryItem } from "./types.ts";

/**
 * Snapshot assembly (docs/memory-design.md §6.1–6.2): the program picks, no
 * model. One budget for everything memory puts into a request; pinned items,
 * related items by level, and room left for memory_search.
 */

/** Tokens kept for the reply and tool traffic on top of the model's output (§6.1). */
export const EXECUTION_RESERVE = 8_000;
/** Shares of the budget (§6.1 at 2000: pinned 300, related 1400, search 300). */
export const SHARES = { pinned: 0.15, related: 0.7, search: 0.15 } as const;
/** Soft shares of the related part per level; what one level leaves goes to the others. */
export const LEVEL_SHARES: Record<Level, number> = { 1: 0.4, 2: 0.35, 3: 0.25 };
/** Estimates are short of the real count now and then: 10% margin (§6.1). */
export const MARGIN = 1.1;
/** Kinds that apply to most tasks even when no words are shared with the prompt. */
const GENERAL_KINDS: readonly ItemKind[] = ["preference", "agreement", "persona", "decision"];
/** Below this, an item shares nothing worth mentioning with the task. */
const RELEVANT = 0.05;

export interface BudgetInput {
	/** The user's cap (settings). */
	cap: number;
	contextWindow: number;
	/** The model's maximum output. */
	maxOutput: number;
	/** What is already in the request besides memory (system prompt, history). */
	nonMemory: number;
}

/** min(cap, window × 3%, (window − non-memory − reserve) × 15%), never below zero. */
export function memoryBudget(input: BudgetInput): number {
	const room = input.contextWindow - input.nonMemory - (input.maxOutput + EXECUTION_RESERVE);
	return Math.max(0, Math.floor(Math.min(input.cap, input.contextWindow * 0.03, room * 0.15)));
}

export type LeftOutReason = "budget" | "irrelevant";

export interface SnapshotPlan {
	budget: number;
	/** Estimated tokens of what was picked (with the margin). */
	tokens: number;
	pinned: MemoryItem[];
	related: MemoryItem[];
	/** Live items in scope that did not make it, and why (17.8 「为什么没想起来」). */
	leftOut: { id: string; reason: LeftOutReason }[];
	/** Pinned items take more than their share: the user is asked to trim them (never cut, §6.1). */
	pinnedOver: boolean;
	/** Tokens memory_search may add this task. */
	searchRoom: number;
}

/** Tokens one snapshot line costs, margin included. */
export function lineCost(item: Pick<MemoryItem, "content">): number {
	return Math.ceil((estimateTokens(item.content) + 8) * MARGIN);
}

/**
 * Picks from [items] (live, already filtered to the session's scopes) for
 * [prompt] within [budget]: every pinned item; then related ones, active
 * before 「待复核」, by level shares, then whatever room is left by score.
 */
export function planSnapshot(items: MemoryItem[], prompt: string, budget: number): SnapshotPlan {
	const pinned = items.filter((m) => m.pinned);
	const pinnedTokens = pinned.reduce((sum, m) => sum + lineCost(m), 0);
	const searchRoom = Math.floor(budget * SHARES.search);
	let room = Math.max(0, budget - pinnedTokens - searchRoom);
	const grams = trigrams(prompt);
	const scored = items
		.filter((m) => !m.pinned)
		.map((m) => {
			const base = taskRelevance(prompt, m.content, grams);
			const general = GENERAL_KINDS.includes(m.kind);
			return { m, relevant: base >= RELEVANT || general, score: base + (m.scope !== "global" ? 0.3 : 0) + (general ? 0.2 : 0) };
		});
	const leftOut: SnapshotPlan["leftOut"] = scored.filter((x) => !x.relevant).map((x) => ({ id: x.m.id, reason: "irrelevant" }));
	// Active first, then 「待复核」 (§6.2: considered last when the budget is tight); best score first; newer first.
	const queue = scored
		.filter((x) => x.relevant)
		.sort((a, b) => Number(a.m.status === "review") - Number(b.m.status === "review") || b.score - a.score || b.m.updatedAt - a.m.updatedAt)
		.map((x) => x.m);
	const picked = new Set<MemoryItem>();
	const related = room;
	// First pass: each level up to its share.
	for (const level of [1, 2, 3] as Level[]) {
		let share = Math.floor(related * LEVEL_SHARES[level]);
		for (const m of queue) {
			if (m.level !== level || picked.has(m)) continue;
			const cost = lineCost(m);
			if (cost > share || cost > room) continue;
			picked.add(m);
			share -= cost;
			room -= cost;
		}
	}
	// Second pass: what a level left goes to the rest, in queue order.
	for (const m of queue) {
		if (picked.has(m)) continue;
		const cost = lineCost(m);
		if (cost > room) continue;
		picked.add(m);
		room -= cost;
	}
	for (const m of queue) if (!picked.has(m)) leftOut.push({ id: m.id, reason: "budget" });
	const chosen = queue.filter((m) => picked.has(m));
	const tokens = pinnedTokens + chosen.reduce((sum, m) => sum + lineCost(m), 0);
	return { budget, tokens, pinned, related: chosen, leftOut, pinnedOver: pinnedTokens > Math.floor(budget * SHARES.pinned), searchRoom };
}
