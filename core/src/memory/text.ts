/** Text helpers for memory: similarity without a model (works for Chinese and English alike). */

/** Character trigrams (lower-cased, whitespace-collapsed). */
export function trigrams(text: string): Set<string> {
	const clean = text.toLowerCase().replace(/\s+/g, " ").trim();
	const out = new Set<string>();
	for (let i = 0; i + 3 <= clean.length; i++) out.add(clean.slice(i, i + 3));
	if (clean.length > 0 && clean.length < 3) out.add(clean);
	return out;
}

/** Relevance of [memory] to [query] by shared trigrams, normalized by memory length. */
export function relevance(query: Set<string>, memory: string): number {
	const grams = trigrams(memory);
	if (grams.size === 0) return 0;
	let shared = 0;
	for (const g of grams) if (query.has(g)) shared++;
	return shared / Math.sqrt(grams.size);
}

const bare = (text: string) => text.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
const wordGrams = (text: string) => trigrams(bare(text));

/** How much of the shorter of two memories the longer one repeats (shared trigrams / the shorter's trigrams). */
export function overlap(a: string, b: string): number {
	const ga = wordGrams(a);
	const gb = wordGrams(b);
	const [small, large] = ga.size <= gb.size ? [ga, gb] : [gb, ga];
	if (small.size < 4) return bare(a) === bare(b) ? 1 : 0;
	let shared = 0;
	for (const g of small) if (large.has(g)) shared++;
	return shared / small.size;
}

/** Whether [a] says something [b] does not (a few words more, not just punctuation). */
export function saysMore(a: string, b: string): boolean {
	const gb = wordGrams(b);
	let extra = 0;
	for (const g of wordGrams(a)) if (!gb.has(g)) extra++;
	return extra >= 3;
}

/**
 * The memory among [among] that [content] mostly repeats, if any. v0.3.2 test:
 * 「回复要简练，少说话」 and 「回复要简练，别长篇大论；……」 were both added from one
 * conversation, because only identical text counted as a repeat.
 */
export function nearDuplicate<T extends { content: string }>(content: string, among: T[]): T | undefined {
	let best: { memory: T; score: number } | undefined;
	for (const memory of among) {
		const score = overlap(content, memory.content);
		if (score >= 0.5 && (!best || score > best.score)) best = { memory, score };
	}
	return best?.memory;
}

/** Rough token estimate: CJK characters ~1 token each, other text ~4 characters per token. */
export function estimateTokens(text: string): number {
	const cjk = (text.match(/[　-鿿＀-￯]/g) ?? []).length;
	return cjk + Math.ceil((text.length - cjk) / 4);
}
