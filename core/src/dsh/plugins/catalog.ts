import type { Plugin } from "@deepseek-ai/cordis";
import cordisManifest from "@deepseek-ai/cordis/package.json" with { type: "json" };
import sessionManifest from "@deepseek-ai/dsh-session/package.json" with { type: "json" };
import statsManifest from "@deepseek-ai/dsh-session-stats/package.json" with { type: "json" };
import shortcutsProtocolManifest from "@deepseek-ai/dsh-client-shortcuts/package.json" with { type: "json" };
import { readFile } from "node:fs/promises";
import usageManifest from "./packages/usage-dashboard/package.json" with { type: "json" };
import shortcutsManifest from "./packages/window-shortcuts/package.json" with { type: "json" };

export const dshVersion: string = sessionManifest.version;

const testedDependencies = new Map([cordisManifest, statsManifest, shortcutsProtocolManifest]
	.map(({ name, version }) => [name, version]));

/** Explicit allowlist of the packages distributed and exercised with this Windows build. */
export const catalog = [
	{
		id: "usage-dashboard",
		title: "用量仪表盘",
		description: "查看最近七天的请求、Token 用量和花费。",
		service: "dfUsageDashboard",
		manifest: usageManifest,
	},
	{
		id: "window-shortcuts",
		title: "窗口快捷键",
		description: "在梦蝶窗口按 Ctrl+Shift+U 打开花费。",
		service: "dfWindowShortcuts",
		manifest: shortcutsManifest,
	},
] as const;

export type CatalogBundle = typeof catalog[number];

/** Resolve the one insert in a bundled DSH manifest; the user's profile only chooses which bundles participate. */
export async function loadBundle(bundle: CatalogBundle): Promise<Plugin.Object<void> & { inject: string[] }> {
	const { manifest, id } = bundle;
	if (manifest.engines.dsh !== dshVersion ||
		Object.entries(manifest.peerDependencies).some(([name, version]) => testedDependencies.get(name) !== version)) {
		throw new Error(`${manifest.name} 与当前 DSH 或 Cordis 依赖版本不匹配`);
	}
	const root = new URL(`./packages/${id}/`, import.meta.url);
	const patch = JSON.parse(await readFile(new URL(manifest.dsh.bundle.patch, root), "utf8"));
	const insert = Array.isArray(patch) && patch.length === 1 ? patch[0]?.insert : undefined;
	if (!Array.isArray(insert) || insert.length !== 1 || insert[0]?.id !== id || insert[0]?.name !== manifest.name) {
		throw new Error(`${manifest.name} 的插件装配清单无效`);
	}
	const entry = await import(new URL(manifest.exports["."], root).href);
	if (typeof entry.apply !== "function" || !Array.isArray(entry.inject)) {
		throw new Error(`${manifest.name} 的 Cordis 入口无效`);
	}
	return entry;
}
