import { pinyin } from "pinyin-pro";
import type { Core } from "../../core.ts";

const fixed = ["蝶君", "梦蝶", "DreamFlutter"];
const hanWord = /^\p{Script=Han}{2,8}$/u;
const englishWord = /^[a-z][a-z0-9-]{1,19}(?: [a-z0-9-]+)?$/i;

export function memoryHotwords(core: Core, workspaceId?: string): string[] {
	if (!core.settings.get().memoryEnabled) return fixed.slice();
	const rows = core.db.all<{ content: string }>(`
		SELECT content FROM memory_items WHERE status = 'active'
		  AND (valid_until IS NULL OR valid_until > ?)
		  AND (valid_from IS NULL OR valid_from <= ?)
		  AND (scope = 'global' OR (scope = 'workspace' AND workspace_id = ?))
		ORDER BY use_count DESC, updated_at DESC, id LIMIT 200
	`, Date.now(), Date.now(), workspaceId ?? null);
	const words = new Set(fixed);
	for (const { content } of rows) {
		const phrases = content.matchAll(/(?:「([^」]+)」|『([^』]+)』|“([^”]+)”|(?:人名|姓名|项目名|术语)\s*[：:]\s*([^\s，。；、]+))/gu);
		for (const match of phrases) {
			const word = match.slice(1).find(Boolean)?.trim() ?? "";
			if (word.length <= 24 && (hanWord.test(word) || englishWord.test(word))) words.add(word);
			if (words.size >= 64) return [...words];
		}
	}
	return [...words];
}

function sounds(text: string): string[] {
	return pinyin(text, { toneType: "num", type: "array" });
}

const near = new Set(["z:zh", "c:ch", "s:sh", "l:n", "an:ang", "en:eng", "in:ing", "ian:iang"]);
function difference(a: string, b: string): number {
	if (a === b) return 0;
	const parts = (s: string) => /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?(.+?)([1-5])?$/.exec(s);
	const x = parts(a);
	const y = parts(b);
	if (!x || !y) return 1;
	let cost = x[3] === y[3] ? 0 : 0.12;
	for (const i of [1, 2]) {
		if (x[i] !== y[i]) cost += near.has([x[i], y[i]].sort().join(":")) ? 0.32 : 1;
	}
	return cost;
}

export function correctHotwords(text: string, terms: readonly string[]): string {
	const dictionary = terms.filter(word => hanWord.test(word)).map(word => ({ word, phonemes: sounds(word) }));
	let corrected = text.replace(/\p{Script=Han}+/gu, run => {
		const chars = [...run];
		const phonemes = sounds(run);
		let result = "";
		for (let offset = 0; offset < chars.length;) {
			let best: { word: string; length: number; score: number } | undefined;
			let tied = false;
			for (const term of dictionary) {
				const length = term.phonemes.length;
				if (length > chars.length - offset) continue;
				const source = chars.slice(offset, offset + length).join("");
				const score = source === term.word ? -1 :
					term.phonemes.reduce((sum, value, i) => sum + difference(phonemes[offset + i] ?? "", value), 0);
				// One near phoneme for a long term, tone differences only for two-character names.
				if (score > (length === 2 ? 0.24 : 0.45)) continue;
				if (!best || score < best.score || score === best.score && length > best.length) {
					best = { word: term.word, length, score };
					tied = false;
				} else if (score === best.score && length === best.length && term.word !== best.word) tied = true;
			}
			result += best && !tied ? best.word : chars[offset];
			offset += best && !tied ? best.length : 1;
		}
		return result;
	});
	if (terms.includes("DreamFlutter")) corrected = corrected.replace(/\bdream[ -]?flutter\b/gi, "DreamFlutter");
	return corrected;
}

