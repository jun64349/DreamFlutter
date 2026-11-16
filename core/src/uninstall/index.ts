import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RpcError, type Client, type Core } from "../core.ts";
import { APP_ROOT, legacyAgentDir, legacyDataDir } from "../paths.ts";
import { installation } from "../update/installation.ts";
import { keepMarker, planUninstall, systemProtectedPaths } from "./plan.ts";
import { freshInstallation, preservedData, stagePreservedData } from "./recovery.ts";

export type UninstallLauncher = (updateExe: string, windowPid: number, corePid: number) => void | Promise<void>;

/** Velopack's Windows CLI documents `Update.exe uninstall` (no --waitPid for uninstall):
 * https://docs.velopack.io/reference/cli/content/update-windows
 * A detached Node helper waits for both processes before invoking that command. */
export const launchUninstall: UninstallLauncher = (updateExe, windowPid, corePid) => {
	const helper = `const {spawn}=require('node:child_process');const {tmpdir}=require('node:os');const [exe,...ids]=process.argv.slice(1);
const alive=id=>{try{process.kill(Number(id),0);return true}catch(error){return error.code==='EPERM'}};
const wait=()=>{if(ids.some(alive))return setTimeout(wait,250);
const child=spawn(exe,['uninstall'],{cwd:tmpdir(),detached:true,windowsHide:true,stdio:'ignore'});child.unref()};wait()`;
	const child = spawn(process.execPath, ["-e", helper, updateExe, String(windowPid), String(corePid)],
		{ cwd: tmpdir(), detached: true, windowsHide: true, stdio: "ignore" });
	return new Promise<void>((resolve, reject) => {
		child.once("spawn", () => { child.unref(); resolve(); });
		child.once("error", reject);
	});
};

export function registerUninstall(core: Core, appRoot = APP_ROOT, options: { launcher?: UninstallLauncher; platform?: string } = {}): void {
	const root = () => {
		const installed = installation(appRoot);
		return installed && resolve(core.paths.dataDir).toLowerCase() === join(installed.root, "data").toLowerCase()
			? installed.root : undefined;
	};
	const requireWindow = (client?: Client) => {
		if (!client || !core.clients.has(client)) throw new RpcError("forbidden", "请通过已连接的窗口操作卸载数据。");
	};
	let restoring = false;
	let uninstalling = false;
	core.register("uninstall.start", async (params, client) => {
		requireWindow(client);
		const installed = root();
		if ((options.platform ?? process.platform) !== "win32" || !installed) throw new RpcError("unavailable", "当前不是支持卸载的 Windows 安装版");
		if (typeof params.keepData !== "boolean" || typeof params.windowPid !== "number" ||
			!Number.isSafeInteger(params.windowPid) || params.windowPid <= 0) throw new RpcError("bad_request", "请提供保留数据选项和窗口进程号");
		if (uninstalling || restoring || core.maintenance || core.busySlots().length ||
			core.db.get("SELECT 1 FROM jobs WHERE status='running' LIMIT 1") ||
			core.db.get("SELECT 1 FROM selfwork_runs WHERE state IN ('planning','testing','running') LIMIT 1") ||
			core.db.get("SELECT 1 FROM goals WHERE status='running' LIMIT 1") ||
			core.db.get("SELECT 1 FROM schedule_runs WHERE status='running' LIMIT 1"))
			throw new RpcError("busy", "后台还有工作正在运行，请稍后卸载");
		const marker = join(installed, "data", keepMarker);
		const markerInfo = lstatSync(marker, { throwIfNoEntry: false });
		if (markerInfo && !markerInfo.isFile()) throw new RpcError("bad_config", "保留数据标记不是普通文件");
		const previous = markerInfo ? readFileSync(marker) : undefined;
		uninstalling = true;
		try {
			if (params.keepData) writeFileSync(marker, "1\n", "utf8");
			else if (previous) unlinkSync(marker);
			await (options.launcher ?? launchUninstall)(join(installed, "Update.exe"), params.windowPid, process.pid);
		} catch (error) {
			uninstalling = false;
			if (previous) writeFileSync(marker, previous);
			else if (existsSync(marker)) unlinkSync(marker);
			throw new RpcError("unavailable", "无法准备卸载启动器");
		}
		core.maintenance = "正在准备卸载";
		setTimeout(() => void core.shutdown(), 300);
		return { started: true };
	});
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

