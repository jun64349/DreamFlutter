import type { Db } from "../db.ts";
import { estimateTokens } from "./text.ts";

/**
 * Corrects the snapshot's token estimate with what the model actually
 * counted (docs/memory-design.md §6.1 「token 用模型实际的计数回校估算值」).
 *
 * A provider reports the input of a whole request: system prompt, tool
 * definitions and every message. Those first two are the same from one call
 * to the next in a session, so the growth of the reported input between two
 * calls, against the growth of our estimate of the messages, says how far
 * off the estimate is for this model. Kept per model as a moving average.
 */

const FLAG = "memory_token_scale:";
/** Too small a growth says nothing (rounding, a cache boundary). */
const MIN_GROWTH = 400;
const LIMITS = [0.5, 2.5] as const;
/** Weight of a new measurement in the moving average. */
const WEIGHT = 0.3;

interface Call {
	estimate: number;
	images: number;
	model?: string;
	actual?: number;
}

export class TokenCalibration {
	private readonly db: Db;
	private readonly now: () => number;
	/** Session id → the call being made (estimated before it, measured after). */
	private readonly pending = new Map<string, Call>();
	/** Session id → the last measured call. */
	private readonly last = new Map<string, Required<Call>>();

	constructor(db: Db, now: () => number) {
		this.db = db;
		this.now = now;
	}

	/** Before a model call: our estimate of the messages it sends. */
	beforeCall(sessionId: string, messages: readonly unknown[]): void {
		let estimate = 0;
		let images = 0;
		for (const message of messages) {
			const counted = countMessage(message);
			estimate += counted.tokens;
			images += counted.images;
		}
		this.pending.set(sessionId, { estimate, images });
	}

	/** After the call: what the model counted. Returns the new scale when this call was a usable measurement. */
	afterCall(sessionId: string, model: string, usage: { input?: number; cacheRead?: number; cacheWrite?: number } | undefined): number | undefined {
		const call = this.pending.get(sessionId);
		this.pending.delete(sessionId);
		if (!call || !usage) return undefined;
		const actual = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		if (actual <= 0) return undefined;
		const previous = this.last.get(sessionId);
		this.last.set(sessionId, { ...call, model, actual });
		// A new image, another model or a compaction in between: the two calls are not comparable.
		if (!previous || previous.model !== model || previous.images !== call.images) return undefined;
		const grew = call.estimate - previous.estimate;
		const counted = actual - previous.actual;
		if (grew < MIN_GROWTH || counted <= 0) return undefined;
		const ratio = Math.min(LIMITS[1], Math.max(LIMITS[0], counted / grew));
		const stored = this.stored(model);
		const scale = stored === undefined ? ratio : stored * (1 - WEIGHT) + ratio * WEIGHT;
		const at = this.now();
		this.db.run("INSERT OR REPLACE INTO app_flags(key, value, at) VALUES(?, ?, ?)", FLAG + model, String(scale), at);
		return scale;
	}

	/** Real tokens per estimated token for [model] (1 until measured). */
	scale(model: string | undefined): number {
		return (model && this.stored(model)) || 1;
	}

	private stored(model: string): number | undefined {
		const value = Number(this.db.get<{ value: string }>("SELECT value FROM app_flags WHERE key = ?", FLAG + model)?.value ?? NaN);
		return Number.isFinite(value) && value > 0 ? value : undefined;
	}
}

/** Our estimate of one message as the model sees it: text, tool calls and their results; images counted apart. */
function countMessage(message: unknown): { tokens: number; images: number } {
	const m = message as { content?: unknown };
	if (typeof m.content === "string") return { tokens: estimateTokens(m.content), images: 0 };
	if (!Array.isArray(m.content)) return { tokens: 0, images: 0 };
	let tokens = 0;
	let images = 0;
	for (const block of m.content as Record<string, unknown>[]) {
		switch (block?.type) {
			case "text":
				tokens += estimateTokens(String(block.text ?? ""));
				break;
			case "toolCall":
				tokens += estimateTokens(String(block.name ?? "") + JSON.stringify(block.arguments ?? {}));
				break;
			case "image":
				images++;
				break;
		}
	}
	return { tokens, images };
}
