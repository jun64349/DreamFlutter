import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { ALLOW, APPROVAL_TITLE, DENY, alwaysAllowLabel, workspaceAllowLabel } from "../pi/dialogs.ts";
import type { ApprovalMode } from "../settings.ts";

/** Tools that cannot change anything outside the agent's own context. */
export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "memory_search", "session_search", "web_fetch", "desk_list", "desk_read"]);

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
			return `执行命令：\n${str("command") ?? ""}`;
		case "write": {
			const content = str("content") ?? "";
			return `写入文件：${str("path") ?? ""}\n（${content.length} 个字符）`;
		}
		case "edit":
			return `修改文件：${str("path") ?? ""}`;
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
			if (mode === "changes" && READ_ONLY_TOOLS.has(event.toolName)) return undefined;
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
