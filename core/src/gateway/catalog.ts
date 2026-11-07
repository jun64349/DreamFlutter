/**
 * What is known about a channel's model beyond what the user typed: Pi's
 * built-in catalog (limits, prices, thinking levels, compatibility settings)
 * and model lists that describe their models (OpenCode's does, models.dev style).
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";

/** A model as a list or the catalog describes it; [efforts] are the provider's own thinking values. */
export interface DescribedModel {
	id: string;
	name: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
	efforts?: string[];
}

/** Pi's thinking levels above "off", in order. */
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const THINKING_LEVELS = ["off", ...LEVELS] as const;

/** Explicit user capability selection: even "off" may be unsupported. */
export function selectedLevelMap(levels: string[]): Record<string, string | null> {
	return Object.fromEntries(THINKING_LEVELS.map((level) => [level, levels.includes(level) ? (level === "off" ? "none" : level) : null]));
}

/** [id] in Pi's built-in catalog of [provider]. */
export function catalogModel(provider: string | undefined, id: string): Model<Api> | undefined {
	if (!provider) return undefined;
	try {
		return (getModels(provider as never) as Model<Api>[]).find((m) => m.id === id);
	} catch {
		return undefined;
	}
}

export function describeCatalogModel(model: Model<Api>): DescribedModel {
	const map = model.thinkingLevelMap as Record<string, string | null> | undefined;
	return {
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		input: [...model.input],
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		cost: { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite },
		efforts: map ? Object.values(map).filter((v): v is string => typeof v === "string") : undefined,
	};
}

/**
 * Pi's thinking-level map from the efforts a model list names: a level the
 * model lacks is null (Pi then moves the chosen level to one it has), and
 * "none" is how the model turns thinking off.
 */
export function levelMap(efforts: string[] | undefined): Record<string, string | null> | undefined {
	if (!efforts?.length) return undefined;
	const map: Record<string, string | null> = {};
	for (const level of LEVELS) map[level] = efforts.includes(level) ? level : null;
	if (efforts.includes("none")) map.off = "none";
	return map;
}

/** The API names model lists use, per channel API. */
const LISTED_API: Record<string, string> = { "openai-completions": "chat-completions", "anthropic-messages": "messages" };

interface ListedModel {
	id?: unknown;
	name?: unknown;
	display_name?: unknown;
	type?: unknown;
	limit?: { context?: unknown; output?: unknown };
	modalities?: { input?: unknown };
	capabilities?: { reasoning?: { supported?: unknown; effort?: unknown } };
	cost?: { text?: { input?: { price?: unknown; cache?: { read?: unknown; write?: unknown } }; output?: { price?: unknown } } };
	api?: unknown;
}

/**
 * The models of a list response (`data` or `models`), with whatever details it
 * carries. A list that says which API serves each model keeps only the ones
 * [api] can call.
 */
export function readModelList(body: unknown, api: string | undefined): DescribedModel[] {
	const root = (body ?? {}) as { data?: unknown; models?: unknown };
	const items = (Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : []) as ListedModel[];
	const listedApi = api ? LISTED_API[api] : undefined;
	const out: DescribedModel[] = [];
	for (const item of items) {
		if (typeof item?.id !== "string") continue;
		// Anthropic lists say "model"; OpenCode's also lists image and classifier models.
		if (typeof item.type === "string" && item.type !== "chat" && item.type !== "model") continue;
		if (listedApi && item.api && typeof item.api === "object" && !(listedApi in (item.api as object))) continue;
		const model: DescribedModel = { id: item.id, name: text(item.display_name) ?? text(item.name) ?? item.id };
		const context = count(item.limit?.context);
		const output = count(item.limit?.output);
		if (context) model.contextWindow = context;
		if (output) model.maxTokens = output;
		const input = item.modalities?.input;
		if (Array.isArray(input)) model.input = input.some((m) => typeof m === "string" && m.startsWith("image")) ? ["text", "image"] : ["text"];
		const reasoning = item.capabilities?.reasoning;
		if (reasoning && typeof reasoning === "object") {
			model.reasoning = reasoning.supported === true;
			if (Array.isArray(reasoning.effort)) model.efforts = reasoning.effort.filter((e): e is string => typeof e === "string");
		}
		const price = item.cost?.text;
		if (price && typeof price === "object") {
			model.cost = {
				input: amount(price.input?.price) ?? 0,
				output: amount(price.output?.price) ?? 0,
				cacheRead: amount(price.input?.cache?.read) ?? 0,
				cacheWrite: amount(price.input?.cache?.write) ?? 0,
			};
		}
		out.push(model);
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

function amount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
