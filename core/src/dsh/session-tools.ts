import type { Context } from "@deepseek-ai/cordis";
import { HarnessError, type ContentBlock } from "@deepseek-ai/dsh-llm";
import { runToolCall } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, JsonObject, TextContent } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { MINIMAL_TOOLS } from "../agent/harness.ts";
import type { DshSlotContent } from "./session-content.ts";

const contentSchema = { type: "array", items: { type: "object", additionalProperties: true } } as const;

/** Reuse the exact existing wrapped tools and guard hooks while the tools are migrated. */
export function bindWorkbenchTools(ctx: Context, session: AgentSession, content: DshSlotContent, emit: (event: AgentSessionEvent) => void,
	names: readonly string[] = MINIMAL_TOOLS, available: () => boolean = () => true): void {
	for (const name of new Set(names)) {
		const currentTool = () => session.agent.state.tools.find(tool => tool.name === name);
		const declared = session.getToolDefinition(name) ?? currentTool();
		if (!declared) continue;
		const subagent = name === "agent";
		ctx.tools.register({
			name,
			description: declared.description,
			parameters: JSON.parse(JSON.stringify(declared.parameters)),
			output: subagent ? {
				schema: { type: "object", properties: { content: contentSchema, details: {} }, required: ["content", "details"], additionalProperties: false },
				render: (_args, value) => (value as unknown as { content: ContentBlock[] }).content,
				presentationMeta: (_args, value) => value && typeof value === "object" && !Array.isArray(value) ? value.details ?? null : null,
			} : {
				schema: contentSchema,
				render: (_args, value) => value as unknown as ContentBlock[],
			},
			...(subagent && { isConcurrencySafe: () => true }),
			async execute(args, exec) {
				const tool = currentTool();
				const beforeToolCall = session.agent.beforeToolCall;
				if (!available() || !tool || !beforeToolCall) throw new HarnessError("工具授权没有准备好", "TOOL_UNAVAILABLE");
				const toolCall = { type: "toolCall" as const, id: exec.callId, name, arguments: args as JsonObject };
				const assistant = session.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
				if (!assistant?.content.some(block => block.type === "toolCall" && block.id === exec.callId && block.name === name)) {
					throw new HarnessError("缺少对应的工具调用记录", "TOOL_UNAVAILABLE");
				}
				const outcome = await runToolCall(toolCall, {
					tools: [tool], assistantMessage: assistant, context: session.agent.state,
					beforeToolCall, afterToolCall: session.agent.afterToolCall, signal: exec.signal,
					onUpdate: (partialResult) => emit({ type: "tool_execution_update", toolCallId: exec.callId, toolName: name, args, partialResult }),
				});
				if (outcome.isError) {
					const reason = outcome.result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
					throw new HarnessError(reason || "工具执行失败", "TOOL_FAILED");
				}
				if (outcome.result.terminate) exec.concludeTurn();
				const blocks = await content.toDsh(outcome.result.content as (TextContent | ImageContent)[]);
				return subagent ? { content: blocks, details: outcome.result.details ?? null } : blocks;
			},
		}, { when: () => available() && session.getActiveToolNames().includes(name) && !!currentTool() });
	}
}
