import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { MIGRATIONS } from "./schema.ts";

export type Row = Record<string, SQLInputValue>;

/** Thin wrapper over node:sqlite with forward-only migrations. */
export class Db {
	readonly raw: DatabaseSync;

	constructor(file: string) {
		this.raw = new DatabaseSync(file);
		this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
		this.migrate();
	}

	private migrate(): void {
		const current = Number((this.raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
		for (let version = current; version < MIGRATIONS.length; version++) {
			this.transaction(() => {
				this.raw.exec(MIGRATIONS[version]!);
				this.raw.exec(`PRAGMA user_version = ${version + 1}`);
			});
		}
	}

	get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
		return this.raw.prepare(sql).get(...params) as T | undefined;
	}

	all<T>(sql: string, ...params: SQLInputValue[]): T[] {
		return this.raw.prepare(sql).all(...params) as T[];
	}

	run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
		const result = this.raw.prepare(sql).run(...params);
		return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
	}

	transaction<T>(fn: () => T): T {
		this.raw.exec("BEGIN");
		try {
			const result = fn();
			this.raw.exec("COMMIT");
			return result;
		} catch (error) {
			this.raw.exec("ROLLBACK");
			throw error;
		}
	}

	close(): void {
		this.raw.close();
	}
}

export function now(): number {
	return Date.now();
}

export function json(value: unknown): string {
	return JSON.stringify(value ?? null);
}

export function parseJson<T>(text: unknown, fallback: T): T {
	if (typeof text !== "string") return fallback;
	try {
		return JSON.parse(text) as T;
	} catch {
		return fallback;
	}
}
