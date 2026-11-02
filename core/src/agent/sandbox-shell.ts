import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { killTree } from "./shell.ts";

/**
 * The bash of 蝶君's sandbox: one persistent shell per session, as the agent
 * user, fed one wrapped command per call (directory and variables persist),
 * the way the minimal preset's PowerShell works (shell.ts PersistentShell).
 * Holding its wsl.exe open also keeps the sandbox from idling out.
 */

const TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 16_000;
const MEMORY_CHARS = 4_000_000;
const RESET_MESSAGE = "The sandbox shell was reset; the next bash call starts in /workspace with a fresh environment.";

export const SANDBOX_BASH_DESCRIPTION = `Run a command in bash inside your Linux sandbox (Ubuntu 24.04, user "agent", home /workspace).
* The shell persists across calls: cd, exported variables and functions stay.
* Everything here is yours: no approval is needed and nothing outside the sandbox can be harmed. You cannot reach the user's Windows files.
* Python 3 with pandas, numpy, matplotlib and openpyxl is installed; create a venv (python3 -m venv) for other packages. git, curl, jq, rg, fd, zip are available. There is no sudo.
* Commands time out after ${TIMEOUT_MS / 1000} seconds; start long jobs in the background (nohup … &) and check on them.
* Avoid commands that print a very large amount of output.`;

function truncate(content: string): string {
	return content.length <= MAX_OUTPUT_CHARS ? content : `${content.slice(0, MAX_OUTPUT_CHARS)}\n<output clipped: use head, tail or grep to see the part you need>`;
}

export class SandboxShell {
	private child: ChildProcess | undefined;
	private output = "";
	private queue: Promise<unknown> = Promise.resolve();
	private readonly distro: string;
	private readonly ready: () => Promise<void>;

	/** [ready] boots the sandbox (mounts cut, firewall rules) before the shell starts. */
	constructor(distro: string, ready: () => Promise<void>) {
		this.distro = distro;
		this.ready = ready;
	}

	private async ensure(): Promise<ChildProcess> {
		if (this.child && this.child.exitCode === null) return this.child;
		this.output = "";
		// Start the shell first: it keeps the distro running, so the boot's work (mounts cut, rules) stays in place.
		const child = spawn("wsl.exe", ["-d", this.distro, "-u", "agent", "--cd", "/workspace", "--", "bash", "--noprofile", "--norc"], {
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, WSL_UTF8: "1" },
		});
		const append = (decoder: StringDecoder) => (chunk: Buffer) => {
			this.output += decoder.write(chunk);
			if (this.output.length > MEMORY_CHARS) this.output = this.output.slice(0, MEMORY_CHARS / 4) + this.output.slice(-MEMORY_CHARS / 4);
		};
		child.stdout!.on("data", append(new StringDecoder("utf8")));
		// wsl.exe's own notices (e.g. about the Windows proxy) arrive on stderr before the shell's; commands send theirs to stdout.
		child.stderr!.on("data", () => {});
		child.on("error", () => {});
		child.stdin!.on("error", () => {});
		this.child = child;
		try {
			await this.ready();
		} catch (error) {
			this.reset();
			throw error;
		}
		child.stdin!.write("export HOME=/workspace LANG=C.UTF-8 PYTHONIOENCODING=utf-8 MPLBACKEND=Agg; cd /workspace\n");
		return child;
	}

	reset(): void {
		if (this.child) killTree(this.child);
		this.child = undefined;
		this.output = "";
	}

	run(command: string, signal: AbortSignal | undefined): Promise<string> {
		const next = this.queue.then(
			() => this.execute(command, signal),
			() => this.execute(command, signal),
		);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async execute(command: string, signal: AbortSignal | undefined): Promise<string> {
		if (signal?.aborted) return "";
		const child = await this.ensure();
		const nonce = randomUUID();
		const start = `__DF_SANDBOX_START_${nonce}__`;
		const end = `__DF_SANDBOX_END_${nonce}:`;
		const body = Buffer.from(command.replaceAll("\r", ""), "utf8").toString("base64");
		// The command never reads the shell's own stdin (that is where the next commands come from).
		const wrapper = `printf '%s\\n' '${start}'; { eval "$(printf %s '${body}' | base64 -d)"; } </dev/null 2>&1; printf '\\n%s%d\\n' '${end}' "$?"\n`;
		this.output = "";
		child.stdin!.write(wrapper);
		const startedAt = Date.now();
		for (;;) {
			await new Promise((r) => setTimeout(r, 25));
			const text = this.output;
			const endAt = text.lastIndexOf(end);
			const status = endAt >= 0 ? /^(-?\d+)\n/.exec(text.slice(endAt + end.length))?.[1] : undefined;
			if (status !== undefined) {
				const startAt = text.indexOf(start);
				const captured = text.slice(startAt < 0 ? 0 : startAt + start.length + 1, endAt).replace(/\n$/, "");
				const content = truncate(captured);
				const code = Number(status);
				return code === 0 ? content : content.length === 0 ? `[exit code: ${code}]` : `${content}\n[exit code: ${code}]`;
			}
			if (child.exitCode !== null || this.child !== child) {
				this.reset();
				return `${truncate(text.replace(`${start}\n`, ""))}\n[shell exited]\n${RESET_MESSAGE}`;
			}
			if (signal?.aborted) {
				this.reset();
				return "";
			}
			if (Date.now() - startedAt >= TIMEOUT_MS) {
				this.reset();
				return `The command timed out after ${TIMEOUT_MS / 1000} seconds. Partial output:\n${truncate(text.replace(`${start}\n`, ""))}\n${RESET_MESSAGE}`;
			}
		}
	}
}

export function sandboxBashTool(shell: SandboxShell): ToolDefinition {
	return {
		name: "bash",
		label: "运行命令",
		description: SANDBOX_BASH_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "The bash command to run." },
				description: { type: "string", description: "A few words on what it does, shown to the user." },
			},
			required: ["command"],
		} as never,
		executionMode: "sequential",
		async execute(_id, params: { command: string }, signal) {
			if (params.command.trim().length === 0) throw new Error("command must be a non-empty string");
			const text = await shell.run(params.command, signal);
			return { content: [{ type: "text", text }], details: {} };
		},
	};
}
