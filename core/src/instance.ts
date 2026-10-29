import { randomBytes } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { CorePaths } from "./paths.ts";

export interface CoreInfo {
	pid: number;
	port: number;
	token: string;
	version: string;
	startedAt: number;
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function readInfo(paths: CorePaths): CoreInfo | undefined {
	try {
		return JSON.parse(readFileSync(paths.infoFile, "utf8")) as CoreInfo;
	} catch {
		return undefined;
	}
}

/**
 * Takes the single-instance lock: a file holding our pid, put in place with
 * a hard link so it never exists half-written. A lock whose pid is gone is
 * stale; it is moved aside with an atomic rename (only one process wins) and
 * restored if what was moved turns out to belong to a live process. Returns
 * the pid of the running instance when the lock is held by a live process.
 */
export function acquireLock(paths: CorePaths): { ok: true } | { ok: false; pid: number } {
	const temp = `${paths.lockFile}.${process.pid}.tmp`;
	writeFileSync(temp, String(process.pid), "utf8");
	try {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				linkSync(temp, paths.lockFile);
				return { ok: true };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const holder = readPid(paths.lockFile);
			if (holder !== undefined && holder !== process.pid && pidAlive(holder)) return { ok: false, pid: holder };
			const aside = `${paths.lockFile}.${process.pid}.stale`;
			try {
				renameSync(paths.lockFile, aside);
			} catch {
				continue; // someone else moved it first
			}
			const moved = readPid(aside);
			if (moved !== undefined && moved !== holder && moved !== process.pid && pidAlive(moved)) {
				// Between our read and the rename a live process took the lock: give it back.
				try {
					linkSync(aside, paths.lockFile);
				} catch {}
				rmSync(aside, { force: true });
				return { ok: false, pid: moved };
			}
			rmSync(aside, { force: true });
		}
		return { ok: false, pid: -1 };
	} finally {
		rmSync(temp, { force: true });
	}
}

function readPid(file: string): number | undefined {
	try {
		const pid = Number.parseInt(readFileSync(file, "utf8"), 10);
		return Number.isInteger(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

export function releaseLock(paths: CorePaths): void {
	try {
		if (Number.parseInt(readFileSync(paths.lockFile, "utf8"), 10) === process.pid) rmSync(paths.lockFile, { force: true });
	} catch {
		// Already gone.
	}
}

export function newToken(): string {
	return randomBytes(32).toString("hex");
}

/** Writes core.json atomically so a reader never sees a partial file. */
export function writeInfo(paths: CorePaths, info: CoreInfo): void {
	const temp = `${paths.infoFile}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(info, null, 2), "utf8");
	renameSync(temp, paths.infoFile);
}

export function removeInfo(paths: CorePaths): void {
	const info = readInfo(paths);
	if (info?.pid === process.pid) rmSync(paths.infoFile, { force: true });
}
