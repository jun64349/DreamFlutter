import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CorePaths } from "../paths.ts";
import { excludedFromData, PI_FILES } from "./export.ts";
import type { Staged } from "./restore.ts";

/**
 * The live data cannot be replaced while the core uses it, so a restore
 * writes a switch record and the core quits; the next start applies the
 * record before the database is opened (main.ts). Every step is a move:
 * the current item goes to restore-old/, the staged one takes its place.
 * Rolling back only looks at what is on disk, so it works from any point,
 * including after the process was killed halfway: on start, a record that
 * is not committed is first rolled back, then applied again; if that fails
 * the old data stays.
 */

export interface SwitchItem {
	/** What it is, for the result page. */
	label: string;
	/** Staged copy; none = the current item only moves aside (it is not in the backup). */
	source?: string;
	target: string;
	old: string;
}

export interface SwitchRecord {
	version: 1;
	state: "pending" | "committed";
	createdAt: number;
	staging: string;
	oldDir: string;
	items: SwitchItem[];
	/** Written to restore-result.json once the switch is done. */
	result: Record<string, unknown>;
}

export interface RestoreOutcome {
	ok: boolean;
	error?: string;
	at: number;
	[key: string]: unknown;
}

export function recordFile(paths: CorePaths): string {
	return join(paths.dataDir, "restore-switch.json");
}

export function resultFile(paths: CorePaths): string {
	return join(paths.dataDir, "restore-result.json");
}

/** The pending restore of the sandbox's files (Sandbox puts them back on its next start). */
export function sandboxRestoreFile(paths: CorePaths): string {
	return join(paths.dataDir, "sandbox", "pending-restore.tar.gz");
}

/** Builds the record for [staged] (made by stageBackup) and writes it. */
export function writeSwitchRecord(paths: CorePaths, agentDir: string, staged: Staged, result: Record<string, unknown>): SwitchRecord {
	const oldDir = join(paths.dataDir, "restore-old");
	const appdata = join(staged.dir, "raw", "data", "appdata");
	const items: SwitchItem[] = [];
	const add = (label: string, target: string, source?: string) => items.push({ label, source, target, old: join(oldDir, String(items.length)) });

	// The data folder: the backup's entries replace the current ones, current ones it lacks move aside.
	const stagedNames = new Set(existsSync(appdata) ? readdirSync(appdata) : []);
	for (const name of stagedNames) add(`数据 ${name}`, join(paths.dataDir, name), join(appdata, name));
	for (const name of existsSync(paths.dataDir) ? readdirSync(paths.dataDir) : []) {
		// Keys stay when the backup brings none (excludedFromData covers them too).
		if (stagedNames.has(name)) continue;
		// The WAL files belong to the database being replaced: left in place they would corrupt the restored one.
		if (name === "core.db-wal" || name === "core.db-shm" || !excludedFromData(name)) add(`数据 ${name}`, join(paths.dataDir, name));
	}

	const pi = join(staged.dir, "raw", "data", "pi");
	const piNames = new Set(staged.piFiles);
	for (const name of [...PI_FILES, "auth.json"]) {
		if (piNames.has(name)) add(`Pi ${name}`, join(agentDir, name), join(pi, name));
		// auth.json holds keys: without keys in the backup, this machine's stay.
		else if (name !== "auth.json" && existsSync(join(agentDir, name))) add(`Pi ${name}`, join(agentDir, name));
	}

	for (const s of staged.sessionTargets) add("会话", s.target, join(staged.dir, "sessions", s.staged));

	const tar = join(staged.dir, "raw", "data", "sandbox", "workspace.tar.gz");
	if (existsSync(tar)) add("蝶君沙箱里的文件", sandboxRestoreFile(paths), tar);

	const record: SwitchRecord = { version: 1, state: "pending", createdAt: Date.now(), staging: staged.dir, oldDir, items, result };
	writeFileSync(recordFile(paths), JSON.stringify(record, null, 2), "utf8");
	return record;
}

export interface SwitchHooks {
	/** Tests: throw after this many items, as a failure (rolled back). */
	failAfter?: number;
	/** Tests: stop dead after this many items, as if the process were killed. */
	killAfter?: number;
	log?: (message: string) => void;
}

export class Killed extends Error {}

/** Applies a pending restore, if any; returns what happened (also kept in restore-result.json). */
export function applyPendingRestore(paths: CorePaths, hooks: SwitchHooks = {}): RestoreOutcome | undefined {
	const file = recordFile(paths);
	if (!existsSync(file)) return undefined;
	let record: SwitchRecord;
	try {
		record = JSON.parse(readFileSync(file, "utf8")) as SwitchRecord;
	} catch {
		hooks.log?.("restore: unreadable switch record, ignored");
		rmSync(file, { force: true });
		return undefined;
	}
	if (record.state === "committed") return finish(paths, record, { ok: true, at: Date.now(), ...record.result });

	// Whatever a previous attempt left half done goes back first.
	rollBack(record.items);
	try {
		let done = 0;
		for (const item of record.items) {
			if (hooks.killAfter !== undefined && done === hooks.killAfter) throw new Killed();
			if (hooks.failAfter !== undefined && done === hooks.failAfter) throw new Error("模拟的切换失败");
			if (existsSync(item.target)) move(item.target, item.old);
			if (item.source) move(item.source, item.target);
			done++;
		}
	} catch (error) {
		if (error instanceof Killed) throw error;
		hooks.log?.(`restore: switch failed, rolling back: ${(error as Error).message}`);
		try {
			rollBack(record.items);
		} catch (rollbackError) {
			// Keep the record: the next start tries the rollback again.
			hooks.log?.(`restore: rollback failed: ${(rollbackError as Error).message}`);
			throw rollbackError;
		}
		const outcome: RestoreOutcome = { ok: false, at: Date.now(), error: (error as Error).message, ...record.result, prefs: undefined };
		writeFileSync(resultFile(paths), JSON.stringify(outcome, null, 2), "utf8");
		rmSync(file, { force: true });
		rmSync(record.staging, { recursive: true, force: true });
		rmSync(record.oldDir, { recursive: true, force: true });
		return outcome;
	}
	record.state = "committed";
	writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
	return finish(paths, record, { ok: true, at: Date.now(), ...record.result });
}

function finish(paths: CorePaths, record: SwitchRecord, outcome: RestoreOutcome): RestoreOutcome {
	writeFileSync(resultFile(paths), JSON.stringify(outcome, null, 2), "utf8");
	rmSync(record.oldDir, { recursive: true, force: true });
	rmSync(record.staging, { recursive: true, force: true });
	rmSync(recordFile(paths), { force: true });
	return outcome;
}

/** Puts every item back as it was, judging only by what is on disk (safe to repeat). */
function rollBack(items: SwitchItem[]): void {
	for (const item of [...items].reverse()) {
		const placed = item.source ? !existsSync(item.source) && existsSync(item.target) : false;
		if (placed) move(item.target, item.source!);
		if (existsSync(item.old)) {
			if (existsSync(item.target)) rmSync(item.target, { recursive: true, force: true });
			move(item.old, item.target);
		}
	}
}

function move(from: string, to: string): void {
	mkdirSync(dirname(to), { recursive: true });
	try {
		renameSync(from, to);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		cpSync(from, to, { recursive: true });
		rmSync(from, { recursive: true, force: true });
	}
}
