import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CORE_VERSION, RpcError, str, type Core, type CoreModule } from "../core.ts";
import { corePaths, type CorePaths } from "../paths.ts";
import { MIGRATIONS } from "../schema.ts";
import { Sandbox } from "../sandbox/sandbox.ts";
import { createBackup, estimateSize, formatBytes, freeSpace, MIN_DB_VERSION, type BackupKind, type ExportResult } from "./export.ts";
import { userTables } from "./parts.ts";
import { inspectBackup, RestoreError, stageBackup, type Preview, type RestoreTarget, type Staged } from "./restore.ts";
import { resultFile, writeSwitchRecord } from "./switch.ts";

/**
 * Settings › 数据与迁移 (docs/v0.3.1-backup-design.md): export a package,
 * import one (check → preview → stage → automatic backup of the current
 * data → switch on restart), undo the last restore, and the list of
 * backups. Long steps run as one job at a time; the window follows its
 * `backup.job` events.
 */

export const AUTO_KEEP = 3;
/** In the data folder: the move from the v0.3.1 locations was tried (state started / switching / done / failed). */
export const MIGRATION_FILE = "migration.json";
/** Left in the old data folder once its data has moved. */
export const MOVED_MARKER = "已搬到新位置.txt";

/** The folders versions up to v0.3.1 used: %APPDATA%\DreamFlutter and the shared ~/.pi/agent. */
export interface LegacyData {
	dataDir: string;
	agentDir: string;
	/** Default: <agentDir>/sessions. */
	sessionsDir?: string;
}
const EXT = ".dfbackup";

export type JobKind = "export" | "stage" | "apply";

export interface Job {
	id: string;
	kind: JobKind;
	status: "running" | "done" | "failed" | "cancelled";
	step: string | null;
	error: string | null;
	result: unknown;
	startedAt: number;
}

export interface HistoryEntry {
	path: string;
	kind: BackupKind;
	createdAt: number;
	size: number;
	exists: boolean;
	/** Automatic backups live in the backups folder and can be deleted here. */
	auto: boolean;
}

export function backupsDir(paths: CorePaths): string {
	return join(paths.dataDir, "backups");
}

export class BackupModule implements CoreModule {
	private readonly core: Core;
	private job: Job | null = null;
	private abort: AbortController | null = null;
	private staged: Staged | null = null;

	/** Where versions up to v0.3.1 kept the data, when this core runs in the default data folder (main.ts). */
	private readonly legacy: LegacyData | undefined;

	constructor(core: Core, legacy?: LegacyData) {
		this.core = core;
		this.legacy = legacy;
		this.register();
	}

	/** Work folders a core that quit midway left behind (a pending switch keeps restore-staging). */
	async start(): Promise<void> {
		if (!existsSync(join(this.core.paths.dataDir, "restore-switch.json"))) await rm(join(this.core.paths.dataDir, "restore-staging"), { recursive: true, force: true });
		const dir = backupsDir(this.core.paths);
		for (const name of existsSync(dir) ? readdirSync(dir) : []) {
			if (name.startsWith(".work-") || name.endsWith(".partial")) await rm(join(dir, name), { recursive: true, force: true });
		}
		this.afterMigration();
		if (this.legacy && this.shouldMigrate(this.legacy)) {
			// In the background: the window connects meanwhile and hears that the data is moving.
			setTimeout(() => {
				try {
					this.startJob("apply", (signal, step) => this.migrate(this.legacy!, signal, step));
				} catch (error) {
					this.core.log.warn("migration could not start", error);
				}
			}, 1500).unref();
		}
	}

	// ---- moving v0.3.1 data into the software's data folder (v0.3.2) ----------------------

	private get migrationFile(): string {
		return join(this.core.paths.dataDir, MIGRATION_FILE);
	}

	/** Only once, only into a data folder nothing has happened in yet, only from data not moved before. */
	private shouldMigrate(legacy: LegacyData): boolean {
		if (existsSync(this.migrationFile) || !existsSync(join(legacy.dataDir, "core.db")) || existsSync(join(legacy.dataDir, MOVED_MARKER))) return false;
		const used = this.core.db.get<{ n: number }>("SELECT (SELECT COUNT(*) FROM runs) + (SELECT COUNT(*) FROM memories) + (SELECT COUNT(*) FROM gateway_channels) AS n");
		return (used?.n ?? 0) === 0;
	}

	private async migrate(legacy: LegacyData, signal: AbortSignal, step: (s: string) => void): Promise<unknown> {
		writeFileSync(this.migrationFile, JSON.stringify({ state: "started", from: legacy, at: Date.now() }, null, 2), "utf8");
		this.core.broadcast({ event: "backup.migrating", from: legacy.dataDir, to: this.core.paths.dataDir });
		step("整理原来的数据");
		const legacySessions = legacy.sessionsDir ?? join(legacy.agentDir, "sessions");
		const db = new DatabaseSync(join(legacy.dataDir, "core.db"));
		let file: string;
		try {
			const ours = dreamFlutterSessions(db);
			const result = await createBackup(
				{ paths: corePaths(legacy.dataDir), agentDir: legacy.agentDir, sessionsDir: legacySessions, db, appVersion: CORE_VERSION },
				{
					out: autoPath(this.core.paths, "migrate"),
					kind: "migrate",
					credentials: "local",
					includeMaterials: false,
					// The Pi command line's own sessions stay where they are.
					sessionFilter: (path) => ours.has(path.toLowerCase()) || hasDreamFlutterEntries(path),
					signal,
					onProgress: step,
				},
			);
			file = result.path;
		} finally {
			db.close();
		}
		// The search tools Pi downloaded (a development checkout has none of its own).
		for (const tool of ["rg.exe", "fd.exe", "rg", "fd"]) {
			const from = join(legacy.agentDir, "bin", tool);
			if (existsSync(from)) {
				mkdirSync(join(this.core.agentDir, "bin"), { recursive: true });
				copyFileSync(from, join(this.core.agentDir, "bin", tool));
			}
		}
		const sandbox = this.core.module(Sandbox);
		if (sandbox) {
			step("搬蝶君的沙箱");
			await sandbox.adopt(join(legacy.dataDir, "sandbox"));
		}
		const staged = await stageBackup(file, { ...this.target, minDbVersion: 1 }, { parts: this.core.backupParts, signal, onProgress: step });
		writeFileSync(this.migrationFile, JSON.stringify({ state: "switching", from: legacy, at: Date.now() }, null, 2), "utf8");
		return this.apply(staged, signal, step, { migratedFrom: legacy, skipAutoBackup: true });
	}

	/** After a migration's switch: the old folder is marked so no later start moves it again. */
	private afterMigration(): void {
		let state: { state?: string; from?: LegacyData };
		try {
			state = JSON.parse(readFileSync(this.migrationFile, "utf8"));
		} catch {
			return;
		}
		if (state.state !== "switching" || !state.from) return;
		let result: { ok?: boolean; error?: string } = {};
		try {
			result = JSON.parse(readFileSync(resultFile(this.core.paths), "utf8"));
		} catch {}
		if (result.ok) {
			try {
				writeFileSync(
					join(state.from.dataDir, MOVED_MARKER),
					`DreamFlutter 从 v0.3.2 起把数据放在软件目录下的 data 文件夹：\n${this.core.paths.dataDir}\n这里的数据已经复制过去，确认新版本一切正常后可以删除这个文件夹（以及 ${state.from.agentDir} 里 DreamFlutter 的会话）。\n`,
					"utf8",
				);
			} catch (error) {
				this.core.log.warn("could not mark the old data folder", error);
			}
		}
		writeFileSync(this.migrationFile, JSON.stringify({ ...state, state: result.ok ? "done" : "failed", error: result.error, at: Date.now() }, null, 2), "utf8");
	}

	private get sessionsDir(): string {
		return this.core.sessionDir ?? join(this.core.agentDir, "sessions");
	}

	private get target(): RestoreTarget {
		return { paths: this.core.paths, agentDir: this.core.agentDir, sessionsDir: this.sessionsDir, appVersion: CORE_VERSION };
	}

	/** Every table in the database with the module that owns it (a test checks none is missing). */
	unclaimedTables(): string[] {
		const claimed = new Set(this.core.backupParts.flatMap((p) => p.tables));
		return userTables(this.core.db).filter((t) => !claimed.has(t));
	}

	private register(): void {
		const core = this.core;
		core.register("backup.overview", () => this.overview());
		core.register("backup.job", () => this.job);
		core.register("backup.cancel", () => {
			this.abort?.abort();
			return { ok: true };
		});
		core.register("backup.export", (p) => {
			const out = str(p.path);
			if (!out) throw new RpcError("bad_request", "请选择保存位置");
			const includeKeys = p.includeKeys === true;
			const password = str(p.password);
			if (includeKeys && (!password || password.length < 6)) throw new RpcError("bad_request", "包含 API Key 时要设置至少 6 位的迁移密码");
			return this.startJob("export", (signal, step) =>
				this.export({
					out: out.toLowerCase().endsWith(EXT) ? out : out + EXT,
					kind: "manual",
					credentials: includeKeys ? "password" : "none",
					password,
					includeMaterials: p.includeMaterials !== false,
					includeSandbox: p.includeSandbox !== false,
					prefs: p.prefs && typeof p.prefs === "object" ? (p.prefs as Record<string, unknown>) : undefined,
					signal,
					step,
				}),
			);
		});
		core.register("backup.inspect", async (p) => {
			const path = str(p.path);
			if (!path) throw new RpcError("bad_request", "请选择备份文件");
			try {
				const { archive, preview } = await inspectBackup(path, this.target);
				archive.close();
				return preview;
			} catch (error) {
				throw new RpcError("bad_backup", (error as Error).message);
			}
		});
		core.register("backup.stage", (p) => {
			const path = str(p.path);
			if (!path) throw new RpcError("bad_request", "请选择备份文件");
			const workspaces = Array.isArray(p.workspaces)
				? (p.workspaces as { from?: unknown; to?: unknown }[]).filter((w) => typeof w?.from === "string" && typeof w?.to === "string").map((w) => ({ from: w.from as string, to: w.to as string }))
				: undefined;
			return this.startJob("stage", async (signal, step) => {
				this.staged = null;
				const staged = await stageBackup(path, this.target, { password: str(p.password), workspaces, parts: core.backupParts, signal, onProgress: step });
				this.staged = staged;
				return stagedSummary(staged);
			});
		});
		core.register("backup.apply", () => {
			const staged = this.staged;
			if (!staged || !existsSync(staged.dir)) throw new RpcError("not_staged", "请先检查备份包");
			return this.startJob("apply", (signal, step) => this.apply(staged, signal, step));
		});
		core.register("backup.discardStaged", async () => {
			this.staged = null;
			await rm(join(core.paths.dataDir, "restore-staging"), { recursive: true, force: true });
			return { ok: true };
		});
		core.register("backup.restoreResult", () => {
			try {
				return JSON.parse(readFileSync(resultFile(core.paths), "utf8"));
			} catch {
				return null;
			}
		});
		core.register("backup.ackResult", () => {
			const file = resultFile(core.paths);
			try {
				const result = JSON.parse(readFileSync(file, "utf8"));
				// The preferences are applied once; the rest stays for the undo button.
				writeFileSync(file, JSON.stringify({ ...result, seen: true, prefs: undefined }, null, 2), "utf8");
			} catch {}
			return { ok: true };
		});
		core.register("backup.undo", () => {
			let result: { undoBackup?: string } | null = null;
			try {
				result = JSON.parse(readFileSync(resultFile(core.paths), "utf8"));
			} catch {}
			const path = result?.undoBackup;
			if (!path || !existsSync(path)) throw new RpcError("not_found", "找不到导入前的自动备份，无法撤销");
			return this.startJob("apply", async (signal, step) => {
				const staged = await stageBackup(path, this.target, { parts: core.backupParts, signal, onProgress: step });
				return this.apply(staged, signal, step, { undo: true });
			});
		});
		core.register("backup.history", () => this.history());
		core.register("backup.delete", async (p) => {
			const path = str(p.path);
			const entry = this.history().find((e) => e.path === path);
			if (!entry) throw new RpcError("not_found", "没有这个备份");
			if (entry.auto) await rm(entry.path, { force: true });
			else this.writeManual(this.readManual().filter((e) => e.path !== path));
			return this.history();
		});
	}

	// ---- jobs --------------------------------------------------------------------------

	private startJob(kind: JobKind, run: (signal: AbortSignal, step: (s: string) => void) => Promise<unknown>): Job {
		if (this.job?.status === "running") throw new RpcError("busy", "已经有一个备份或恢复在进行");
		const job: Job = { id: randomUUID(), kind, status: "running", step: null, error: null, result: null, startedAt: Date.now() };
		const abort = new AbortController();
		this.job = job;
		this.abort = abort;
		const changed = () => this.core.broadcast({ event: "backup.job", job });
		const step = (s: string) => {
			job.step = s;
			changed();
		};
		void run(abort.signal, step).then(
			(result) => {
				job.status = "done";
				job.result = result;
				job.step = null;
				changed();
			},
			(error: unknown) => {
				job.status = abort.signal.aborted ? "cancelled" : "failed";
				job.error = abort.signal.aborted ? "已取消" : error instanceof Error ? error.message : String(error);
				job.step = null;
				this.core.log.warn(`backup ${kind} ${job.status}`, error);
				changed();
			},
		);
		changed();
		return job;
	}

	// ---- export ------------------------------------------------------------------------

	private async export(options: {
		out: string;
		kind: BackupKind;
		credentials: "none" | "password" | "local";
		password?: string;
		includeMaterials: boolean;
		includeSandbox: boolean;
		prefs?: Record<string, unknown>;
		signal: AbortSignal;
		step: (s: string) => void;
	}): Promise<ExportResult> {
		const busy = this.core.busySlots();
		if (busy.length) throw new RpcError("busy", `有 ${busy.length} 个任务正在运行，请等它结束或先停止，再备份。`);
		const sandbox = this.core.module(Sandbox);
		this.core.maintenance = "正在备份数据";
		try {
			const result = await createBackup(
				{ paths: this.core.paths, agentDir: this.core.agentDir, sessionsDir: this.sessionsDir, db: this.core.db.raw, appVersion: CORE_VERSION },
				{
					out: options.out,
					kind: options.kind,
					credentials: options.credentials,
					password: options.password,
					includeMaterials: options.includeMaterials,
					prefs: options.prefs,
					sandbox: options.includeSandbox && sandbox ? (dest) => sandbox.archiveWorkspace(dest) : undefined,
					signal: options.signal,
					onProgress: options.step,
					copied: () => {
						this.core.maintenance = undefined;
					},
				},
			);
			if (options.kind === "manual") this.writeManual([{ path: result.path, kind: "manual" as const, createdAt: result.manifest.createdAt, size: result.size }, ...this.readManual().filter((e) => e.path !== result.path)].slice(0, 50));
			else pruneAuto(this.core.paths, options.kind);
			return result;
		} finally {
			this.core.maintenance = undefined;
		}
	}

	private async apply(
		staged: Staged,
		signal: AbortSignal,
		step: (s: string) => void,
		options: { undo?: boolean; migratedFrom?: LegacyData; skipAutoBackup?: boolean } = {},
	): Promise<unknown> {
		let auto: ExportResult | undefined;
		if (!options.skipAutoBackup) {
			step("备份当前的数据");
			auto = await this.export({
				out: autoPath(this.core.paths, "import"),
				kind: "import",
				credentials: "local",
				includeMaterials: true,
				includeSandbox: true,
				signal,
				step,
			});
		}
		signal.throwIfAborted();
		step("准备切换");
		const result = {
			undo: options.undo === true,
			undoBackup: auto?.path,
			migratedFrom: options.migratedFrom,
			from: { appVersion: staged.manifest.appVersion, createdAt: staged.manifest.createdAt, host: staged.manifest.source.host, user: staged.manifest.source.user, kind: staged.manifest.kind },
			counts: staged.counts,
			sessions: staged.sessions,
			materialsRestored: staged.materialsRestored,
			missingKeys: staged.missingKeys,
			sandbox: staged.sandbox,
			prefs: staged.prefs,
			notRestored: [
				...(staged.manifest.credentials === "none" ? ["API Key（备份里没有）"] : []),
				...(options.migratedFrom ? ["Pi 命令行自己的会话（留在原来的文件夹）"] : []),
				...(staged.preview.paths.filter((p) => p.kind === "workspace" && !p.exists).map((p) => `工作区 ${p.from}（这台电脑上没有）`)),
				...(options.migratedFrom ? [] : ["工作区里的文件（备份只记位置）"]),
			],
			schedulesPaused: true,
		};
		writeSwitchRecord(this.core.paths, this.core.agentDir, staged, result);
		this.staged = null;
		// Nothing new starts between here and the restart.
		this.core.maintenance = "正在切换到备份的数据";
		// The window reconnects and so starts a new core, which switches before opening the database.
		this.core.broadcast({ event: "backup.restarting" });
		setTimeout(() => void this.core.shutdown(), 300);
		return { restarting: true };
	}

	// ---- overview and history ------------------------------------------------------------

	private async overview(): Promise<Record<string, unknown>> {
		const sessions = this.core.db.all<{ path: string }>("SELECT path FROM session_meta").map((r) => r.path);
		const materials = this.core.db.all<{ path: string }>("SELECT path FROM materials WHERE path IS NOT NULL AND path != ''").map((r) => r.path);
		const estimate = estimateSize({ paths: this.core.paths, agentDir: this.core.agentDir, sessionsDir: this.sessionsDir, appVersion: CORE_VERSION }, sessions, materials);
		const sandbox = this.core.module(Sandbox);
		const status = sandbox ? await sandbox.status().catch(() => undefined) : undefined;
		const history = this.history();
		return {
			busy: this.core.busySlots().map((s) => s.info().sessionName ?? s.cwd),
			estimate,
			estimateText: formatBytes(estimate.data + estimate.sessions + estimate.materials),
			materialsCount: materials.length,
			materialsWarning: estimate.materials > 200 * 1024 ** 2,
			sandbox: status?.state === "ready",
			sandboxDiskBytes: status?.diskBytes ?? null,
			backupsDir: backupsDir(this.core.paths),
			autoBytes: history.filter((h) => h.auto).reduce((sum, h) => sum + h.size, 0),
			freeBytes: freeSpace(this.core.paths.dataDir) ?? null,
			job: this.job,
			history,
		};
	}

	history(): HistoryEntry[] {
		const dir = backupsDir(this.core.paths);
		const auto: HistoryEntry[] = [];
		for (const name of existsSync(dir) ? readdirSync(dir) : []) {
			const kind = /^auto-(upgrade|import|migrate)-/.exec(name)?.[1] as BackupKind | undefined;
			if (!kind || !name.endsWith(EXT)) continue;
			const path = join(dir, name);
			const info = statSync(path);
			auto.push({ path, kind, createdAt: info.mtimeMs, size: info.size, exists: true, auto: true });
		}
		const manual = this.readManual().map((e) => ({ ...e, exists: existsSync(e.path), auto: false }));
		return [...auto, ...manual].sort((a, b) => b.createdAt - a.createdAt);
	}

	private get manualFile(): string {
		return join(backupsDir(this.core.paths), "history.json");
	}

	private readManual(): Omit<HistoryEntry, "exists" | "auto">[] {
		try {
			const list = JSON.parse(readFileSync(this.manualFile, "utf8"));
			return Array.isArray(list) ? list : [];
		} catch {
			return [];
		}
	}

	private writeManual(list: Omit<HistoryEntry, "exists" | "auto">[]): void {
		mkdirSync(backupsDir(this.core.paths), { recursive: true });
		writeFileSync(this.manualFile, JSON.stringify(list, null, 2), "utf8");
	}
}

function stagedSummary(staged: Staged): Record<string, unknown> {
	return {
		preview: staged.preview,
		counts: staged.counts,
		sessions: staged.sessions,
		materialsRestored: staged.materialsRestored,
		missingKeys: staged.missingKeys,
		sandbox: staged.sandbox,
		prefs: staged.prefs !== undefined,
	};
}

export function autoPath(paths: CorePaths, kind: "upgrade" | "import" | "migrate"): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(backupsDir(paths), `auto-${kind}-${stamp}${EXT}`);
}

/** Keeps the newest [AUTO_KEEP] automatic backups of [kind]; touches nothing else. */
export function pruneAuto(paths: CorePaths, kind: BackupKind): void {
	const dir = backupsDir(paths);
	if (!existsSync(dir)) return;
	const files = readdirSync(dir)
		.filter((n) => n.startsWith(`auto-${kind}-`) && n.endsWith(EXT))
		.sort()
		.reverse();
	for (const name of files.slice(AUTO_KEEP)) void rm(join(dir, name), { force: true });
}

/**
 * Before the app upgrades a v0.3.0-or-later database (main.ts, before the
 * core opens it): an automatic backup, kept on this machine with its keys.
 */
export async function backupBeforeUpgrade(paths: CorePaths, agentDir: string, sessionsDir: string, log: { info(m: string): void; warn(m: string, e?: unknown): void }): Promise<void> {
	if (!existsSync(paths.dbFile)) return;
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(paths.dbFile);
		const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
		if (version < MIN_DB_VERSION || version >= MIGRATIONS.length) return;
		log.info(`backup: database v${version} → v${MIGRATIONS.length}, backing up first`);
		const result = await createBackup(
			{ paths, agentDir, sessionsDir, db, appVersion: CORE_VERSION },
			{ out: autoPath(paths, "upgrade"), kind: "upgrade", credentials: "local", includeMaterials: false },
		);
		log.info(`backup: ${result.path} (${formatBytes(result.size)})`);
		pruneAuto(paths, "upgrade");
	} catch (error) {
		log.warn("backup before upgrade failed", error);
	} finally {
		db?.close();
	}
}

export { RestoreError, type Preview };

/** Session files the old data refers to (runs, tasks, cards, schedules…): DreamFlutter's, not the Pi command line's. */
export function dreamFlutterSessions(db: DatabaseSync): Set<string> {
	const out = new Set<string>();
	for (const [table, column] of [["runs", "session_file"], ["tasks", "session_file"], ["cards", "session_file"], ["schedules", "session_file"], ["schedule_runs", "session_file"], ["notices", "session_file"], ["memories", "source_session"]]) {
		try {
			for (const row of db.prepare(`SELECT DISTINCT "${column}" AS p FROM "${table}" WHERE "${column}" IS NOT NULL`).all() as { p: string }[]) out.add(row.p.toLowerCase());
		} catch {
			// Older database without this table.
		}
	}
	return out;
}

/** DreamFlutter writes its own entries (agent mode, cards…) early in every session it starts. */
export function hasDreamFlutterEntries(path: string): boolean {
	try {
		const fd = openSync(path, "r");
		try {
			const buffer = Buffer.alloc(16 * 1024);
			const n = readSync(fd, buffer, 0, buffer.length, 0);
			return buffer.subarray(0, n).toString("utf8").includes('"customType":"df.');
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
}
