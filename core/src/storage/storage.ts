import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RpcError, type Core, type CoreModule } from "../core.ts";
import { MemoryModule } from "../modules/memory.ts";
import { compactMemoryHistory, memoryUsage } from "./memory-maintenance.ts";
import { readSystemProxy } from "../agent/system-proxy.ts";
import { STORAGE_KINDS, storageLocations, type StorageKind } from "./locations.ts";
import { moveResultFile, requestMove } from "./move.ts";
import { Sandbox } from "../sandbox/sandbox.ts";

/** Count owned files without following junctions/symlinks into someone else's data. */
export function directoryBytes(path: string): number {
	if (!existsSync(path)) return 0;
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) return 0;
	if (stat.isFile()) return stat.size;
	return stat.isDirectory() ? readdirSync(path).reduce((n, name) => n + directoryBytes(join(path, name)), 0) : 0;
}

export class StorageModule implements CoreModule {
	readonly modelFacing = false;
	private readonly core: Core;
	constructor(core: Core) {
		this.core = core;
		// Configure the public root; T-63's classification/approval policy is unchanged.
		core.security.roots.secrets = storageLocations(core.paths.dataDir).secrets;
		core.register("storage.locations", () => this.locations());
		core.register("storage.move", async (params) => {
			if (core.maintenance) throw new RpcError("busy", core.maintenance);
			if (!STORAGE_KINDS.includes(params.kind as StorageKind) || typeof params.target !== "string") throw new RpcError("bad_request", "需要数据类别和目标目录");
			if (existsSync(join(core.paths.dataDir, "restore-switch.json"))) throw new RpcError("busy", "请先完成待重启的备份恢复");
			if (core.busySlots().length || core.module(MemoryModule)!.work.jobs.list({ status: ["running"] }).length) throw new RpcError("busy", "请先停止对话和记忆后台任务，再搬迁数据");
			const sandbox = params.kind === "sandbox" ? await core.module(Sandbox)?.status() : undefined;
			if (sandbox?.state === "provisioning") throw new RpcError("busy", "沙箱正在准备，请完成后再搬迁");
			const move = requestMove(core.paths.dataDir, params.kind as StorageKind, params.target, core.agentDir, core.sessionDir, core.paths.dbFile, sandbox?.distro);
			core.maintenance = "正在准备搬迁数据，后台即将重启";
			core.broadcast({ event: "storage.restarting" });
			setTimeout(() => void core.shutdown(), 300);
			return { id: move.id, restarting: true, restartRequired: true };
		});
		core.register("storage.memory", () => this.overview());
		core.register("storage.compactMemory", () => {
			if (core.maintenance) throw new RpcError("busy", core.maintenance);
			const memory = core.module(MemoryModule)!;
			if (core.busySlots().length || memory.work.jobs.list({ status: ["running"] }).length)
				throw new RpcError("busy", "请等对话和记忆后台任务结束后再压缩历史");
			const status = memory.space.status();
			if (status.paused) throw new RpcError("storage_paused", status.reason!);
			core.maintenance = "正在备份并压缩记忆历史";
			try {
				// Synchronous transaction: no background writer can interleave backup and deletion.
				const result = compactMemoryHistory(core.db, join(core.paths.dataDir, "backups", "storage"));
				core.broadcast({ event: "memory.changed", batchId: null });
				return { ...result, ...this.overview() };
			} finally { core.maintenance = undefined; }
		});
	}

	private overview() {
		const { core } = this;
		return { path: core.paths.dbFile, ...memoryUsage(core.db),
			databaseBytes: directoryBytes(core.paths.dbFile) + directoryBytes(core.paths.dbFile + "-wal"),
			space: core.module(MemoryModule)!.space.status() };
	}

	private locations() {
		const core = this.core;
		const paths = storageLocations(core.paths.dataDir, core.agentDir, core.sessionDir);
		const names: Record<StorageKind, string> = { database: "后台数据库", configuration: "配置", secrets: "密钥存储", logs: "日志", sessions: "会话", skills: "技能", templates: "模板", cards: "卡片", cache: "缓存", sandbox: "沙箱" };
		const rows = STORAGE_KINDS.map((id) => ({ id, label: names[id], path: paths[id], movable: true,
			bytes: id === "database" ? directoryBytes(core.paths.dbFile) + directoryBytes(core.paths.dbFile + "-wal") : id === "logs" ? directoryBytes(core.paths.logFile) + directoryBytes(core.paths.logFile + ".1")
				: id === "configuration" ? readdirOwnedBytes(paths[id], Object.entries(paths).filter(([kind, path]) => kind !== id && path !== paths[id]).map(([, path]) => path)) : directoryBytes(paths[id]),
			layer: ["sessions", "skills", "templates", "cards"].includes(id) ? "用户内容" : id === "cache" ? "缓存" : "应用数据" }));
		const artifacts = core.db.all<{ path: string }>("SELECT DISTINCT path FROM artifacts WHERE path IS NOT NULL AND path != ''").map(({ path }) => {
			try { return { path, bytes: existsSync(path) ? directoryBytes(path) : null, movable: false }; }
			catch { return { path, bytes: null, movable: false }; }
		});
		let lastMove: unknown = null;
		if (existsSync(moveResultFile(core.paths.dataDir))) lastMove = JSON.parse(readFileSync(moveResultFile(core.paths.dataDir), "utf8"));
		return { rows, artifacts, memory: { ...memoryUsage(core.db), path: core.paths.dbFile, moveKind: "database" }, lastMove,
			note: "修改位置会停止后台并重启验证；失败退回原位置，验证通过才清理旧文件。旧安装不会自动重排。" };
	}

	start(): void {
		if (readSystemProxy()?.autoConfig) this.core.log.warn("工具代理：系统 PAC 配置无法转换成通用代理环境变量；仅沿用显式 HTTP(S)_PROXY，不把 PAC 地址当代理服务器。");
	}
}

function readdirOwnedBytes(path: string, excluded: string[]): number {
	if (excluded.some((other) => resolve(other).toLowerCase() === resolve(path).toLowerCase()) || !existsSync(path)) return 0;
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) return 0;
	if (stat.isFile()) return stat.size;
	return stat.isDirectory() ? readdirSync(path).reduce((sum, name) => sum + readdirOwnedBytes(join(path, name), excluded), 0) : 0;
}
