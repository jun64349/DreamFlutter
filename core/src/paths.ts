import { homedir } from "node:os";
import { join } from "node:path";

/** Where the core keeps its own state (not Pi's). */
export interface CorePaths {
	dataDir: string;
	/** SQLite database with memory, desk, tasks, schedules, confirmations and run logs. */
	dbFile: string;
	/** Discovery file the UI reads to find and authenticate to a running core. */
	infoFile: string;
	lockFile: string;
	logFile: string;
	/** 蝶君's home on this machine: its sessions open here, apart from every workbench workspace. */
	butterflyDir: string;
}

export function defaultDataDir(): string {
	const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
	return join(appData, "DreamFlutter");
}

export function corePaths(dataDir = defaultDataDir()): CorePaths {
	return {
		dataDir,
		dbFile: join(dataDir, "core.db"),
		infoFile: join(dataDir, "core.json"),
		lockFile: join(dataDir, "core.lock"),
		logFile: join(dataDir, "core.log"),
		butterflyDir: join(dataDir, "butterfly"),
	};
}

export function defaultAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}
