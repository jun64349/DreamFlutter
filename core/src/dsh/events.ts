import type { Agent, AssistantStreamFrame } from "@deepseek-ai/dsh-agent";
import type { ContentBlock, FinishReason, TokenUsage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent, TurnEndReason } from "@deepseek-ai/dsh-session";
import { calculateCost, type AssistantMessage, type AssistantMessageEvent, type ImageContent, type JsonObject, type Message, type Model, type Api, type TextContent, type ToolResultMessage, type Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { replayLedgerId } from "./transport.ts";

/** Projects official DSH events to the current window/run recorder contract. */
export class DshEvents {
	private partial: AssistantMessage | undefined;
	private lastAssistant: AssistantMessage | undefined;
	private toolResults: ToolResultMessage[] = [];
	private readonly tools = new Map<string, { name: string; started: number }>();
	private aborted = false;
	private readonly options: {
		model(): Model<Api> | undefined;
		messages(): Message[];
		persist(message: Message, seq: number, messageId?: string): void;
		content(blocks: readonly ContentBlock[]): (TextContent | ImageContent)[];
		emit(event: AgentSessionEvent): void;
	};

	constructor(options: DshEvents["options"]) { this.options = options; }

	get streamingMessage(): AssistantMessage | undefined { return this.partial; }

	status(status: Agent["status"]): void {
		if (status === "running") {
			this.aborted = false;
			this.options.emit({ type: "agent_start" });
		} else {
			this.partial = undefined;
			this.options.emit({ type: "agent_end", messages: this.options.messages(), willRetry: false });
			this.options.emit({ type: "agent_settled", aborted: this.aborted });
		}
	}

	stream(frame: AssistantStreamFrame): void {
		if (frame.type === "start") {
			this.partial = this.assistant(Date.now());
			this.options.emit({ type: "message_start", message: this.partial });
			return;
		}
		const partial = this.partial;
		if (frame.type !== "chunk" || !partial) return;
		const chunk = frame.chunk;
		if (chunk.type === "usage") partial.usage = projectUsage(chunk.usage, this.options.model());
		if (chunk.type === "block-start" && (chunk.blockType === "text" || chunk.blockType === "reasoning")) {
			partial.content[chunk.index] = chunk.blockType === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
			this.delta(partial, { type: chunk.blockType === "text" ? "text_start" : "thinking_start", contentIndex: chunk.index, partial });
		}
		if (chunk.type === "tool-call-delta") {
			if (partial.content[chunk.index]?.type !== "toolCall" && chunk.name) {
				partial.content[chunk.index] = { type: "toolCall", id: chunk.id, name: chunk.name, arguments: {} };
				this.delta(partial, { type: "toolcall_start", contentIndex: chunk.index, partial });
			}
			this.delta(partial, { type: "toolcall_delta", contentIndex: chunk.index, delta: chunk.argumentsDelta, partial });
		}
		if (chunk.type === "block-end") {
			const [block] = assistantContent(chunk.block);
			const prior = partial.content[chunk.index];
			if (!block) return;
			partial.content[chunk.index] = block;
			if (block.type === "toolCall" && prior?.type !== "toolCall") this.delta(partial, { type: "toolcall_start", contentIndex: chunk.index, partial });
			if (block.type === "toolCall") this.delta(partial, { type: "toolcall_end", contentIndex: chunk.index, toolCall: block, partial });
			if (block.type === "text") this.delta(partial, { type: "text_end", contentIndex: chunk.index, content: block.text, partial });
			if (block.type === "thinking") this.delta(partial, { type: "thinking_end", contentIndex: chunk.index, content: block.thinking, partial });
		}
		if (chunk.type !== "text-delta" && chunk.type !== "reasoning-delta") return;
		const delta = chunk.text;
		const contentIndex = chunk.index;
		const block = partial.content[contentIndex];
		if (chunk.type === "text-delta") {
			const text = block?.type === "text" ? block.text : "";
			partial.content[contentIndex] = { type: "text", text: text + delta };
		} else {
			const thinking = block?.type === "thinking" ? block.thinking : "";
			partial.content[contentIndex] = { type: "thinking", thinking: thinking + delta };
		}
		this.delta(partial, {
			type: chunk.type === "text-delta" ? "text_delta" : "thinking_delta", partial, contentIndex, delta,
		});
	}

	private delta(message: AssistantMessage, assistantMessageEvent: AssistantMessageEvent): void {
		this.options.emit({ type: "message_update", message, assistantMessageEvent });
	}

	event(event: SessionEvent): void {
		switch (event.type) {
			case "turn/start":
				this.lastAssistant = undefined;
				this.toolResults = [];
				break;
			case "step/start":
				// A legacy turn starts with each model step, including tool follow-ups.
				this.options.emit({ type: "turn_start" });
				break;
			case "user/message": {
				if (event.data.source.kind !== "user") break;
				const message: Message = { role: "user", content: this.options.content(event.data.content), timestamp: event.time };
				this.options.emit({ type: "message_start", message });
				this.finishMessage(message, event.seq, event.data.id);
				break;
			}
			case "assistant/message": {
				const { message, usage, interrupted, stream } = event.data;
				const tail = stream.at(-1);
				const finish = tail?.type === "chunk" ? tail.chunk : undefined;
				this.finishAssistant({
					...this.assistant(event.time), provider: message.source.provider, model: message.source.model,
					content: message.content.flatMap(assistantContent),
					usage: projectUsage(usage, this.options.model(), replayLedgerId(message.source.replayState)),
					stopReason: interrupted ? "aborted" : stopReason(finish?.type === "finish" ? finish.reason : undefined),
				}, event.seq);
				break;
			}
			case "tool/call": {
				const { callId, name, arguments: args } = event.data;
				this.tools.set(callId, { name, started: event.time });
				this.options.emit({ type: "tool_execution_start", toolCallId: callId, toolName: name, args: argumentsObject(args) });
				break;
			}
			case "tool/result": {
				const { message, meta } = event.data;
				const call = this.tools.get(message.toolCallId);
				this.tools.delete(message.toolCallId);
				const result: ToolResultMessage = { role: "toolResult", toolCallId: message.toolCallId, toolName: call?.name ?? "",
					content: this.options.content(message.content), isError: message.isError === true, timestamp: event.time,
					...(meta != null && { details: meta }) };
				this.toolResults.push(result);
				this.options.emit({ type: "tool_execution_end", toolCallId: result.toolCallId, toolName: result.toolName,
					result: { content: result.content, ...(meta != null && { details: meta }) }, isError: result.isError, durationMs: call ? event.time - call.started : undefined });
				this.finishMessage(result, event.seq);
				break;
			}
			case "turn/end":
				this.finishTurn(event.data.reason, event.time, event.seq);
				break;
		}
	}

	private finishTurn(reason: TurnEndReason, timestamp: number, seq: number): void {
		this.aborted = reason.kind === "aborted";
		if (reason.kind === "error" || reason.kind === "blocked") {
			this.finishAssistant({ ...this.assistant(timestamp), stopReason: "error",
				errorMessage: reason.kind === "error" ? reason.error.message : "本轮请求未获准执行" }, seq);
		}
		if (this.lastAssistant) this.options.emit({ type: "turn_end", message: this.lastAssistant, toolResults: this.toolResults });
		this.partial = undefined;
	}

	private finishAssistant(message: AssistantMessage, seq: number): void {
		if (!this.partial) this.options.emit({ type: "message_start", message });
		this.partial = undefined;
		this.lastAssistant = message;
		this.finishMessage(message, seq);
	}

	private finishMessage(message: Message, seq: number, messageId?: string): void {
		this.options.persist(message, seq, messageId);
		this.options.emit({ type: "message_end", message });
	}

	usage(usage?: TokenUsage, model = this.options.model(), receipt?: string): Usage { return projectUsage(usage, model, receipt); }

	private assistant(timestamp: number): AssistantMessage {
		const model = this.options.model();
		return { role: "assistant", content: [], api: model?.api ?? "openai-completions", provider: model?.provider ?? "", model: model?.id ?? "",
			usage: projectUsage(undefined, model), stopReason: "stop", timestamp };
	}
}

export function projectUsage(usage?: TokenUsage, model?: Model<Api>, receipt?: string): Usage {
	const input = usage?.inputTokens ?? 0;
	const output = usage?.outputTokens ?? 0;
	const cacheRead = usage?.cacheReadTokens ?? 0;
	const cacheWrite = usage?.cacheWriteTokens ?? 0;
	const result: Usage = { input, output, cacheRead, cacheWrite, totalTokens: usage?.totalTokens ?? input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	if (model) calculateCost(model, result);
	if (receipt) Object.assign(result, { dreamflutterRequestId: receipt });
	return result;
}

export function assistantContent(block: ContentBlock): AssistantMessage["content"] {
	switch (block.type) {
		case "text": return [block];
		case "reasoning": return [{ type: "thinking", thinking: block.text }];
		case "tool-call": return [{ type: "toolCall", id: block.id, name: block.name, arguments: argumentsObject(block.arguments) }];
		default: return [];
	}
}

function argumentsObject(raw: string): JsonObject {
	try {
		const value: unknown = JSON.parse(raw);
		if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
	} catch { /* The DSH tool executor reports invalid model arguments. */ }
	return {};
}

export function stopReason(reason?: FinishReason): AssistantMessage["stopReason"] {
	switch (reason?.kind) {
		case "tool-calls": return "toolUse";
		case "max-tokens": return "length";
		case "aborted": return "aborted";
		case "error": return "error";
		default: return "stop";
	}
}
