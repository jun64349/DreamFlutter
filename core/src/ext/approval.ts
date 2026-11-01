import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { ALLOW, APPROVAL_TITLE, DENY, alwaysAllowLabel, workspaceAllowLabel } from "../pi/dialogs.ts";
import type { ApprovalMode } from "../settings.ts";

/** Tools that cannot change anything outside the agent's own context. */
export const READ_ONLY_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"glob",
	"read_image",
	"working_directory",
	"job_list",
	"job_output",
	"job_kill",
	"todo_write",
	"ask_user_question",
	"exit_plan_mode",
	"skill",
	"memory_search",
	"session_search",
	"web_fetch",
]);

/** Shell tools: whether a call only reads depends on its command. */
export const SHELL_TOOLS = new Set(["pwsh", "bash", "powershell"]);

/** Commands (the first word of a pipeline stage) that only read. */
const READ_ONLY_COMMANDS = new Set([
	"ls", "dir", "gci", "cat", "type", "gc", "pwd", "echo", "cd", "sl", "pushd", "popd", "findstr", "where.exe", "whoami", "hostname", "tree",
	"select-string", "sls", "select-object", "select", "where-object", "?", "sort-object", "sort", "measure-object", "measure", "group-object",
	"format-table", "ft", "format-list", "fl", "format-wide", "out-string", "write-output", "write-host", "test-path", "resolve-path",
	"split-path", "join-path", "compare-object", "convertfrom-json", "convertto-json",
]);
/** git subcommands that only read, whatever their options. */
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "grep"]);
/** git subcommands that read only when listing (no arguments but these). */
const LISTING_GIT: Record<string, Set<string>> = {
	branch: new Set(["-a", "-r", "-v", "-vv", "--list", "--all", "--show-current", "--remotes"]),
	remote: new Set(["-v", "--verbose"]),
	tag: new Set(["-l", "--list"]),
};
/** git options that start other programs, even on reading subcommands (git accepts unique prefixes of long options). */
const GIT_RUNNERS = ["--open-files-in-pager", "--ext-diff"];

function gitArgRuns(arg: string): boolean {
	if (arg.startsWith("--")) {
		const name = arg.split("=")[0]!.toLowerCase();
		return name.length >= 4 && GIT_RUNNERS.some((option) => option.startsWith(name));
	}
	// -O[<pager>] opens matches in a program; short options can be bundled (-nO).
	return /^-[^-]*O/.test(arg);
}

/** Programs whose bare version query only reads. */
const VERSION_PROGRAMS = new Set(["node", "npm", "npx", "pnpm", "yarn", "python", "python3", "py", "pip", "uv", "git", "dotnet", "java", "go", "rustc", "cargo", "flutter", "dart", "pwsh", "powershell"]);

/**
 * Whether a shell command only reads: every pipeline stage starts with a
 * known read-only command (Get-*, git status, …) and nothing redirects,
 * groups, substitutes or runs other code. Anything not provably read-only
 * asks for approval.
 */
export function isReadOnlyCommand(command: string): boolean {
	const text = command.trim();
	if (text.length === 0) return false;
	// Redirection, escapes, grouping and script blocks (which can hold any command), and code runners.
	if (/[>`(){}\[\]]|@'|@"|\binvoke-|\biex\b|-command\b|-encodedcommand\b|start-process|-delete\b|--output\b|--pre\b|-outvariable\b|-ov\b/i.test(text)) return false;
	// A lone & runs what follows as another command (PowerShell 7's background operator, bash too); && is split below.
	if (/(^|[^&])&(?!&)/.test(text)) return false;
	for (const raw of text.split(/\r?\n|;|\|\||&&|\|/)) {
		const stage = raw.trim();
		if (stage.length === 0) continue;
		const [first, ...rest] = stage.split(/\s+/);
		const word = first!.toLowerCase();
		if (word === "git") {
			const sub = rest[0]?.toLowerCase();
			if (!sub) return false;
			if (rest.slice(1).some(gitArgRuns)) return false;
			if (READ_ONLY_GIT.has(sub)) continue;
			const listing = LISTING_GIT[sub];
			if (listing && rest.slice(1).every((arg) => listing.has(arg.toLowerCase()))) continue;
			return false;
		}
		if (/^get-[a-z]+$/.test(word) && word !== "get-credential") continue;
		if (VERSION_PROGRAMS.has(word) && rest.length === 1 && /^(--version|-v|-version)$/i.test(rest[0]!)) continue;
		if (!READ_ONLY_COMMANDS.has(word)) return false;
	}
	return true;
}

/** Whether a tool call cannot change anything (approval mode "changes" lets it run). */
export function isReadOnlyCall(tool: string, input: Record<string, unknown>): boolean {
	if (READ_ONLY_TOOLS.has(tool)) return true;
	return SHELL_TOOLS.has(tool) && typeof input.command === "string" && isReadOnlyCommand(input.command);
}

export interface ApprovalPolicy {
	mode(): ApprovalMode;
	/** Tools the user always allows in this workspace. */
	workspaceAllowed(cwd: string): Set<string>;
	allowInWorkspace(cwd: string, tool: string): void;
	/** Tools that never need approval (e.g. the core's own bookkeeping tools). */
	exempt?(tool: string): boolean;
	/** A decision that skips the dialog (scheduled runs: allowed tools run, others are blocked). */
	override?(tool: string, input: Record<string, unknown>): "allow" | "deny" | undefined;
}

export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
	const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined);
	switch (toolName) {
		case "bash":
		case "powershell":
		case "pwsh": {
			const what = str("description");
			return `执行命令${what ? `（${what}）` : ""}：\n${str("command") ?? ""}`;
		}
		case "write": {
			const content = str("content") ?? "";
			return `写入文件：${str("file_path") ?? str("path") ?? ""}\n（${content.length} 个字符）`;
		}
		case "edit":
			return `修改文件：${str("file_path") ?? str("path") ?? ""}`;
		default: {
			const text = JSON.stringify(input, null, 2);
			return `调用工具「${toolName}」：\n${text.length > 1200 ? `${text.slice(0, 1200)}…` : text}`;
		}
	}
}

/**
 * Asks the user before tool calls according to the approval mode:
 * off = never, changes = anything not read-only, all = every call.
 * Unanswered or cancelled questions block the call (fail closed).
 */
export function approvalExtension(policy: ApprovalPolicy): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let sessionAllowed = new Set<string>();

		pi.on("session_start", () => {
			sessionAllowed = new Set();
		});

		pi.on("tool_call", async (event, ctx) => {
			const decided = policy.override?.(event.toolName, (event.input ?? {}) as Record<string, unknown>);
			if (decided === "allow") return undefined;
			if (decided === "deny") return { block: true, reason: "定时任务没有被允许使用这个工具（可以在定时任务设置里允许）" };
			const mode = policy.mode();
			if (mode === "off") return undefined;
			if (policy.exempt?.(event.toolName)) return undefined;
			if (mode === "changes" && isReadOnlyCall(event.toolName, (event.input ?? {}) as Record<string, unknown>)) return undefined;
			if (sessionAllowed.has(event.toolName)) return undefined;
			if (policy.workspaceAllowed(ctx.cwd).has(event.toolName)) return undefined;
			if (!ctx.hasUI) return { block: true, reason: "需要用户确认，但当前没有界面" };

			const session = alwaysAllowLabel(event.toolName);
			const workspace = workspaceAllowLabel(event.toolName);
			// Stopping the run dismisses the question (an unanswered question blocks the call).
			const choice = await ctx.ui.select(
				`${APPROVAL_TITLE}\n\n${describeToolCall(event.toolName, event.input as Record<string, unknown>)}`,
				[ALLOW, session, workspace, DENY],
				{ signal: ctx.signal },
			);
			if (choice === ALLOW) return undefined;
			if (choice === session) {
				sessionAllowed.add(event.toolName);
				return undefined;
			}
			if (choice === workspace) {
				policy.allowInWorkspace(ctx.cwd, event.toolName);
				return undefined;
			}
			return { block: true, reason: choice === DENY ? "用户拒绝了这次操作" : "没有得到用户确认" };
		});
	};
}
