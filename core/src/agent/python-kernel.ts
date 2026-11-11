import { ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { OutputStream, type JobRegistry, killTree } from "./shell.ts";
import type { HarnessState } from "./state.ts";
import { redactValue } from "../security/redaction.ts";

const IDLE_MS = 30 * 60_000;
const TIMEOUT_SECONDS = 300;
const INTERRUPT_MS = 2000;
const MAX_FRAME = 3 * 1024 * 1024;
const NEW_KERNEL = "内核是新开的，之前的变量没有了。";
export const PYTHON_BACKGROUND_RESULT = "df.python_result";
const WORKER = readFileSync(new URL("../../assets/python-kernel.py", import.meta.url)).toString("base64");
const LOADER = "import base64,sys;exec(compile(base64.b64decode(sys.stdin.buffer.readline()),'df-python-kernel','exec'))";
const SIGNAL = [
	"import os,signal,sys",
	"pid,start,action=sys.argv[1:]",
	"try:",
	" stat=open('/proc/'+pid+'/stat').read().rsplit(')',1)[1].split()",
	" if stat[19]==start and stat[2]==pid:",
	"  if action=='interrupt': os.kill(int(pid),signal.SIGINT)",
	"  else: os.killpg(int(pid),signal.SIGKILL)",
	"except ProcessLookupError: pass",
	"except FileNotFoundError: pass",
].join("\n");

export interface PythonSandbox { distro: string; ready(): Promise<void> }
export interface PythonFiles {
	folder: string | null;
	record(path: string): void;
}
export const pythonFilesBySession = new WeakMap<object, (sessionId: string) => PythonFiles>();

type Request = { code: string; cwd: string; folder: string | null };
type Status = "completed" | "failed" | "interrupted";
type Figure = { name: string; data: string; mime: string };
type Frame = { kind: "output"; text: string } | { kind: "figure"; figure: Figure };
type Execution = { status: Status; text: string; images: ImageContent[]; paths: string[] };
type Pending = { frame(frame: Frame): void; settle(status: Status): void };

class KernelConnection {
	private readonly distro: string;
	private readonly child: ChildProcess;
	private identity?: { pid: number; start: string };
	private pending?: Pending;
	private ended = false;
	private closing?: Promise<void>;
	private line = "";
	private opened!: (ok: boolean) => void;
	private readonly started = new Promise<boolean>(resolve => { this.opened = resolve; });

	constructor(distro: string, cwd: string) {
		this.distro = distro;
		this.child = spawn("wsl.exe", ["-d", distro, "-u", "agent", "--cd", cwd, "--exec",
			"/usr/bin/env", "HOME=/workspace", "LANG=C.UTF-8", "PYTHONIOENCODING=utf-8", "MPLBACKEND=Agg",
			"/usr/bin/python3", "-u", "-c", LOADER], {
			windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, WSLENV: "", WSL_UTF8: "1" },
		});
		this.child.stderr!.resume(); // WSL startup messages and native descriptors aren't protocol frames.
		this.child.stdin!.on("error", () => this.end());
		this.child.once("error", () => this.end());
		this.child.once("close", () => this.end());
		this.child.stdout!.setEncoding("utf8").on("data", (chunk: string) => this.receive(chunk));
	}

	get live(): boolean { return !this.ended; }

	async start(ready: () => Promise<void>): Promise<void> {
		await ready();
		if (this.ended) throw new Error("Python 内核进程没有启动");
		this.child.stdin!.write(WORKER + "\n");
		const timer = setTimeout(() => this.opened(false), 10_000);
		try {
			if (!await this.started) throw new Error("Python 内核没有就绪");
		} finally { clearTimeout(timer); }
	}

	execute(request: Request, frame: Pending["frame"]): Promise<Status> {
		if (this.ended) return Promise.resolve("failed");
		return new Promise(resolve => {
			this.pending = { frame, settle: resolve };
			this.child.stdin!.write(JSON.stringify(request) + "\n");
		});
	}

	interrupt(): void { void this.signal("interrupt"); }

	close(): Promise<void> {
		return this.closing ??= this.terminate();
	}

	private async terminate(): Promise<void> {
		this.end();
		this.child.stdin!.end();
		if (this.identity) await this.signal("kill");
		else killTree(this.child);
	}

	private signal(action: "interrupt" | "kill"): Promise<void> {
		if (!this.identity || this.child.exitCode !== null) return Promise.resolve();
		const child = spawn("wsl.exe", ["-d", this.distro, "-u", "agent", "--exec", "/usr/bin/python3",
			"-c", SIGNAL, String(this.identity.pid), this.identity.start, action], {
			windowsHide: true, stdio: "ignore", env: { ...process.env, WSLENV: "", WSL_UTF8: "1" },
		});
		return new Promise(resolve => {
			const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
			const done = () => { clearTimeout(timer); resolve(); };
			child.once("error", done);
			child.once("close", done);
		});
	}

	private end(): void {
		this.ended = true;
		this.opened(false);
		this.settle("failed");
	}

	private settle(status: Status): void {
		const pending = this.pending;
		this.pending = undefined;
		pending?.settle(status);
	}

	private receive(chunk: string): void {
		for (const part of chunk.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
			this.line += part;
			if (this.line.length > MAX_FRAME) { void this.close(); return; }
			if (!part.endsWith("\n")) continue;
			const line = this.line;
			this.line = "";
			this.parse(line);
		}
	}

	private parse(line: string): void {
		let value: Record<string, unknown>;
		try { value = JSON.parse(line); } catch { return; }
		if (!value || this.ended) return;
		if (value.kind === "ready" && !this.identity && Number.isInteger(value.pid) && Number(value.pid) > 1
			&& typeof value.start === "string" && /^\d+$/.test(value.start)) {
			this.identity = { pid: Number(value.pid), start: value.start };
			this.opened(true);
		}
		if (value.kind === "output" && typeof value.text === "string") this.pending?.frame({ kind: "output", text: value.text });
		if (value.kind === "figure" && typeof value.name === "string" && /^python-[a-f0-9]{24}\.png$/.test(value.name)
			&& typeof value.data === "string" && (value.mime === "image/png" || value.mime === "image/jpeg")) {
			this.pending?.frame({ kind: "figure", figure: value as unknown as Figure });
		}
		if (value.kind === "done" && (value.status === "completed" || value.status === "failed" || value.status === "interrupted")) this.settle(value.status);
	}
}

/** A session owns one process and queues calls so globals have a defined execution order. */
export class PythonKernel {
	private readonly sandbox: PythonSandbox;
	private readonly idleMs: number;
	private readonly interruptMs: number;
	private connection?: KernelConnection;
	private queue: Promise<unknown> = Promise.resolve();
	private idle?: NodeJS.Timeout;
	private closed = false;
	private closing?: Promise<void>;

	constructor(sandbox: PythonSandbox, idleMs = IDLE_MS, interruptMs = INTERRUPT_MS) {
		this.sandbox = sandbox;
		this.idleMs = idleMs;
		this.interruptMs = interruptMs;
	}

	run(request: Request, files: PythonFiles, options: { restart?: boolean; timeout?: number; signal?: AbortSignal },
		progress: (text: string) => void = () => {}): Promise<Execution> {
		const run = this.queue.then(() => this.execute(request, files, options, progress));
		this.queue = run.catch(() => {});
		return run;
	}

	close(): Promise<void> {
		this.closed = true;
		return this.closing ??= this.reset();
	}

	private async reset(): Promise<void> {
		clearTimeout(this.idle);
		const connection = this.connection;
		this.connection = undefined;
		await connection?.close();
	}

	private async execute(request: Request, files: PythonFiles, options: { restart?: boolean; timeout?: number; signal?: AbortSignal },
		progress: (text: string) => void): Promise<Execution> {
		const result: Execution = { status: "completed", text: "", images: [], paths: [] };
		const output = (text: string) => { result.text += text; progress(text); };
		if (this.closed || options.signal?.aborted) return { ...result, status: "interrupted", text: "Python 执行已取消。" };
		clearTimeout(this.idle);
		if (options.restart || (this.connection && !this.connection.live)) await this.reset();
		if (!this.connection) {
			if (this.closed) return { ...result, status: "interrupted", text: "Python 执行已取消。" };
			const connection = this.connection = new KernelConnection(this.sandbox.distro, request.cwd);
			try { await connection.start(this.sandbox.ready); }
			catch (error) { await this.reset(); throw error; }
			output(NEW_KERNEL + "\n");
		}
		const connection = this.connection;
		let reason: "timeout" | "aborted" | undefined;
		let killed = false;
		let closeAfterInterrupt: Promise<void> | undefined;
		let escalation: NodeJS.Timeout | undefined;
		const interrupt = (why: NonNullable<typeof reason>) => {
			if (reason) return;
			reason = why;
			connection.interrupt();
			escalation = setTimeout(() => {
				killed = true;
				closeAfterInterrupt = this.reset();
			}, this.interruptMs);
		};
		const abort = () => interrupt("aborted");
		const timer = setTimeout(() => interrupt("timeout"), (options.timeout ?? TIMEOUT_SECONDS) * 1000);
		options.signal?.addEventListener("abort", abort, { once: true });
		try {
			if (this.closed || options.signal?.aborted) {
				result.status = "interrupted";
				output("Python 执行已取消。\n");
				return result;
			}
			result.status = await connection.execute(request, frame => {
				if (frame.kind === "output") { output(frame.text); return; }
				const { figure } = frame;
				const path = request.folder ? posix.join(request.folder, figure.name) : "";
				if (path) {
					try { files.record(path); } catch { output("图像已写入，登记产物失败。\n"); }
					output("\n已生成图片：" + path + "\n");
				}
				result.images.push({ type: "image", data: figure.data, mimeType: figure.mime });
				result.paths.push(path);
			});
			await closeAfterInterrupt;
			if (reason) {
				result.status = reason === "aborted" ? "interrupted" : "failed";
				const description = reason === "timeout" ? "Python 执行超时" : "Python 执行已取消";
				output("\n" + description + (killed ? "，中断未响应，内核已关闭。下一次将重新启动，之前的变量没有了。\n"
					: connection.live ? "，内核保留。\n" : "，内核已关闭。下一次将重新启动，之前的变量没有了。\n"));
			} else if (!connection.live) output("\nPython 内核意外关闭。下一次将重新启动，之前的变量没有了。\n");
			return result;
		} finally {
			clearTimeout(timer);
			clearTimeout(escalation);
			options.signal?.removeEventListener("abort", abort);
			if (!this.closed && this.connection?.live) {
				this.idle = setTimeout(() => void this.reset(), this.idleMs);
				this.idle.unref();
			}
		}
	}
}

function backgroundPython(pi: ExtensionAPI, jobs: JobRegistry, kernel: PythonKernel, request: Request,
	files: PythonFiles, options: { restart?: boolean; timeout?: number }) {
	// One registry entry per execution, with no ownership over the shared Python process.
	const pipe = new PassThrough();
	const carrier = Object.assign(new ChildProcess(), { stdout: pipe });
	const stdout = new OutputStream("stdout");
	pipe.on("data", (chunk: Buffer) => stdout.push(chunk));
	const stop = new AbortController();
	const job = jobs.start("python", "Python", carrier, stdout, new OutputStream("stderr"));
	job.stopProcess = () => stop.abort();
	jobs.publish(job, { cwd: request.cwd, label: "Python", service: false });
	void (async () => {
		let exitCode = 1;
		try {
			const result = await kernel.run(request, files, { ...options, signal: stop.signal }, text => pipe.write(text));
			exitCode = result.status === "completed" ? 0 : 1;
			if (result.images.length && job.stoppedBy !== "shutdown") {
				pi.sendMessage({ customType: PYTHON_BACKGROUND_RESULT, content: result.images, display: true,
					details: { jobId: job.id, imagePaths: result.paths } }, { triggerTurn: false });
			}
		} catch (error) {
			pipe.write(redactValue(error instanceof Error ? error.message : String(error)));
		} finally {
			pipe.end();
			await finished(pipe).catch(() => {});
			carrier.emit("close", exitCode);
		}
	})();
	return { content: [{ type: "text" as const, text: "started background job " + job.id }], details: { jobId: job.id } };
}

export function pythonTool(pi: ExtensionAPI, state: HarnessState, sandbox: PythonSandbox, jobs: JobRegistry): ToolDefinition {
	const kernel = new PythonKernel(sandbox);
	pi.on("session_shutdown", async () => { await kernel.close(); });
	return {
		name: "python", label: "Python",
		description: "Execute Python in a persistent sandbox kernel. Variables persist between calls. Returns printed text, the last expression and matplotlib figures. Use background for long work and job_output to read its output.",
		parameters: {
			type: "object", required: ["code"], properties: {
				code: { type: "string", description: "Python source code." },
				timeout: { type: "number", description: "Seconds before interrupting this execution, default 300." },
				restart: { type: "boolean", description: "Restart the kernel and clear its variables before running." },
				background: { type: "boolean", description: "Run as a managed background job." },
			},
		} as never,
		async execute(_id, params: { code: string; timeout?: number; restart?: boolean; background?: boolean }, signal, _update, ctx) {
			if (typeof params.code !== "string" || (!params.code.trim() && !params.restart)) throw new Error("请输入 Python 代码。");
			if (params.timeout !== undefined && (!Number.isFinite(params.timeout) || params.timeout <= 0 || params.timeout * 1000 > 2_147_483_647)) {
				throw new Error("Python 超时需要为有效的正秒数。");
			}
			const sessionId = ctx.sessionManager.getSessionId();
			const files = pythonFilesBySession.get(ctx.sessionManager)?.(sessionId) ?? { folder: null, record: () => {} };
			const request = { code: params.code, cwd: state.cwd, folder: files.folder };
			signal?.throwIfAborted();
			if (params.background) return backgroundPython(pi, jobs, kernel, request, files, params);
			const result = await kernel.run(request, files, { ...params, signal });
			return { content: [{ type: "text", text: result.text || "Python 执行完成。" }, ...result.images],
				details: { status: result.status, imagePaths: result.paths } };
		},
	};
}
