import { Service, type Context } from "@deepseek-ai/cordis";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import {
	LlmAdapter, LlmError, ReasoningEffortId, attributionHeaders, type AdapterRegistrationHandle, type GenerateOptions,
	type LlmResolvedModelInfo, type PreparedAdapterCall, type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type AssistantMessage, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { classifyFailure, isChannelFailure } from "../gateway/classify.ts";
import { hasAlternateGatewayKey } from "../gateway/gateway.ts";
import type { RouteState } from "../gateway/router.ts";
import { withLedgerContext, type LedgerContext } from "../ledger/types.ts";
import { withDshRouteSession } from "./routing-context.ts";
import { contentChunk, gatewayFinish, previousGroupRoute, replayEnvelope, toDshAssistantBlocks, toGatewayContext, usageChunk } from "./transport.ts";

declare module "@deepseek-ai/cordis" {
	interface Context { dreamflutterModels: DshModels; }
}

export interface DshModelConfig {
	/** A fresh existing Gateway catalog/wire runtime. It also installs the 1.0 Ledger. */
	runtime(signal?: AbortSignal): Promise<ModelRuntime>;
}

interface SessionBinding {
	context(): LedgerContext;
	/** The active slot's transport retains its per-run authorization and budget wrappers. */
	runtime?: () => ModelRuntime;
	attachments?: AttachmentStore;
	completed?(message: AssistantMessage): void;
}

/** Attach the existing model transports to the official DSH model seam. */
export class DshModels extends Service {
	private readonly sessions = new Map<string, SessionBinding>();
	private readonly auxiliary = new AsyncLocalStorage<SessionBinding>();
	private readonly config: DshModelConfig;
	private readonly adapter: GatewayAdapter;
	private registration?: AdapterRegistrationHandle;
	private providers: string[] = [];
	private refreshing?: Promise<void>;
	private disposed = false;

	constructor(ctx: Context, config: DshModelConfig) {
		super(ctx, "dreamflutterModels");
		this.config = config;
		this.adapter = new GatewayAdapter(ctx, config, sessionId => sessionId ? this.sessions.get(sessionId) : this.auxiliary.getStore());
		ctx.effect(() => () => {
			this.disposed = true;
			this.sessions.clear();
			this.registration?.();
		});
	}

	/** Synchronize provider ids before the session chooses a route. Model details are resolved per call. */
	refresh(): Promise<void> {
		if (this.refreshing) return this.refreshing;
		const task = this.config.runtime().then(runtime => {
			if (this.disposed) return;
			const providers = [...new Set(runtime.getModels().map(model => model.provider))].sort();
			if (providers.length === this.providers.length && providers.every((id, index) => id === this.providers[index])) return;
			if (this.registration) this.registration.replace(providers);
			else if (providers.length) this.registration = this.ctx.llm.registerAdapter(providers, this.adapter);
			this.providers = providers;
		}).finally(() => { this.refreshing = undefined; });
		this.refreshing = task;
		return task;
	}

	bindSession(id: string, context: () => LedgerContext, runtime?: () => ModelRuntime, attachments?: AttachmentStore): () => void {
		const binding = { context, runtime, attachments };
		this.sessions.set(id, binding);
		return () => { if (this.sessions.get(id) === binding) this.sessions.delete(id); };
	}

	withAuxiliary<T>(binding: SessionBinding, work: () => Promise<T>): Promise<T> {
		return this.auxiliary.run(binding, work);
	}
}

export const dshModelPlugin = {
	name: "dreamflutter-models",
	inject: ["llm"],
	apply(ctx: Context, config: DshModelConfig): void { new DshModels(ctx, config); },
};

class GatewayAdapter extends LlmAdapter {
	constructor(ctx: Context, config: DshModelConfig, sessionBinding: (id?: string) => SessionBinding | undefined) {
		super();
		this.ctx = ctx;
		this.config = config;
		this.sessionBinding = sessionBinding;
	}
	private readonly ctx: Context;
	private readonly config: DshModelConfig;
	private readonly sessionBinding: (id?: string) => SessionBinding | undefined;

	async listModels(provider: string) {
		return (await this.config.runtime()).getModels(provider).map(modelInfo);
	}

	async resolveModel(provider: string, id: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
		return (await this.prepareCall(provider, id, signal)).model;
	}

	async prepareCall(provider: string, id: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
		const runtime = this.sessionBinding()?.runtime?.() ?? await this.config.runtime(signal);
		signal?.throwIfAborted();
		const model = runtime.getModel(provider, id);
		if (!model) throw new LlmError(`找不到模型 ${provider}/${id}`, "UNKNOWN_MODEL");
		return { model: modelInfo(model), stream: options => this.dispatch(runtime, options) };
	}

	async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
		const prepared = await this.prepareCall(options.provider, options.model, options.signal);
		yield* prepared.stream(options);
	}

	private async *dispatch(preparedRuntime: ModelRuntime, options: GenerateOptions): AsyncIterable<StreamChunk> {
		const binding = this.sessionBinding(options.sessionId);
		const runtime = binding?.runtime?.() ?? preparedRuntime;
		const selected = runtime.getModel(options.provider, options.model);
		if (!selected) throw new LlmError(`找不到模型 ${options.provider}/${options.model}`, "UNKNOWN_MODEL");
		if (options.stop?.length) throw new LlmError("此渠道不支持自定义停止词", "UNSUPPORTED_OPTION");
		const virtual = selected.api === "pi-virtual";
		const transcript = await toGatewayContext(options, runtime, selected, binding?.attachments ?? this.ctx.get("attachments"));
		const thinking = (options.reasoningEffort ?? "off") as ModelThinkingLevel;
		let state = virtual ? previousGroupRoute(options) : undefined;
		let failed: AssistantMessage | undefined;
		for (let attempt = 0; attempt < 3; attempt++) {
			options.signal?.throwIfAborted();
			let model = selected, reasoning = clampThinkingLevel(selected, thinking);
			if (virtual) {
				const route = await withDshRouteSession(options.sessionId, () => runtime.resolveModel(selected, transcript.messages, {
					reason: failed ? "retry" : "user", thinkingLevel: thinking, state, signal: options.signal, failed,
				}));
				model = route.model;
				reasoning = route.thinkingLevel;
				state = route.state as RouteState | undefined;
			}
			const consumer = new AbortController();
			const signal = options.signal ? AbortSignal.any([options.signal, consumer.signal]) : consumer.signal;
			const maxTokens = options.maxTokens && model.maxTokens > 0 ? Math.min(options.maxTokens, model.maxTokens) : options.maxTokens;
			const bound = binding?.context();
			const context: LedgerContext = {
				...bound, sessionId: bound?.sessionId ?? options.sessionId ?? null,
				purpose: options.purpose === "compaction" ? "compaction" : bound?.purpose ?? (options.purpose || !options.sessionId ? "auxiliary" : "conversation"),
			};
			const stream = withLedgerContext(context, () => runtime.streamSimple(model, transcript, {
				maxTokens, temperature: options.temperature, reasoning: reasoning === "off" ? undefined : reasoning, signal,
				sessionId: options.sessionId, headers: attributionHeaders(),
			}));
			const prefix: StreamChunk[] = [];
			let streamed = false;
			let terminal: AssistantMessage | undefined;
			try {
				for await (const event of stream) {
					if (event.type === "done" || event.type === "error") {
						terminal = event.type === "done" ? event.message : event.error;
						break;
					}
					const chunk = contentChunk(event);
					if (!chunk) continue;
					if (!streamed && chunk.type === "block-start") prefix.push(chunk);
					else {
						if (!streamed) yield* prefix;
						streamed = true;
						yield chunk;
					}
				}
			} finally {
				if (!terminal) consumer.abort();
			}
			if (!terminal) throw new LlmError("模型流提前结束", "STREAM_CLOSED");
			const finish = gatewayFinish(terminal, model);
			if (!streamed && attempt < 2 && finish.kind === "error" &&
				(hasAlternateGatewayKey(terminal) || virtual && isChannelFailure(classifyFailure(terminal.errorMessage)))) {
				failed = terminal;
				continue;
			}
			// The ledger stamps the terminal usage when result() settles. Keep the
			// live receipt on the projection so indexing does not count it again.
			const final = await stream.result();
			binding?.completed?.(final);
			// Some transports deliver the complete response in the terminal event only.
			if (!streamed && finish.kind !== "error" && finish.kind !== "aborted") {
				for (const [index, part] of final.content.entries()) {
					if (part.type === "toolCall" && (finish.kind === "max-tokens" || part.argumentsError)) continue;
					const block = toDshAssistantBlocks([part])[0]!;
					yield { type: "block-start", index, blockType: block.type };
					yield { type: "block-end", index, block };
				}
			}
			const usage = usageChunk(terminal);
			if (usage) yield usage;
			yield { type: "finish", reason: finish, ...((finish.kind !== "error" && finish.kind !== "aborted") && { replayState: replayEnvelope(final, state) }) };
			return;
		}
	}
}

function modelInfo(model: Model<Api>): LlmResolvedModelInfo {
	const efforts = getSupportedThinkingLevels(model);
	return { provider: model.provider, id: model.id, name: model.name, inputModalities: model.input,
		...(model.contextWindow > 0 && { context: { contextWindow: model.contextWindow } }),
		...(model.maxTokens > 0 && { defaultMaxTokens: model.maxTokens }),
		reasoning: { efforts: efforts.map(level => ({ id: ReasoningEffortId(level), name: level })) } };
}
