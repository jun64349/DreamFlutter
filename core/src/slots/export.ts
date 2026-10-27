import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

type Block = { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };

function blocks(content: unknown): Block[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as Block[]) : [];
}

function fence(text: string): string {
	const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
	const ticks = "`".repeat(longest + 1);
	return `${ticks}\n${text}\n${ticks}`;
}

/** Renders the active branch as Markdown for reading or sharing. */
export function sessionToMarkdown(session: AgentSession): string {
	const title = session.sessionName ?? "对话记录";
	const lines: string[] = [`# ${title}`, ""];
	for (const message of session.messages as unknown as Record<string, unknown>[]) {
		switch (message.role) {
			case "user": {
				const text = blocks(message.content)
					.filter((b) => b.type === "text")
					.map((b) => b.text ?? "")
					.join("\n")
					.trim();
				if (text) lines.push("## 用户", "", text, "");
				break;
			}
			case "assistant": {
				const parts: string[] = [];
				for (const block of blocks(message.content)) {
					if (block.type === "text" && block.text?.trim()) parts.push(block.text.trim());
					if (block.type === "toolCall") parts.push(`> 调用工具 \`${block.name}\`\n\n${fence(JSON.stringify(block.arguments ?? {}, null, 2))}`);
				}
				if (parts.length) lines.push("## 助手", "", ...parts.flatMap((p) => [p, ""]));
				break;
			}
			case "toolResult": {
				const text = blocks(message.content)
					.filter((b) => b.type === "text")
					.map((b) => b.text ?? "")
					.join("\n")
					.trim();
				if (text) lines.push(`<details><summary>工具结果${message.isError ? "（出错）" : ""}</summary>`, "", fence(text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text), "", "</details>", "");
				break;
			}
		}
	}
	return lines.join("\n");
}

export function exportMarkdown(session: AgentSession, outputPath?: string): string {
	const path = outputPath ?? join(session.sessionManager.getCwd(), `${(session.sessionName ?? session.sessionId).replace(/[\\/:*?"<>|]/g, "_")}.md`);
	writeFileSync(path, sessionToMarkdown(session), "utf8");
	return path;
}
