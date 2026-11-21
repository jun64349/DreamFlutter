import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";
import type { ExecEnv } from "../agent/state.ts";

const execFileAsync = promisify(execFile);
const marker = "runner-v1.ready";
const tools = {
	node: "node.exe",
	python: "python\\python.exe",
	uv: "uv.exe",
	rg: "rg.exe",
	fd: "fd.exe",
	git: "git\\cmd\\git.exe",
	powershell: "@powershell",
} as const;

export interface AppContainerConfig {
	/** Core-owned directory that receives one new appcontainer-<id> child. */
	dataDir: string;
	/** A persisted, Core-generated, installation-specific random 128-bit ID (lowercase hex). */
	profileId: string;
	/** Absolute path to the trusted native runner delivered by the application. */
	bridgePath: string;
	/** Trusted packaging output containing the documented fixed tool layout. */
	toolsSource: string | { node: string; python: string; uv: string; rg: string; fd: string; git: string; htmlRenderer?: string };
	toolsVersion?: string;
	fresh?: boolean;
	ownerMarker?: { name: string; value: string };
	allowNetwork?: () => boolean;
	assertActive?: () => void;
	track?: (child: ChildProcess) => void;
}

function absolutePath(value: string): string {
	const normalized = value.replaceAll("/", "\\");
	if (!/^[A-Za-z]:\\/.test(normalized) || /[:\0]/.test(normalized.slice(2))) {
		throw new Error("AppContainer 需要本地盘符上的绝对路径。");
	}
	return win32.resolve(normalized);
}

type ProfileLocation = Pick<AppContainerConfig, "dataDir" | "profileId" | "bridgePath">;

function paths(config: ProfileLocation) {
	if (!/^[0-9a-f]{32}$/.test(config.profileId)) throw new Error("AppContainer 工作区标识无效。");
	const root = win32.join(absolutePath(config.dataDir), `appcontainer-${config.profileId}`);
	return {
		root,
		workspace: win32.join(root, "workspace"),
		tools: win32.join(root, "tools"),
		ready: win32.join(root, marker),
		toolsVersion: win32.join(root, "tools-version"),
		bridge: absolutePath(config.bridgePath),
	};
}

export function appContainerWorkspacePath(config: AppContainerConfig): string {
	return paths(config).workspace;
}

export async function appContainerProvisioned(config: ProfileLocation): Promise<boolean> {
	try {
		const dirs = paths(config);
		const [root, ready] = await Promise.all([lstat(dirs.root), lstat(dirs.ready)]);
		return root.isDirectory() && !root.isSymbolicLink() && ready.isFile() && !ready.isSymbolicLink() && ready.size <= 65536 &&
			(await readFile(dirs.ready, "utf16le")).toLowerCase() === dirs.root.toLowerCase();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function requireWindows(): void {
	if (process.platform !== "win32") throw new Error("AppContainer 仅适用于 Windows。");
}

async function copyTools(source: AppContainerConfig["toolsSource"], directory: string): Promise<void> {
	const copy = (path: string, destination: string) => cp(absolutePath(path), destination, {
		recursive: true,
		force: false,
		errorOnExist: true,
		filter: async (entry) => {
			const info = await lstat(entry);
			if (!info.isDirectory() && !info.isFile()) throw new Error("随包工具目录包含重解析点或特殊文件。");
			return true;
		},
	});
	if (typeof source === "string") { await copy(source, directory); return; }
	await mkdir(directory);
	for (const [tool, path] of Object.entries(source)) {
		const destination = tool === "htmlRenderer" ? "html-render.exe" : tool === "python" || tool === "git" ? tool : `${tool}.exe`;
		await copy(path, win32.join(directory, destination));
	}
}

/** Installs the new package's tools without giving the container write access to them. */
export async function refreshAppContainerTools(config: AppContainerConfig): Promise<void> {
	if (!config.toolsVersion) return;
	requireWindows();
	if (!await appContainerProvisioned(config)) throw new Error("Windows 工作区需要用当前存储位置重新建立权限。");
	const dirs = paths(config);
	const prior = await readFile(dirs.toolsVersion, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	const toolsPresent = await lstat(dirs.tools).then((info) => info.isDirectory() && !info.isSymbolicLink()).catch(() => false);
	if (prior === config.toolsVersion && toolsPresent) return;

	const stageId = randomUUID().replaceAll("-", "");
	const next = win32.join(dirs.root, `tools-next-${stageId}`);
	const old = win32.join(dirs.root, `tools-old-${stageId}`);
	const stamp = `${dirs.toolsVersion}-${stageId}`;
	try {
		await copyTools(config.toolsSource, next);
		await execFileAsync(dirs.bridge, ["refresh-tools", dirs.root, config.profileId, stageId], { windowsHide: true });
		await writeFile(stamp, config.toolsVersion, { flag: "wx" });
		await rename(stamp, dirs.toolsVersion);
		await rm(old, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	} finally {
		await rm(next, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		await rm(stamp, { force: true });
	}
}

/** Creates the private ACL and an empty-capabilities AppContainer for this Core-owned layout. */
export async function provisionAppContainer(config: AppContainerConfig): Promise<void> {
	requireWindows();
	const dirs = paths(config);
	try {
		await mkdir(dirs.root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (config.fresh || config.ownerMarker) throw new Error("目标工作区目录已存在，未覆盖原目录。");
		if (!await appContainerProvisioned(config)) throw error;
		await refreshAppContainerTools(config);
		return;
	}
	let ready = false;
	try {
		if (config.ownerMarker) await writeFile(win32.join(dirs.root, config.ownerMarker.name), config.ownerMarker.value, { flag: "wx" });
		await mkdir(dirs.workspace);
		await mkdir(win32.join(dirs.workspace, "home"));
		await mkdir(win32.join(dirs.workspace, "temp"));
		await copyTools(config.toolsSource, dirs.tools);
		await execFileAsync(dirs.bridge, ["provision", dirs.root, config.profileId], { windowsHide: true });
		ready = true;
		if (config.toolsVersion) await writeFile(dirs.toolsVersion, config.toolsVersion, { flag: "wx" });
	} catch (error) {
		if (ready) await removeAppContainerProfile(config).catch(() => {});
		await rm(dirs.root, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

/** Revokes the profile after the owning Core has stopped its commands. Workspace files are retained. */
export async function removeAppContainerProfile(config: ProfileLocation): Promise<void> {
	requireWindows();
	const dirs = paths(config);
	await execFileAsync(dirs.bridge, ["remove-profile", dirs.root, config.profileId], { windowsHide: true });
}

function toWorkspacePath(workspace: string, cwd: string, raw: string): string {
	const token = raw.replaceAll("/", "\\");
	const virtualRoot = /^\\workspace(?=\\|$)/i;
	const modelPath = virtualRoot.test(token) ? workspace + token.replace(virtualRoot, "") : token;
	if (/[:\0]/.test(modelPath.slice(/^[A-Za-z]:\\/.test(modelPath) ? 2 : 0))) {
		throw new Error("AppContainer 文件路径无效。");
	}
	const resolved = win32.resolve(cwd, modelPath);
	const relative = win32.relative(workspace, resolved);
	if (relative === ".." || relative.startsWith("..\\") || win32.isAbsolute(relative)) {
		throw new Error("AppContainer 文件路径超出工作区。");
	}
	return resolved;
}

function startTool(config: AppContainerConfig, command: string, args: string[], cwd: string, mode: "run" | "run-input"): ChildProcess {
	const name = command.toLowerCase().replace(/\.exe$/, "");
	if (!Object.hasOwn(tools, name)) throw new Error("AppContainer 中没有该随包命令。");
	return startExecutable(config, tools[name as keyof typeof tools], args, cwd, mode);
}

function startExecutable(config: AppContainerConfig, target: string, args: string[], cwd: string, mode: "run" | "run-input"): ChildProcess {
	requireWindows();
	config.assertActive?.();
	const dirs = paths(config);
	const executable = target === "@powershell" ? target : win32.join(dirs.tools, target);
	const hostCwd = toWorkspacePath(dirs.workspace, dirs.workspace, cwd);
	const operation = config.allowNetwork?.() === true ? `${mode}-online` : mode;
	const child = spawn(dirs.bridge, [operation, dirs.root, config.profileId, executable, hostCwd, ...args], {
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	config.track?.(child);
	return child;
}

/** Launches the fixed file protocol with a private input pipe that also owns the Job lifetime. */
export function startAppContainerFileProcess(config: AppContainerConfig, code: string): ChildProcess {
	return startTool({ ...config, allowNetwork: undefined }, "node", ["-e", code], appContainerWorkspacePath(config), "run-input");
}

/** HTML capture has no network capability even while the active task allows network tools. */
export function startAppContainerHtmlRenderer(config: AppContainerConfig): ChildProcess {
	return startExecutable({ ...config, allowNetwork: undefined }, "html-render.exe", [], appContainerWorkspacePath(config), "run-input");
}

export function startAppContainerPython(config: AppContainerConfig, args: string[], cwd: string): ChildProcess {
	return startTool(config, "python", args, cwd, "run-input");
}

/** A command uses the native bridge's empty-capabilities token and supervised lifetime. */
export function appContainerSandboxEnv(config: AppContainerConfig): ExecEnv {
	const dirs = paths(config);
	return {
		kind: "sandbox",
		resolve(cwd, path) {
			const base = toWorkspacePath(dirs.workspace, dirs.workspace, cwd);
			return toWorkspacePath(dirs.workspace, base, path);
		},
		local() {
			throw new Error("AppContainer 文件操作需要在容器内执行。");
		},
		spawn(command, args, cwd): ChildProcess {
			return startTool(config, command, args, cwd, "run");
		},
	};
}
