import { spawn, type ChildProcess } from "node:child_process";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { killTree } from "../agent/shell.ts";
import { toolchainEnv } from "../agent/toolchain.ts";
import { sandboxEnv, type ExecEnv } from "../agent/state.ts";

export interface GitOutput { code: number; stdout: string; stderr: string; }
export interface GitRunner {
	run(cwd: string, args: string[], signal?: AbortSignal): Promise<GitOutput>;
	exists(paths: string[], signal?: AbortSignal): Promise<boolean[]>;
}
export class GitError extends Error {
	readonly code: string;
	constructor(code: string, message: string) { super(message); this.code = code; }
}

export const DEFAULT_BUNDLED_GIT = join(dirname(fileURLToPath(import.meta.url)), "../../bin/git", process.platform === "win32" ? "cmd/git.exe" : "bin/git");
const GLOBAL_ARGS = ["--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "color.ui=false", "-c", "user.useConfigOnly=true", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];
// Repository selection and author overrides must not leak from the parent process.
const scrub = (key: string) => /^GIT_/i.test(key) || /^(EMAIL)$/i.test(key);
const fixed = { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_PAGER: "cat", LC_ALL: "C" };

async function executable(path: string): Promise<boolean> {
	try { await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK); return (await stat(path)).isFile(); } catch { return false; }
}

/** Only the configured package and absolute PATH entries; never implicitly execute workspace/git.exe. */
export async function findGit(options: { bundledPath?: string | null; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
	const env = options.env ?? process.env;
	const bundled = options.bundledPath === undefined ? env.DREAMFLUTTER_BUNDLED_GIT ?? DEFAULT_BUNDLED_GIT : options.bundledPath;
	if (bundled && isAbsolute(bundled) && await executable(bundled)) return bundled;
	const path = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
	for (const entry of path.split(delimiter)) {
		const dir = entry.replace(/^"|"$/g, "");
		if (!isAbsolute(dir)) continue;
		const candidate = join(dir, process.platform === "win32" ? "git.exe" : "git");
		if (await executable(candidate)) return candidate;
	}
	throw new GitError("not_installed", "未安装 Git：请安装 Git 并加入 PATH，或配置 DREAMFLUTTER_BUNDLED_GIT 为随包 Git 的绝对路径。");
}

export function collectGit(child: ChildProcess, signal?: AbortSignal, timeoutMs = 30_000, maxBytes = 2 * 1024 * 1024): Promise<GitOutput> {
	return new Promise((resolve, reject) => {
		let stdout = "", stderr = "", size = 0, failure: GitError | undefined;
		child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
		const stop = (error: GitError) => { failure ??= error; killTree(child); };
		const abort = () => stop(new GitError("cancelled", "Git 操作已取消；请重新检查状态。"));
		const timer = setTimeout(() => stop(new GitError("timeout", "Git 操作超时；请重新检查状态。")), timeoutMs);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		const append = (stream: "stdout" | "stderr") => (chunk: string) => {
			size += Buffer.byteLength(chunk);
			if (size > maxBytes) { stop(new GitError("output_limit", "Git 输出超过 2 MiB；请缩小文件范围或历史条数。")); return; }
			if (stream === "stdout") stdout += chunk; else stderr += chunk;
		};
		child.stdout?.on("data", append("stdout")); child.stderr?.on("data", append("stderr"));
		const clear = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
		child.once("error", (error: NodeJS.ErrnoException) => { clear(); reject(new GitError(error.code === "ENOENT" ? "not_installed" : "process_error", error.code === "ENOENT" ? "未安装 Git，或配置的可执行文件已不存在。" : error.message)); });
		child.once("close", (code) => { clear(); if (failure) reject(failure); else resolve({ code: code ?? -1, stdout, stderr }); });
	});
}

export function hostGitRunner(options: { bundledPath?: string | null; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): GitRunner {
	return { async exists(paths) { return Promise.all(paths.map(async (path) => { try { await access(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } })); }, async run(cwd, args, signal) {
		if (signal?.aborted) throw new GitError("cancelled", "Git 操作已取消。");
		const base = toolchainEnv(options.env ?? process.env);
		const git = await findGit({ bundledPath: options.bundledPath, env: base });
		const env = { ...Object.fromEntries(Object.entries(base).filter(([key]) => !scrub(key))), ...fixed };
		return collectGit(spawn(git, [...GLOBAL_ARGS, ...args], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }), signal, options.timeoutMs);
	} };
}

/** Boot first; use Linux git as agent, never a Windows/bundled executable. */
export function sandboxGitEnvironment(distro: string): ExecEnv {
	return { ...sandboxEnv(distro), spawn(command, args, cwd) {
		// WSL's default -- route joins arguments into a shell command. --exec preserves argv,
		// including Git formats, multiline messages, spaces and shell metacharacters.
		return spawn("wsl.exe", ["-d", distro, "-u", "agent", "--cd", cwd, "--exec", command, ...args], {
			windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WSL_UTF8: "1" },
		});
	} };
}

const SANDBOX_UNSET = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE", "EMAIL"];

export function sandboxGitRunner(env: ExecEnv, ready: () => Promise<void>): GitRunner {
	return { async exists(paths, signal) {
		await ready();
		// One fixed probe per status instead of bootstrapping wsl.exe once per marker.
		// Paths remain positional argv, never interpolated into shell source.
		const result = await collectGit(env.spawn("sh", ["-c", "for path do if test -e \"$path\"; then printf '1\\n'; else printf '0\\n'; fi; done", "git-state", ...paths], "/workspace"), signal);
		if (result.code !== 0) throw failureForProbe(result);
		const values = result.stdout.trimEnd().split("\n");
		if (values.length !== paths.length || values.some((value) => !/^[01]$/.test(value))) throw new GitError("process_error", "无法检查沙箱仓库状态。");
		return values.map((value) => value === "1");
	}, async run(cwd, args, signal) {
		if (signal?.aborted) throw new GitError("cancelled", "Git 操作已取消。");
		await ready();
		if (signal?.aborted) throw new GitError("cancelled", "Git 操作已取消。");
		const result = await collectGit(env.spawn("env", [...SANDBOX_UNSET.flatMap((key) => ["-u", key]), ...Object.entries({ ...fixed, HOME: "/workspace" }).map(([key, value]) => `${key}=${value}`), "git", ...GLOBAL_ARGS, ...args], cwd), signal);
		if (result.code === 127 && /git/.test(result.stderr)) throw new GitError("not_installed", "沙箱内未安装 Git；请修复沙箱环境。");
		return result;
	} };
}

function failureForProbe(result: GitOutput): GitError { return new GitError("process_error", result.stderr || "无法检查沙箱仓库状态。"); }
