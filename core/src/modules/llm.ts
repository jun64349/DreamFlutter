import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Core } from "../core.ts";
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

	constructor(core: Core, runtimeOverride?: () => ModelRuntime) {
		this.core = core;
		this.runtimeOverride = runtimeOverride;
	}

	async runtime(): Promise<ModelRuntime> {
		if (this.runtimeOverride) return this.runtimeOverride();
		return ModelRuntime.create({
			authPath: join(this.core.agentDir, "auth.json"),
			modelsPath: join(this.core.agentDir, "models.json"),
			refreshOnCreate: false,
		});
	}

	/** The auxiliary model (settings.auxModel, else the default model, else any available). */
	async auxModel(runtime?: ModelRuntime): Promise<Model<never> | undefined> {
		const rt = runtime ?? (await this.runtime());
		const { auxModel, defaultModel } = this.core.settings.get();
		for (const key of [auxModel, defaultModel]) {
			if (!key) continue;
			const slash = key.indexOf("/");
			const model = rt.getModel(key.slice(0, slash), key.slice(slash + 1));
			if (model && rt.hasConfiguredAuth(model.provider)) return model as Model<never>;
		}
		return (await rt.getAvailable())[0] as Model<never> | undefined;
	}

	/** Sends one user message and returns the text answer. */
	async complete(
		prompt: string,
		options: { system?: string; model?: Model<never>; maxTokens?: number; timeoutMs?: number; runtime?: ModelRuntime } = {},
	): Promise<string> {
		const runtime = options.runtime ?? (await this.runtime());
		const model = options.model ?? (await this.auxModel(runtime));
		if (!model) throw new Error("没有可用的模型");
		const message = await runtime.completeSimple(
			model,
			{ systemPrompt: options.system, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
			{ maxTokens: options.maxTokens ?? 1024, signal: AbortSignal.timeout(options.timeoutMs ?? 60_000) } as never,
		);
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
