import { mkdirSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "../db.ts";

export const DEFAULT_MIN_FREE_BYTES = 1024 ** 3;
export const LOW_SPACE_MESSAGE = "磁盘剩余空间不足，记忆写入已暂停；释放空间后会自动恢复，对话可继续。";

/** No deletes, no persisted pause flag: every check can recover without a restart. */
export class MemorySpaceGuard {
	private readonly directory: string;
	private readonly minimum: () => number;
	private readonly available: (path: string) => number;
	constructor(directory: string, minimum: () => number,
		available = (path: string) => { const s = statfsSync(path); return s.bavail * s.bsize; }) {
		this.directory = directory; this.minimum = minimum; this.available = available;
	}

	status(): { paused: boolean; freeBytes: number | null; minimumBytes: number; reason: string | null } {
		const minimumBytes = this.minimum();
		try {
			const freeBytes = this.available(this.directory);
			return { paused: freeBytes < minimumBytes, freeBytes, minimumBytes, reason: freeBytes < minimumBytes ? LOW_SPACE_MESSAGE : null };
		} catch {
			return { paused: true, freeBytes: null, minimumBytes, reason: "无法检查磁盘剩余空间，记忆写入暂时暂停。" };
		}
	}
}

/** A consistent SQLite backup including WAL contents, never a live-file copy. */
export function backupDatabase(db: Db, directory: string): string {
	mkdirSync(directory, { recursive: true });
	const file = join(directory, `storage-${Date.now()}-${randomUUID()}.db`);
	try {
		db.raw.prepare("VACUUM INTO ?").run(file);
		checkDatabase(file);
		return file;
	} catch (error) {
		// Only our freshly generated partial backup, never the live database.
		rmSync(file, { force: true });
		throw error;
	}
}

export function checkDatabase(file: string): void {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const rows = db.prepare("PRAGMA integrity_check").all();
		if (rows.length !== 1 || Object.values(rows[0]!)[0] !== "ok") throw new Error("数据库完整性检查未通过");
		if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("数据库外键检查未通过");
	} finally { db.close(); }
}

/** Old versions only; preserve the first and last of each item's old history. */
export function compactMemoryHistory(db: Db, backupDir: string, at = Date.now()): { deleted: number; backup: string } {
	const cutoff = new Date(at);
	cutoff.setFullYear(cutoff.getFullYear() - 1);
	const backup = backupDatabase(db, backupDir);
	const deleted = db.transaction(() => db.run(`DELETE FROM memory_versions WHERE at < ? AND (item_id, version) IN (
		SELECT item_id, version FROM (
			SELECT item_id, version, ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY version) AS first_rank,
			ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY version DESC) AS last_rank
			FROM memory_versions WHERE at < ?
		) WHERE first_rank > 1 AND last_rank > 1
	)`, cutoff.getTime(), cutoff.getTime()).changes);
	return { deleted, backup };
}

/** Logical memory payload, separate from the shared SQLite file's allocated bytes. */
export function memoryUsage(db: Db): { logicalBytes: number; versions: number } {
	const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'memory_%' OR name IN ('memories','workspaces','workspace_groups','workspace_group_members'))");
	let logicalBytes = 0;
	for (const { name } of tables) {
		const columns = db.raw.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all().map((c) => String(c.name));
		const sum = columns.map((c) => `coalesce(length(CAST("${c.replaceAll('"', '""')}" AS BLOB)),0)`).join("+");
		logicalBytes += Number(db.get<{ bytes: number }>(`SELECT coalesce(sum(${sum}),0) AS bytes FROM "${name.replaceAll('"', '""')}"`)!.bytes);
	}
	return { logicalBytes, versions: db.get<{ n: number }>("SELECT count(*) AS n FROM memory_versions")!.n };
}
