import type { Db } from "../db.ts";
import type { PathMap } from "./path-map.ts";

/**
 * How a column holds paths: a plain path, a normalizeCwd key (resolved,
 * lowercased), JSON with paths among its strings, or a Pi `!command` key
 * reference (SecretStore) whose files move with the data folder.
 */
export type PathKind = "path" | "key" | "json" | "secretRef";

/** What restoring a module's data needs. */
export interface StageContext {
	map: PathMap;
	/** A key reference pointing at this machine's secrets folder and node. */
	secretRef(ref: string): string;
}

/**
 * A module's share of the database in a backup: the tables it owns (every
 * table must have an owner, a test checks), the columns holding paths, and
 * what to do to the staged copy before it replaces the live data.
 */
export interface BackupPart {
	id: string;
	title: string;
	tables: string[];
	paths?: Record<string, Record<string, PathKind>>;
	/** Runs on the staged, upgraded and remapped database. */
	onStage?(db: Db, context: StageContext): void;
}

/** Rewrites the path columns [parts] declare in [db]. */
export function remapColumns(db: Db, parts: BackupPart[], context: StageContext): void {
	const { map } = context;
	if (map.empty && !parts.some((p) => Object.values(p.paths ?? {}).some((c) => Object.values(c).includes("secretRef")))) return;
	for (const part of parts) {
		for (const [table, columns] of Object.entries(part.paths ?? {})) {
			for (const [column, kind] of Object.entries(columns)) {
				const rows = db.all<{ id: number; value: unknown }>(`SELECT rowid AS id, "${column}" AS value FROM "${table}" WHERE "${column}" IS NOT NULL`);
				for (const row of rows) {
					if (typeof row.value !== "string") continue;
					const next = rewrite(row.value, kind, context);
					if (next === row.value) continue;
					try {
						db.run(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`, next, row.id);
					} catch {
						// Two rows mapped onto one key (the same folder twice): keep the one already there.
					}
				}
			}
		}
	}
}

function rewrite(value: string, kind: PathKind, context: StageContext): string {
	switch (kind) {
		case "path":
			return context.map.map(value);
		case "key":
			return context.map.mapKey(value);
		case "secretRef":
			return context.secretRef(value);
		case "json":
			try {
				return JSON.stringify(context.map.mapJson(JSON.parse(value)));
			} catch {
				return value;
			}
	}
}

/** Tables in [db] (SQLite's own and FTS shadow tables left out). */
export function userTables(db: Db): string[] {
	const rows = db.all<{ name: string; sql: string | null }>("SELECT name, sql FROM sqlite_master WHERE type = 'table'");
	const virtual = rows.filter((r) => /CREATE VIRTUAL TABLE/i.test(r.sql ?? "")).map((r) => r.name);
	return rows
		.map((r) => r.name)
		.filter((name) => !name.startsWith("sqlite_") && !virtual.some((v) => name.startsWith(`${v}_`)))
		.sort();
}
