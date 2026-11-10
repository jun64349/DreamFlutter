import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readdirSync, readFileSync, statSync, statfsSync, type Stats } from "node:fs";
import { copyFile, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import type { DatabaseSync } from "node:sqlite";
import type { CorePaths } from "../paths.ts";
import { redactBackup } from "../modules/providers.ts";
import { dpapiMany } from "../modules/secrets.ts";
import { writeArchive, type ArchiveFile } from "./archive.ts";
import { seal } from "./crypto.ts";
import { isInside } from "./path-map.ts";
import { storageLocations, type StorageLocations } from "../storage/locations.ts";

/**
 * Making a backup package (docs/v0.3.1-backup-design.md §三–四): take a
 * consistent copy of everything into a work folder (the database by VACUUM
 * INTO, session files up to their current length), then hash, seal the keys
 * if asked and zip it to `<out>.partial`, renamed to `<out>` only when
 * complete. Any failure or cancel leaves no package behind.
 */

export const FORMAT = "dreamflutter-backup";
export const FORMAT_VERSION = 1;
/** Packages from data older than this (v0.2) are refused: the app upgrades those itself. */
export const MIN_DB_VERSION = 8;

/** Data-folder entries never backed up (caches, process files, the sandbox disk, backups themselves). */
export function excludedFromData(name: string): boolean {
	const n = name.toLowerCase();
	return (
		["webview2", "core.json", "core.lock", "core-startup.json", "core.db", "core.db-wal", "core.db-shm", "sandbox", "backups", "trash", "secrets", "pi", "window", "cache", "migration.json"].includes(n) ||
		n.startsWith("core.log") ||
		["application-data", "user-content"].includes(n) || n.startsWith("storage-") ||
		n === "updates" ||
		n.startsWith("restore-")
	);
}

/** Pi's own files the app depends on (auth.json goes with the keys). */
export const PI_FILES = ["settings.json", "models.json", "models-store.json", "trust.json", "mcp.json", "skills", "prompts"];
/** Pi config that may hold plain-text keys: redacted unless the keys are sealed or kept local. */
const PI_KEYED = ["models.json", "mcp.json"];

export const EXCLUDED_NOTE = [
	"webview2（窗口的网页缓存）",
	"core.json、core.lock、core.log（后台运行时的临时文件）",
	"蝶君沙箱的虚拟磁盘（用随附镜像重建，只带 /workspace 和 /home/agent）",
	"core\\bin、~\\.pi\\agent\\bin（应用自带的工具）",
	"工作区里的文件（只记位置）",
];

export type Credentials = "none" | "password" | "local";
export type BackupKind = "manual" | "upgrade" | "import" | "migrate";

export interface ManifestFile {
	path: string;
	size: number;
	sha256: string;
}

export interface Manifest {
	format: typeof FORMAT;
	formatVersion: number;
	appVersion: string;
	dbVersion: number;
	kind: BackupKind;
	createdAt: number;
	credentials: Credentials;
	source: {
		platform: string;
		host: string;
		user: string;
		home: string;
		dataDir: string;
		agentDir: string;
		sessionsDir: string;
		locations?: StorageLocations;
		butterflyDir: string;
		workspaces: string[];
	};
	counts: Record<string, number>;
	includes: { sessions: number; materials: number; sandbox: boolean; prefs: boolean; keys: number; pi: string[] };
	excluded: string[];
	files: ManifestFile[];
}

export interface ExportSource {
	paths: CorePaths;
	agentDir: string;
	sessionsDir: string;
	/** The live database, copied with VACUUM INTO. */
	db: DatabaseSync;
	appVersion: string;
}

export interface ExportOptions {
	out: string;
	kind: BackupKind;
	credentials: Credentials;
	password?: string;
	includeMaterials: boolean;
	/** The window's preferences. */
	prefs?: Record<string, unknown>;
	/** Writes 蝶君's /workspace and /home/agent as a tar.gz; false when there is no sandbox. */
	sandbox?: (dest: string) => Promise<boolean>;
	signal?: AbortSignal;
	onProgress?: (step: string) => void;
	/** Which indexed session files to take (default: all). */
	sessionFilter?: (path: string) => boolean;
	/** The consistent copy is complete (runs and schedules may go on). */
	copied?: () => void;
}

export interface ExportResult {
	path: string;
	size: number;
	manifest: Manifest;
}

export async function createBackup(source: ExportSource, options: ExportOptions): Promise<ExportResult> {
	const work = join(source.paths.dataDir, "backups", `.work-${randomUUID()}`);
	const data = join(work, "data");
	const partial = `${options.out}.partial`;
	const step = (s: string) => {
		options.signal?.throwIfAborted();
		options.onProgress?.(s);
	};
	let copiedCalled = false;
	const copied = () => {
		if (!copiedCalled) options.copied?.();
		copiedCalled = true;
	};
	try {
		await mkdir(data, { recursive: true });
		step("复制数据库");
		const dbCopy = join(data, "appdata", "core.db");
		await mkdir(dirname(dbCopy), { recursive: true });
		source.db.exec(`VACUUM INTO '${dbCopy.replaceAll("'", "''")}'`);
		const { DatabaseSync } = await import("node:sqlite");
		const copy = new DatabaseSync(dbCopy, { readOnly: true });
		let dbVersion: number;
		let counts: Record<string, number>;
		let sessionFiles: string[];
		let materials: { id: string; path: string }[];
		let workspaces: string[];
		try {
			dbVersion = Number((copy.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
			counts = tableCounts(copy);
			sessionFiles = (copy.prepare("SELECT path FROM session_meta").all() as { path: string }[]).map((r) => r.path);
			if (copy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_recycle'").get()) {
				if (copy.prepare("SELECT 1 FROM session_recycle WHERE phase<>'stored' LIMIT 1").get()) throw new Error("回收站中有未完成的文件操作，请先完成恢复处理再备份");
				const recycled = copy.prepare("SELECT stored_path FROM session_recycle WHERE phase='stored' AND expires_at>?").all(Date.now()) as { stored_path: string }[];
				sessionFiles.push(...recycled.map((r) => r.stored_path));
			}
			materials = options.includeMaterials ? (copy.prepare("SELECT id, path FROM materials WHERE path IS NOT NULL AND path != ''").all() as { id: string; path: string }[]) : [];
			workspaces = workspacesOf(copy, source.paths.dataDir, options.prefs);
		} finally {
			copy.close();
		}

		step("复制数据文件");
		for (const name of readdirSync(source.paths.dataDir)) {
			if (excludedFromData(name) || ["cards", "butterfly"].includes(name)) continue;
			await cp(join(source.paths.dataDir, name), join(data, "appdata", name), { recursive: true, force: true, errorOnExist: false });
		}
		const locations = storageLocations(source.paths.dataDir, source.agentDir, source.sessionsDir);
		for (const [name, from] of [["cards", locations.cards], ["butterfly", source.paths.butterflyDir]]) {
			if (existsSync(from!)) await cp(from!, join(data, "appdata", name!), { recursive: true, force: true });
		}

		step("复制会话");
		let sessions = 0;
		for (const file of sessionFiles) {
			if (!isInside(source.sessionsDir, file) || (options.sessionFilter && !options.sessionFilter(file))) continue;
			let size: number;
			try {
				size = statSync(file).size;
			} catch {
				continue; // deleted since it was indexed
			}
			const dest = join(data, "sessions", relative(source.sessionsDir, file));
			await mkdir(dirname(dest), { recursive: true });
			// Session files only grow: up to the current length is a consistent copy.
			if (size > 0) await pipeline(createReadStream(file, { start: 0, end: size - 1 }), createWriteStream(dest));
			else await writeFile(dest, "");
			sessions++;
		}

		step("复制 Pi 的设置");
		const pi: string[] = [];
		for (const name of PI_FILES) {
			const from = name === "skills" ? locations.skills : name === "prompts" ? locations.templates : join(source.agentDir, name);
			if (!existsSync(from)) continue;
			await cp(from, join(data, "pi", name), { recursive: true, force: true });
			pi.push(name);
		}

		step("整理 API Key");
		const secretsDir = locations.secrets;
		const secretFiles = existsSync(secretsDir) ? readdirSync(secretsDir).filter((f) => f.endsWith(".dpapi")) : [];
		const authFile = join(source.agentDir, "auth.json");
		let sealed: Buffer | undefined;
		if (options.credentials === "local") {
			// Kept on this machine only (automatic backups): the DPAPI files as they are.
			if (secretFiles.length) await cp(secretsDir, join(data, "appdata", "secrets"), { recursive: true });
			if (existsSync(authFile)) {
				await mkdir(join(data, "pi"), { recursive: true });
				await copyFile(authFile, join(data, "pi", "auth.json"));
				pi.push("auth.json");
			}
		} else {
			if (options.credentials === "password") {
				if (!options.password) throw new Error("没有设置迁移密码");
				const plain = await dpapiMany("unprotect", secretFiles.map((f) => readFileSync(join(secretsDir, f), "utf8")));
				const files: Record<string, string> = {};
				for (const name of [...PI_KEYED, "auth.json"]) {
					const path = join(source.agentDir, name);
					if (existsSync(path)) files[`pi/${name}`] = readFileSync(path, "utf8");
				}
				const box = { secrets: Object.fromEntries(secretFiles.map((f, i) => [f, plain[i]!])), files };
				sealed = Buffer.from(JSON.stringify(await seal(Buffer.from(JSON.stringify(box), "utf8"), options.password)), "utf8");
			}
			for (const name of PI_KEYED) redactBackup(join(data, "pi", name));
		}
		copied();

		if (options.includeMaterials && materials.length) {
			step("复制蝶君的资料");
			for (const material of materials) {
				if (!existsSync(material.path)) continue;
				await cp(material.path, join(data, "materials", material.id, basename(material.path)), { recursive: true, force: true });
			}
		}

		let sandbox = false;
		if (options.sandbox) {
			step("打包蝶君沙箱里的文件");
			const tar = join(data, "sandbox", "workspace.tar.gz");
			await mkdir(dirname(tar), { recursive: true });
			sandbox = await options.sandbox(tar);
			if (!sandbox) await rm(join(data, "sandbox"), { recursive: true, force: true });
		}

		if (options.prefs) await writeFile(join(data, "prefs.json"), JSON.stringify(options.prefs, null, 2), "utf8");

		step("计算校验值");
		const files: ManifestFile[] = [];
		const archiveFiles: ArchiveFile[] = [];
		for (const path of await walk(data)) {
			const name = relative(work, path).split(/[\\/]/).join("/");
			const info = await stat(path);
			files.push({ path: name, size: info.size, sha256: await sha256(path) });
			archiveFiles.push({ name, path, stored: name.endsWith(".gz") });
		}
		const manifest: Manifest = {
			format: FORMAT,
			formatVersion: FORMAT_VERSION,
			appVersion: source.appVersion,
			dbVersion,
			kind: options.kind,
			createdAt: Date.now(),
			credentials: options.credentials,
			source: {
				platform: process.platform,
				host: hostname(),
				user: userInfo().username,
				home: homedir(),
				dataDir: source.paths.dataDir,
				locations,
				agentDir: source.agentDir,
				sessionsDir: source.sessionsDir,
				butterflyDir: source.paths.butterflyDir,
				workspaces,
			},
			counts,
			includes: {
				sessions,
				materials: existsSync(join(data, "materials")) ? readdirSync(join(data, "materials")).length : 0,
				sandbox,
				prefs: options.prefs !== undefined,
				keys: options.credentials === "none" ? 0 : secretFiles.length,
				pi,
			},
			excluded: EXCLUDED_NOTE,
			files,
		};

		step("压缩");
		const total = files.reduce((sum, f) => sum + f.size, 0);
		ensureSpace(dirname(options.out), total);
		const buffers: { name: string; data: Buffer }[] = [{ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") }];
		if (sealed) buffers.push({ name: "secrets.enc", data: sealed });
		await writeArchive(partial, archiveFiles, buffers, options.signal);
		options.signal?.throwIfAborted();
		await rename(partial, options.out);
		return { path: options.out, size: (await stat(options.out)).size, manifest };
	} catch (error) {
		await rm(partial, { force: true }).catch(() => {});
		throw error;
	} finally {
		copied();
		await rm(work, { recursive: true, force: true }).catch(() => {});
	}
}

/** Bytes a backup would take before compression (preflight). */
export function estimateSize(source: Omit<ExportSource, "db">, sessionFiles: string[], materialPaths: string[]): { data: number; sessions: number; materials: number } {
	let dataBytes = sizeOf(source.paths.dbFile);
	const locations = storageLocations(source.paths.dataDir, source.agentDir, source.sessionsDir);
	for (const name of safeReaddir(source.paths.dataDir)) if (!excludedFromData(name) && !["cards", "butterfly"].includes(name)) dataBytes += sizeOf(join(source.paths.dataDir, name));
	dataBytes += sizeOf(locations.cards) + sizeOf(source.paths.butterflyDir);
	for (const name of PI_FILES) dataBytes += sizeOf(name === "skills" ? locations.skills : name === "prompts" ? locations.templates : join(source.agentDir, name));
	let sessions = 0;
	for (const file of sessionFiles) sessions += sizeOf(file);
	let materials = 0;
	for (const path of materialPaths) materials += sizeOf(path);
	return { data: dataBytes, sessions, materials };
}

/** Free bytes on [dir]'s volume, or undefined when unknown. */
export function freeSpace(dir: string): number | undefined {
	try {
		const s = statfsSync(existingParent(dir));
		return Number(s.bavail) * Number(s.bsize);
	} catch {
		return undefined;
	}
}

function ensureSpace(dir: string, bytes: number): void {
	const free = freeSpace(dir);
	if (free !== undefined && free < bytes * 1.1) throw new Error(`保存位置的磁盘空间不够：需要约 ${formatBytes(bytes)}，只剩 ${formatBytes(free)}`);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function existingParent(dir: string): string {
	let current = dir;
	while (!existsSync(current) && dirname(current) !== current) current = dirname(current);
	return current;
}

function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function sizeOf(path: string): number {
	let info: Stats;
	try {
		info = statSync(path);
	} catch {
		return 0;
	}
	if (!info.isDirectory()) return info.size;
	let total = 0;
	for (const name of safeReaddir(path)) total += sizeOf(join(path, name));
	return total;
}

async function walk(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(path)));
		else if (entry.isFile()) out.push(path);
	}
	return out.sort();
}

export async function sha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

export function tableCounts(db: DatabaseSync): Record<string, number> {
	const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all() as { name: string; sql: string | null }[];
	const virtual = rows.filter((r) => /CREATE VIRTUAL TABLE/i.test(r.sql ?? "")).map((r) => r.name);
	const counts: Record<string, number> = {};
	for (const { name } of rows) {
		if (name.startsWith("sqlite_") || virtual.some((v) => name.startsWith(`${v}_`))) continue;
		counts[name] = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n);
	}
	return counts;
}

/** Workspace folders the data refers to (蝶君's home and other app folders left out). */
function workspacesOf(db: DatabaseSync, dataDir: string, prefs?: Record<string, unknown>): string[] {
	const found = new Map<string, string>();
	const add = (cwd: unknown) => {
		if (typeof cwd !== "string" || !cwd || cwd.startsWith("\\\\") || isInside(dataDir, cwd)) return;
		const key = cwd.toLowerCase().replace(/[\\/]+$/, "");
		if (!found.has(key)) found.set(key, cwd.replace(/[\\/]+$/, "") || cwd);
	};
	for (const table of ["session_meta", "tasks", "schedules", "cards", "memories", "runs", "notes", "proposals"]) {
		try {
			for (const row of db.prepare(`SELECT DISTINCT cwd FROM "${table}" WHERE cwd IS NOT NULL`).all() as { cwd: string }[]) add(row.cwd);
		} catch {
			// Table missing in this version.
		}
	}
	if (prefs) {
		add(prefs.workspace);
		if (Array.isArray(prefs.recentWorkspaces)) for (const w of prefs.recentWorkspaces) add(w);
	}
	return [...found.values()].sort((a, b) => a.localeCompare(b)).slice(0, 1000);
}
