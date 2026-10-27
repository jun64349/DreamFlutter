/**
 * DreamFlutter tool approval.
 *
 * Asks the user before tool calls, according to the mode the DreamFlutter
 * settings page writes to the JSON file named by DREAMFLUTTER_SETTINGS_FILE
 * (re-read on every call, so changes apply without restarting Pi):
 *
 *   "off"     – never ask
 *   "changes" – ask before anything that can change files or run commands
 *               (default; read-only tools run freely)
 *   "all"     – ask before every tool call
 *
 * The question is an extension `select` dialog, which RPC mode forwards to the
 * GUI. Unanswered or cancelled questions block the call (fail closed).
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ApprovalMode = "off" | "changes" | "all";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const ALLOW = "允许";
const DENY = "拒绝";

function currentMode(): ApprovalMode {
	const file = process.env.DREAMFLUTTER_SETTINGS_FILE;
	if (!file) return "changes";
	try {
		const mode = JSON.parse(readFileSync(file, "utf8")).approvalMode;
		return mode === "off" || mode === "all" ? mode : "changes";
	} catch {
		return "changes";
	}
}

function describe(toolName: string, input: Record<string, unknown>): string {
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
			const json = JSON.stringify(input, null, 2);
			return `调用工具「${toolName}」：\n${json.length > 1200 ? `${json.slice(0, 1200)}…` : json}`;
		}
	}
}

export default function (pi: ExtensionAPI) {
	/** Tools the user allowed for the rest of this session. */
	let alwaysAllowed = new Set<string>();

	pi.on("session_start", () => {
		alwaysAllowed = new Set();
	});

	pi.on("tool_call", async (event, ctx) => {
		const mode = currentMode();
		if (mode === "off") return undefined;
		if (mode === "changes" && READ_ONLY_TOOLS.has(event.toolName)) return undefined;
		if (alwaysAllowed.has(event.toolName)) return undefined;
		if (!ctx.hasUI) return { block: true, reason: "需要用户确认，但当前没有界面" };

		const alwaysLabel = `本会话内总是允许「${event.toolName}」`;
		const choice = await ctx.ui.select(`Agent 请求执行操作\n\n${describe(event.toolName, event.input)}`, [
			ALLOW,
			alwaysLabel,
			DENY,
		]);
		if (choice === ALLOW) return undefined;
		if (choice === alwaysLabel) {
			alwaysAllowed.add(event.toolName);
			return undefined;
		}
		return { block: true, reason: "用户拒绝了这次操作" };
	});
}
