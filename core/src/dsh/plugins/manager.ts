import type { Fiber } from "@deepseek-ai/cordis";
import { requireStr, RpcError, type Core, type CoreModule } from "../../core.ts";
import { catalog, dshVersion, loadBundle, type CatalogBundle } from "./catalog.ts";
import { writeSystemPlugins, type InstalledBundle, type SystemPluginSelection } from "../system-plugins.ts";

type Action = "install" | "remove" | "enable" | "disable";

export class PluginManager implements CoreModule {
	private readonly core: Core;
	private readonly active = new Map<CatalogBundle, Fiber>();
	private selection: SystemPluginSelection;
	private pending = Promise.resolve();
	private running = false;

	constructor(core: Core, selection: SystemPluginSelection) {
		this.core = core;
		this.selection = selection;
		core.register("plugins.list", async () => { await this.pending; return this.list(); });
		core.register("plugins.install", p => this.change("install", requireStr(p.id, "id")));
		core.register("plugins.remove", p => this.change("remove", requireStr(p.id, "id")));
		core.register("plugins.enable", p => this.change("enable", requireStr(p.id, "id")));
		core.register("plugins.disable", p => this.change("disable", requireStr(p.id, "id")));
		core.register("plugins.usage", async p => {
			await this.pending;
			const dashboard = core.cordis.get("dfUsageDashboard");
			if (!dashboard) throw new RpcError("unavailable", "用量仪表盘未启用。");
			const slot = p.slotId === undefined ? undefined : core.slot(requireStr(p.slotId, "slotId"));
			return dashboard.read(slot?.nativeSession);
		});
		core.register("plugins.shortcuts", async () => {
			await this.pending;
			return { bindings: core.cordis.get("dfWindowShortcuts") ?? [] };
		});
	}

	async start(): Promise<void> {
		for (const bundle of catalog) {
			const installed = this.selection.bundles[bundle.id];
			if (!installed?.enabled || installed.version !== bundle.manifest.version) continue;
			try { await this.mount(bundle); }
			catch (error) { this.core.log.warn(`plugin ${bundle.id} did not load`, error); }
		}
		this.running = true;
	}

	async stop(): Promise<void> {
		this.running = false;
		await this.pending;
		for (const bundle of [...this.active.keys()].reverse()) await this.unmount(bundle);
	}

	private list() {
		const memoryActive = !!this.core.cordis.get("dfMemory");
		return { plugins: [{
			id: "memory", title: "记忆", description: "使用和整理梦蝶记忆。停用会保留已有记忆。",
			packageName: "dfMemory", source: "梦蝶内置", dshVersion, kind: "system", version: "1.0.0",
			installed: true, enabled: this.selection.dfMemory, active: memoryActive,
			restartRequired: this.selection.dfMemory !== memoryActive,
		}, ...catalog.map(bundle => {
			const installed = this.selection.bundles[bundle.id];
			return {
				id: bundle.id, title: bundle.title, description: bundle.description,
				packageName: bundle.manifest.name, source: "梦蝶适配", dshVersion, kind: "catalog",
				version: bundle.manifest.version, installedVersion: installed?.version,
				installed: !!installed, enabled: installed?.enabled ?? false,
				active: this.active.has(bundle), restartRequired: false,
			};
		})] };
	}

	private change(action: Action, id: string) {
		const result = this.pending.then(async () => {
			if (!this.running) throw new RpcError("unavailable", "插件管理还未准备好。");
			if (this.core.maintenance) throw new RpcError("busy", this.core.maintenance);
			if (id === "memory") {
				if (action !== "enable" && action !== "disable") throw new RpcError("forbidden", "内置记忆只支持启用或停用。");
				const dfMemory = action === "enable";
				if (this.selection.dfMemory !== dfMemory) {
					this.save({ ...this.selection, dfMemory });
					this.core.broadcast({ event: "plugins.changed", id });
				}
			} else {
				const bundle = catalog.find(entry => entry.id === id);
				if (!bundle) throw new RpcError("not_found", "实测目录中没有这个插件。");
				if (await this.changeBundle(bundle, action)) this.core.broadcast({ event: "plugins.changed", id });
			}
			return this.list();
		});
		this.pending = result.then(() => {}, () => {});
		return result;
	}

	private async changeBundle(bundle: CatalogBundle, action: Action): Promise<boolean> {
		const before = this.selection.bundles[bundle.id];
		const version = bundle.manifest.version;
		let after: InstalledBundle | undefined;
		switch (action) {
			case "install":
				after = before?.version === version ? before : { version, enabled: before?.enabled ?? true };
				break;
			case "remove":
				break;
			case "enable":
			case "disable":
				if (!before) throw new RpcError("not_found", "请先安装这个插件。");
				if (action === "enable" && before.version !== version) throw new RpcError("conflict", "请先安装实测目录中的当前版本。");
				after = { ...before, enabled: action === "enable" };
				break;
		}
		const wasActive = this.active.has(bundle);
		const shouldBeActive = after?.enabled === true && after.version === version;
		if (shouldBeActive && !wasActive) {
			try { await this.mount(bundle); }
			catch (error) {
				this.core.log.warn(`plugin ${bundle.id} did not load`, error);
				throw new RpcError("unavailable", `「${bundle.title}」未能加载，请重试。`);
			}
		}
		const changed = before?.enabled !== after?.enabled || before?.version !== after?.version;
		if (changed) {
			const bundles = { ...this.selection.bundles };
			if (after) bundles[bundle.id] = after;
			else delete bundles[bundle.id];
			try { this.save({ ...this.selection, bundles }); }
			catch (error) {
				if (shouldBeActive && !wasActive) await this.unmount(bundle);
				throw error;
			}
		}
		if (!shouldBeActive && wasActive) await this.unmount(bundle);
		return changed || wasActive !== shouldBeActive;
	}

	private save(selection: SystemPluginSelection): void {
		try { writeSystemPlugins(this.core.paths.dataDir, selection); }
		catch (error) {
			this.core.log.warn("could not save the plugin profile", error);
			throw new RpcError("unavailable", "插件状态未能保存，请重试。");
		}
		this.selection = selection;
	}

	private async mount(bundle: CatalogBundle): Promise<void> {
		const plugin = await loadBundle(bundle);
		const ctx = this.core.cordis;
		for (const dependency of plugin.inject) {
			if (!ctx.get(dependency)) throw new Error(`${bundle.id} requires ${dependency}`);
		}
		const fiber = ctx.plugin(plugin);
		try {
			await fiber;
			if (!ctx.get(bundle.service)) throw new Error(`${bundle.id} did not provide ${bundle.service}`);
			this.active.set(bundle, fiber);
		} catch (error) {
			await fiber.dispose();
			throw error;
		}
	}

	private async unmount(bundle: CatalogBundle): Promise<void> {
		await this.active.get(bundle)?.dispose();
		this.active.delete(bundle);
	}
}
