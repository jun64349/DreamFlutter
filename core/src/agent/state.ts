import { type ChildProcess, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, posix, resolve } from "node:path";

/** A file version as dsh's observation policy compares it. */
export type FileVersion = string;

export type Observation = { kind: "present"; version: FileVersion } | { kind: "absent" };

export interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
}

/**
 * Per-session harness state the dsh-style tools share: the session's working
 * directory, what the agent has read (dsh fs-observation-policy), the todo
 * list and plan mode. Lives as long as the Pi runtime that owns it.
 */
/**
 * Where a session's tools act (docs/v0.3-design.md 三): this machine, or
 * 蝶君's WSL sandbox. Paths the model writes follow the environment's rules
 * (Windows or POSIX); the core opens them through [local].
 */
export interface ExecEnv {
	readonly kind: "host" | "sandbox";
	/** A model-supplied path, made absolute against [cwd]. */
	resolve(cwd: string, path: string): string;
	/** The path Node opens for a resolved model path. */
	local(path: string): string;
	/** Starts [command] inside the environment, in [cwd]. */
	spawn(command: string, args: string[], cwd: string): ChildProcess;
}

export const HOST_ENV: ExecEnv = {
	kind: "host",
	resolve: (cwd, path) => (isAbsolute(path) ? resolve(path) : resolve(cwd, path)),
	local: (path) => path,
	spawn: (command, args, cwd) => spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }),
};

/** 蝶君's sandbox: Linux paths, opened through \\wsl.localhost; programs run as the agent user. */
export function sandboxEnv(distro: string): ExecEnv {
	return {
		kind: "sandbox",
		resolve: (cwd, path) => (posix.isAbsolute(path) ? posix.resolve(path) : posix.resolve(cwd, path)),
		local: (path) => `\\\\wsl.localhost\\${distro}${posix.resolve("/", path).replaceAll("/", "\\")}`,
		spawn: (command, args, cwd) =>
			spawn("wsl.exe", ["-d", distro, "-u", "agent", "--cd", cwd, "--", command, ...args], {
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, WSL_UTF8: "1" },
			}),
	};
}

export class HarnessState {
	cwd: string;
	readonly env: ExecEnv;
	readonly observations = new Map<string, Observation>();
	todos: TodoItem[] | null = null;
	planMode = false;
	/** Plan mode the model was last told about (narration on change). */
	planModeTold: boolean | undefined;

	constructor(cwd: string, env: ExecEnv = HOST_ENV) {
		this.cwd = cwd;
		this.env = env;
	}

	/** A model-supplied path, absolute (relative paths resolve against the session cwd). */
	resolve(path: string): string {
		return this.env.resolve(this.cwd, path);
	}

	/** Where the core opens a resolved path. */
	local(path: string): string {
		return this.env.local(path);
	}

	observe(path: string, observation: Observation): void {
		this.observations.set(key(path), observation);
	}

	observed(path: string): Observation | undefined {
		return this.observations.get(key(path));
	}

	private readonly locks = new Map<string, Promise<unknown>>();

	/**
	 * Runs [fn] alone for [path] (tools run in parallel): the version check,
	 * read, write and new observation of one mutation happen together.
	 */
	async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
		const k = key(path);
		const prior = this.locks.get(k) ?? Promise.resolve();
		const run = prior.then(fn, fn);
		const tail = run.catch(() => undefined);
		this.locks.set(k, tail);
		try {
			return await run;
		} finally {
			if (this.locks.get(k) === tail) this.locks.delete(k);
		}
	}
}

function key(path: string): string {
	return process.platform === "win32" ? path.toLowerCase() : path;
}

/** Current version of [path], or null when it does not exist. */
export async function versionOf(path: string): Promise<{ version: FileVersion; isFile: boolean } | null> {
	try {
		const info = await stat(path);
		return { version: `${info.size}:${info.mtimeMs}`, isFile: info.isFile() };
	} catch {
		return null;
	}
}

/** dsh FsError: a model-facing message plus a machine code. */
export class FsError extends Error {
	readonly code: string;

	constructor(message: string, code: string) {
		super(message);
		this.code = code;
	}
}

/** tool-fs/src/error.ts remediateFsError. */
export function remediate(error: unknown, displayPath: string): unknown {
	if (!(error instanceof FsError)) return error;
	if (error.code === "FS_NOT_OBSERVED") return new FsError(`cannot modify "${displayPath}": file has not been read — read the file, then retry`, error.code);
	if (error.code === "FS_STALE_VERSION") return new FsError(`${error.message} — re-read the file, then retry`, error.code);
	return error;
}
