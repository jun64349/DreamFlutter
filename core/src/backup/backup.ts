import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CORE_VERSION, RpcError, str, type Core, type CoreModule } from "../core.ts";
import type { CorePaths } from "../paths.ts";
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

	constructor(core: Core) {
		this.core = core;
		this.register();
	}

	/** Work folders a core that quit midway left behind (a pending switch keeps restore-staging). */
	async start(): Promise<void> {
		if (!existsSync(join(this.core.paths.dataDir, "restore-switch.json"))) await rm(join(this.core.paths.dataDir, "restore-staging"), { recursive: true, force: true });
		const dir = backupsDir(this.core.paths);
		for (const name of existsSync(dir) ? readdirSync(dir) : []) {
			if (name.startsWith(".work-") || name.endsWith(".partial")) await rm(join(dir, name), { recursive: true, force: true });
		}
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

	private async apply(staged: Staged, signal: AbortSignal, step: (s: string) => void, options: { undo?: boolean } = {}): Promise<unknown> {
		step("备份当前的数据");
		const auto = await this.export({
			out: autoPath(this.core.paths, "import"),
			kind: "import",
			credentials: "local",
			includeMaterials: true,
			includeSandbox: true,
			signal,
			step,
		});
		signal.throwIfAborted();
		step("准备切换");
		const result = {
			undo: options.undo === true,
			undoBackup: auto.path,
			from: { appVersion: staged.manifest.appVersion, createdAt: staged.manifest.createdAt, host: staged.manifest.source.host, user: staged.manifest.source.user, kind: staged.manifest.kind },
			counts: staged.counts,
			sessions: staged.sessions,
			materialsRestored: staged.materialsRestored,
			missingKeys: staged.missingKeys,
			sandbox: staged.sandbox,
			prefs: staged.prefs,
			notRestored: [
				...(staged.manifest.credentials === "none" ? ["API Key（备份里没有）"] : []),
				...(staged.preview.paths.filter((p) => p.kind === "workspace" && !p.exists).map((p) => `工作区 ${p.from}（这台电脑上没有）`)),
				"工作区里的文件（备份只记位置）",
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
			const kind = /^auto-(upgrade|import)-/.exec(name)?.[1] as BackupKind | undefined;
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

export function autoPath(paths: CorePaths, kind: "upgrade" | "import"): string {
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
