import { builtinProviders, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Platform } from "./platforms.ts";

/** Public Pi catalog only; no auth resolution or network work. */
let cached: (Platform & { modelDetails: Record<string, unknown>[] })[] | undefined;
export function piPresets(): (Platform & { modelDetails: Record<string, unknown>[] })[] {
	const names = new Map(builtinProviders().map((p) => [p.id, p.name]));
	return cached ??= getBuiltinProviders().flatMap((id) => {
		const models = getBuiltinModels(id);
		if (!models.length) return [];
		const endpoints = [...new Map(models.filter((m) => m.baseUrl && m.api).map((m) => [`${m.api}|${m.baseUrl}`, { api: m.api, baseUrl: m.baseUrl }])).values()];
		return [{ id: `pi-builtin:${id}`, catalog: id, name: `Pi · ${names.get(id) ?? id}`, kind: "payg" as const,
			endpoints, models: models.map((m) => m.id), modelDetails: models.map((m) => ({ ...m })) }];
	});
}

export function piApi(api: string): boolean {
	return piPresets().some((p) => p.endpoints.some((e) => e.api === api));
}
