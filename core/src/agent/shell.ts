import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { isAbsolute, join, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HarnessState } from "./state.ts";
import { toolchainEnv } from "./toolchain.ts";
import { currentToolEnvironment, type ToolEnvironment } from "./tool-environment.ts";

/**
 * dsh's shell tools for Windows: the standard preset's one-process-per-call
 * `pwsh` (packages/shell/tool-pwsh + pwsh-local) with background jobs
 * (packages/jobs/tool-jobs), and the minimal preset's persistent `pwsh`
 * (packages/shell/tool-pwsh-persistent). Pipes stand in for dsh's PTY.
 */

const ENCODING_PREAMBLE = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 64_000;
const JOB_WAIT_DEFAULT_MS = 30_000;
const JOB_WAIT_MAX_MS = 600_000;
const JOB_INLINE_BYTES = 2048;

let resolvedPwsh: string | undefined;

/** pwsh-local/src/resolve.ts: PowerShell 7 when installed, else Windows PowerShell. */
export function pwshPath(): string {
	if (resolvedPwsh) return resolvedPwsh;
	const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
	const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
	const candidates = [join(programFiles, "PowerShell", "7", "pwsh.exe")];
	for (const dir of (process.env.PATH ?? "").split(";")) if (dir.trim()) candidates.push(join(dir.trim(), "pwsh.exe"));
	candidates.push(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
	resolvedPwsh = candidates.find((c) => existsSync(c)) ?? "powershell.exe";
	return resolvedPwsh;
}

/** Ends [child] and everything it started. */
export function killTree(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null) return;
	if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
	else child.kill("SIGKILL");
}

/** Output kept in memory per stream; older bytes live only in the spill file. */
const MEMORY_BYTES = 1024 * 1024;

function utf8From(buffer: Buffer): string {
	let start = 0;
	while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
	return buffer.subarray(start).toString("utf8");
}

/**
 * One output stream of a command (dsh's collected output): the recent bytes
 * in memory, the complete stream spilled to a temp file once it outgrows
 * the result cap, and byte offsets for incremental reads.
 */
export class OutputStream {
	private chunks: Buffer[] = [];
	private readonly listeners = new Set<(chunk: Buffer) => void>();
	private memory = 0;
	/** Bytes received so far; [dropped] of them are no longer in memory. */
	total = 0;
	private dropped = 0;
	spillPath: string | undefined;
	private readonly name: string;

	constructor(name: string) {
		this.name = name;
	}

	push(chunk: Buffer): void {
		this.total += chunk.length;
		if (this.spillPath === undefined && this.total > MAX_OUTPUT_BYTES) this.startSpill();
		if (this.spillPath !== undefined) {
			try {
				appendFileSync(this.spillPath, chunk);
			} catch {
				// The spill is best effort; memory still holds the tail.
			}
		}
		this.chunks.push(chunk);
		this.memory += chunk.length;
		while (this.memory > MEMORY_BYTES && this.chunks.length > 1) {
			const old = this.chunks.shift()!;
			this.memory -= old.length;
			this.dropped += old.length;
		}
		for (const listener of this.listeners) listener(chunk);
	}

	/** Mirrors the collected bytes without touching the model's read offsets. */
	observe(listener: (chunk: Buffer) => void): () => void {
		let mirrored = false;
		if (this.dropped && this.spillPath) {
			let fd: number | undefined;
			try {
				fd = openSync(this.spillPath, "r");
				if (fstatSync(fd).size === this.total) {
					mirrored = true;
					const buffer = Buffer.allocUnsafe(64 * 1024);
					for (let count; (count = readSync(fd, buffer, 0, buffer.length, null)) > 0;) {
						listener(buffer.subarray(0, count));
					}
				}
			} catch {
				// A missing spill still leaves the recent tail and subsequent bytes available.
			} finally { if (fd !== undefined) closeSync(fd); }
		}
		if (!mirrored) for (const chunk of this.chunks) listener(chunk);
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private startSpill(): void {
		try {
			const dir = join(process.env.DREAMFLUTTER_CACHE || tmpdir(), "shell-output");
			mkdirSync(dir, { recursive: true });
			this.spillPath = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.${this.name}.txt`);
			writeFileSync(this.spillPath, Buffer.concat(this.chunks));
		} catch {
			this.spillPath = undefined;
		}
	}

	/** The last [maxBytes] bytes as text, and whether earlier output was cut. */
	tail(maxBytes = MAX_OUTPUT_BYTES): { text: string; truncated: boolean } {
		const buffer = Buffer.concat(this.chunks);
		const truncated = this.total > maxBytes;
		return { text: utf8From(buffer.length > maxBytes ? buffer.subarray(buffer.length - maxBytes) : buffer), truncated };
	}

	/** Output from byte [offset] on; lossy when part of it already left memory. */
	from(offset: number): { text: string; lossy: boolean } {
		const buffer = Buffer.concat(this.chunks);
		const lossy = offset < this.dropped;
		const start = Math.max(0, offset - this.dropped);
		return { text: lossy ? utf8From(buffer.subarray(start)) : buffer.subarray(start).toString("utf8"), lossy };
	}
}

/** tool-pwsh render.ts streamText: the tail, with where the whole stream went. */
function streamText(stream: OutputStream): string {
	const { text, truncated } = stream.tail();
	if (!truncated) return text;
	return `${text}\n[output truncated; full output: ${stream.spillPath ?? "(unavailable)"}]`;
}

// ---- background jobs ------------------------------------------------------------------------------

export type JobStatus = "running" | "completed" | "failed" | "cancelled";
export type ShellStopSource = "user" | "shutdown";
export interface BackgroundCommand { cwd: string; label: string; service: boolean }

export interface Job {
	id: string;
	kind: string;
	label: string;
	status: JobStatus;
	detail?: string;
	stdout: OutputStream;
	stderr: OutputStream;
	/** Bytes of stdout/stderr already returned to the model. */
	readOut: number;
	readErr: number;
	child?: ChildProcess;
	done: Promise<void>;
	startedAt: number;
	exitCode?: number | null;
	stoppedBy?: ShellStopSource;
	stopProcess?: () => void;
	killedByModel?: boolean;
}

function statusLine(job: Job): string {
	return job.detail !== undefined ? `[status: ${job.status}, ${job.detail}]` : `[status: ${job.status}]`;
}

/**
 * The session's background jobs (dsh jobs registry): processes keep running
 * past their tool call; output is read incrementally with job_output.
 */
export class JobRegistry {
	readonly jobs = new Map<string, Job>();
	/** Called when a job settles that the model did not kill itself. */
	onSettled: ((job: Job, notice: string) => void) | undefined;
	onBackground?: (job: Job, command: BackgroundCommand) => void;

	start(kind: string, label: string, child: ChildProcess, stdout: OutputStream, stderr: OutputStream, timeoutKill?: () => void): Job {
		let settle!: () => void;
		const job: Job = {
			id: randomUUID(), kind, label, status: "running", stdout, stderr, readOut: 0, readErr: 0,
			child, startedAt: Date.now(), done: new Promise((r) => (settle = r)),
		};
		child.on("close", (code) => {
			timeoutKill?.();
			job.exitCode = code;
			if (job.status === "running") {
				job.status = code === 0 ? "completed" : "failed";
				if (code !== 0) job.detail = `exit code ${code ?? 1}`;
			}
			settle();
			if (!job.killedByModel && job.stoppedBy !== "shutdown") this.onSettled?.(job, this.notice(job));
		});
		this.jobs.set(job.id, job);
		return job;
	}

	publish(job: Job, command: BackgroundCommand): void {
		this.onBackground?.(job, command);
	}

	stop(job: Job, source: ShellStopSource): void {
		if (job.status !== "running" && !(job.stoppedBy && job.exitCode === undefined)) return;
		if (!job.stoppedBy) {
			job.stoppedBy = source;
			job.status = "cancelled";
			job.detail = source === "user" ? "用户停止了这个作业" : "后台退出时停止了这个作业";
		}
		if (job.stopProcess) job.stopProcess();
		else if (job.child) killTree(job.child);
	}

	/** tool-jobs inlineCompletionNotice / fitCompletionNotice. */
	private notice(job: Job): string {
		const first = job.label.trimStart();
		const newline = first.indexOf("\n");
		const label = newline === -1 ? first : `${first.slice(0, newline)}…`;
		const head = `background job ${job.id} (${job.kind}: ${label.length > 200 ? `${label.slice(0, 200)}…` : label}) finished ${statusLine(job)}`;
		// Only an inline notice consumes the output; otherwise job_output still has all of it.
		const output = this.peek(job);
		const inline = output.text.length === 0 ? `${head}. No new output.` : `${head}. Output:\n${output.text.replace(/\n$/, "")}`;
		if (Buffer.byteLength(inline, "utf8") > JOB_INLINE_BYTES) return `${head}. Read its output with job_output.`;
		job.readOut = output.outEnd;
		job.readErr = output.errEnd;
		return inline;
	}

	/** Output since the previous read, without consuming it (tool-jobs renderModelDelta). */
	private peek(job: Job): { text: string; outEnd: number; errEnd: number } {
		const out = job.stdout.from(job.readOut);
		const err = job.stderr.from(job.readErr);
		let body = out.text;
		if (err.text.length > 0) {
			if (body.length > 0 && !body.endsWith("\n")) body += "\n";
			body += `[stderr]\n${err.text}`;
		}
		if (out.lossy || err.lossy) {
			const files = [job.stdout.spillPath, job.stderr.spillPath].filter((p): p is string => p !== undefined);
			if (body.length > 0 && !body.endsWith("\n")) body += "\n";
			body += `[some output was dropped from memory; full output: ${files.length > 0 ? files.join(", ") : "(unavailable)"}]`;
		}
		return { text: body, outEnd: job.stdout.total, errEnd: job.stderr.total };
	}

	/** Output since the previous read: stdout, then stderr in one `[stderr]` section. */
	read(job: Job): string {
		const output = this.peek(job);
		job.readOut = output.outEnd;
		job.readErr = output.errEnd;
		return output.text;
	}

	get(id: string): Job {
		const job = this.jobs.get(id);
		if (!job) throw new Error(`unknown job id ${JSON.stringify(id)}; use job_list to see your jobs`);
		return job;
	}

	killAll(): void {
		for (const job of this.jobs.values()) this.stop(job, "shutdown");
	}
}

/** The harness and the window module see the same registry for each Pi session. */
export const shellJobsBySession = new WeakMap<object, JobRegistry>();

function validateJobId(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error("job_id must be a non-empty string");
	return value.trim();
}

export function jobTools(jobs: JobRegistry): ToolDefinition[] {
	const idParam = { type: "string", description: "Job id returned by the tool that started the background work." };
	return [
		{
			name: "job_output",
			label: "后台任务输出",
			description: "Read a background job: output since the previous read for stream jobs, or the result of a finished final-output job.",
			parameters: {
				type: "object",
				properties: {
					job_id: idParam,
					wait: { type: "boolean", description: "Block until the job finishes or the timeout expires; a timed-out wait leaves the job running. Defaults to false." },
					timeout_ms: { type: "number", description: "Max wait in milliseconds with wait: true. Defaults to and is capped by configuration." },
				},
				required: ["job_id"],
			} as never,
			async execute(_id, params: { job_id: string; wait?: boolean; timeout_ms?: number }, signal) {
				const job = jobs.get(validateJobId(params.job_id));
				if (params.wait === true && job.status === "running") {
					const wait = Math.min(Math.max(1, params.timeout_ms ?? JOB_WAIT_DEFAULT_MS), JOB_WAIT_MAX_MS);
					await Promise.race([job.done, new Promise((r) => setTimeout(r, wait)), new Promise((r) => signal?.addEventListener("abort", r, { once: true }))]);
				}
				const text = jobs.read(job);
				const body = text.length > 0 ? text : "(no new output)";
				return { content: [{ type: "text", text: `${body}${body.endsWith("\n") ? "" : "\n"}${statusLine(job)}` }], details: { jobId: job.id, status: job.status } };
			},
		},
		{
			name: "job_list",
			label: "后台任务",
			description: "List your background jobs (running and finished) with their ids, kinds, and statuses.",
			parameters: { type: "object", properties: {} } as never,
			async execute() {
				const list = [...jobs.jobs.values()];
				const text = list.length === 0 ? "(no background jobs)" : list.map((j) => `${j.id} [${j.kind}] ${j.status} — ${j.label}`).join("\n");
				return { content: [{ type: "text", text }], details: {} };
			},
		},
		{
			name: "job_kill",
			label: "停止后台任务",
			description: "Request cancellation of a running background job.",
			parameters: {
				type: "object",
				properties: {
					job_id: idParam,
					reason: { type: "string", description: "Optional short reason, recorded in the log and forwarded to the job." },
				},
				required: ["job_id"],
			} as never,
			async execute(_id, params: { job_id: string; reason?: string }) {
				const job = jobs.get(validateJobId(params.job_id));
				if (job.status !== "running") {
					return { content: [{ type: "text", text: `job ${job.id} had already finished ${statusLine(job)}` }], details: {} };
				}
				job.killedByModel = true;
				job.status = "cancelled";
				if (params.reason) job.detail = params.reason;
				if (job.child) killTree(job.child);
				return { content: [{ type: "text", text: `requested cancellation of job ${job.id}` }], details: {} };
			},
		},
	];
}

// ---- standard: one process per call ----------------------------------------------------------------

export const PWSH_DESCRIPTION =
	"Execute a PowerShell command (`pwsh -Command`) and return its stdout/stderr. " +
	"Each call runs in a fresh pwsh process; pass `workdir` instead of using `cd`. Paths use native Windows form (`C:\\...`); read environment " +
	"variables with `$env:NAME`. " +
	"Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. " +
	"On Windows a force-killed command settles as `[exit code: 1]` without a signal marker — treat it as an interruption, not a command failure. " +
	"Provide `description` before `command` in the arguments. " +
	"Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked. " +
	"Do not assign to automatic variables such as `$HOME`; variable names are case-insensitive, so `$home` is the same read-only variable.";

/** render.ts renderPwshResult. */
function renderResult(stdout: string, stderr: string, exitCode: number | null, timedOutMs: number | undefined, stopped: string | undefined): string {
	let body = stdout;
	if (stderr.length > 0) {
		if (body.length > 0 && !body.endsWith("\n")) body += "\n";
		body += `[stderr]\n${stderr}`;
	}
	if (body.length === 0) body = "(no output)";
	const markers: string[] = [];
	if (timedOutMs !== undefined) markers.push(`[timed out after ${timedOutMs}ms]`);
	if (stopped !== undefined) markers.push(`[stopped: ${stopped}]`);
	if (exitCode !== 0) markers.push(`[exit code: ${exitCode ?? 1}]`);
	if (markers.length === 0) return body;
	if (!body.endsWith("\n")) body += "\n";
	return body + markers.join("\n");
}

export function pwshTool(state: HarnessState, jobs: JobRegistry): ToolDefinition {
	const sources = currentToolEnvironment();
	return {
		name: "pwsh",
		label: "运行命令",
		description: PWSH_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				description: {
					type: "string",
					description:
						"Clear, concise description of what this command does in active voice, " +
						'5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; ' +
						'"git status" → "Show working tree status"; "Get-Process" → "List running processes".',
				},
				command: { type: "string", description: "The PowerShell command to execute." },
				timeoutMs: {
					type: "number",
					description: "Timeout in milliseconds. The executor applies its configured default and cap; on expiry the command moves to the background as a job instead of being killed.",
				},
				workdir: { type: "string", description: "Working directory for this command. Defaults to the session workspace; a relative path is resolved against it." },
				run_in_background: {
					type: "boolean",
					description: "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.",
				},
				service: { type: "boolean", description: "Mark a background job as an ongoing service, such as a development server." },
			},
			required: ["description", "command"],
		} as never,
		async execute(_id, params: { description: string; command: string; timeoutMs?: number; workdir?: string; run_in_background?: boolean; service?: boolean }, signal) {
			if (params.command.trim().length === 0) throw new Error("invalid command: expected a non-empty string");
			if (params.description.trim().length === 0) throw new Error("invalid description: expected a non-empty string");
			if (params.timeoutMs !== undefined && (!Number.isFinite(params.timeoutMs) || params.timeoutMs <= 0)) {
				throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(params.timeoutMs)}`);
			}
			const workdir = params.workdir === undefined ? state.cwd : isAbsolute(params.workdir) ? params.workdir : resolve(state.cwd, params.workdir);
			const timeoutMs = Math.min(params.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
			const child = spawn(pwshPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `${ENCODING_PREAMBLE}${params.command}`], {
				cwd: workdir,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: toolchainEnv(process.env, undefined, undefined, sources?.provider.host(workdir, sources.workspace, params.command)),
			});
			const stdout = new OutputStream("stdout");
			const stderr = new OutputStream("stderr");
			child.stdout!.on("data", (c: Buffer) => stdout.push(c));
			child.stderr!.on("data", (c: Buffer) => stderr.push(c));
			const spawned = new Promise<void>((resolveSpawn, reject) => {
				child.once("spawn", () => resolveSpawn());
				child.once("error", (error) => reject(new Error(`failed to start PowerShell: ${error.message}`)));
			});
			await spawned;
			const job = jobs.start("pwsh", params.command, child, stdout, stderr);
			const details = { cwd: workdir, description: params.description };
			const background = { cwd: workdir, label: params.description, service: params.service === true };
			if (params.run_in_background === true) {
				jobs.publish(job, background);
				return { content: [{ type: "text", text: `started background job ${job.id}` }], details: { ...details, jobId: job.id } };
			}
			// Foreground: the job is announced only if it outlives its timeout.
			job.killedByModel = true;
			let timedOut = false;
			const outcome = await Promise.race([
				job.done.then(() => "done" as const),
				new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs)),
				new Promise<"aborted">((r) => signal?.addEventListener("abort", () => r("aborted"), { once: true })),
			]);
			if (outcome === "aborted") {
				killTree(child);
				jobs.jobs.delete(job.id);
				throw new Error("tool call aborted");
			}
			if (outcome === "timeout") {
				timedOut = true;
				job.killedByModel = false;
				jobs.publish(job, background);
				const partial = jobs.read(job);
				const body = partial.length > 0 ? (partial.endsWith("\n") ? partial : `${partial}\n`) : "";
				return {
					content: [{ type: "text", text: `${body}[still running after ${timeoutMs}ms; moved to background job ${job.id}]` }],
					details: { ...details, jobId: job.id, timedOut },
				};
			}
			jobs.jobs.delete(job.id);
			const exitCode = child.exitCode;
			return {
				content: [{ type: "text", text: renderResult(streamText(stdout), streamText(stderr), exitCode, undefined, undefined) }],
				details: { ...details, exitCode },
			};
		},
	};
}

// Keep a control pipe open until the job ends. Closing it stops the Linux process
// group even though killing only wsl.exe need not stop its Linux descendants.
export const BASH_JOB_SUPERVISOR = [
	"exec 3<&0",
	"export HOME=/workspace LANG=C.UTF-8 PYTHONIOENCODING=utf-8 MPLBACKEND=Agg",
	"task=$(printf '%s' \"$1\" | base64 -d) || exit 1",
	"setsid bash --noprofile --norc -c \"$task\" </dev/null 3<&- &",
	"pid=$!",
	"( IFS= read -r _ <&3; kill -KILL -- \"-$pid\" 2>/dev/null || { kill -KILL -- \"$pid\" 2>/dev/null; kill -KILL -- \"-$pid\" 2>/dev/null; }; ) &",
	"watcher=$!",
	"wait \"$pid\"; code=$?",
	"kill \"$watcher\" 2>/dev/null || :",
	"wait \"$watcher\" 2>/dev/null || :",
	"exit \"$code\"",
].join("\n");

export async function startBashJob(jobs: JobRegistry, distro: string, command: string, environment: string, background: BackgroundCommand): Promise<Job> {
	const encoded = Buffer.from([environment, command.replaceAll("\r", "")].filter(Boolean).join("\n")).toString("base64");
	const child = spawn("wsl.exe", ["-d", distro, "-u", "agent", "--cd", background.cwd, "--exec", "bash", "--noprofile", "--norc", "-c", BASH_JOB_SUPERVISOR, "df-background", encoded], {
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, WSL_UTF8: "1" },
	});
	child.stdin!.on("error", () => {}); // The job may exit while a stop closes the control pipe.
	const stdout = new OutputStream("stdout");
	const stderr = new OutputStream("stderr");
	child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
	await new Promise<void>((resolveSpawn, reject) => {
		child.once("spawn", resolveSpawn);
		child.once("error", reject);
	});
	const job = jobs.start("bash", command, child, stdout, stderr);
	job.stopProcess = () => child.stdin!.end();
	jobs.publish(job, background);
	return job;
}

// ---- minimal: one persistent shell -------------------------------------------------------------------

export const PERSISTENT_PWSH_DESCRIPTION = `Run commands in a PowerShell shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* State is persistent across command calls and discussions with the user.
* Use native Windows paths (C:\\...) and $env:NAME variables; this is PowerShell, not bash.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'Start-Job' or start a server with Start-Process.`;

const PERSISTENT_TIMEOUT_MS = 300_000;
const PERSISTENT_MAX_OUTPUT_CHARS = 16_000;
/** Characters of one command's output kept in memory before its middle is dropped. */
const PERSISTENT_MEMORY_CHARS = 4_000_000;
const TRUNCATED_MESSAGE =
	"<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with Select-String in order to find the line numbers of what you are looking for.</NOTE>";
const SHELL_RESET_MESSAGE = "The persistent pwsh shell was reset; the next pwsh call starts from the workspace with a fresh current directory and environment.";

/**
 * The command as one ASCII line that decodes to every character literally.
 * dsh quotes it into a double-quoted string; Windows PowerShell reads stdin
 * in the console code page, so here non-ASCII text travels as base64.
 */
export function encodeForPwsh(value: string): string {
	return `([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(value.replaceAll("\r", ""), "utf8").toString("base64")}')))`;
}

function maybeTruncate(content: string): string {
	if (content.length <= PERSISTENT_MAX_OUTPUT_CHARS) return content;
	let cut = PERSISTENT_MAX_OUTPUT_CHARS;
	const code = content.charCodeAt(cut - 1);
	if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
	return content.slice(0, cut) + TRUNCATED_MESSAGE;
}

function withExitCode(content: string, exitCode: number | undefined): string {
	if (exitCode === undefined || exitCode === 0) return content;
	const marker = `[exit code: ${exitCode}]`;
	return content.length === 0 ? marker : `${content}\n${marker}`;
}

/**
 * The minimal preset's shell: one PowerShell per session, fed one wrapped
 * command per call, so the directory, variables and functions persist.
 */
export class PersistentShell {
	private child: ChildProcess | undefined;
	private output = "";
	private queue: Promise<unknown> = Promise.resolve();
	private readonly cwd: () => string;
	private readonly sources = currentToolEnvironment();
	private sourceFingerprint: string | undefined;
	private directory: string | undefined;
	private requestedDirectory: string | undefined;

	constructor(cwd: () => string) {
		this.cwd = cwd;
	}

	private ensure(source?: ToolEnvironment, cwd = this.cwd()): ChildProcess {
		if (this.child && this.child.exitCode === null) return this.child;
		this.output = "";
		const child = spawn(pwshPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
			cwd,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: toolchainEnv(process.env, undefined, undefined, source),
		});
		// Decoders keep a character split across chunks whole; a runaway command keeps its head and tail only.
		const append = (decoder: StringDecoder) => (chunk: Buffer) => {
			this.output += decoder.write(chunk);
			if (this.output.length > PERSISTENT_MEMORY_CHARS) {
				this.output = this.output.slice(0, PERSISTENT_MEMORY_CHARS / 4) + this.output.slice(-PERSISTENT_MEMORY_CHARS / 4);
			}
		};
		child.stdout!.on("data", append(new StringDecoder("utf8")));
		child.stderr!.on("data", append(new StringDecoder("utf8")));
		child.on("error", () => {});
		child.stdin!.on("error", () => {});
		child.stdin!.write(`${ENCODING_PREAMBLE}$ProgressPreference = 'SilentlyContinue'\n`);
		this.child = child;
		this.sourceFingerprint = source?.fingerprint;
		return child;
	}

	reset(): void {
		if (this.child) killTree(this.child);
		this.child = undefined;
		this.output = "";
		this.sourceFingerprint = undefined;
		this.directory = undefined;
		this.requestedDirectory = undefined;
	}

	run(command: string, signal: AbortSignal | undefined, receipt?: (exitCode: number) => void): Promise<string> {
		const next = this.queue.then(
			() => this.execute(command, signal, receipt),
			() => this.execute(command, signal, receipt),
		);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async execute(command: string, signal: AbortSignal | undefined, receipt?: (exitCode: number) => void): Promise<string> {
		if (signal?.aborted) return "";
		const requested = this.cwd();
		const cwd = this.requestedDirectory === requested ? this.directory ?? requested : requested;
		const source = this.sources?.provider.host(cwd, this.sources.workspace, command);
		if (this.child && (source?.fingerprint !== this.sourceFingerprint || this.requestedDirectory !== requested)) this.reset();
		this.directory = cwd;
		this.requestedDirectory = requested;
		const child = this.ensure(source, cwd);
		const nonce = randomUUID();
		const start = `__DSH_PERSISTENT_PWSH_START_${nonce}__`;
		const end = `__DSH_PERSISTENT_PWSH_END_${nonce}:`;
		const cwdMarker = `__DSH_PERSISTENT_CWD_${nonce}:`;
		const body = encodeForPwsh(command);
		const wrapper = `Write-Output '${start}'; $LASTEXITCODE = $null; $__s = 1; try { Invoke-Expression ${body}; $__ok = $? } catch { $__ok = $false }; if ($null -ne $LASTEXITCODE) { $__s = [int]$LASTEXITCODE } else { $__s = if ($__ok) { 0 } else { 1 } }; Write-Output ('${cwdMarker}' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Location).ProviderPath))); Write-Output ('${end}' + $__s)`;
		// Anything left from earlier commands is stray output: drop it so the buffer never grows across calls.
		this.output = "";
		const from = 0;
		child.stdin!.write(`${wrapper}\n`);
		const startedAt = Date.now();
		for (;;) {
			await new Promise((r) => setTimeout(r, 25));
			const text = this.output.slice(from);
			const endAt = text.lastIndexOf(end);
			const status = endAt >= 0 ? /^(-?\d+) *\r?\n/.exec(text.slice(endAt + end.length))?.[1] : undefined;
			if (status !== undefined) {
				// Error text travels on the other pipe; give it a moment to land.
				await new Promise((r) => setTimeout(r, 30));
				const settled = this.output.slice(from);
				const startAt = settled.indexOf(start);
				const endIndex = settled.lastIndexOf(end);
				let captured = settled.slice(startAt < 0 ? 0 : startAt + start.length, endIndex) + settled.slice(endIndex + end.length).replace(/^-?\d+ *\r?\n/, "");
				const location = new RegExp(`^${cwdMarker}([A-Za-z0-9+/=]+)\\r?$`, "m").exec(captured);
				if (location) { const decoded = Buffer.from(location[1]!, "base64").toString("utf8"); if (isAbsolute(decoded)) this.directory = decoded; }
				captured = captured.replace(new RegExp(`^${cwdMarker}[^\\r\\n]*\\r?\\n?`, "m"), "");
				const clean = captured.replace(/^\r?\n/, "").replace(/\r?\n$/, "").replaceAll("\r\n", "\n");
				receipt?.(Number(status));
				return withExitCode(maybeTruncate(clean), Number(status));
			}
			if (child.exitCode !== null || this.child !== child) {
				const partial = text.replace(start, "").replace(/^\r?\n/, "").replace(/\r?\n$/, "");
				const marker = child.exitCode !== null ? `[shell exited: code ${child.exitCode}]` : "[shell exited]";
				this.reset();
				return [partial.length === 0 ? marker : `${maybeTruncate(partial)}\n${marker}`, SHELL_RESET_MESSAGE].join("\n");
			}
			if (signal?.aborted) {
				this.reset();
				return "";
			}
			if (Date.now() - startedAt >= PERSISTENT_TIMEOUT_MS) {
				const startAt = text.indexOf(start);
				const partial = (startAt < 0 ? text : text.slice(startAt + start.length)).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
				this.reset();
				return [
					`Your command timed out after ${Math.round(PERSISTENT_TIMEOUT_MS / 1000)} seconds or experienced an OOM error. Below is partial output:`,
					maybeTruncate(partial),
					SHELL_RESET_MESSAGE,
				].join("\n");
			}
		}
	}
}

export function persistentPwshTool(shell: PersistentShell): ToolDefinition {
	return {
		name: "pwsh",
		label: "运行命令",
		description: PERSISTENT_PWSH_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "The PowerShell command to run. Relative path is preferred in the command." },
			},
			required: ["command"],
		} as never,
		executionMode: "sequential",
		async execute(_id, params: { command: string }, signal) {
			if (params.command.trim().length === 0) throw new Error("command must be a non-empty string");
			const details: { exitCode?: number } = {};
			const text = await shell.run(params.command, signal, exitCode => { details.exitCode = exitCode; });
			return { content: [{ type: "text", text }], details };
		},
	};
}
