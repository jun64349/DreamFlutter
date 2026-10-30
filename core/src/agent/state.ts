import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

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
export class HarnessState {
	cwd: string;
	readonly observations = new Map<string, Observation>();
	todos: TodoItem[] | null = null;
	planMode = false;
	/** Plan mode the model was last told about (narration on change). */
	planModeTold: boolean | undefined;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	/** A model-supplied path, absolute (relative paths resolve against the session cwd). */
	resolve(path: string): string {
		return isAbsolute(path) ? resolve(path) : resolve(this.cwd, path);
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
