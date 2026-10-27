import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const FALLBACK_PROVIDER = "dreamflutter";
export const FALLBACK_MODEL_ID = "auto";

/**
 * "自动（备用链）": a Pi virtual model that sends each request to the first
 * model of the user's fallback chain and, when a request fails (Pi retries
 * with `failed` set), moves on to the next model in the chain. Tool
 * follow-ups stay on the model that handled the turn.
 */
export function fallbackExtension(chain: () => string[]): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const keys = chain();
		if (keys.length === 0) return;
		pi.registerVirtualModel({
			provider: FALLBACK_PROVIDER,
			id: FALLBACK_MODEL_ID,
			name: "自动（主模型 + 备用链）",
			thinkingLevels: ["off", "minimal", "low", "medium", "high"],
			route(request, ctx) {
				const models = chain()
					.map((key) => {
						const slash = key.indexOf("/");
						return ctx.modelRegistry.find(key.slice(0, slash), key.slice(slash + 1));
					})
					.filter((m): m is NonNullable<typeof m> => m !== undefined);
				if (models.length === 0) throw new Error("备用链里没有可用的模型");
				const same = (a: { provider: string; id: string }, b: { provider: string; id: string }) => a.provider === b.provider && a.id === b.id;
				if (request.failed) {
					const index = models.findIndex((m) => same(m, request.failed!.model));
					const next = models[index + 1] ?? models[0]!;
					return { model: next, thinkingLevel: request.thinkingLevel };
				}
				if (request.reason !== "user" && request.previous) {
					return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? request.thinkingLevel };
				}
				return { model: models[0]!, thinkingLevel: request.thinkingLevel };
			},
		});
	};
}
