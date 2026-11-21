import { Context, type Fiber } from "@deepseek-ai/cordis";
import type { CoreModule } from "../core.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicJson } from "../storage/locations.ts";

export interface InstalledBundle {
	version: string;
	enabled: boolean;
}

export interface SystemPluginSelection {
	dfMemory: boolean;
	bundles: Record<string, InstalledBundle>;
}

/** Local composition recorded outside the application bundle, applied when the Core starts. */
export function readSystemPlugins(dataDir: string): SystemPluginSelection {
	const path = join(dataDir, "system-plugins.json");
	let contents: string;
	try { contents = readFileSync(path, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { dfMemory: true, bundles: {} };
		throw error;
	}
	const config: unknown = JSON.parse(contents.replace(/^\uFEFF/, ""));
	if (!config || typeof config !== "object" || Array.isArray(config) ||
		("dfMemory" in config && typeof config.dfMemory !== "boolean")) {
		throw new Error(`系统插件配置无效，${path} 中的 dfMemory 需要填 true 或 false`);
	}
	const bundles = "bundles" in config ? config.bundles : {};
	if (!bundles || typeof bundles !== "object" || Array.isArray(bundles) ||
		Object.values(bundles).some(value => !value || typeof value.version !== "string" || typeof value.enabled !== "boolean")) {
		throw new Error(`系统插件配置无效，${path} 中的插件需要指定版本和启用状态`);
	}
	return { ...config, dfMemory: !("dfMemory" in config) || config.dfMemory === true,
		bundles: bundles as Record<string, InstalledBundle> };
}

export function writeSystemPlugins(dataDir: string, selection: SystemPluginSelection): void {
	atomicJson(join(dataDir, "system-plugins.json"), selection);
}

/** Installed by the application's composition root. No profiles or user plugins are discovered here. */
export class SystemPlugins {
	readonly context = new Context();
	private readonly entries = new Map<CoreModule, { service: string; requires: readonly string[]; fiber?: Fiber }>();
	private readonly names = new Set<string>();

	add(service: string, module: CoreModule, requires: readonly string[]): void {
		if (this.names.has(service) || this.entries.has(module)) throw new Error(`Duplicate system plugin: ${service}`);
		this.names.add(service);
		this.entries.set(module, { service, requires });
	}

	async start(module: CoreModule): Promise<void> {
		const entry = this.entries.get(module);
		if (!entry) {
			await module.start?.();
			return;
		}
		// A missing built-in dependency is a broken build. Cordis would otherwise
		// leave the consumer pending while Core reports that startup has finished.
		for (const dependency of entry.requires) {
			if (!this.context.get(dependency)) throw new Error(`${entry.service} requires ${dependency}`);
		}
		const fiber = this.context.plugin({
			name: entry.service,
			inject: [...entry.requires],
			apply: async (ctx: Context) => {
				ctx.effect(() => () => module.stop?.());
				await module.start?.();
				ctx.provide(entry.service, module);
			},
		});
		entry.fiber = fiber;
		await fiber;
	}

	async stop(module: CoreModule): Promise<void> {
		const fiber = this.entries.get(module)?.fiber;
		if (fiber) await fiber.dispose();
		else await module.stop?.(); // Constructor-owned resources also need cleanup before startup.
	}
}
