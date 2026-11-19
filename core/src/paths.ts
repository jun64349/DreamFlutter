import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { materialLocation, storageLocations } from "./storage/locations.ts";

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
	/** Throwaway files: shell scratch, uv and pip caches, dropped images. Safe to delete. */
	cacheDir: string;
}

/** The software folder: the one holding app\, core\ (and runtime\ in a package). */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Whether [root] points inside a macOS `.app/Contents/Resources` bundle. */
export function isMacAppBundle(root: string = APP_ROOT): boolean {
	return root.replaceAll("\\", "/").includes(".app/Contents/Resources");
}

/** 内测版（第 6 步朋友内测）：打包时在程序根目录放 beta-edition.json。内测版不检查、不下载更新。 */
export const BETA_EDITION = existsSync(join(APP_ROOT, "beta-edition.json")) || process.env.DREAMFLUTTER_BETA === "1";

/**
 * Everything the platform keeps lives in one folder next to the software
 * (v0.3.2, user's choice): `<software>\data` (or `~/Library/Application Support/DreamFlutter`
 * when running inside a macOS `.app` bundle). DREAMFLUTTER_DATA overrides it
 * (tests, and later a location picked in Settings).
 */
export function defaultDataDir(
	platform: NodeJS.Platform = process.platform,
	root: string = APP_ROOT,
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string {
	if (!env.DREAMFLUTTER_DATA && existsSync(join(root, "sq.version")) && existsSync(join(dirname(root), "Update.exe"))) return join(dirname(root), "data");
	if (!env.DREAMFLUTTER_DATA && platform === "darwin" && isMacAppBundle(root)) {
		return join(home, "Library", "Application Support", "DreamFlutter");
	}
	return env.DREAMFLUTTER_DATA || join(root, "data");
}

export function corePaths(dataDir = defaultDataDir()): CorePaths {
	const locations = storageLocations(dataDir);
	return {
		dataDir,
		dbFile: join(locations.database, "core.db"),
		infoFile: join(dataDir, "core.json"),
		lockFile: join(dataDir, "core.lock"),
		logFile: join(locations.logs, "core.log"),
		butterflyDir: materialLocation(dataDir),
		cacheDir: locations.cache,
	};
}

/**
 * DreamFlutter's own Pi folder (settings, models, skills, templates, sessions),
 * inside its data folder: apart from the Pi command line's ~/.pi/agent and any
 * other agent tool.
 */
export function defaultAgentDir(dataDir: string): string {
	return storageLocations(dataDir).configuration;
}

/** Where versions up to v0.3.1 kept the core's data. */
export function legacyDataDir(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string {
	if (platform === "darwin") return join(home, "Library", "Application Support", "DreamFlutter");
	const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
	return join(appData, "DreamFlutter");
}

/** The Pi folder versions up to v0.3.1 shared with the Pi command line. */
export function legacyAgentDir(): string {
	return join(homedir(), ".pi", "agent");
}

/** The skills folder several agent tools share (~/.agents/skills); Pi reads it, DreamFlutter does not. */
export function sharedAgentsSkillsDir(): string {
	return join(process.env.HOME || homedir(), ".agents", "skills");
}

/** A Pi resource loader's skillsOverride: drops the skills other agent tools share in ~/.agents/skills. */
export function dropSharedAgentSkills<T extends { skills: { filePath: string }[] }>(base: T): T {
	const shared = resolve(sharedAgentsSkillsDir()).toLowerCase();
	return { ...base, skills: base.skills.filter((s) => !resolve(s.filePath).toLowerCase().startsWith(shared + sep)) };
}
