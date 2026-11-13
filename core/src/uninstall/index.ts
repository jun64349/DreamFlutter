import { join, resolve } from "node:path";
import { RpcError, type Client, type Core } from "../core.ts";
import { APP_ROOT, legacyAgentDir, legacyDataDir } from "../paths.ts";
import { installation } from "../update/installation.ts";
import { planUninstall, systemProtectedPaths } from "./plan.ts";
import { freshInstallation, preservedData, stagePreservedData } from "./recovery.ts";

export function registerUninstall(core: Core, appRoot = APP_ROOT): void {
	const root = () => {
		const installed = installation(appRoot);
		return installed && resolve(core.paths.dataDir).toLowerCase() === join(installed.root, "data").toLowerCase()
			? installed.root : undefined;
	};
	const requireWindow = (client?: Client) => {
		if (!client || !core.clients.has(client)) throw new RpcError("forbidden", "请通过已连接的窗口操作卸载数据。");
	};
	let restoring = false;
	core.register("uninstall.preview", (_params, client) => {
		requireWindow(client);
		const installed = root();
		if (process.platform !== "win32" || !installed) {
			throw new RpcError("unavailable", "当前后台不属于支持卸载预演的 Windows 安装。");
		}
		try { return planUninstall(installed, { dataDir: legacyDataDir(), agentDir: legacyAgentDir() }, systemProtectedPaths()); }
		catch { throw new RpcError("bad_config", "无法确认卸载的数据位置，请检查本安装的数据配置。"); }
	});
	core.register("uninstall.preservedData", (_params, client) => {
		requireWindow(client);
		const installed = root();
		if (!installed || restoring || !freshInstallation(core)) return { candidates: [] };
		try { return { candidates: preservedData(installed) }; }
		catch { throw new RpcError("unavailable", "暂时无法读取保留数据。"); }
	});
	core.register("uninstall.restorePreservedData", async (params, client) => {
		requireWindow(client);
		const installed = root();
		if (!installed) throw new RpcError("unavailable", "当前后台不属于支持恢复的安装。");
		if (typeof params.path !== "string" || !params.path) throw new RpcError("bad_request", "请选择要恢复的保留数据。");
		if (restoring || core.maintenance || core.busySlots().length) throw new RpcError("busy", "后台还有工作正在运行，请稍后恢复。");
		restoring = true;
		core.maintenance = "正在准备恢复保留数据";
		const previousGuard = core.beforeRpc;
		const guard = (method: string) => {
			previousGuard?.(method);
			if (method !== "uninstall.preservedData" && method !== "uninstall.restorePreservedData") {
				throw new RpcError("busy", "正在准备恢复保留数据，请等后台重启。");
			}
		};
		core.beforeRpc = guard;
		try {
			await stagePreservedData(core, installed, params.path);
			setTimeout(() => void core.shutdown(), 300);
			return { restarting: true };
		} catch (error) {
			restoring = false;
			if (core.beforeRpc === guard) core.beforeRpc = previousGuard;
			core.maintenance = undefined;
			throw error;
		}
	});
}

