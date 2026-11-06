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

/** blocked = failed the safety check when loaded (17.2 item 3). */
export type LeftOutReason = "budget" | "irrelevant" | "blocked";

/**
 * A snapshot material (§2.2, §6.2): a short text the memory agent wrote in
 * advance for several related items of one partition. Only fresh ones are
 * handed in (every item still at the version it was written from).
 */
export interface Material {
	id: string;
	scopeKey: string;
	text: string;
	items: MemoryItem[];
}

export interface SnapshotPlan {
	budget: number;
	/** Estimated tokens of what was picked (with the margin). */
	tokens: number;
	pinned: MemoryItem[];
	/** Every related item picked, whether shown on its own or through a material. */
	related: MemoryItem[];
	/** Materials picked: their text stands for their items. */
	materials: Material[];
	/** Live items in scope that did not make it, and why (17.8 「为什么没想起来」). */
	leftOut: { id: string; reason: LeftOutReason }[];
	/** Pinned items take more than their share: the user is asked to trim them (never cut, §6.1). */
	pinnedOver: boolean;
	/** Tokens memory_search may add this task. */
	searchRoom: number;
	/** Items kept out because they failed the safety check (the snapshot says how many). */
	blocked?: string[];
}

/**
 * Tokens one snapshot line costs, margin included. [scale] = real tokens per
 * estimated token for the model in use (measured, calibrate.ts).
 */
export function lineCost(item: Pick<MemoryItem, "content">, scale = 1): number {
	return Math.ceil((estimateTokens(item.content) + 8) * scale * MARGIN);
}

/** Tokens a material's line costs, margin included. */
export function materialCost(material: Pick<Material, "text">, scale = 1): number {
	return Math.ceil((estimateTokens(material.text) + 8) * scale * MARGIN);
}

/** What the snapshot picks from: one item, or a material standing for several. */
interface Unit {
	items: MemoryItem[];
	material?: Material;
	level: Level;
	cost: number;
	relevant: boolean;
	review: boolean;
	score: number;
	updatedAt: number;
}

/**
 * Picks from [items] (live, already filtered to the session's scopes) for
 * [prompt] within [budget]: every pinned item; then related ones, active
 * before 「待复核」, by level shares, then whatever room is left by score.
 * A fresh material whose items are all here stands in for them (its text is
 * shorter than their lines, §6.2 「先用新鲜的素材」).
 */
export function planSnapshot(items: MemoryItem[], prompt: string, budget: number, materials: Material[] = [], scale = 1): SnapshotPlan {
	const pinned = items.filter((m) => m.pinned);
	const pinnedTokens = pinned.reduce((sum, m) => sum + lineCost(m, scale), 0);
	const searchRoom = Math.floor(budget * SHARES.search);
	let room = Math.max(0, budget - pinnedTokens - searchRoom);
	const grams = trigrams(prompt);
	const here = new Map(items.filter((m) => !m.pinned).map((m) => [m.id, m]));
	const covered = new Set<string>();
	const units: Unit[] = [];
	for (const material of materials) {
		const own = material.items.map((m) => here.get(m.id));
		if (!own.length || own.some((m) => !m || covered.has(m.id) || m.version !== material.items.find((x) => x.id === m.id)!.version)) continue;
		const list = own as MemoryItem[];
		for (const m of list) covered.add(m.id);
		const base = taskRelevance(prompt, material.text, grams);
		const general = list.some((m) => GENERAL_KINDS.includes(m.kind));
		units.push({
			items: list,
			material,
			level: Math.max(...list.map((m) => m.level)) as Level,
			cost: materialCost(material, scale),
			relevant: base >= RELEVANT || general,
			review: false,
			score: base + (list.some((m) => m.scope !== "global") ? 0.3 : 0) + (general ? 0.2 : 0),
			updatedAt: Math.max(...list.map((m) => m.updatedAt)),
		});
	}
	for (const m of here.values()) {
		if (covered.has(m.id)) continue;
		const base = taskRelevance(prompt, m.content, grams);
		const general = GENERAL_KINDS.includes(m.kind);
		units.push({ items: [m], level: m.level, cost: lineCost(m, scale), relevant: base >= RELEVANT || general, review: m.status === "review", score: base + (m.scope !== "global" ? 0.3 : 0) + (general ? 0.2 : 0), updatedAt: m.updatedAt });
	}
	const leftOut: SnapshotPlan["leftOut"] = units.filter((u) => !u.relevant).flatMap((u) => u.items.map((m) => ({ id: m.id, reason: "irrelevant" as const })));
	// Active first, then 「待复核」 (§6.2: considered last when the budget is tight); best score first; newer first.
	const queue = units.filter((u) => u.relevant).sort((a, b) => Number(a.review) - Number(b.review) || b.score - a.score || b.updatedAt - a.updatedAt);
	const picked = new Set<Unit>();
	const related = room;
	// First pass: each level up to its share.
	for (const level of [1, 2, 3] as Level[]) {
		let share = Math.floor(related * LEVEL_SHARES[level]);
		for (const u of queue) {
			if (u.level !== level || picked.has(u)) continue;
			if (u.cost > share || u.cost > room) continue;
			picked.add(u);
			share -= u.cost;
			room -= u.cost;
		}
	}
	// Second pass: what a level left goes to the rest, in queue order.
	for (const u of queue) {
		if (picked.has(u) || u.cost > room) continue;
		picked.add(u);
		room -= u.cost;
	}
	for (const u of queue) if (!picked.has(u)) for (const m of u.items) leftOut.push({ id: m.id, reason: "budget" });
	const chosen = queue.filter((u) => picked.has(u));
	const tokens = pinnedTokens + chosen.reduce((sum, u) => sum + u.cost, 0);
	return {
		budget,
		tokens,
		pinned,
		related: chosen.flatMap((u) => u.items),
		materials: chosen.flatMap((u) => (u.material ? [u.material] : [])),
		leftOut,
		pinnedOver: pinnedTokens > Math.floor(budget * SHARES.pinned),
		searchRoom,
	};
}
