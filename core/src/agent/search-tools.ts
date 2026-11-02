import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExecEnv, HarnessState } from "./state.ts";

/**
 * dsh's glob and grep (packages/fs/tool-fs-search): ripgrep with dsh's fixed
 * argument vectors, caps and model-facing output. Pi keeps a ripgrep binary in
 * its bin directory; a system `rg` is the fallback.
 */

const GLOB_MAX_RESULTS = 100;
const GREP_MAX_MATCHES = 250;
const GREP_MAX_LINE_BYTES = 2000;
const SEARCH_TIMEOUT_MS = 30_000;
const RAW_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
const VCS_EXCLUDES = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

/** `core/bin`: where the packaged app ships its tools (scripts/package-windows.ps1). */
export const BUNDLED_TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin");

/**
 * ripgrep shipped with the app, else the one Pi keeps in its bin directory,
 * else `rg` on PATH. A packaged install has its own Pi directory without
 * Pi's binaries, which left search with `rg ENOENT` (extra test 4).
 */
export function ripgrepPath(agentDir: string, bundledDir = BUNDLED_TOOLS_DIR): string {
	const exe = process.platform === "win32" ? "rg.exe" : "rg";
	for (const dir of [bundledDir, join(agentDir, "bin")]) {
		if (existsSync(join(dir, exe))) return join(dir, exe);
	}
	return "rg";
}

interface RgRun {
	stdout: string;
	stderr: string;
	code: number | null;
}

function runRg(env: ExecEnv, rg: string, args: string[], cwd: string, signal: AbortSignal | undefined): Promise<RgRun> {
	return new Promise((resolve, reject) => {
		const child = env.spawn(rg, args, cwd);
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let size = 0;
		const timer = setTimeout(() => child.kill(), SEARCH_TIMEOUT_MS);
		const abort = () => child.kill();
		signal?.addEventListener("abort", abort, { once: true });
		child.stdout!.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > RAW_OUTPUT_MAX_BYTES) child.kill();
			else out.push(chunk);
		});
		child.stderr!.on("data", (chunk: Buffer) => err.push(chunk));
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(new Error(`search failed to start ripgrep: ${error.message}`));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (size > RAW_OUTPUT_MAX_BYTES) return reject(new Error("search output exceeded the raw output cap; narrow the search"));
			resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), code });
		});
	});
}

/** ripgrep exits 1 for "no matches"; anything else above 1 is a failure. */
function rgFailure(run: RgRun): Error | undefined {
	if (run.code === 0 || run.code === 1) return undefined;
	const detail = run.stderr.trim().split("\n")[0] ?? "";
	return new Error(detail ? `search failed: ${detail}` : `search failed with exit code ${run.code}`);
}

/** glob.ts buildGlobCommand. */
export function globArgs(pattern: string, path: string | undefined): string[] {
	const directories = pattern.split("/").slice(0, -1);
	const pruning: string[] = [];
	if (path === undefined && directories.length > 0 && directories.every((part) => /^[\w .-]+$/.test(part) && part !== "." && part !== ".." && !VCS_EXCLUDES.includes(part))) {
		const directoryGlob = `--glob={${[...new Set(directories)].join(",")}}/`;
		if (directoryGlob.length + "--glob=!**".length + 2 <= 8 * 1024) pruning.push("--glob=!**", directoryGlob);
	}
	const parts = [
		"--files",
		...pruning,
		`--glob=${pattern}`,
		"--sort=modified",
		"--no-ignore",
		"--hidden",
		...VCS_EXCLUDES.flatMap((name) => [`--glob=!**/${name}`, `--glob=!**/${name}/**`]),
	];
	if (path !== undefined) parts.push("--", path);
	return parts;
}

export function globTool(state: HarnessState, rg: string): ToolDefinition {
	return {
		name: "glob",
		label: "查找文件",
		description:
			"Find files, not directories, whose paths match a glob pattern, including hidden and ignored files. " +
			`Returns up to ${GLOB_MAX_RESULTS} paths in modification-time order; a larger result keeps the first paths ` +
			"and reports where the complete list was saved.",
		parameters: {
			type: "object",
			properties: {
				pattern: {
					type: "string",
					description:
						'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). ' +
						'A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both search the whole tree; include a separator to anchor the depth.',
				},
				path: { type: "string", description: "Directory to search in. Defaults to the session workspace; a relative path resolves against it." },
			},
			required: ["pattern"],
		} as never,
		async execute(_id, params: { pattern: string; path?: string }, signal) {
			if (params.pattern.trim().length === 0) throw new Error("pattern must be a non-empty string");
			const run = await runRg(state.env, rg, globArgs(params.pattern, params.path), state.cwd, signal);
			const failure = rgFailure(run);
			if (failure) throw failure;
			const paths = run.stdout
				.split("\n")
				.map((line) => line.replace(/\r$/, ""))
				.filter((line) => line.length > 0)
				.map((line) => state.resolve(line));
			let body: string;
			if (paths.length === 0) body = "No files found";
			else if (paths.length <= GLOB_MAX_RESULTS) body = paths.join("\n");
			else {
				body = `${paths.slice(0, GLOB_MAX_RESULTS).join("\n")}\n\n(Showing ${GLOB_MAX_RESULTS} of ${paths.length} paths. The complete result could not be saved; narrow pattern or path to see more.)`;
			}
			return { content: [{ type: "text", text: body }], details: { count: paths.length } };
		},
	};
}

interface GrepMatch {
	path: string;
	lineNumber: number;
	line: string;
}

/** grep.ts parse of `rg --json` output. */
export function parseGrep(stdout: string, resolvePath: (p: string) => string): GrepMatch[] {
	const matches: GrepMatch[] = [];
	for (const raw of stdout.split("\n")) {
		if (!raw.startsWith("{")) continue;
		let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string; bytes?: string } } };
		try {
			event = JSON.parse(raw);
		} catch {
			continue;
		}
		if (event.type !== "match" || !event.data) continue;
		const path = event.data.path?.text;
		const lineNumber = event.data.line_number;
		if (path === undefined || lineNumber === undefined) continue;
		const text = event.data.lines?.text ?? (event.data.lines?.bytes ? Buffer.from(event.data.lines.bytes, "base64").toString("utf8") : "");
		matches.push({ path: resolvePath(path), lineNumber, line: text.replace(/\r?\n$/, "") });
	}
	return matches;
}

function previewLine(line: string): string {
	const bytes = Buffer.from(line, "utf8");
	if (bytes.length <= GREP_MAX_LINE_BYTES) return line;
	let end = GREP_MAX_LINE_BYTES;
	while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1;
	return `${bytes.subarray(0, end).toString("utf8")} (line truncated)`;
}

/** grep.ts formatGrepOutput. */
export function formatGrep(matches: GrepMatch[]): string {
	if (matches.length === 0) return "No matches found";
	const kept = matches.slice(0, GREP_MAX_MATCHES).map((m) => ({ ...m, line: previewLine(m.line) }));
	const truncated = matches.length > kept.length;
	const header = truncated ? `Found ${kept.length} of ${matches.length} matches` : `Found ${matches.length} ${matches.length === 1 ? "match" : "matches"}`;
	const byFile = new Map<string, GrepMatch[]>();
	for (const match of kept) {
		const group = byFile.get(match.path);
		if (group) group.push(match);
		else byFile.set(match.path, [match]);
	}
	const body = [...byFile].map(([path, group]) => `${path}\n${group.map((m) => `Line ${m.lineNumber}: ${m.line}`).join("\n")}`).join("\n\n");
	if (!truncated) return `${header}\n\n${body}`;
	return `${header}\n\n${body}\n\n(The complete result could not be saved; narrow pattern, path, or include to see more.)`;
}

export function grepTool(state: HarnessState, rg: string): ToolDefinition {
	return {
		name: "grep",
		label: "搜索",
		description:
			"Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file. " +
			`Returns up to ${GREP_MAX_MATCHES} matches; a larger result reports where the complete match list was saved.`,
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Regular expression to search for (ripgrep syntax)." },
				path: { type: "string", description: "File or directory to search. Defaults to the session workspace; a relative path resolves against it." },
				include: {
					type: "string",
					description: 'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.',
				},
			},
			required: ["pattern"],
		} as never,
		async execute(_id, params: { pattern: string; path?: string; include?: string }, signal) {
			if (params.pattern.length === 0) throw new Error("pattern must be a non-empty string");
			const args = ["--json", `--regexp=${params.pattern}`];
			if (params.include !== undefined) args.push(`--glob=${params.include}`);
			if (params.path !== undefined) args.push("--", params.path);
			const run = await runRg(state.env, rg, args, state.cwd, signal);
			const failure = rgFailure(run);
			if (failure) throw failure;
			const matches = parseGrep(run.stdout, (p) => state.resolve(p));
			return { content: [{ type: "text", text: formatGrep(matches) }], details: { count: matches.length } };
		},
	};
}
