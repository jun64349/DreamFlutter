import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { shellJobsBySession, type BackgroundCommand, type Job, type JobRegistry, type ShellStopSource } from "../agent/shell.ts";
import { normalizeCwd, requireStr, RpcError, samePath, type Core, type CoreModule, type Params } from "../core.ts";
import { MASK, redact } from "../security/redaction.ts";
import type { Slot } from "../slots/slot.ts";

const MAX_READ_BYTES = 64 * 1024;
const PRIVATE_OUTPUT_BYTES = 1024 * 1024;
const STOP_WAIT_MS = 5000;
const LOST_DETAIL = "后台重启时这个作业已经不在了";
const statuses = ["running", "completed", "failed", "cancelled", "lost"] as const;
type Status = (typeof statuses)[number];
type ResultStatus = Exclude<Status, "running" | "lost">;
type StopSource = "model" | ShellStopSource;

interface JobRow {
	id: string;
	session_file: string | null;
	slot_id: string;
	cwd: string;
	sandboxed: number;
	kind: string;
	label: string;
	command: string | null;
	service: number;
	status: Status;
	exit_code: number | null;
	detail: string | null;
	started_at: number;
	ended_at: number | null;
	stopped_by: StopSource | null;
	output_path: string | null;
	goal_id: string | null;
	owner_run_id: string | null;
	goal_revision: number | null;
}
type JobIdentity = Pick<JobRow, "id" | "session_file" | "cwd" | "kind" | "label" | "command" | "service" | "started_at">;
type Outcome = { status: ResultStatus; exitCode?: number | null; detail?: string; stoppedBy?: StopSource };
interface TrackedJob {
	append(text: string): void;
	finish(outcome: Outcome): void;
}
interface LiveJob {
	row: JobRow;
	private: boolean;
	cancel: (source: ShellStopSource) => void;
	stopSource?: ShellStopSource;
	done: Promise<void>;
	resolve: () => void;
	outputFailed: boolean;
}
interface PrivateOutput { buffer: Buffer; dropped: number }

function redactCommand(command: string): string {
	// Configured keys and recognized providers are handled by the shared redactor.
	// Command arguments can also contain short, explicitly named credentials.
	return redact(command, true).replace(
		/(--(?:api[-_]?key|(?:auth[-_]?)?token|password|secret)(?:[=\s]+)|\b(?:[\w]+_)?(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_KEY|PASSWORD)\s*=\s*)(?:"(?:[^"\r\n]|"")*"|'(?:[^'\r\n]|'')*'|[^\s;|&]+)/gi,
		(_match, prefix: string) => prefix + MASK,
	);
}

export class JobsModule implements CoreModule {
	private readonly core: Core;
	private readonly outputDir: string;
	private readonly active = new Map<string, LiveJob>();
	private readonly privateJobs = new Map<string, { row: JobRow; output: PrivateOutput }>();
	private shutdown?: Promise<void>;
	private closed = false;

	constructor(core: Core) {
		this.core = core;
		this.outputDir = join(core.paths.cacheDir, "jobs");
		core.declareBackup({
			id: "jobs", title: "后台作业", tables: ["jobs"],
			paths: { jobs: { session_file: "path", cwd: "path", output_path: "path" } },
			onStage: db => { db.run("UPDATE jobs SET output_path=NULL WHERE output_path IS NOT NULL"); },
		});
		core.register("jobs.list", p => this.list(p));
		core.register("jobs.output", p => this.output(p));
		core.register("jobs.stop", p => this.stopJob(requireStr(p.id, "id")));
		core.beforeShutdown(() => this.stop());
	}

	start(): void {
		const orphaned = this.core.db.all<JobRow>("SELECT * FROM jobs WHERE status='running'");
		if (!orphaned.length) return;
		const at = Date.now();
		this.core.db.run("UPDATE jobs SET status='lost',ended_at=?,detail=? WHERE status='running'", at, LOST_DETAIL);
		for (const row of orphaned) this.changed({ ...row, status: "lost" });
	}

	stop(): Promise<void> {
		return this.shutdown ??= this.stopAll();
	}

	private async stopAll(): Promise<void> {
		// Set a closed-to-new-work state synchronously, then let every owner settle its output.
		await Promise.resolve();
		await Promise.allSettled([...this.active.values()].map(job => this.requestStop(job, "shutdown")));
		this.closed = true;
	}

	onSlotClosed(slot: Slot): void {
		for (const [id, entry] of this.privateJobs) {
			if (entry.row.slot_id === slot.slotId) this.privateJobs.delete(id);
		}
	}

	extensions({ slotId }: { slotId: string }): ExtensionFactory[] {
		return [pi => {
			pi.on("session_start", (_event, ctx) => {
				const registry = shellJobsBySession.get(ctx.sessionManager);
				if (registry) registry.onBackground = (job, command) => {
					try { this.trackShell(slotId, ctx.sessionManager.getSessionFile() ?? null, registry, job, command); }
					catch (error) { this.core.log.warn("无法登记后台作业", error); }
				};
			});
		}];
	}

	private trackShell(slotId: string, sessionFile: string | null, registry: JobRegistry, job: Job, command: BackgroundCommand): void {
		const slot = this.core.slots.get(slotId);
		if (!slot || this.shutdown) return;
		const entry = this.track(slot, {
			id: job.id, session_file: sessionFile, cwd: command.cwd, kind: job.kind, label: command.label, command: job.label,
			service: Number(command.service), started_at: job.startedAt,
		}, source => registry.stop(job, source));
		const append = (bytes: Buffer) => this.write(entry, bytes);
		const listeners: (() => void)[] = [];
		for (const stream of [job.stdout, job.stderr]) {
			try { listeners.push(stream.observe(append)); }
			catch (error) { this.core.log.warn("无法读取后台作业先前的输出", error); }
		}
		void job.done.then(() => {
			for (const unsubscribe of listeners) unsubscribe();
			this.finish(entry, {
				status: job.status === "running" ? "failed" : job.status, exitCode: job.exitCode, detail: job.detail,
				stoppedBy: job.stoppedBy ?? (job.killedByModel ? "model" : undefined),
			});
		}).catch(error => this.core.log.warn("无法记录后台作业的结局", error));
	}

	trackSubagent(slot: Slot, cwd: string, label: string, cancel: () => void): TrackedJob | undefined {
		if (this.shutdown) return undefined;
		try {
			const entry = this.track(slot, {
				id: randomUUID(), session_file: slot.info().sessionFile, cwd, kind: "subagent", label, command: null,
				service: 0, started_at: Date.now(),
			}, cancel);
			return {
				append: text => this.write(entry, Buffer.from(redact(text, true))),
				finish: outcome => this.finish(entry, outcome),
			};
		} catch (error) {
			this.core.log.warn("无法登记子 Agent 作业", error);
			return undefined;
		}
	}

	private track(slot: Slot, identity: JobIdentity, cancel: LiveJob["cancel"]): LiveJob {
		const run = slot.currentRun;
		const goal = !slot.incognito && run?.taskId ? this.core.db.get<{ goal_id: string; revision: number }>(`
			SELECT i.goal_id,i.revision FROM goal_intents i JOIN tasks t ON t.goal_id=i.goal_id
			WHERE i.run_id=? AND i.action='run' AND i.status='started' AND t.id=?`, run.id, run.taskId) : undefined;
		const row: JobRow = {
			...identity, label: redactCommand(identity.label), command: identity.command === null ? null : redactCommand(identity.command),
			slot_id: slot.slotId, sandboxed: Number(slot.sandboxed), status: "running", exit_code: null, detail: null,
			ended_at: null, stopped_by: null, output_path: null,
			goal_id: goal?.goal_id ?? null, goal_revision: goal?.revision ?? null, owner_run_id: goal ? run!.id : null,
		};
		if (slot.incognito) {
			this.privateJobs.set(row.id, { row, output: { buffer: Buffer.alloc(0), dropped: 0 } });
		} else {
			this.core.db.run(`INSERT INTO jobs(id,session_file,slot_id,cwd,sandboxed,kind,label,command,service,status,started_at,goal_id,goal_revision,owner_run_id)
				VALUES(?,?,?,?,?,?,?,?,?,'running',?,?,?,?)`, row.id, row.session_file, row.slot_id, row.cwd, row.sandboxed, row.kind,
				row.label, row.command, row.service, row.started_at, row.goal_id, row.goal_revision, row.owner_run_id);
		}
		let resolveDone!: () => void;
		const done = new Promise<void>(resolve => { resolveDone = resolve; });
		const entry: LiveJob = { row, private: slot.incognito, cancel, done, resolve: resolveDone, outputFailed: false };
		this.active.set(row.id, entry);
		this.changed(row);
		return entry;
	}

	private write(entry: LiveJob, bytes: Buffer): void {
		const row = entry.row;
		if (this.closed || row.status !== "running" || !bytes.length || entry.outputFailed) return;
		if (entry.private) {
			const output = this.privateJobs.get(row.id)?.output;
			if (output) {
				const buffer = Buffer.concat([output.buffer, bytes]);
				const drop = Math.max(0, buffer.length - PRIVATE_OUTPUT_BYTES);
				output.dropped += drop;
				output.buffer = Buffer.from(buffer.subarray(drop));
			}
			return;
		}
		try {
			if (row.output_path) appendFileSync(row.output_path, bytes);
			else {
				mkdirSync(this.outputDir, { recursive: true });
				const path = this.outputFile(row.id);
				writeFileSync(path, bytes, { flag: "wx" });
				this.core.db.run("UPDATE jobs SET output_path=? WHERE id=?", path, row.id);
				row.output_path = path;
			}
		} catch (error) {
			entry.outputFailed = true;
			this.core.log.warn("无法保存后台作业输出", error);
		}
	}

	private finish(entry: LiveJob, outcome: Outcome): void {
		const row = entry.row;
		if (row.status !== "running") return;
		try {
			if (this.closed) return;
			const source = outcome.stoppedBy ?? entry.stopSource ?? null;
			row.status = source ? "cancelled" : outcome.status;
			row.stopped_by = source;
			row.ended_at = Date.now();
			row.exit_code = outcome.exitCode ?? null;
			const detail = source === "user" ? "用户停止了这个作业" : source === "shutdown" ? "后台退出时停止了这个作业" : outcome.detail;
			row.detail = [detail && redact(detail, true), entry.outputFailed ? "输出保存不完整" : null].filter(Boolean).join("。") || null;
			if (!entry.private) this.core.db.run("UPDATE jobs SET status=?,exit_code=?,detail=?,ended_at=?,stopped_by=? WHERE id=?",
				row.status, row.exit_code, row.detail, row.ended_at, row.stopped_by, row.id);
			this.changed(row);
		} catch (error) {
			this.core.log.warn("无法记录后台作业的结局", error);
		} finally {
			this.active.delete(row.id);
			entry.resolve();
		}
	}

	private changed(row: JobRow): void {
		const payload = { id: row.id, sessionFile: row.session_file, status: row.status,
			...(row.goal_id ? { goalId: row.goal_id, ownerRunId: row.owner_run_id, revision: row.goal_revision } : {}) };
		this.core.broadcast({ event: "jobs.changed", ...payload });
		if (row.status !== "running") this.core.broadcast({ event: "job.finished", ...payload });
	}

	private row(id: string): JobRow {
		const row = this.privateJobs.get(id)?.row ?? this.core.db.get<JobRow>("SELECT * FROM jobs WHERE id=?", id);
		if (!row) throw new RpcError("not_found", "找不到这个后台作业");
		return row;
	}

	private outputFile(id: string): string { return join(this.outputDir, id + ".log"); }

	private ownedOutput(row: JobRow): string | null {
		return row.output_path && /^[\w-]+$/.test(row.id) && samePath(row.output_path, this.outputFile(row.id))
			? row.output_path : null;
	}

	private outputBytes(row: JobRow): number {
		const privateOutput = this.privateJobs.get(row.id)?.output;
		if (privateOutput) return privateOutput.dropped + privateOutput.buffer.length;
		const path = this.ownedOutput(row);
		try {
			const file = path ? lstatSync(path) : undefined;
			return file?.isFile() ? file.size : 0;
		} catch { return 0; }
	}

	private list(params: Params) {
		const sessionFile = params.sessionFile === undefined ? undefined : normalizeCwd(requireStr(params.sessionFile, "sessionFile"));
		const slotId = params.slotId === undefined ? undefined : requireStr(params.slotId, "slotId");
		const status = params.status === undefined ? undefined : requireStr(params.status, "status") as Status;
		if (status !== undefined && !statuses.includes(status)) throw new RpcError("bad_request", "后台作业状态无效");
		const filter: string[] = [];
		const values: string[] = [];
		if (sessionFile !== undefined) { filter.push("lower(session_file)=?"); values.push(sessionFile); }
		if (slotId !== undefined) { filter.push("slot_id=?"); values.push(slotId); }
		if (status !== undefined) { filter.push("status=?"); values.push(status); }
		const persistent = this.core.db.all<JobRow>("SELECT * FROM jobs" + (filter.length ? " WHERE " + filter.join(" AND ") : ""), ...values);
		const transient = [...this.privateJobs.values()].map(entry => entry.row).filter(row =>
			(sessionFile === undefined || samePath(row.session_file, sessionFile)) &&
			(slotId === undefined || row.slot_id === slotId) && (status === undefined || row.status === status));
		return [...persistent, ...transient].sort((a, b) => b.started_at - a.started_at || a.id.localeCompare(b.id)).map(row => ({
			...row, sandboxed: row.sandboxed === 1, service: row.service === 1, outputBytes: this.outputBytes(row),
		}));
	}

	private output(params: Params) {
		const row = this.row(requireStr(params.id, "id"));
		const offset = params.from ?? 0;
		if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new RpcError("bad_request", "输出位置无效");
		const ended = row.status !== "running";
		const transient = this.privateJobs.get(row.id)?.output;
		if (transient) {
			const end = transient.dropped + transient.buffer.length;
			const from = Math.max(transient.dropped, Math.min(offset, end));
			const bytes = transient.buffer.subarray(from - transient.dropped, from - transient.dropped + MAX_READ_BYTES + 3);
			return this.readChunk(bytes, from, end, ended, offset < from);
		}
		const path = this.ownedOutput(row);
		if (path) {
			let fd: number | undefined;
			try {
				if (!lstatSync(path).isFile()) throw new Error("不是作业输出文件");
				fd = openSync(path, "r");
				const stat = fstatSync(fd);
				if (!stat.isFile()) throw new Error("不是作业输出文件");
				const from = Math.min(offset, stat.size);
				const buffer = Buffer.alloc(Math.min(stat.size - from, MAX_READ_BYTES + 3));
				const read = readSync(fd, buffer, 0, buffer.length, from);
				return this.readChunk(buffer.subarray(0, read), from, stat.size, ended, false);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.core.log.warn("无法读取后台作业输出", error);
			} finally { if (fd !== undefined) closeSync(fd); }
		}
		return { text: "", next: 0, truncated: false, ended, available: false };
	}

	private readChunk(buffer: Buffer, from: number, total: number, ended: boolean, lost: boolean) {
		let start = 0;
		while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
		let end = Math.min(buffer.length, MAX_READ_BYTES);
		while (end > start && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
		const next = from + end;
		return { text: buffer.subarray(start, end).toString("utf8"), next, truncated: lost || start > 0 || next < total, ended };
	}

	private async requestStop(entry: LiveJob, source: ShellStopSource): Promise<boolean> {
		const previous = entry.stopSource;
		entry.stopSource ??= source;
		try { entry.cancel(entry.stopSource); }
		catch (error) { entry.stopSource = previous; throw error; }
		return new Promise(resolve => {
			const timer = setTimeout(() => resolve(false), STOP_WAIT_MS);
			void entry.done.then(() => { clearTimeout(timer); resolve(true); });
		});
	}

	private async stopJob(id: string) {
		const row = this.row(id);
		if (row.status !== "running") return { ok: true, status: row.status };
		const entry = this.active.get(id);
		if (!entry || !await this.requestStop(entry, "user")) throw new RpcError("busy", "后台作业还没有停止");
		return { ok: true, status: entry.row.status };
	}
}
