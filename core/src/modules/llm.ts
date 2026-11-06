import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Core } from "../core.ts";
import { classifyFailure, isChannelFailure } from "../gateway/classify.ts";
import { textOf } from "../runs.ts";

/**
 * One-off model calls the core makes for itself (titles, memory extraction,
 * summaries, connection tests), outside any session. Uses a fresh model
 * runtime so edits to models.json / auth.json apply immediately.
 */
export class Llm {
	private readonly core: Core;
	/** Test hook: shared runtime (faux provider). */
	private readonly runtimeOverride: (() => ModelRuntime) | undefined;
	/** Adds the gateway's channels and model groups to a runtime. */
	extendRuntime: ((runtime: ModelRuntime) => void) | undefined;

	constructor(core: Core, runtimeOverride?: () => ModelRuntime) {
		this.core = core;
		this.runtimeOverride = runtimeOverride;
	}

	async runtime(signal?: AbortSignal): Promise<ModelRuntime> {
		const runtime = this.runtimeOverride
			? this.runtimeOverride()
			: await ModelRuntime.create({
					authPath: join(this.core.agentDir, "auth.json"),
					modelsPath: join(this.core.agentDir, "models.json"),
					refreshOnCreate: false,
				});
		// A memory shutdown deadline may expire while runtime initialization is pending.
		// Do not attach gateway handlers (which use the DB) after the caller detached.
		signal?.throwIfAborted();
		this.extendRuntime?.(runtime);
		return runtime;
	}

	/**
	 * The auxiliary model: settings.auxModel, else the model of the session the
	 * call is for ([sessionModel], provider/id), else the default model, else
	 * any available one. Only models with usable credentials count.
	 */
	async auxModel(runtime?: ModelRuntime, sessionModel?: string | null): Promise<Model<never> | undefined> {
		const rt = runtime ?? (await this.runtime());
		const { auxModel, defaultModel } = this.core.settings.get();
		const available = (await rt.getAvailable()) as Model<never>[];
		for (const key of [auxModel, sessionModel, defaultModel]) {
			if (!key) continue;
			const slash = key.indexOf("/");
			const model = available.find((m) => m.provider === key.slice(0, slash) && m.id === key.slice(slash + 1));
			if (model) return model;
		}
		return available.find((m) => m.provider !== "dreamflutter") ?? available[0];
	}

	/** Sends one user message and returns the text answer. */
	async complete(
		prompt: string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[],
		options: { system?: string; model?: Model<never>; sessionModel?: string | null; maxTokens?: number; timeoutMs?: number; runtime?: ModelRuntime } = {},
	): Promise<string> {
		const runtime = options.runtime ?? (await this.runtime());
		const model = options.model ?? (await this.auxModel(runtime, options.sessionModel));
		if (!model) throw new Error("没有可用的模型");
		const signal = AbortSignal.timeout(options.timeoutMs ?? 60_000);
		const ask = () =>
			runtime.completeSimple(
				model,
				{ systemPrompt: options.system, messages: [{ role: "user", content: prompt as never, timestamp: Date.now() }] },
				{ maxTokens: options.maxTokens ?? 1024, signal } as never,
			);
		let message = await ask();
		// A model group: when a channel failed before answering anything, it is resting
		// now, so asking again goes to the next one.
		const switchable = (m: typeof message) =>
			m.stopReason === "error" && isChannelFailure(classifyFailure(m.errorMessage)) && !m.content.some((c) => (c.type === "text" ? c.text : c.type === "thinking" ? c.thinking : "x"));
		for (let attempt = 1; attempt < 3 && switchable(message) && (model as { api?: string }).api === "pi-virtual" && !signal.aborted; attempt++) {
			message = await ask();
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage ?? "模型调用失败");
		}
		return textOf(message.content);
	}
}

/** Extracts the first JSON value from a model answer (tolerates code fences and prose). */
export function parseJsonAnswer<T>(text: string): T | undefined {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = fenced ? fenced[1]! : text;
	const start = body.search(/[[{]/);
	if (start < 0) return undefined;
	const open = body[start]!;
	const close = open === "[" ? "]" : "}";
	const end = body.lastIndexOf(close);
	if (end <= start) return undefined;
	try {
		return JSON.parse(body.slice(start, end + 1)) as T;
	} catch {
		return undefined;
	}
}
