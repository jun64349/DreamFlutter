import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import { LlmError, ToolCallId, type AssistantStreamRecord, type ContentBlock, type FinishReason, type GenerateOptions, type ReplayEnvelope, type StreamChunk } from "@deepseek-ai/dsh-llm";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, JsonObject, Model, TextContent, ImageContent } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { classifyFailure } from "../gateway/classify.ts";
import type { RouteState } from "../gateway/router.ts";

const replayFormat = "dreamflutter-model-transport-v1";
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

interface ReplayResponse {
	format: typeof replayFormat;
	provider: string;
	model: string;
	state?: RouteState;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function replayResponse(replay: unknown): ReplayResponse | undefined {
	const value = record(record(replay).response);
	if (value.format !== replayFormat || typeof value.provider !== "string" || typeof value.model !== "string") return;
	const state = record(value.state);
	return { format: replayFormat, provider: value.provider, model: value.model,
		state: typeof state.channel === "string" && typeof state.model === "string" ? { channel: state.channel, model: state.model } : undefined };
}

export function previousGroupRoute(options: GenerateOptions): RouteState | undefined {
	for (const message of [...options.messages].reverse()) {
		if (message.role === "assistant" && message.source.provider === options.provider && message.source.model === options.model) {
			return replayResponse(message.source.replayState)?.state;
		}
	}
}

function textOf(content: readonly ContentBlock[]): string {
	return content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
}

async function textAndImages(content: readonly ContentBlock[], attachments: AttachmentStore | undefined, signal?: AbortSignal) {
	const result: (TextContent | ImageContent)[] = [];
	for (const block of content) {
		if (block.type === "text") result.push({ type: "text", text: block.text });
		if (block.type === "image" && !block.offloaded) {
			if (!attachments) throw new LlmError("附件服务尚未就绪，无法读取图片", "UNSUPPORTED_CONTENT");
			const { data, ref } = await attachments.readImage(block.attachment, signal);
			result.push({ type: "image", data: Buffer.from(data).toString("base64"), mimeType: ref.mediaType });
		}
	}
	return result;
}

export async function toGatewayContext(options: GenerateOptions, runtime: ModelRuntime, selected: Model<Api>, attachments: AttachmentStore | undefined): Promise<Context> {
	const messages: Context["messages"] = [];
	const toolsByCall = new Map<string, string>();
	for (const message of options.messages) {
		options.signal?.throwIfAborted();
		const timestamp = 0;
		switch (message.role) {
			case "system":
			case "developer": {
				const content = textOf(message.content);
				if (content) messages.push({ role: "system", content, timestamp });
				break;
			}
			case "user":
				messages.push({ role: "user", content: await textAndImages(message.content, attachments, options.signal), timestamp });
				break;
			case "tool":
				messages.push({ role: "toolResult", toolCallId: message.toolCallId, toolName: toolsByCall.get(message.toolCallId) ?? "tool",
					content: await textAndImages(message.content, attachments, options.signal), timestamp, isError: message.isError ?? false });
				break;
			case "assistant": {
				const replay = replayResponse(message.source.replayState);
				const blocks = record(message.source.replayState).blocks;
				const model = runtime.getPhysicalModel(replay?.provider ?? message.source.provider, replay?.model ?? message.source.model);
				const source = model ?? selected;
				const content: AssistantMessage["content"] = [];
				for (const [index, block] of message.content.entries()) {
					const metadata = record(replay && Array.isArray(blocks) ? blocks[index] : undefined);
					if (block.type === "text") content.push({ type: "text", text: block.text,
						textSignature: model && typeof metadata.textSignature === "string" ? metadata.textSignature : undefined });
					if (block.type === "reasoning" && model) content.push({ type: "thinking", thinking: block.text,
						thinkingSignature: typeof metadata.thinkingSignature === "string" ? metadata.thinkingSignature : undefined,
						redacted: metadata.redacted === true || undefined });
					if (block.type === "tool-call") {
						toolsByCall.set(block.id, block.name);
						content.push({ type: "toolCall", id: block.id, name: block.name, arguments: record(JSON.parse(block.arguments)) as JsonObject,
							thoughtSignature: model && typeof metadata.thoughtSignature === "string" ? metadata.thoughtSignature : undefined });
					}
				}
				if (content.length) messages.push({ role: "assistant", provider: source.provider, model: source.id, api: source.api,
					timestamp, content, usage: zeroUsage, stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop" });
				break;
			}
		}
	}
	return { messages, systemPrompt: options.system, tools: options.tools as Context["tools"] };
}

export function gatewayFinish(message: AssistantMessage, model: Model<Api>): FinishReason {
	if (message.stopReason === "aborted") return { kind: "aborted", failure: { code: "ABORTED", message: "模型请求已取消" } };
	if (isContextOverflow(message, model.contextWindow)) return { kind: "error", failure: { code: "CONTEXT_WINDOW_EXCEEDED", message: "模型上下文已满" } };
	if (message.stopReason === "length") return { kind: "max-tokens" };
	if (message.stopReason === "toolUse") return { kind: "tool-calls" };
	if (message.stopReason === "stop" && message.content.length) return { kind: "stop" };
	const codes = { auth: "AUTH", quota: "QUOTA", balance: "QUOTA", rate_limit: "RATE_LIMIT", server: "SERVER", network: "TRANSPORT", other: "PI_AI_ERROR" };
	const code = message.stopReason === "stop" ? "EMPTY_RESPONSE" : codes[classifyFailure(message.errorMessage)];
	return { kind: "error", failure: { code, message: message.errorMessage ?? "模型未返回内容" } };
}

export function usageChunk({ usage }: AssistantMessage): StreamChunk | undefined {
	if (!usage.totalTokens && !usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite) return;
	return { type: "usage", usage: { inputTokens: usage.input, outputTokens: usage.output,
		...(usage.totalTokens > 0 && { totalTokens: usage.totalTokens }), cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
		...(usage.reasoning !== undefined && { reasoningTokens: usage.reasoning }) } };
}

type AssistantBlock = Extract<ContentBlock, { type: "text" | "reasoning" | "tool-call" }>;

export function toDshAssistantBlocks(content: AssistantMessage["content"]): AssistantBlock[] {
	return content.map(block => block.type === "text" ? { type: "text", text: block.text }
		: block.type === "thinking" ? { type: "reasoning", text: block.thinking }
		: { type: "tool-call", id: ToolCallId(block.id), name: block.name, arguments: JSON.stringify(block.arguments) });
}

export function replayEnvelope(message: AssistantMessage, state?: RouteState): ReplayEnvelope {
	const requestId = record(message.usage).dreamflutterRequestId;
	return { response: { format: replayFormat, provider: message.provider, model: message.model, ...(state && { state }),
		...(typeof requestId === "string" && { requestId }) }, blocks: message.content.map(block => {
		if (block.type === "text") return block.textSignature ? { textSignature: block.textSignature } : null;
		if (block.type === "thinking") return { ...(block.thinkingSignature && { thinkingSignature: block.thinkingSignature }), ...(block.redacted && { redacted: true }) };
		return block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : null;
	}) };
}

export function replayLedgerId(replay: unknown): string | undefined {
	const response = record(record(replay).response);
	return response.format === replayFormat && typeof response.requestId === "string" ? response.requestId : undefined;
}

export function contentChunk(event: AssistantMessageEvent): StreamChunk | undefined {
	switch (event.type) {
		case "text_start": return { type: "block-start", index: event.contentIndex, blockType: "text" };
		case "thinking_start": return { type: "block-start", index: event.contentIndex, blockType: "reasoning" };
		case "toolcall_start": return { type: "block-start", index: event.contentIndex, blockType: "tool-call" };
		case "text_delta": return { type: "text-delta", index: event.contentIndex, text: event.delta };
		case "thinking_delta": return { type: "reasoning-delta", index: event.contentIndex, text: event.delta };
		case "text_end": return { type: "block-end", index: event.contentIndex, block: { type: "text", text: event.content } };
		case "thinking_end": return { type: "block-end", index: event.contentIndex, block: { type: "reasoning", text: event.content } };
		case "toolcall_delta": {
			const tool = event.partial.content[event.contentIndex];
			if (tool?.type !== "toolCall" || !tool.id) return;
			return { type: "tool-call-delta", index: event.contentIndex, id: ToolCallId(tool.id), name: tool.name, argumentsDelta: event.delta };
		}
		case "toolcall_end": {
			if (event.toolCall.argumentsError) throw new LlmError(`工具 ${event.toolCall.name} 的参数无效`, "MALFORMED_RESPONSE");
			return { type: "block-end", index: event.contentIndex, block: { type: "tool-call", id: ToolCallId(event.toolCall.id),
				name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.arguments) } };
		}
	}
}

export function recordedAssistantStream(message: AssistantMessage, blocks: ContentBlock[], reason: FinishReason, replayState: ReturnType<typeof replayEnvelope>) {
	const stream: AssistantStreamRecord[] = [];
	const push = (chunk: StreamChunk) => stream.push({ type: "chunk", time: message.timestamp, chunk });
	for (const [index, block] of blocks.entries()) {
		push({ type: "block-start", index, blockType: block.type });
		push({ type: "block-end", index, block });
	}
	const usage = usageChunk(message);
	if (usage) push(usage);
	push({ type: "finish", reason, replayState });
	return { stream, tokens: usage?.type === "usage" ? usage.usage : undefined };
}
