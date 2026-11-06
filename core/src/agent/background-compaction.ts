import { createHash } from "node:crypto";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { buildSessionContext, estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Background compaction (roadmap 5.12, user decisions 2026-11-07): before a
 * session reaches its compaction point (85% of the threshold), a candidate
 * summary is written in the background while the task goes on; when the
 * session does compact, the candidate replaces the summary call if nothing it
 * rests on changed (the history it covers, the model, the instructions). At
 * most one candidate per session, kept in memory only (a restart drops it);
 * candidates not used are paid for all the same, on the main task's bill.
 */

/** What the core gives the harness for one session's compactions. */
export interface CompactionHooks {
	/** Pi's compaction settings after the session's own threshold (a percentage of the window). */
	settings?(model: { contextWindow: number; maxTokens: number } | undefined, base: { enabled: boolean; reserveTokens: number; keepRecentTokens: number }): { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
	background?: BackgroundCompaction;
	/** What a compaction did, for the comparison between normal and background compaction. */
	record?(entry: CompactionRecord): void;
	/** The user reported the last summary wrong and asked for a new one: their note, taken once. */
	takeRegenerate?(): { note: string } | undefined;
}

export interface BackgroundCompaction {
	enabled(): boolean;
	/** Share of the threshold at which a candidate is written (0.85). */
	lead(): number;
	/** The model that writes it: the session's own, or the auxiliary one (settings). */
	model(sessionModel: Model<never>): Promise<Model<never> | undefined>;
	/** The main task's daily / monthly budget is not spent. */
	allowed(): boolean;
	/** Bills the candidate to the session's task (used or not). */
	charge(usage: Usage, model: Model<never>): void;
}

export interface CompactionRecord {
	kind: "normal" | "manual" | "background" | "regenerate";
	/** done = a summary was made the normal way; used / dropped / made / failed = a background candidate. */
	outcome: "done" | "made" | "used" | "dropped" | "failed";
	reason?: string;
	waitMs?: number;
	tokensBefore?: number;
	tokensAfter?: number;
	cost?: number;
	model?: string;
}

export interface Candidate {
	/** The compaction the session's context starts from (or "start"): a new compaction makes the candidate useless. */
	cycle: string;
	/** First entry kept after the summary. */
	cutId: string;
	/** Fingerprint of the history the summary covers (every entry id up to the cut). */
	prefix: string;
	/** Fingerprint of the system prompt (instructions, rules, mode). */
	instructions: string;
	/** provider/id of the session's model. */
	model: string;
	summary: string;
	/** Estimated tokens of what the summary replaces. */
	covered: number;
	cost: number;
	writer: string;
}

export function fingerprint(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

/** The compaction the context currently starts from, or "start". */
export function compactionCycle(branch: readonly SessionEntry[]): string {
	for (let i = branch.length - 1; i >= 0; i--) if (branch[i]!.type === "compaction") return branch[i]!.id;
	return "start";
}

/**
 * Where a candidate cuts the history: keep at least [keepRecent] tokens of
 * the newest messages, cut before a user or assistant message (never between
 * a tool call and its result), and only inside the part of the history the
 * context holds now (after the last compaction's kept tail starts).
 */
export function chooseCut(branch: readonly SessionEntry[], keepRecent: number): number | undefined {
	let start = 0;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type === "compaction") {
			const kept = branch.findIndex((e) => e.id === (entry as { firstKeptEntryId?: string }).firstKeptEntryId);
			start = kept >= 0 ? kept : i + 1;
			break;
		}
	}
	let kept = 0;
	let index = branch.length;
	for (let i = branch.length - 1; i > start; i--) {
		const entry = branch[i]!;
		if (entry.type === "message") kept += estimateTokens((entry as unknown as { message: never }).message);
		if (kept >= keepRecent) {
			index = i;
			break;
		}
	}
	if (index >= branch.length) return undefined;
	for (let i = index; i > start; i--) {
		const entry = branch[i]!;
		const role = entry.type === "message" ? (entry as { message: { role?: string } }).message.role : undefined;
		if (role === "user" || role === "assistant") return i;
	}
	return undefined;
}

/** The messages a candidate cut at [cut] summarizes: the context as it would be just before the cut (the previous summary included). */
export function messagesBefore(branch: readonly SessionEntry[], cut: number): unknown[] {
	const prefix = branch.slice(0, cut) as SessionEntry[];
	if (!prefix.length) return [];
	return buildSessionContext(prefix, prefix[prefix.length - 1]!.id).messages;
}

export function prefixFingerprint(branch: readonly SessionEntry[], cut: number): string {
	return fingerprint(branch.slice(0, cut).map((e) => e.id).join(","));
}

export function estimateAll(messages: readonly unknown[]): number {
	let sum = 0;
	for (const m of messages) sum += estimateTokens(m as never);
	return sum;
}

/**
 * Whether [candidate] can stand in for the summary of this compaction, and
 * if not, why (16.3: compare, then commit; out of date = dropped).
 */
export function candidateProblem(candidate: Candidate, now: { branch: readonly SessionEntry[]; instructions: string; model: string; tokensBefore: number; threshold: number }): string | undefined {
	if (compactionCycle(now.branch) !== candidate.cycle) return "compacted_since";
	const cut = now.branch.findIndex((e) => e.id === candidate.cutId);
	if (cut < 0 || prefixFingerprint(now.branch, cut) !== candidate.prefix) return "history_changed";
	if (now.model !== candidate.model) return "model_changed";
	if (now.instructions !== candidate.instructions) return "instructions_changed";
	const after = now.tokensBefore - candidate.covered + estimateTokens({ role: "user", content: candidate.summary, timestamp: 0 } as never);
	if (after >= now.threshold) return "too_small";
	return undefined;
}
