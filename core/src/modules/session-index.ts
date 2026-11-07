import { inheritedIds, readSessionEntries, sideFromEntries } from "../pi/session-metadata.ts";
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Core, CoreModule } from "../core.ts";
import { normalizeCwd, requireStr, samePath, str } from "../core.ts";
import type { Db } from "../db.ts";
import { textOf } from "../runs.ts";
import type { Slot } from "../slots/slot.ts";

export interface SessionRow {
	path: string;
	cwd: string | null;
	sessionId: string | null;
	parentSession: string | null;
	sessionType: "ordinary" | "side";
	parentMissing: boolean;
	quote: string | null;
	quoteEntryId: string | null;
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
	session_type: "ordinary" | "side";
	side_quote: string | null;
	quote_entry_id: string | null;
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
		core.declareBackup({
			id: "sessions",
			title: "会话索引、用量",
			tables: ["session_meta", "session_fts", "usage_records", "session_inherited_history"],
			paths: {
				session_meta: { path: "path", cwd: "path", parent_session: "path" },
				session_inherited_history: { parent_session: "path" },
				session_fts: { path: "path" },
				usage_records: { path: "path", cwd: "path" },
			},
		});
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

	onSlotChanged(slot: Slot): void {
		const path = slot.info().sessionFile;
		if (!slot.isSideConversation || !path || !existsSync(path) || this.core.pendingSessionFiles.has(normalizeCwd(path))) return;
		// Make the type available to session-id APIs immediately after first-send commit,
		// even when the last run's refresh happened while the file was provisional.
		if (!this.get(path)) {
			try {
				const stat = statSync(path);
				this.indexFile(path, Math.floor(stat.mtimeMs), stat.size);
			} catch (error) { this.core.log.warn(`could not index ${path}`, error); }
		}
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
			if (this.core.pendingSessionFiles.has(resolve(file).toLowerCase())) { known.delete(file); continue; }
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
			this.db.run("DELETE FROM session_inherited_history WHERE session_id IN (SELECT session_id FROM session_meta WHERE path = ?)", path);
			this.db.run("DELETE FROM session_meta WHERE path = ?", path);
			this.db.run("DELETE FROM session_fts WHERE path = ?", path);
			this.db.run("DELETE FROM usage_records WHERE path = ?", path);
		});
	}

	indexFile(path: string, mtime: number, size: number): void {
		if (this.core.pendingSessionFiles.has(resolve(path).toLowerCase())) return;
		const entries = readSessionEntries(path);
		const header = entries.find((e) => e.type === "session");
		const side = sideFromEntries(entries, header?.id ?? "");
		const inherited = inheritedIds(entries, header?.id ?? "", header?.parentSession, header?.timestamp, this.db);
		let cwd: string | null = null;
		let sessionId: string | null = null;
		let parent: string | null = null;
		let createdAt: number | null = null;
		let name: string | null = null;
		let firstMessage: string | null = null;
		let messageCount = 0;
		const texts: { entryId: string; role: string; text: string }[] = [];
		const usage: { entryId: string; at: number; provider: string | null; model: string | null; u: Record<string, unknown> }[] = [];

		for (const entry of entries) {
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
				// Model calls outside the replies: compaction summaries and background summaries (roadmap 5.12) are spending too.
				case "compaction":
				case "branch_summary":
				case "usage":
					if (entry.usage && typeof entry.usage === "object") {
						const at = Date.parse(String(entry.timestamp ?? "")) || mtime;
						usage.push({ entryId: String(entry.id ?? ""), at, provider: typeof entry.provider === "string" ? entry.provider : null, model: typeof entry.model === "string" ? entry.model : null, u: entry.usage as Record<string, unknown> });
					}
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
			this.db.run("UPDATE session_meta SET session_type = ?, side_quote = ?, quote_entry_id = ? WHERE path = ?", side ? "side" : "ordinary", side?.quote ?? null, side?.quoteEntryId ?? null, path);
			this.db.run("DELETE FROM session_fts WHERE path = ?", path);
			for (const t of side ? [] : texts) this.db.run("INSERT INTO session_fts(path, entry_id, role, text) VALUES(?, ?, ?, ?)", path, t.entryId, t.role, t.text);
			this.db.run("DELETE FROM usage_records WHERE path = ?", path);
			for (const record of usage) {
				if (inherited.has(record.entryId)) continue;
				const u = record.u;
				this.core.ledger?.linkIndex(record.entryId, record.at, record.provider, record.model, u);
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
		const where: string[] = ["session_type = 'ordinary'"];
		const params: string[] = [];
		const archived = filter.archived ?? "exclude";
		if (archived === "exclude") where.push("archived = 0");
		if (archived === "only") where.push("archived = 1");
		let rows = this.db.all<MetaRow>(`SELECT * FROM session_meta ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY pinned DESC, modified_at DESC`, ...params);
		if (filter.cwd) rows = rows.filter((r) => samePath(r.cwd, filter.cwd));
		return rows.map(toSession);
	}

	children(parent: string, cwd?: string): SessionRow[] {
		return this.db.all<MetaRow>("SELECT * FROM session_meta ORDER BY created_at").filter((r) => samePath(r.parent_session, parent) && (!cwd || samePath(r.cwd, cwd))).map(toSession);
	}

	/** Only side descendants cascade. Ordinary forks keep their complete history. */
	private deletionFiles(path: string): SessionRow[] {
		const root = this.get(path);
		if (!root) throw new Error("没有找到这个会话");
		const out = [root];
		const seen = new Set([normalizeCwd(root.path)]);
		for (let i = 0; i < out.length; i++) {
			for (const child of this.children(out[i]!.path, root.cwd ?? undefined)) {
				if (child.sessionType !== "side" || seen.has(normalizeCwd(child.path))) continue;
				seen.add(normalizeCwd(child.path));
				out.push(child);
			}
		}
		// Index membership alone is insufficient: reject symlinks/out-of-root paths.
		const rootDir = realpathSync(this.sessionsDir);
		for (const row of out) {
			const rel = relative(rootDir, realpathSync(row.path));
			if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("会话文件不在会话目录内");
		}
		return out;
	}

	async deleteSession(path: string): Promise<{ deleted: string[]; sideCount: number }> {
		await this.refresh();
		let rows = this.deletionFiles(path);
		const locks = new Set(rows.map((r) => normalizeCwd(r.path)));
		if ([...locks].some((p) => this.core.deletingSessionFiles.has(p))) throw new Error("会话正在删除");
		for (const p of locks) this.core.deletingSessionFiles.add(p);
		try {
			const affected = this.core.sessionSlots().filter((slot) => locks.has(normalizeCwd(slot.info().sessionFile ?? "")) || (slot.forkOf && locks.has(normalizeCwd(slot.forkOf))));
			if (affected.some((slot) => !this.core.slots.has(slot.slotId) && !this.core.isSlotClosing(slot.slotId))) throw new Error("会话正在打开，请稍后重试删除");
			for (const slot of affected) await this.core.closeSlot(slot.slotId);
			// Closing joins a first send already in progress; include its newly saved file.
			await this.refresh();
			rows = this.deletionFiles(path);
			for (const row of rows) { const key = normalizeCwd(row.path); locks.add(key); this.core.deletingSessionFiles.add(key); }
			const deleted: string[] = [];
			for (const row of rows.slice().reverse()) {
				await recycleSession(row.path);
				this.forget(row.path);
				deleted.push(row.path);
				await this.core.call("cards.forgetSession", { sessionFile: row.path });
			}
			return { deleted, sideCount: rows.length - 1 };
		} finally {
			for (const p of locks) this.core.deletingSessionFiles.delete(p);
		}
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
			if (!meta || meta.archived || meta.session_type === "side") continue;
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
		if (this.core.ledger) {
			this.core.ledger.importHistory();
			return this.core.ledger.summary({ ...options, period: options.groupBy === "day" ? "day" : "all", groupBy: options.groupBy === "day" ? "all" : options.groupBy }).rows.map((r) => ({ key: options.groupBy === "day" ? r.period : r.key, label: r.key, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, cost: r.amounts.USD ?? 0, responses: r.requests }));
		}
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
		core.register("sessions.deletePreview", async (params) => {
			await this.refresh();
			const rows = this.deletionFiles(requireStr(params.path, "path"));
			return { sideCount: rows.length - 1, paths: rows.map((r) => r.path) };
		});
		core.register("sessions.delete", (params) => this.deleteSession(requireStr(params.path, "path")));
		core.register("sessions.children", async (params) => {
			await this.refresh();
			const parent = requireStr(params.parentSession, "parentSession");
			const cwd = str(params.cwd) ?? this.get(parent)?.cwd;
			if (!cwd) throw new Error("父会话不存在时请提供 cwd");
			return this.children(parent, cwd);
		});
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
		sessionType: row.session_type,
		parentMissing: !!row.parent_session && !existsSync(row.parent_session),
		quote: row.side_quote,
		quoteEntryId: row.quote_entry_id,
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

/** Matches the existing desktop deletion semantics, now owned by the core. */
async function recycleSession(path: string): Promise<void> {
	if (!existsSync(path)) return;
	if (process.platform !== "win32") { rmSync(path); return; }
	const literal = path.replaceAll("'", "''");
	const command = `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${literal}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
	await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { windowsHide: true });
	if (existsSync(path)) throw new Error("删除失败：文件可能正被占用");
}
