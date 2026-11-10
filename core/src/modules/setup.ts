import { existsSync, statSync, statfsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { RpcError, requireStr, type Core, type CoreModule, type Params } from "../core.ts";
import { Gateway, type ChannelInput, type ChannelModel } from "../gateway/gateway.ts";
import { Sandbox } from "../sandbox/sandbox.ts";

export interface SetupModels { conversation: string | null; small: string | null; large: string | null; vision?: string | null; }
export interface SetupInput {
	/** Picked before launching this core with the existing --data-dir option. */
	dataRoot?: string;
	userName?: string;
	channel?: ChannelInput;
	channelId?: string;
	models?: SetupModels;
	defaultWorkspace?: string | null;
	sandbox?: "now" | "later";
}

/** Wizard orchestration only: channel credentials, migration and sandbox stay with their owners. */
export class SetupModule implements CoreModule {
	private readonly core: Core;
	private readonly gateway: Gateway;
	private completing = false;
	constructor(core: Core, gateway: Gateway) {
		this.core = core; this.gateway = gateway;
		core.register("setup.status", () => this.status());
		core.register("setup.complete", p => this.complete(p as unknown as SetupInput));
		core.register("setup.testChannel", p => core.call("gateway.testChannel", { channel: requireStr(p.channel, "channel"), model: p.model }));
		core.register("setup.recommendModels", p => this.recommend(requireStr(p.channel, "channel")));
		core.register("setup.validateDataRoot", p => this.validateDataRoot(requireStr(p.path, "path")));
	}
	validateDataRoot(path: string) {
		if (!isAbsolute(path)) throw new RpcError("bad_request", "请选择绝对路径");
		path = resolve(path);
		let parent = path;
		while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
		if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new RpcError("bad_request", "数据位置需要是目录");
		const disk = statfsSync(parent);
		return { path, exists: existsSync(path), freeBytes: disk.bavail * disk.bsize, launchArgs: ["--data-dir", path] };
	}
	async status() {
		const s = this.core.settings.get();
		return { completed: s.firstSetupComplete, dataRoot: this.core.paths.dataDir, userName: s.userName, defaultWorkspace: s.defaultWorkspace,
			models: { conversation: s.defaultModel, small: s.smallTaskModel, large: s.largeTaskModel, vision: s.visionModel },
			sandbox: s.sandboxSetupChoice, locations: await this.core.call("storage.locations", {}) };
	}
	recommend(id: string): SetupModels {
		const channel = this.gateway.channel(id);
		if (!channel) throw new RpcError("not_found", "找不到这个渠道");
		const models = channel.models.filter(m => !m.input?.length || m.input.includes("text"));
		if (!models.length) throw new RpcError("not_found", "这个渠道没有可用于对话的模型");
		const ref = (m: ChannelModel) => `${channel.provider}/${m.id}`;
		const price = (m: ChannelModel) => m.cost ? m.cost.input + m.cost.output : Number.POSITIVE_INFINITY;
		const small = [...models].sort((a,b) => price(a) - price(b))[0]!;
		const large = [...models].sort((a,b) => Number(!!b.reasoning) - Number(!!a.reasoning) || (b.contextWindow ?? 0) - (a.contextWindow ?? 0))[0]!;
		return { conversation: ref(models[0]!), small: ref(small), large: ref(large), vision: channel.models.find(m => m.input?.includes("image")) ? ref(channel.models.find(m => m.input?.includes("image"))!) : null };
	}
	private validate(p: SetupInput): void {
		if (p.dataRoot !== undefined && (typeof p.dataRoot !== "string" || !isAbsolute(p.dataRoot) || resolve(p.dataRoot).toLowerCase() !== resolve(this.core.paths.dataDir).toLowerCase())) throw new RpcError("bad_request", "首次设置请先用所选根目录的 --data-dir 启动后台；已有数据请使用按类别搬迁");
		if (p.userName !== undefined && (typeof p.userName !== "string" || p.userName.length > 100)) throw new RpcError("bad_request", "称呼需要是 100 字以内的文字");
		if (p.channel && p.channelId) throw new RpcError("bad_request", "请选择新渠道或已保存的渠道");
		if (p.channel?.id) throw new RpcError("bad_request", "首次设置请用 channelId 引用已保存的渠道");
		if (p.defaultWorkspace !== undefined && p.defaultWorkspace !== null && (typeof p.defaultWorkspace !== "string" || !isAbsolute(p.defaultWorkspace) || !existsSync(p.defaultWorkspace) || !statSync(p.defaultWorkspace).isDirectory())) throw new RpcError("bad_request", "默认工作区需要是存在的绝对目录");
		if (p.sandbox !== undefined && p.sandbox !== "now" && p.sandbox !== "later") throw new RpcError("bad_request", "沙箱选择无效");
		if (p.sandbox === "now" && !this.core.module(Sandbox)) throw new RpcError("unavailable", "此系统暂不支持准备蝶君沙箱");
		if (p.models !== undefined && (!p.models || typeof p.models !== "object" || Array.isArray(p.models) || ["conversation", "small", "large"].some(k => !(k in p.models!)) || Object.entries(p.models).some(([k,v]) => !["conversation","small","large","vision"].includes(k) || v !== null && (typeof v !== "string" || v.indexOf("/") <= 0 || v.endsWith("/"))))) throw new RpcError("bad_request", "请提供对话、小任务和大任务的模型标识");
	}
	async complete(p: SetupInput) {
		if (this.completing || this.core.maintenance) throw new RpcError("busy", this.core.maintenance ?? "首次设置正在保存");
		if (this.core.settings.get().firstSetupComplete) return { ...await this.status(), alreadyCompleted: true, restartRequired: false };
		this.validate(p);
		this.completing = true;
		let created: string | undefined;
		let committed = false;
		try {
			const channel = p.channel ? (created = await this.gateway.saveChannel(p.channel)) : p.channelId;
			if (channel && !this.gateway.channel(channel)) throw new RpcError("not_found", "找不到这个渠道");
			const models = p.models ?? (channel ? this.recommend(channel) : undefined);
			const patch: Params = { firstSetupComplete: true, userName: p.userName?.trim() ?? "", defaultWorkspace: p.defaultWorkspace ?? null, sandboxSetupChoice: p.sandbox ?? "later" };
			if (models) Object.assign(patch, { defaultModel: models.conversation, smallTaskModel: models.small, largeTaskModel: models.large, visionModel: models.vision ?? null });
			this.core.settings.update(patch);
			committed = true;
			const sandbox = p.sandbox === "now" ? await this.core.call("sandbox.provision", {}) : null;
			return { ...await this.status(), channelId: channel ?? null, restartRequired: false, sandboxStatus: sandbox };
		} catch (error) {
			if (created && !committed) await this.gateway.removeChannel(created);
			throw error;
		} finally { this.completing = false; }
	}
	start(): void {
		const s = this.core.settings.get();
		if (s.firstSetupComplete && s.sandboxSetupChoice === "now" && this.core.module(Sandbox)) {
			void this.core.call("sandbox.provision", {}).catch(error => this.core.log.warn("initial sandbox preparation failed", error));
		}
	}
}
