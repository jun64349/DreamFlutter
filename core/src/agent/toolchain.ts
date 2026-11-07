import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { proxyEnvironment, readSystemProxy } from "./system-proxy.ts";
import { applyToolEnvironment, type ToolEnvironment } from "./tool-environment.ts";

/**
 * The workbench's runtime environment (roadmap 3.6): tools the app ships for
 * every workspace (rg, fd, uv in core/bin; a portable Python in core/python,
 * scripts/fetch-toolchain.ts), and a .dreamflutter folder in each workspace for
 * the agent's own notes, virtual environment and scratch files, so it neither
 * hunts for tools nor scatters files among the user's.
 */

const CORE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** rg, fd, uv, uvx. */
export const TOOLS_DIR = join(CORE_DIR, "bin");
/** `uv python install --install-dir` puts a cpython-* folder here. */
export const PYTHON_DIR = join(CORE_DIR, "python");

export const WORKSPACE_DIR = ".dreamflutter";
export const WORKSPACE_NOTES = "workspace.md";
/** Notes put into the prompt; longer notes are cut (the agent can read the file). */
const NOTES_PROMPT_CHARS = 6_000;

/** python.exe of the shipped Python, if there is one. */
export function bundledPython(pythonDir = PYTHON_DIR): string | undefined {
	if (!existsSync(pythonDir)) return undefined;
	const installs = readdirSync(pythonDir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && e.name.startsWith("cpython-"))
		.map((e) => e.name)
		.sort()
		.reverse();
	for (const name of installs) {
		const exe = join(pythonDir, name, process.platform === "win32" ? "python.exe" : "bin/python3");
		if (existsSync(exe)) return exe;
	}
	return undefined;
}

/**
 * The environment for the agent's commands: the shipped tools and Python first
 * on PATH, uv told to use that Python and never download one, Python in UTF-8.
 * Without shipped tools (a development checkout before fetch-toolchain) it is
 * the plain environment plus UTF-8.
 */
export function toolchainEnv(base: NodeJS.ProcessEnv = process.env, toolsDir = TOOLS_DIR, pythonDir = PYTHON_DIR, source?: ToolEnvironment): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...applyToolEnvironment(proxyEnvironment(readSystemProxy(), base), source), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
	// Downloads and caches stay in the app's data folder instead of the user's profile on C:.
	const cache = base.DREAMFLUTTER_CACHE;
	if (cache) {
		env.UV_CACHE_DIR ??= join(cache, "uv");
		env.PIP_CACHE_DIR ??= join(cache, "pip");
	}
	const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
	const first: string[] = [];
	if (existsSync(toolsDir)) first.push(toolsDir);
	const python = bundledPython(pythonDir);
	if (python) {
		const home = dirname(python);
		first.push(home, join(home, "Scripts"));
		env.UV_PYTHON = python;
		env.UV_PYTHON_DOWNLOADS = "never";
	}
	if (first.length) env[pathKey] = [...first, env[pathKey] ?? ""].filter(Boolean).join(process.platform === "win32" ? ";" : ":");
	return env;
}

/** What the agent is told about the tools it has (one line each). */
export function toolchainSummary(env: NodeJS.ProcessEnv = toolchainEnv()): string[] {
	const lines: string[] = [];
	const has = (exe: string) => existsSync(join(TOOLS_DIR, process.platform === "win32" ? `${exe}.exe` : exe));
	const tools = ["rg", "fd", "uv"].filter(has);
	if (tools.length) lines.push(`The app provides ${tools.join(", ")} on PATH for your commands.`);
	if (env.UV_PYTHON) lines.push(`Python ${pythonVersion(env.UV_PYTHON) ?? "3"} is on PATH (\`python\`) and is uv's default interpreter; use it rather than installing another.`);
	return lines;
}

function pythonVersion(exe: string): string | undefined {
	return /cpython-(\d+\.\d+\.\d+)/.exec(exe)?.[1];
}

/**
 * Makes sure [cwd]/.dreamflutter exists (ignored by git) and returns the
 * workspace notes, if any. Never touches anything else in the workspace; a
 * workspace that cannot be written (read-only, a drive root) is left alone.
 */
export function prepareWorkspace(cwd: string): { dir: string; notes: string | undefined } {
	const dir = join(cwd, WORKSPACE_DIR);
	try {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
			// The folder keeps git out of itself (a .gitignore of "*" ignores the file too).
			writeFileSync(join(dir, ".gitignore"), "# DreamFlutter's own files for this workspace\n*\n");
		}
	} catch {}
	let notes: string | undefined;
	try {
		notes = readFileSync(join(dir, WORKSPACE_NOTES), "utf8").trim() || undefined;
	} catch {}
	return { dir, notes };
}

/** The system-prompt section about the workspace folder and the tools. */
export function workspaceGuidance(notes: string | undefined, tools: string[] = toolchainSummary()): string {
	const parts = [
		"# Workspace environment",
		...tools.map((t) => `- ${t}`),
		`- Keep your own working files in \`${WORKSPACE_DIR}\\\` inside the workspace, never among the user's files: \`${WORKSPACE_DIR}\\venv\` for a Python virtual environment when you need packages (\`uv venv ${WORKSPACE_DIR}\\venv\`, then \`uv pip install --python ${WORKSPACE_DIR}\\venv <package>\`), \`${WORKSPACE_DIR}\\tmp\` for scratch files and helper scripts. Git ignores this folder.`,
		`- \`${WORKSPACE_DIR}\\${WORKSPACE_NOTES}\` keeps notes about this workspace for later sessions: what it is, how to run and test it, conventions you found. When you learn something lasting about it, update the file (short, facts only).`,
	];
	if (notes) {
		const cut = notes.length > NOTES_PROMPT_CHARS ? `${notes.slice(0, NOTES_PROMPT_CHARS)}\n… (cut here; read the file for the rest)` : notes;
		parts.push("", `## ${WORKSPACE_DIR}\\${WORKSPACE_NOTES}`, cut);
	}
	return parts.join("\n");
}
