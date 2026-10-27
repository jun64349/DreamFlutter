import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
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
 * Takes the single-instance lock (an exclusively created file holding our
 * pid). A lock whose pid is gone is stale and taken over. Returns the pid of
 * the running instance when the lock is held by a live process.
 */
export function acquireLock(paths: CorePaths): { ok: true } | { ok: false; pid: number } {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(paths.lockFile, "wx");
			writeSync(fd, String(process.pid));
			closeSync(fd);
			return { ok: true };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const holder = Number.parseInt(readFileSync(paths.lockFile, "utf8"), 10);
			if (Number.isInteger(holder) && holder !== process.pid && pidAlive(holder)) return { ok: false, pid: holder };
			rmSync(paths.lockFile, { force: true });
		}
	}
	return { ok: false, pid: -1 };
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
