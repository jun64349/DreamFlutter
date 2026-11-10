import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Core } from "../core.ts";
import { normalizeCwd, RpcError } from "../core.ts";

export const RECYCLE_DAYS = 30;
export const RECYCLE_MS = RECYCLE_DAYS * 86_400_000;
export interface RecycleRow {
	batch_id: string; original_path: string; stored_path: string; deleted_at: number; expires_at: number;
	phase: "deleting" | "stored" | "restoring" | "purging"; metadata: string;
}
/** Pi discovery is shallow; nested .recycle/batch files are never candidates. */
export function inRecycle(path: string): boolean { return resolve(path).split(/[\\/]/).some((p) => p.toLowerCase() === ".recycle"); }
export function assertSessionAvailable(core: Core, path: string): void {
	if (inRecycle(path) || core.db.all<{ original_path: string }>("SELECT original_path FROM session_recycle").some((r) => normalizeCwd(r.original_path) === normalizeCwd(path))) throw new RpcError("conflict", "这个对话在回收站中，请先恢复");
}

/** File moves are journaled before touching files. Recovery always rolls forward. */
export class SessionRecycle {
	private core: Core;
	private root: () => string;
	private forget: (path: string) => void;
	private restored: (path: string, metadata: Record<string, unknown>) => void;
	constructor(core: Core, root: () => string, forget: (path: string) => void, restored: (path: string, metadata: Record<string, unknown>) => void) {
		this.core = core; this.root = root; this.forget = forget; this.restored = restored;
	}
	list(): RecycleRow[] { return this.core.db.all<RecycleRow>("SELECT * FROM session_recycle ORDER BY deleted_at DESC,original_path"); }
	private checked(path: string, allowMissing = false): void {
		const root = realpathSync(this.root());
		const rel = relative(root, resolve(path));
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new RpcError("bad_request", "会话文件超出保管目录");
		let current = root;
		for (const part of rel.split(/[\\/]/)) {
			current = join(current, part);
			if (!existsSync(current)) {
				// Broken symlinks must not be mistaken for an absent target.
				try { if (lstatSync(current).isSymbolicLink()) throw new Error("会话路径不能包含链接"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
				if (allowMissing) return;
				throw new Error("回收文件缺失，已保留恢复记录");
			}
			if (lstatSync(current).isSymbolicLink()) throw new Error("会话路径不能包含链接");
		}
		if (!statSync(path).isFile()) throw new Error("会话路径不是文件");
	}
	private move(from: string, to: string, expected: string): void {
		this.checked(from, true); this.checked(to, true);
		if (!existsSync(from)) {
			if (existsSync(to) && createHash("sha256").update(readFileSync(to)).digest("hex") === expected) return;
			throw new Error("回收文件缺失或内容不符，已保留恢复记录");
		}
		mkdirSync(dirname(to), { recursive: true });
		if (existsSync(to)) {
			const a = statSync(from), b = statSync(to);
			if (a.dev !== b.dev || a.ino !== b.ino) throw new RpcError("conflict", "原位置已有文件，未覆盖；恢复记录已保留");
		} else linkSync(from, to); // exclusive, same resource/filesystem; never overwrite
		unlinkSync(from);
	}
	store(rows: { path: string }[]): string {
		const id = `recycle_${randomUUID()}`, at = Date.now();
		for (const row of rows) this.checked(row.path);
		this.core.ledger?.importHistory();
		this.core.db.transaction(() => {
			rows.forEach((row, i) => {
				const meta = this.core.db.get<Record<string, unknown>>("SELECT * FROM session_meta WHERE path=?", row.path);
				this.core.db.run("INSERT INTO session_recycle VALUES(?,?,?,?,?,?,?)", id, row.path, join(this.root(), ".recycle", id, `${i}_${basename(row.path)}`), at, at + RECYCLE_MS, "deleting", JSON.stringify({ ...meta, recycleSha256: createHash("sha256").update(readFileSync(row.path)).digest("hex") }));
			});
		});
		this.finish(id);
		return id;
	}
	private finish(id: string): void {
		const rows = this.list().filter((r) => r.batch_id === id);
		if (!rows.length) return;
		for (const row of rows) {
			const expected = (JSON.parse(row.metadata) as { recycleSha256: string }).recycleSha256;
			if (row.phase === "deleting") this.move(row.original_path, row.stored_path, expected);
			if (row.phase === "restoring") this.move(row.stored_path, row.original_path, expected);
			if (row.phase === "purging") {
				this.checked(row.stored_path, true);
				if (existsSync(row.stored_path)) unlinkSync(row.stored_path);
			}
		}
		// Only expose a restored batch after all files have arrived.
		if (rows[0]!.phase === "restoring") {
			for (const row of rows) this.restored(row.original_path, JSON.parse(row.metadata));
			this.core.db.run("DELETE FROM session_recycle WHERE batch_id=?", id);
			try { rmdirSync(dirname(rows[0]!.stored_path)); } catch { /* keep a nonempty directory */ }
		} else if (rows[0]!.phase === "purging") {
			for (const row of rows) {
				this.forget(row.original_path);
				void this.core.call("cards.forgetSession", { sessionFile: row.original_path }).catch((e) => this.core.log.warn("recycle: card cleanup failed", e));
			}
			this.core.db.run("DELETE FROM session_recycle WHERE batch_id=?", id);
			try { rmdirSync(dirname(rows[0]!.stored_path)); } catch { /* keep a nonempty directory */ }
		} else {
			for (const row of rows) this.forget(row.original_path);
			this.core.db.run("UPDATE session_recycle SET phase='stored' WHERE batch_id=?", id);
		}
	}
	recover(): void {
		for (const id of new Set(this.list().filter((r) => r.phase !== "stored").map((r) => r.batch_id))) {
			try { this.finish(id); } catch (e) { this.core.log.warn(`recycle: batch ${id} needs recovery`, e); }
		}
	}
	restore(id: string): { restored: string[] } {
		if (this.core.maintenance) throw new RpcError("busy", "正在维护数据，请稍后恢复");
		const rows = this.list().filter((r) => r.batch_id === id);
		if (!rows.length) throw new RpcError("not_found", "没有这个回收批次");
		if (rows.some((r) => r.expires_at <= Date.now())) throw new RpcError("expired", "已超过 30 天恢复期限");
		if (rows.some((r) => r.phase !== "stored")) throw new RpcError("conflict", "这个批次需要先完成恢复处理");
		for (const r of rows) {
			this.checked(r.stored_path); this.checked(r.original_path, true);
			if (existsSync(r.original_path)) throw new RpcError("conflict", "原位置已有文件，未覆盖");
		}
		this.core.db.run("UPDATE session_recycle SET phase='restoring' WHERE batch_id=?", id);
		this.finish(id);
		return { restored: rows.map((r) => r.original_path) };
	}
	purgeExpired(at = Date.now()): { purged: string[] } {
		if (this.core.maintenance) return { purged: [] };
		const ids = [...new Set(this.list().filter((r) => r.expires_at <= at && r.phase === "stored").map((r) => r.batch_id))];
		for (const id of ids) {
			this.core.db.run("UPDATE session_recycle SET phase='purging' WHERE batch_id=?", id);
			this.finish(id);
		}
		return { purged: ids };
	}
}
