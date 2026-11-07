import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { ALLOW, APPROVAL_TITLE, DENY, alwaysAllowLabel, workspaceAllowLabel } from "../pi/dialogs.ts";
import type { ApprovalMode } from "../settings.ts";
import { safeLiteralCommand, wasSecurityApproved } from "../security/command.ts";
import { redact } from "../security/redaction.ts";

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
	"web_search",
]);

/** Shell tools: whether a call only reads depends on its command. */
export const SHELL_TOOLS = new Set(["pwsh", "bash", "powershell"]);

/** Only the reviewed PowerShell literal grammar is eligible for automatic approval. */
export function isReadOnlyCommand(command: string): boolean {
	return safeLiteralCommand(command);
}

/** Whether a tool call cannot change anything (approval mode "changes" lets it run). */
export function isReadOnlyCall(tool: string, input: Record<string, unknown>): boolean {
	if (READ_ONLY_TOOLS.has(tool)) return true;
	return SHELL_TOOLS.has(tool) && typeof input.command === "string" && isReadOnlyCommand(input.command);
}

export interface ApprovalPolicy {
	audit?(tool: string, decision: string, reason: string, requestId: string): void;
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
			if (decided) policy.audit?.(event.toolName, decided, "模块运行策略", event.toolCallId);
			if (decided === "allow") return undefined;
			if (decided === "deny") return { block: true, reason: "定时任务没有被允许使用这个工具（可以在定时任务设置里允许）" };
			if (wasSecurityApproved((event.input ?? {}) as object)) return undefined;
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
				`${APPROVAL_TITLE}\n\n${redact(describeToolCall(event.toolName, event.input as Record<string, unknown>), true)}`,
				[ALLOW, session, workspace, DENY],
				{ signal: ctx.signal },
			).catch(() => undefined);
			policy.audit?.(event.toolName, choice === ALLOW || choice === session || choice === workspace ? "allow" : "deny", choice === undefined ? "未得到用户确认" : "用户选择审批结果", event.toolCallId);
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
