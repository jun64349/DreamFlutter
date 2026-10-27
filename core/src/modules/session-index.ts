import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Core, CoreModule } from "../core.ts";
import { normalizeCwd, requireStr, samePath, str } from "../core.ts";
import type { Db } from "../db.ts";
import { textOf } from "../runs.ts";

export interface SessionRow {
	path: string;
	cwd: string | null;
	sessionId: string | null;
	parentSession: string | null;
	title: string;
	name: string | null;
	createdAt: number | null;
	modifiedAt: number | null;
	messageCount: number;
	pinned: boolean;
	archived: boolean;
}

export interface SearchHit {
	path: string;
	cwd: string | null;
	title: string;
	entryId: string;
	role: string;
	snippet: string;
	modifiedAt: number | null;
}

interface MetaRow {
	path: string;
	cwd: string | null;
	session_id: string | null;
	parent_session: string | null;
	name: string | null;
	first_message: string | null;
	created_at: number | null;
	modified_at: number | null;
	message_count: number;
	pinned: number;
	archived: number;
}

const MAX_TEXT_PER_ENTRY = 20_000;

/**
 * Keeps an index of Pi's session files: metadata (title, workspace, pin and
 * archive flags the core adds), full-text search over messages on every
 * branch, and per-response token usage and cost. Files are re-parsed when
 * their size or mtime changes; Pi's JSONL stays the source of truth.
 */
export class SessionIndex implements CoreModule {
	private readonly core: Core;
	private readonly db: Db;
	private timer: NodeJS.Timeout | undefined;
	private scanning: Promise<number> | undefined;

	constructor(core: Core) {
		this.core = core;
		this.db = core.db;
		this.register();
	}

	get sessionsDir(): string {
		return this.core.sessionDir ?? join(this.core.agentDir, "sessions");
	}

	start(): void {
		void this.refresh();
		this.timer = setInterval(() => void this.refresh(), 60_000);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
	}

	onRunFinished(): void {
		void this.refresh();
	}

	/** Re-indexes changed files; returns how many were (re)parsed. */
	refresh(): Promise<number> {
		this.scanning ??= Promise.resolve()
			.then(() => this.scan())
			.finally(() => {
				this.scanning = undefined;
			});
		return this.scanning;
	}

	private scan(): number {
		const files = listJsonl(this.sessionsDir);
		const known = new Map(
			this.db.all<{ path: string; indexed_mtime: number; indexed_size: number }>("SELECT path, indexed_mtime, indexed_size FROM session_meta").map((r) => [r.path, r]),
		);
		let changed = 0;
		for (const file of files) {
			let stat;
			try {
				stat = statSync(file);
			} catch {
				continue;
			}
			const row = known.get(file);
			known.delete(file);
			if (row && row.indexed_mtime === Math.floor(stat.mtimeMs) && row.indexed_size === stat.size) continue;
			try {
				this.indexFile(file, Math.floor(stat.mtimeMs), stat.size);
				changed++;
			} catch (error) {
				this.core.log.warn(`could not index ${file}`, error);
			}
		}
		// Files that disappeared (deleted to the Recycle Bin, moved).
		for (const path of known.keys()) this.forget(path);
		return changed;
	}

	private forget(path: string): void {
		this.db.transaction(() => {
			this.db.run("DELETE FROM session_meta WHERE path = ?", path);
			this.db.run("DELETE FROM session_fts WHERE path = ?", path);
			this.db.run("DELETE FROM usage_records WHERE path = ?", path);
		});
	}

	indexFile(path: string, mtime: number, size: number): void {
		const lines = readFileSync(path, "utf8").split("\n");
		let cwd: string | null = null;
		let sessionId: string | null = null;
		let parent: string | null = null;
		let createdAt: number | null = null;
		let name: string | null = null;
		let firstMessage: string | null = null;
		let messageCount = 0;
		const texts: { entryId: string; role: string; text: string }[] = [];
		const usage: { entryId: string; at: number; provider: string | null; model: string | null; u: Record<string, unknown> }[] = [];

		for (const line of lines) {
			if (!line.trim()) continue;
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			switch (entry.type) {
				case "session":
					cwd = typeof entry.cwd === "string" ? entry.cwd : null;
					sessionId = typeof entry.id === "string" ? entry.id : null;
					parent = typeof entry.parentSession === "string" ? entry.parentSession : null;
					createdAt = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : null;
					break;
				case "session_info":
					name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : name;
					break;
				case "message": {
					const message = (entry.message ?? {}) as Record<string, unknown>;
					const role = String(message.role ?? "");
					const entryId = String(entry.id ?? "");
					if (role === "user" || role === "assistant") {
						messageCount++;
						const text = textOf(message.content);
						if (text) {
							texts.push({ entryId, role, text: text.slice(0, MAX_TEXT_PER_ENTRY) });
							if (role === "user" && firstMessage === null) firstMessage = text.replace(/\s+/g, " ").slice(0, 200);
						}
					}
					if (role === "assistant" && message.usage && typeof message.usage === "object") {
						const at = typeof message.timestamp === "number" ? message.timestamp : Date.parse(String(entry.timestamp ?? "")) || mtime;
						usage.push({
							entryId,
							at,
							provider: typeof message.provider === "string" ? message.provider : null,
							model: typeof message.model === "string" ? message.model : null,
							u: message.usage as Record<string, unknown>,
						});
					}
					break;
				}
			}
		}

		this.db.transaction(() => {
			this.db.run(
				`INSERT INTO session_meta(path, cwd, session_id, parent_session, name, first_message, created_at, modified_at, size, message_count, indexed_mtime, indexed_size)
				 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(path) DO UPDATE SET cwd = excluded.cwd, session_id = excluded.session_id, parent_session = excluded.parent_session,
				   name = excluded.name, first_message = excluded.first_message, created_at = excluded.created_at, modified_at = excluded.modified_at,
				   size = excluded.size, message_count = excluded.message_count, indexed_mtime = excluded.indexed_mtime, indexed_size = excluded.indexed_size`,
				path,
				cwd,
				sessionId,
				parent,
				name,
				firstMessage,
				createdAt,
				mtime,
				size,
				messageCount,
				mtime,
				size,
			);
			this.db.run("DELETE FROM session_fts WHERE path = ?", path);
			for (const t of texts) this.db.run("INSERT INTO session_fts(path, entry_id, role, text) VALUES(?, ?, ?, ?)", path, t.entryId, t.role, t.text);
			this.db.run("DELETE FROM usage_records WHERE path = ?", path);
			for (const record of usage) {
				const u = record.u;
				const cost = (u.cost ?? {}) as Record<string, unknown>;
				this.db.run(
					"INSERT OR REPLACE INTO usage_records(path, entry_id, at, cwd, provider, model, input, output, cache_read, cache_write, cost) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					path,
					record.entryId,
					record.at,
					cwd,
					record.provider,
					record.model,
					num(u.input),
					num(u.output),
					num(u.cacheRead),
					num(u.cacheWrite),
					num(cost.total),
				);
			}
		});
	}

	list(filter: { cwd?: string; archived?: "exclude" | "only" | "include" } = {}): SessionRow[] {
		const where: string[] = [];
		const params: string[] = [];
		const archived = filter.archived ?? "exclude";
		if (archived === "exclude") where.push("archived = 0");
		if (archived === "only") where.push("archived = 1");
		let rows = this.db.all<MetaRow>(`SELECT * FROM session_meta ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY pinned DESC, modified_at DESC`, ...params);
		if (filter.cwd) rows = rows.filter((r) => samePath(r.cwd, filter.cwd));
		return rows.map(toSession);
	}

	get(path: string): SessionRow | undefined {
		const row = this.db.all<MetaRow>("SELECT * FROM session_meta").find((r) => samePath(r.path, path));
		return row ? toSession(row) : undefined;
	}

	search(query: string, options: { cwd?: string; limit?: number } = {}): SearchHit[] {
		const q = query.trim();
		if (!q) return [];
		const limit = options.limit ?? 30;
		type Hit = { path: string; entry_id: string; role: string; snippet: string };
		let hits: Hit[];
		if ([...q].length >= 3) {
			const phrase = `"${q.replaceAll('"', '""')}"`;
			hits = this.db.all<Hit>(
				"SELECT path, entry_id, role, snippet(session_fts, 3, '【', '】', '…', 16) AS snippet FROM session_fts WHERE session_fts MATCH ? ORDER BY rank LIMIT ?",
				phrase,
				limit * 4,
			);
		} else {
			// Trigram FTS needs three characters; short (often Chinese) queries scan instead.
			hits = this.db
				.all<{ path: string; entry_id: string; role: string; text: string }>("SELECT path, entry_id, role, text FROM session_fts WHERE text LIKE ? ESCAPE '\\' LIMIT ?", `%${escapeLike(q)}%`, limit * 4)
				.map((r) => ({ ...r, snippet: around(r.text, q) }));
		}
		const metas = new Map(this.db.all<MetaRow>("SELECT * FROM session_meta").map((r) => [r.path, r]));
		const perSession = new Map<string, number>();
		const out: SearchHit[] = [];
		for (const hit of hits) {
			const meta = metas.get(hit.path);
			if (!meta || meta.archived) continue;
			if (options.cwd && !samePath(meta.cwd, options.cwd)) continue;
			const count = perSession.get(hit.path) ?? 0;
			if (count >= 3) continue;
			perSession.set(hit.path, count + 1);
			out.push({
				path: hit.path,
				cwd: meta.cwd,
				title: titleOf(meta),
				entryId: hit.entry_id,
				role: hit.role,
				snippet: hit.snippet.replace(/\s+/g, " "),
				modifiedAt: meta.modified_at,
			});
			if (out.length >= limit) break;
		}
		return out;
	}

	setFlag(path: string, flag: "pinned" | "archived", value: boolean): void {
		const row = this.get(path);
		if (!row) throw new Error("没有找到这个会话");
		this.db.run(`UPDATE session_meta SET ${flag} = ? WHERE path = ?`, value ? 1 : 0, row.path);
	}

	usage(options: { since?: number; until?: number; groupBy: "day" | "model" | "workspace" | "session" }): UsageRow[] {
		const since = options.since ?? 0;
		const until = options.until ?? Number.MAX_SAFE_INTEGER;
		const rows = this.db.all<{ at: number; cwd: string | null; provider: string | null; model: string | null; path: string; input: number; output: number; cache_read: number; cache_write: number; cost: number }>(
			"SELECT at, cwd, provider, model, path, input, output, cache_read, cache_write, cost FROM usage_records WHERE at >= ? AND at < ?",
			since,
			until,
		);
		const groups = new Map<string, UsageRow>();
		for (const r of rows) {
			const key =
				options.groupBy === "day"
					? localDay(r.at)
					: options.groupBy === "model"
						? `${r.provider ?? "?"}/${r.model ?? "?"}`
						: options.groupBy === "workspace"
							? normalizeCwd(r.cwd ?? "")
							: r.path;
			const g = groups.get(key) ?? { key, label: key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, responses: 0 };
			if (options.groupBy === "workspace") g.label = r.cwd ?? "未知";
			g.input += r.input;
			g.output += r.output;
			g.cacheRead += r.cache_read;
			g.cacheWrite += r.cache_write;
			g.cost += r.cost;
			g.responses++;
			groups.set(key, g);
		}
		if (options.groupBy === "session") {
			for (const g of groups.values()) {
				const meta = this.get(g.key);
				if (meta) g.label = meta.title;
			}
		}
		const list = [...groups.values()];
		return options.groupBy === "day" ? list.sort((a, b) => a.key.localeCompare(b.key)) : list.sort((a, b) => b.cost - a.cost || b.input + b.output - (a.input + a.output));
	}

	private register(): void {
		const core = this.core;
		core.register("sessions.list", async (params) => {
			await this.refresh();
			const archived = params.archived === "only" || params.archived === "include" ? params.archived : "exclude";
			return this.list({ cwd: str(params.cwd), archived });
		});
		core.register("sessions.search", async (params) => {
			await this.refresh();
			return this.search(requireStr(params.query, "query"), { cwd: str(params.cwd), limit: typeof params.limit === "number" ? params.limit : undefined });
		});
		core.register("sessions.setPinned", (params) => {
			this.setFlag(requireStr(params.path, "path"), "pinned", params.pinned === true);
			return { ok: true };
		});
		core.register("sessions.setArchived", (params) => {
			this.setFlag(requireStr(params.path, "path"), "archived", params.archived === true);
			return { ok: true };
		});
		core.register("sessions.workspaces", async () => {
			await this.refresh();
			return this.db.all<{ cwd: string; last: number; n: number }>(
				"SELECT cwd, MAX(modified_at) AS last, COUNT(*) AS n FROM session_meta WHERE cwd IS NOT NULL GROUP BY lower(cwd) ORDER BY last DESC",
			).filter((r) => existsSync(r.cwd));
		});
		core.register("usage.summary", async (params) => {
			await this.refresh();
			const groupBy = (["day", "model", "workspace", "session"] as const).find((g) => g === params.groupBy) ?? "day";
			return this.usage({
				since: typeof params.since === "number" ? params.since : undefined,
				until: typeof params.until === "number" ? params.until : undefined,
				groupBy,
			});
		});
	}
}

export interface UsageRow {
	key: string;
	label: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	responses: number;
}

function toSession(row: MetaRow): SessionRow {
	return {
		path: row.path,
		cwd: row.cwd,
		sessionId: row.session_id,
		parentSession: row.parent_session,
		title: titleOf(row),
		name: row.name,
		createdAt: row.created_at,
		modifiedAt: row.modified_at,
		messageCount: row.message_count,
		pinned: row.pinned === 1,
		archived: row.archived === 1,
	};
}

function titleOf(row: MetaRow): string {
	return row.name ?? row.first_message ?? "新会话";
}

function listJsonl(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, depth: number) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory() && depth < 3) walk(path, depth + 1);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
		}
	};
	walk(root, 0);
	return out;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function escapeLike(text: string): string {
	return text.replace(/[%_\\]/g, (c) => `\\${c}`);
}

function around(text: string, query: string, radius = 30): string {
	const index = text.toLowerCase().indexOf(query.toLowerCase());
	if (index < 0) return text.slice(0, radius * 2);
	const start = Math.max(0, index - radius);
	const end = Math.min(text.length, index + query.length + radius);
	return `${start > 0 ? "…" : ""}${text.slice(start, index)}【${text.slice(index, index + query.length)}】${text.slice(index + query.length, end)}${end < text.length ? "…" : ""}`;
}

export function localDay(at: number): string {
	const d = new Date(at);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
