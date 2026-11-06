import { basename } from "node:path";
import type { MemoryStore } from "./store.ts";
import { localDay } from "./store.ts";
import type { ScopeSet } from "./scopes.ts";
import { LIVE_STATUSES, type Confidence, type Level, type MemoryItem, type MemoryOp, type MemorySource } from "./types.ts";

/**
 * What the program decides about a memory's life on its own, without a model
 * (docs/memory-design.md §3, 17.3–17.6): whether a level change is allowed,
 * validity running out, counter-evidence from tools, and the cheap check for
 * contradictions that decides whether the memory agent is asked at all.
 */

export const DAY = 86_400_000;
/** 17.3: a judgment about a tool, the environment or an outside service holds 30 days unless it says otherwise (用户 2026-11-06). */
export const TOOL_VALIDITY_DAYS = 30;

// ---- levels (§3, §12 item 3) -------------------------------------------------------------

const USER_BACKED: readonly Confidence[] = ["user_explicit", "user_confirmed", "user_reported", "verified"];

/** Distinct places an item was seen: sessions, tasks, runs, tool results, the user's own edits. Repeats from one session count once. */
export function independentSources(sources: readonly MemorySource[]): number {
	const keys = new Set<string>();
	for (const s of sources) {
		if (s.kind === "migration") continue;
		keys.add(s.kind === "user_edit" ? "user_edit" : `${s.kind}:${s.ref ?? ""}`);
	}
	return keys.size;
}

/**
 * Why [item] may not move to level [to] (undefined = it may). Raising a level
 * rests on evidence, not age: days only say when to look again (§12 item 3,
 * 纪要 §7). Lowering is always allowed (it is recorded like any change).
 */
export function promotionBlock(item: MemoryItem, to: Level, sources: readonly MemorySource[], now: number): string | undefined {
	if (to <= item.level) return undefined;
	if (to - item.level > 1) return "一次只能升一级";
	const days = (now - item.createdAt) / DAY;
	const independent = independentSources(sources);
	if (to === 2) {
		if (days < 7) return `一级升二级要存在满 7 天（现在 ${Math.floor(days)} 天）`;
		const userBacked = item.confidence === "user_explicit" || item.confidence === "user_confirmed";
		if (independent < 2 && item.kind !== "decision" && !userBacked) return "一级升二级要来自至少 2 个不同的会话，或者是一条明确的决定、用户确认过的内容";
		return undefined;
	}
	if (days < 30) return `二级升三级要存在满 30 天（现在 ${Math.floor(days)} 天）`;
	if (independent < 2) return "二级升三级要跨至少 2 个任务或会话";
	if (!USER_BACKED.includes(item.confidence) || item.confidence === "user_reported") return "二级升三级要用户明说、确认过，或被工具 / 任务结果验证过";
	if (!item.conditions?.trim()) return "二级升三级要写明适用条件";
	return undefined;
}

/** Items of [items] that could move up a level now (shown to the memory agent in its reviews). */
export function promotable(store: MemoryStore, items: readonly MemoryItem[], now: number): Set<string> {
	const out = new Set<string>();
	for (const m of items) {
		if (m.level === 3 || m.status !== "active" || m.retention === "locked") continue;
		if (!promotionBlock(m, (m.level + 1) as Level, store.sources(m.id), now)) out.add(m.id);
	}
	return out;
}

// ---- validity (17.3) ---------------------------------------------------------------------

/**
 * Items whose validity ran out: ended and out of snapshots (kept, can be
 * restored). Locked, level-3 and 「不要自动处理」 items are only marked for
 * review, once per expiry (17.3: 「锁定的、三级的不自动到期，到期只标待复核」).
 */
export function expire(store: MemoryStore, now: number): { ended: string[]; review: string[]; batchId: string | null } {
	const due = store.list({ statuses: LIVE_STATUSES }).filter((m) => m.validUntil !== null && m.validUntil <= now);
	const ops: MemoryOp[] = [];
	const review: string[] = [];
	for (const m of due) {
		const until = localDay(m.validUntil!);
		// Handled once: an item the user restored or kept after it ran out stays as they left it.
		if (store.expiredBefore(m.id, m.validUntil!)) continue;
		if (m.retention === "locked" || m.level === 3 || !m.autoOk) {
			if (m.status === "review") continue;
			ops.push({ kind: "status", id: m.id, baseVersion: m.version, status: "review", reason: `有效期到了（${until}），这条受保护，等你复核` });
			review.push(m.id);
		} else {
			ops.push({ kind: "status", id: m.id, baseVersion: m.version, status: "ended", reason: `有效期到了（${until}）` });
		}
	}
	if (!ops.length) return { ended: [], review: [], batchId: null };
	const result = store.commit({ actor: "system", ops, batchKind: "expire", reason: "有效期到了" });
	const applied = new Set(result.applied.map((a) => a.itemId));
	return { ended: due.filter((m) => applied.has(m.id) && !review.includes(m.id)).map((m) => m.id), review: review.filter((id) => applied.has(id)), batchId: result.batchId };
}

/** The validity a judgment about tools or the environment gets when nobody gave one (17.3). */
export function defaultValidity(kind: MemoryItem["kind"], at: number): number | null {
	return kind === "observation" ? at + TOOL_VALIDITY_DAYS * DAY : null;
}

// ---- counter-evidence from tools (17.3) ----------------------------------------------------

/** 「某工具用不了」 kinds of statement: what a successful run of that tool disproves. Plain 「失败」 is left out (a lesson on how to avoid a failure is not refuted by success). */
const UNAVAILABLE =
	/用不了|不能用|无法使用|不可用|用不上|没有安装|没装|未安装|装不上|找不到(这个)?命令|运行不了|跑不起来|打不开|连不上|访问不了|不能访问|无法访问|无法连接|需要代理|要代理|要翻墙|not (available|installed|found|reachable|accessible)|unavailable|does(n'| no)t work|can(no|')t (be )?(run|use|used|access|reach|open)|command not found|blocked/i;

export function unavailableClaim(content: string): boolean {
	return UNAVAILABLE.test(content);
}

const SHELLS = new Set(["pwsh", "bash", "powershell", "shell"]);
/** Launchers whose next word is the program that actually ran. */
const LAUNCHERS = new Set(["npx", "uvx", "pipx", "uv", "pnpm", "yarn", "sudo", "env", "call", "start", "&"]);
const NOT_PROGRAMS = new Set(["cd", "echo", "set", "export", "if", "then", "else", "fi", "for", "do", "done", "true", "false", "exit", "write-host", "write-output", "set-location", "get-childitem", "ls", "dir", "cat", "type"]);

/**
 * What a successful tool call shows works: the tool itself, the programs a
 * shell command started, the host a fetched address is on.
 */
export function toolIdentifiers(toolName: string, args: unknown): string[] {
	const out = new Set<string>();
	if (!SHELLS.has(toolName)) out.add(toolName.toLowerCase());
	const a = (args ?? {}) as Record<string, unknown>;
	if (SHELLS.has(toolName) && typeof a.command === "string") {
		// Only what the exit status speaks for: the last statement, each part of an && chain, the head of a pipe
		// (`a; b` and `a | b` succeed when b does, whatever a did).
		const statement = a.command.split(/[;\n]/).map((s) => s.trim()).filter(Boolean).at(-1) ?? "";
		for (const part of statement.split("&&")) {
			const segment = part.split(/\|\||\|/)[0] ?? "";
			const words = segment.trim().replace(/^[&.]\s*/, "").split(/\s+/).filter(Boolean);
			let i = 0;
			while (i < words.length && (LAUNCHERS.has(words[i]!.toLowerCase()) || /^\w+=/.test(words[i]!) || words[i] === "run" || words[i] === "dlx" || words[i] === "exec")) i++;
			const word = words[i]?.replace(/^["']|["']$/g, "");
			if (!word) continue;
			const program = basename(word.replaceAll("\\", "/")).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
			if (program.length >= 2 && !NOT_PROGRAMS.has(program) && /^[\w.+-]+$/.test(program)) out.add(program);
		}
	}
	for (const key of ["url", "uri", "href"]) {
		const value = a[key];
		if (typeof value !== "string") continue;
		try {
			const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
			if (host) out.add(host);
		} catch {
			// not an address
		}
	}
	return [...out];
}

/**
 * Whether a tool call that did not report an error still failed: our shells
 * report a non-zero exit as `[exit code: N]` in the output, and a missing
 * program prints its own message.
 */
export function failedOutput(text: string): boolean {
	return /\[exit code: [1-9]\d*\]|not recognized as|command not found|no such file or directory|无法将.{0,40}识别为|不是内部或外部命令/i.test(text);
}

/** The text of a tool result (content blocks or a plain string). */
export function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	const content = (result as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return "";
	return content.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : "")).join("\n");
}

/** Whether [content] names [identifier] (as a word, not inside a longer one). */
export function mentions(content: string, identifier: string): boolean {
	const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^a-z0-9_.-])${escaped}($|[^a-z0-9_-])`, "i").test(content);
}

/** Live observations in [set] that a successful run of [identifiers] disproves. */
export function refutedBy(store: MemoryStore, set: ScopeSet, identifiers: readonly string[]): MemoryItem[] {
	if (!identifiers.length) return [];
	return store.list({ set }).filter((m) => m.kind === "observation" && unavailableClaim(m.content) && identifiers.some((id) => mentions(m.content, id)));
}

// ---- the contradiction prefilter (17.6) ------------------------------------------------------

/** Words in nearly every memory: they say nothing about what it is about. */
const COMMON = new Set(["用户", "希望", "喜欢", "需要", "使用", "可以", "一个", "这个", "时候", "因为", "所以", "the", "user", "and", "for", "with", "use", "uses", "prefers"]);
const NEGATION = /不|没|别|无|非|勿|未|否|禁止|停止|取消|改掉|不再|\b(not|no|never|don't|doesn't|stop|avoid|without)\b/i;
const NUMBER = /\d+(?:\.\d+)?|[零一二两三四五六七八九十百千万]+/g;

/** What a memory is about: English words and CJK word pairs, minus numbers, negations and filler. */
function subject(text: string): Set<string> {
	const out = new Set<string>();
	const lower = text.toLowerCase();
	for (const w of lower.match(/[a-z][a-z0-9_.+-]+/g) ?? []) if (!COMMON.has(w) && !/^(not|no|never|don't|doesn't)$/.test(w)) out.add(w);
	for (const run of lower.replace(NUMBER, " ").match(/[㐀-鿿]+/g) ?? []) {
		const clean = run.replace(/不|没|别|勿|未/g, " ").split(" ");
		for (const part of clean) for (let i = 0; i + 2 <= part.length; i++) if (!COMMON.has(part.slice(i, i + 2))) out.add(part.slice(i, i + 2));
	}
	return out;
}

const DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 「十二」 and 「12」 are the same number; larger Chinese numbers are compared as written. */
function normalizeNumber(raw: string): string {
	if (/^\d/.test(raw)) return String(Number(raw));
	if (raw.length === 1 && raw in DIGITS) return String(DIGITS[raw]);
	const m = raw.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
	if (m) return String((m[1] ? DIGITS[m[1]]! : 1) * 10 + (m[2] ? DIGITS[m[2]]! : 0));
	return raw;
}

function numbers(text: string): Set<string> {
	return new Set((text.match(NUMBER) ?? []).map(normalizeNumber));
}

/**
 * How likely [a] and [b] say opposite things about the same matter: 0 when
 * they are about different things or simply agree; above 0 (higher = more
 * likely) when they share their subject but one negates what the other says,
 * or their numbers and dates differ. 「用中文回复」 and 「不要用中文回复」 look
 * nearly the same and mean the opposite.
 */
export function conflictScore(a: string, b: string): number {
	const sa = subject(a);
	const sb = subject(b);
	const small = Math.min(sa.size, sb.size);
	if (small === 0) return 0;
	let shared = 0;
	for (const w of sa) if (sb.has(w)) shared++;
	const same = shared / small;
	if (same < 0.5) return 0;
	const negation = NEGATION.test(a) !== NEGATION.test(b);
	const na = numbers(a);
	const nb = numbers(b);
	const numberDiff = na.size > 0 && nb.size > 0 && ![...na].some((n) => nb.has(n));
	if (!negation && !numberDiff) return 0;
	return same + (negation ? 0.5 : 0) + (numberDiff ? 0.4 : 0);
}

/** Items of [among] that [text] may contradict, most likely first. */
export function possibleConflicts<T extends { id: string; content: string }>(text: string, among: readonly T[], min = 0.5): T[] {
	return among
		.map((m) => ({ m, score: conflictScore(text, m.content) }))
		.filter((x) => x.score >= min)
		.sort((a, b) => b.score - a.score)
		.map((x) => x.m);
}

/** Sentences of [text] worth comparing with memories (a correction is usually one sentence). */
export function sentences(text: string): string[] {
	return text
		.split(/[。！？!?\n；;]+|(?<=[a-z])\.\s/i)
		.map((s) => s.trim())
		.filter((s) => s.length >= 4);
}

// ---- review calendar (§12 item 1) ----------------------------------------------------------

/** The latest Monday 03:00 (local) at or before [at]. */
export function lastMonday3am(at: number): number {
	const d = new Date(at);
	d.setHours(3, 0, 0, 0);
	const back = (d.getDay() + 6) % 7; // days since Monday
	d.setDate(d.getDate() - back);
	if (d.getTime() > at) d.setDate(d.getDate() - 7);
	return d.getTime();
}

/** The latest first day of a month (every [months] months from January) at 03:00 local, at or before [at]. */
export function lastMonthStart3am(at: number, months: 1 | 3 | 12 = 1): number {
	const d = new Date(at);
	let month = d.getMonth() - (d.getMonth() % months);
	let year = d.getFullYear();
	let start = new Date(year, month, 1, 3, 0, 0, 0).getTime();
	if (start > at) {
		month -= months;
		if (month < 0) {
			month += 12;
			year -= 1;
		}
		start = new Date(year, month, 1, 3, 0, 0, 0).getTime();
	}
	return start;
}

export type Period = "week" | "month" | "quarter" | "year";

/** When each level's reviews fall due (§3, §12 item 1), largest first: one due review covers the smaller ones that fall on the same day. */
export const CALENDAR: Record<Level, { period: Period; light: boolean }[]> = {
	1: [{ period: "week", light: false }],
	2: [
		{ period: "quarter", light: false },
		{ period: "month", light: false },
		{ period: "week", light: true },
	],
	3: [
		{ period: "year", light: false },
		{ period: "quarter", light: false },
		{ period: "month", light: true },
	],
};

export function periodStart(period: Period, at: number): number {
	switch (period) {
		case "week":
			return lastMonday3am(at);
		case "month":
			return lastMonthStart3am(at, 1);
		case "quarter":
			return lastMonthStart3am(at, 3);
		case "year":
			return lastMonthStart3am(at, 12);
	}
}

export const PERIOD_LABEL: Record<Period, string> = { week: "每周", month: "每月", quarter: "每季", year: "每年" };
