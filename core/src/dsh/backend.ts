import type { Context } from "@deepseek-ai/cordis";
import LlmRuntime, { BlockAssembler, createAssistantMessage, createSystemMessage, createToolResultMessage, ToolCallId, type RequestMessage } from "@deepseek-ai/dsh-llm";
import type { Api, AssistantMessage, Context as ModelContext, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { LedgerContext } from "../ledger/types.ts";
import { assistantContent, projectUsage, stopReason } from "./events.ts";
import { replayEnvelope, replayLedgerId, toDshAssistantBlocks } from "./transport.ts";
import { dshModelPlugin, type DshModelConfig } from "./models.ts";
import { installDshSessions, type DshSessions } from "./session.ts";

/** Owns the official runtime under the same Cordis lifetime as the desktop services. */
export class DshBackend {
	sessions?: DshSessions;
	private readonly ctx: Context;
	private readonly root: string;
	private readonly models: DshModelConfig;

	constructor(ctx: Context, root: string, models: DshModelConfig) {
		this.ctx = ctx;
		this.root = root;
		this.models = models;
	}

	async start(): Promise<void> {
		await this.ctx.plugin(LlmRuntime);
		await this.ctx.plugin(dshModelPlugin, this.models);
		this.sessions = await installDshSessions(this.ctx, { root: this.root, setupTemporary: async (ctx) => {
			await ctx.plugin(LlmRuntime);
			await ctx.plugin(dshModelPlugin, this.models);
		} });
	}

	async complete(runtime: ModelRuntime, model: Model<Api>, context: ModelContext, options: {
		signal?: AbortSignal; maxTokens?: number; ledger: LedgerContext;
	}): Promise<AssistantMessage> {
		if (!this.sessions) throw new Error("模型服务还没有准备好");
		const models = this.ctx.dreamflutterModels;
		await models.refresh();
		options.signal?.throwIfAborted();
		const content = this.sessions.createContentStore(true);
		try {
			const messages: RequestMessage[] = [];
			for (const message of context.messages) {
				if (message.role === "assistant") {
					messages.push(createAssistantMessage({ content: toDshAssistantBlocks(message.content),
						source: { provider: message.provider, model: message.model, replayState: replayEnvelope(message) } }));
				} else if (message.role === "system") {
					messages.push(createSystemMessage(typeof message.content === "string" ? message.content : message.content.map(block => block.text).join("")));
				} else {
					const blocks = await content.toDsh(typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content);
					messages.push(message.role === "user" ? { role: "user", content: blocks }
						: createToolResultMessage({ callId: ToolCallId(message.toolCallId), content: blocks, isError: message.isError }));
				}
			}
			let receipt: AssistantMessage | undefined;
			return await models.withAuxiliary({ runtime: () => runtime, context: () => options.ledger, attachments: content.attachmentStore,
				completed: message => { receipt = message; } }, async () => {
				const result = new BlockAssembler();
				for await (const chunk of this.ctx.llm.stream({ provider: model.provider, model: model.id, system: context.systemPrompt,
					messages, tools: context.tools?.map(tool => ({ name: tool.name, description: tool.description, parameters: { ...tool.parameters } })), maxTokens: options.maxTokens, signal: options.signal })) result.push(chunk);
				const finish = result.finish;
				// DSH determines the finished blocks. The gateway owns its billing receipt and replay signatures.
				const blocks = result.blocks().flatMap(assistantContent).map((block, index) => {
					const original = receipt?.content[index];
					return original?.type === block.type ? { ...original, ...block } : block;
				}) as AssistantMessage["content"];
				return { ...receipt, role: "assistant", api: receipt?.api ?? model.api, model: receipt?.model ?? model.id,
					provider: receipt?.provider ?? model.provider, timestamp: receipt?.timestamp ?? Date.now(), content: blocks,
					usage: receipt?.usage ?? projectUsage(result.usage, model, replayLedgerId(result.replayState)), stopReason: stopReason(finish),
					...((finish.kind === "error" || finish.kind === "aborted") && { errorMessage: finish.failure.message }) };
			});
		} finally { content.clear(); }
	}
}
