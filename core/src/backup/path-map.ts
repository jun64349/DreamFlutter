import { join, resolve, sep } from "node:path";

/** One rewrite: paths at or under [from] move under [to]. */
export interface PathRule {
	from: string;
	to: string;
}

/**
 * Rewrites absolute paths from the machine a backup was made on to this one.
 * Prefix rules apply at path boundaries, case-insensitively (Windows paths);
 * the longest prefix wins. Exact rules (session files, whose folder name
 * encodes their workspace) are checked first.
 */
export class PathMap {
	private readonly prefixes: PathRule[];
	private readonly exact = new Map<string, string>();

	constructor(rules: PathRule[] = [], exact: PathRule[] = []) {
		this.prefixes = rules
			.filter((r) => r.from && r.to && !samePath(r.from, r.to))
			.map((r) => ({ from: trimSep(r.from), to: trimSep(r.to) }))
			.sort((a, b) => b.from.length - a.from.length);
		for (const rule of exact) if (!samePath(rule.from, rule.to)) this.exact.set(key(rule.from), rule.to);
	}

	get empty(): boolean {
		return this.prefixes.length === 0 && this.exact.size === 0;
	}

	/** [path] on this machine; unchanged when no rule covers it. */
	map(path: string): string {
		const hit = this.exact.get(key(path));
		if (hit !== undefined) return hit;
		const lower = path.toLowerCase();
		for (const rule of this.prefixes) {
			const from = rule.from.toLowerCase();
			if (!lower.startsWith(from)) continue;
			const rest = path.slice(rule.from.length);
			if (rest !== "" && rest[0] !== "\\" && rest[0] !== "/") continue;
			return rule.to + rest;
		}
		return path;
	}

	/** Like map, for values stored lowercased and resolved (normalizeCwd keys). */
	mapKey(value: string): string {
		return this.map(value).toLowerCase();
	}

	/** Maps every string in a JSON value that is a path a rule covers. */
	mapJson(value: unknown): unknown {
		if (typeof value === "string") return this.map(value);
		if (Array.isArray(value)) return value.map((v) => this.mapJson(v));
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.mapJson(v)]));
		return value;
	}
}

function trimSep(path: string): string {
	return path.length > 3 ? path.replace(/[\\/]+$/, "") : path;
}

function key(path: string): string {
	return resolve(path).toLowerCase();
}

function samePath(a: string, b: string): boolean {
	return key(a) === key(b);
}

/** The folder Pi keeps [cwd]'s sessions in (Pi's getDefaultSessionDirPath, kept in step with it). */
export function piSessionFolder(sessionsDir: string, cwd: string): string {
	const resolved = resolve(cwd);
	return join(sessionsDir, `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

/** True when [child] is [parent] or inside it. */
export function isInside(parent: string, child: string): boolean {
	const p = key(parent);
	const c = key(child);
	return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}
