import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join, win32 } from "node:path";
import { RpcError, type Core, type CoreModule } from "../core.ts";
import { bundledPython } from "../agent/toolchain.ts";
import { APP_ROOT } from "../paths.ts";
import { storageLocations } from "../storage/locations.ts";
import { remapColumns } from "../backup/parts.ts";
import { PathMap } from "../backup/path-map.ts";
import { collectGit } from "../git/process.ts";
import {
	appContainerProvisioned, appContainerSandboxEnv, appContainerWorkspacePath, provisionAppContainer,
	refreshAppContainerTools, removeAppContainerProfile, type AppContainerConfig,
} from "./appcontainer.ts";
import { appContainerFileAccess } from "./appcontainer-fs.ts";
import { exportAppContainerArchive, importAppContainerArchive } from "./appcontainer-archive.ts";
import { compatibleParent, gitWorkspaceOwner, gitWorkspaceRoot, LOCAL_NATIVE_FLAGS, nativeArchiveSource, nativeArchiveSourceFile, ownsGitWorkspace, readNativePlacements, saveNativePlacements } from "./appcontainer-placements.ts";
import type { SandboxStatus, SelfTestItem } from "./sandbox.ts";

const [PROFILE_FLAG, RETAINED_FLAG, NETWORK_FLAG] = LOCAL_NATIVE_FLAGS;
const ID = "DreamFlutter-Windows";

export interface WindowsAppContainerOptions {
	dir?: string;
	bridgePath?: string;
	toolsSource?: AppContainerConfig["toolsSource"];
	toolsVersion?: string;
}

export class WindowsAppContainerSandbox implements CoreModule {
	readonly id = "sandbox";
	readonly modelFacing = false;
	private readonly core: Core;
	private readonly dir: string;
	private readonly bridgePath: string;
	private readonly pendingArchive: string;
	private readonly pendingArchiveSource: string;
	private readonly toolsSource?: AppContainerConfig["toolsSource"];
	private readonly toolsVersion: string;
	private profileId: string;
	private gitCompatible = false;
	private nextId = this.newId();
	private transition?: string;
	private transitionWork?: Promise<void>;
	private online: boolean;
	private provisioned = false;
	private changing = false;
	private closing = false;
	private error: string | null = null;
	private provisionTask?: Promise<void>;
	private readonly runners = new Set<ChildProcess>();
	private retained?: string;
	private readonly legacyDisk?: string;

	constructor(core: Core, options: WindowsAppContainerOptions = {}) {
		this.core = core;
		const sandboxDir = storageLocations(core.paths.dataDir).sandbox;
		const disk = join(sandboxDir, "disk", "ext4.vhdx");
		if (lstatSync(disk, { throwIfNoEntry: false })?.isFile()) this.legacyDisk = disk;
		this.dir = win32.resolve(options.dir ?? join(sandboxDir, "native-windows"));
		this.pendingArchive = join(sandboxDir, "pending-restore.tar.gz");
		this.pendingArchiveSource = join(sandboxDir, nativeArchiveSourceFile);
		this.bridgePath = options.bridgePath ?? join(APP_ROOT, "core", "bin", "appcontainer-runner.exe");
		this.toolsSource = options.toolsSource;
		this.toolsVersion = options.toolsVersion ?? this.packageToolVersion();
		this.profileId = core.db.get<{ value: string }>("SELECT value FROM app_flags WHERE key=?", PROFILE_FLAG)?.value ?? this.newId();
		try {
			const placement = readNativePlacements(core.paths.dataDir).entries.find(entry => entry.profileId === this.profileId);
			this.gitCompatible = placement?.standardDir.toLowerCase() === this.dir.toLowerCase();
		} catch (error) { core.log.warn("保留无法确认归属的 Windows 工作区位置记录", error); }
		this.retained = core.db.get<{ value: string }>("SELECT value FROM app_flags WHERE key=?", RETAINED_FLAG)?.value;
		this.online = core.db.get<{ value: string }>("SELECT value FROM app_flags WHERE key=?", NETWORK_FLAG)?.value === "1";
		core.sandboxProvider = () => {
			if (!this.provisioned || this.changing || this.closing) return undefined;
			const appContainer = this.config();
			return {
				kind: "appcontainer", distro: ID, appContainer, workspaceDir: appContainerWorkspacePath(appContainer),
				ready: async () => appContainer.assertActive?.(), online: () => !this.changing && this.online,
			};
		};
		core.register("sandbox.status", () => this.status());
		core.register("sandbox.provision", () => {
			void this.prepare().catch(() => {});
			return this.status();
		});
		core.register("sandbox.reset", async () => {
			if (this.gitCompatible) await this.changeWorkspace(true, undefined, false);
			else { await this.retire(); await this.prepare(); }
			return this.status();
		});
		core.register("sandbox.remove", async () => { await this.retire(); return this.status(); });
		core.register("sandbox.selfTest", async () => ({ items: await this.selfTest() }));
		core.register("sandbox.setOnline", (params) => this.setOnline(params.online === true));
		core.register("sandbox.setGitCompatibility", async params => {
			if (typeof params.enabled !== "boolean" || typeof params.workspaceDir !== "string") throw new RpcError("bad_request", "请选择已确认的工作区路径。");
			await this.changeWorkspace(params.enabled, params.workspaceDir, true);
			return this.status();
		});
		core.register("sandbox.restartComputer", () => { throw new RpcError("not_supported", "Windows 蝶君工作区无需重启电脑。"); });
	}

	private newId(): string { return randomUUID().replaceAll("-", ""); }

	private packageToolVersion(): string {
		const hash = createHash("sha256").update("windows-appcontainer-tools-1\n" + APP_ROOT.toLowerCase());
		const manifest = join(APP_ROOT, "build-info.json");
		if (existsSync(manifest)) hash.update(readFileSync(manifest));
		for (const path of [this.bridgePath, join(APP_ROOT, "core", "bin", "html-render.exe"), join(APP_ROOT, "runtime", "node.exe"), bundledPython()]) {
			if (!path || !existsSync(path)) continue;
			const info = statSync(path);
			hash.update(JSON.stringify([path, info.size, info.mtimeMs]));
		}
		return hash.digest("hex");
	}

	private saveFlag(key: string, value: string): void {
		this.core.db.run("INSERT INTO app_flags(key,value,at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,at=excluded.at",
			key, value, Date.now());
	}

	private config(profileId = this.profileId, gitCompatible = this.gitCompatible): AppContainerConfig {
		const bin = join(APP_ROOT, "core", "bin");
		const python = bundledPython();
		return {
			dataDir: gitCompatible ? compatibleParent(this.dir) : this.dir, profileId, bridgePath: this.bridgePath,
			toolsVersion: this.toolsVersion,
			ownerMarker: gitCompatible ? gitWorkspaceOwner(this.core.paths.dataDir, { profileId, standardDir: this.dir }) : undefined,
			allowNetwork: () => this.online,
			toolsSource: this.toolsSource ?? {
				node: join(APP_ROOT, "runtime", "node.exe"),
				python: python ? dirname(python) : join(APP_ROOT, "core", "python", "missing-bundled-python"),
				uv: join(bin, "uv.exe"), rg: join(bin, "rg.exe"), fd: join(bin, "fd.exe"), git: join(bin, "git"),
				htmlRenderer: join(bin, "html-render.exe"),
			},
			assertActive: () => {
				if (!this.provisioned || this.changing || this.closing || this.profileId !== profileId) {
					throw new RpcError("sandbox_absent", "蝶君的 Windows 工作区已改变，请重新打开对话。");
				}
			},
			track: (child) => {
				this.runners.add(child);
				child.once("close", () => this.runners.delete(child));
			},
		};
	}

	async start(): Promise<void> {
		// A storage move is still reversible until validateMove commits its record.
		if (!this.core.maintenance) await this.retireInactiveGitProfiles();
		const config = this.config();
		if (this.gitCompatible && !ownsGitWorkspace(this.core.paths.dataDir, { profileId: this.profileId, standardDir: this.dir })) {
			this.error = "无法确认 Git 兼容工作区的归属。可以切回标准工作区。";
			return;
		}
		if (!await appContainerProvisioned(config)) {
			// A copied database is not proof that the destination owns the old profile.
			if (this.gitCompatible) {
				this.error = "Git 兼容工作区尚未就绪。可以切回标准工作区。";
				return;
			}
			this.profileId = this.newId();
			this.online = false;
			return;
		}
		try {
			if (!existsSync(this.bridgePath)) throw new Error("安装包缺少 Windows 工作区运行器。");
			await refreshAppContainerTools(config);
			this.provisioned = true;
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
			return;
		}
		if (this.provisioned && existsSync(this.pendingArchive)) {
			try { await this.restorePending(); }
			catch (error) { this.core.log.warn("Windows 工作区未能导入待恢复归档", error); }
		}
	}

	private async retireInactiveGitProfiles(): Promise<void> {
		try {
			const owner = this.core.paths.dataDir;
			for (const entry of readNativePlacements(owner).entries) {
				if (entry.profileId === this.profileId || !ownsGitWorkspace(owner, entry)) continue;
				const config = { dataDir: compatibleParent(entry.standardDir), profileId: entry.profileId, bridgePath: this.bridgePath };
				if (await appContainerProvisioned(config)) await removeAppContainerProfile(config);
			}
		} catch (error) { this.core.log.warn("保留暂不能注销的旧 Git 兼容工作区", error); }
	}

	private changed(): void { this.core.broadcast({ event: "sandbox.changed", status: this.status() }); }

	status(): SandboxStatus & { retainedWorkspaceDir?: string; legacyDisk?: string; gitCompatibility: { enabled: boolean; alternativePath: string } } {
		return {
			kind: "appcontainer", state: this.provisionTask || this.transition ? "provisioning" : this.error ? "error" : this.provisioned ? "ready" : "absent",
			step: this.transition ?? (this.provisionTask ? "建立 Windows 工作区" : null),
			error: this.error, progress: null, online: this.online, diskBytes: null, distro: ID,
			...(this.provisioned ? { workspaceDir: appContainerWorkspacePath(this.config()) } : {}),
			...(this.retained ? { retainedWorkspaceDir: this.retained } : {}),
			...(this.legacyDisk ? { legacyDisk: this.legacyDisk } : {}),
			gitCompatibility: { enabled: this.gitCompatible, alternativePath: appContainerWorkspacePath(this.config(this.nextId, !this.gitCompatible)) },
			mirror: null, bundled: existsSync(this.bridgePath),
		};
	}

	private async setOnline(online: boolean): Promise<SandboxStatus> {
		if (!this.provisioned || this.changing || this.closing) throw new RpcError("conflict", "工作区还没就绪。");
		if (online === this.online) return this.status();
		this.changing = true;
		try {
			await this.stopChildren();
			this.saveFlag(NETWORK_FLAG, online ? "1" : "0");
			this.online = online;
			return this.status();
		} finally {
			this.changing = false;
			this.changed();
		}
	}

	prepare(): Promise<void> {
		if (this.provisionTask) return this.provisionTask;
		if (this.changing || this.closing) return Promise.reject(new RpcError("conflict", "工作区正在关闭。"));
		if (this.provisioned) return Promise.resolve();
		if (this.gitCompatible) return Promise.reject(new RpcError("conflict", "请先切回标准工作区。"));
		this.error = null;
		this.provisionTask = (async () => {
			if (!existsSync(this.bridgePath)) throw new Error("安装包缺少 Windows 工作区运行器。");
			await mkdir(this.dir, { recursive: true });
			if (await this.restorePending()) return;
			this.saveFlag(PROFILE_FLAG, this.profileId);
			this.saveFlag(NETWORK_FLAG, this.online ? "1" : "0");
			await provisionAppContainer(this.config());
			this.provisioned = true;
		})().catch((error: unknown) => {
			this.error = error instanceof Error ? error.message : String(error);
			throw error;
		}).finally(() => {
			this.provisionTask = undefined;
			this.changed();
		});
		this.changed();
		return this.provisionTask;
	}

	private async stopChildren(): Promise<void> {
		await Promise.all([...this.runners].map(async (child) => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const closed = once(child, "close");
			child.kill();
			await closed;
		}));
	}

	private async retire(): Promise<void> {
		if (this.changing || this.closing || this.provisionTask) throw new RpcError("conflict", "工作区正在改变。");
		this.changing = true;
		try {
			await this.stopChildren();
			const config = this.config();
			if (this.provisioned) {
				await removeAppContainerProfile(config);
				this.provisioned = false;
				this.retained = appContainerWorkspacePath(config);
				this.saveFlag(RETAINED_FLAG, this.retained);
			}
			this.profileId = this.newId();
			this.saveFlag(PROFILE_FLAG, this.profileId);
			this.gitCompatible = false;
			this.nextId = this.newId();
			this.error = null;
		} finally {
			this.changing = false;
			this.changed();
		}
	}

	async archiveWorkspace(destination: string): Promise<boolean> {
		if (!this.provisioned) return false;
		if (this.changing || this.closing || this.runners.size) throw new RpcError("conflict", "请等 Windows 工作区里的命令结束后再备份。");
		this.changing = true;
		try {
			await exportAppContainerArchive({ ...this.config(), assertActive: undefined, allowNetwork: undefined }, destination);
			return true;
		} finally { this.changing = false; }
	}

	private candidate(profileId: string, gitCompatible: boolean): AppContainerConfig {
		const config = { ...this.config(profileId, gitCompatible), fresh: true, assertActive: undefined, allowNetwork: undefined };
		if (gitCompatible) {
			const catalog = readNativePlacements(this.core.paths.dataDir);
			if (catalog.entries.some(entry => entry.profileId === profileId)) throw new RpcError("conflict", "工作区编号已使用，请重新确认位置。");
			catalog.entries.push({ profileId, standardDir: this.dir });
			saveNativePlacements(this.core.paths.dataDir, catalog);
		}
		return config;
	}

	private async ensureCandidateParent(config: AppContainerConfig): Promise<void> {
		if (!config.ownerMarker) { await mkdir(config.dataDir, { recursive: true }); return; }
		const physical = await realpath(config.dataDir);
		if (win32.resolve(physical).toLowerCase() !== config.dataDir.toLowerCase()) throw new RpcError("unavailable", "Git 兼容工作区需要实际磁盘，当前盘符指向其他位置。");
		const standard = lstatSync(this.dir, { throwIfNoEntry: false }) ?? lstatSync(dirname(this.dir), { throwIfNoEntry: false });
		if (standard && standard.dev !== statSync(config.dataDir).dev) throw new RpcError("unavailable", "标准工作区位于挂载卷中，无法使用该盘符的根目录。");
	}

	private async discardCandidate(config: AppContainerConfig, ready: boolean): Promise<void> {
		const root = dirname(appContainerWorkspacePath(config));
		if (ready) {
			if (config.ownerMarker && !ownsGitWorkspace(this.core.paths.dataDir, { profileId: config.profileId, standardDir: this.dir })) {
				throw new Error("无法确认待清理的 Git 兼容工作区归属。");
			}
			if (win32.resolve(await realpath(root)).toLowerCase() !== root.toLowerCase()) throw new Error("待清理的工作区路径已变更。");
			await removeAppContainerProfile(config);
			await rm(root, { recursive: true, force: true });
		}
		if (config.ownerMarker && (!existsSync(root) || !ready && !ownsGitWorkspace(this.core.paths.dataDir, { profileId: config.profileId, standardDir: this.dir }))) {
			const catalog = readNativePlacements(this.core.paths.dataDir);
			catalog.entries = catalog.entries.filter(entry => entry.profileId !== config.profileId);
			saveNativePlacements(this.core.paths.dataDir, catalog);
		}
	}

	private async probeGit(config: AppContainerConfig): Promise<void> {
		const name = ".git-check-" + this.newId();
		const path = join(appContainerWorkspacePath(config), "temp", name);
		const env = appContainerSandboxEnv(config);
		const run = (args: string[], cwd: string) => collectGit(env.spawn("git", args, cwd), undefined, undefined, undefined, true);
		try {
			const init = await run(["init", "--quiet", "--initial-branch=main", name], "/workspace/temp");
			if (init.code !== 0) throw new RpcError("unavailable", "随包 Git 无法在所选磁盘建立仓库。" + (init.stderr.trim() ? ` ${init.stderr.trim().slice(0, 500)}` : ""));
			const status = await run(["status", "--porcelain"], path);
			if (status.code !== 0) throw new RpcError("unavailable", "随包 Git 无法读取新仓库。" + (status.stderr.trim() ? ` ${status.stderr.trim().slice(0, 500)}` : ""));
		} finally {
			if (existsSync(path) && win32.resolve(await realpath(path)).toLowerCase() === path.toLowerCase()) await rm(path, { recursive: true, force: true });
		}
	}

	private async publish(candidate: AppContainerConfig, online: boolean, previous?: AppContainerConfig, sourceWorkspace?: string): Promise<void> {
		const original = previous && appContainerWorkspacePath(previous);
		const target = appContainerWorkspacePath(candidate);
		this.core.db.transaction(() => {
			this.saveFlag(PROFILE_FLAG, candidate.profileId);
			this.saveFlag(NETWORK_FLAG, online ? "1" : "0");
			if (original) this.saveFlag(RETAINED_FLAG, original);
			if (sourceWorkspace) remapColumns(this.core.db, this.core.backupParts, { map: new PathMap([{ from: sourceWorkspace, to: target }]), secretRef: ref => ref }, true);
		});
		this.profileId = candidate.profileId;
		this.gitCompatible = !!candidate.ownerMarker;
		this.nextId = this.newId();
		this.online = online;
		this.provisioned = true;
		this.error = null;
		if (previous) {
			this.retained = original;
			await removeAppContainerProfile(previous).catch((error: unknown) => this.core.log.warn("旧 Windows 工作区 profile 未清理", error));
		}
	}

	private changeWorkspace(enabled: boolean, confirmedPath: string | undefined, copyFiles: boolean): Promise<void> {
		if (this.transitionWork) return Promise.reject(new RpcError("busy", "工作区正在切换。"));
		return this.transitionWork = this.performWorkspaceChange(enabled, confirmedPath, copyFiles).finally(() => { this.transitionWork = undefined; });
	}

	private async performWorkspaceChange(enabled: boolean, confirmedPath: string | undefined, copyFiles: boolean): Promise<void> {
		if (this.core.maintenance || this.changing || this.closing || this.provisionTask || this.runners.size || this.core.busySlots().length) {
			throw new RpcError("busy", "请等当前任务结束后再切换工作区。");
		}
		if (confirmedPath && enabled === this.gitCompatible) return;
		const id = this.nextId;
		const destination = appContainerWorkspacePath(this.config(id, enabled));
		if (confirmedPath !== undefined && confirmedPath.toLowerCase() !== destination.toLowerCase()) {
			throw new RpcError("conflict", "计划使用的位置已变化，请重新确认。");
		}
		if (existsSync(this.pendingArchive)) throw new RpcError("busy", "请先恢复等待导入的工作区备份。");
		this.changing = true;
		this.transition = "正在切换 Windows 工作区";
		this.core.maintenance = this.transition;
		this.nextId = this.newId();
		this.changed();
		const previous = this.provisioned ? this.config() : undefined;
		let staging: string | undefined;
		let candidate: AppContainerConfig | undefined;
		let ready = false;
		let published = false;
		try {
			const material = previous && copyFiles ? join(staging = await mkdtemp(join(this.core.paths.dataDir, ".native-workspace-")), "workspace.tar.gz") : undefined;
			const source = material && previous ? appContainerWorkspacePath(previous) : undefined;
			if (material && previous) await exportAppContainerArchive({ ...previous, assertActive: undefined, allowNetwork: undefined }, material);
			for (const slot of this.core.slots.values()) if (slot.sandboxed) await this.core.closeSlot(slot.slotId);
			candidate = this.candidate(id, enabled);
			await this.ensureCandidateParent(candidate);
			await provisionAppContainer(candidate);
			ready = true;
			if (material) await importAppContainerArchive(candidate, material, source);
			if (enabled) await this.probeGit(candidate);
			const [check] = await this.testWorkspace(candidate);
			if (!check?.passed) throw new RpcError("unavailable", "新工作区读写自检没有通过，原文件保留。" + (check?.detail ? ` ${check.detail}` : ""));
			if (this.closing) throw new RpcError("busy", "后台正在退出，原工作区已保留。");
			await this.publish(candidate, this.online, previous, source);
			published = true;
		} catch (error) {
			if (error instanceof RpcError) throw error;
			throw new RpcError("unavailable", `未能切换工作区，原文件保留。${error instanceof Error ? ` ${error.message}` : ""}`);
		} finally {
			if (candidate && !published) await this.discardCandidate(candidate, ready).catch(error => this.core.log.warn("待切换 Windows 工作区清理失败", error));
			if (staging) {
				try {
					const physical = await realpath(staging);
					if (physical.toLowerCase() === win32.resolve(staging).toLowerCase() && dirname(physical).toLowerCase() === win32.resolve(this.core.paths.dataDir).toLowerCase()) {
						await rm(physical, { recursive: true, force: true });
					}
				} catch (error) { this.core.log.warn("临时工作区归档清理失败", error); }
			}
			this.changing = false;
			this.transition = undefined;
			this.core.maintenance = undefined;
			this.changed();
		}
	}

	async restorePending(options: { preserveNetworkConsent?: boolean; sourceWorkspace?: string } = {}): Promise<boolean> {
		if (!existsSync(this.pendingArchive)) return false;
		if (this.changing || this.closing) throw new RpcError("conflict", "工作区正在改变。");
		this.changing = true;
		const online = options.preserveNetworkConsent
			? this.core.db.get<{ value: string }>("SELECT value FROM app_flags WHERE key=?", NETWORK_FLAG)?.value === "1"
			: this.online;
		let candidate: AppContainerConfig | undefined;
		let candidateReady = false;
		let switched = false;
		try {
			await this.stopChildren();
			const sourceInfo = lstatSync(this.pendingArchiveSource, { throwIfNoEntry: false });
			const source = nativeArchiveSource(options.sourceWorkspace) ?? (sourceInfo?.isFile() && !sourceInfo.isSymbolicLink() && sourceInfo.nlink === 1 && sourceInfo.size < 64 * 1024
				? nativeArchiveSource(JSON.parse(readFileSync(this.pendingArchiveSource, "utf8"))) : undefined);
			candidate = this.candidate(this.newId(), this.gitCompatible);
			await this.ensureCandidateParent(candidate);
			await provisionAppContainer(candidate);
			candidateReady = true;
			await importAppContainerArchive(candidate, this.pendingArchive, source);
			const previous = this.provisioned ? this.config() : undefined;
			if (this.gitCompatible) await this.probeGit(candidate);
			await this.publish(candidate, online, previous, source);
			switched = true;
			await rm(this.pendingArchive).catch(error => this.core.log.warn("已恢复的 Windows 工作区归档未清理", error));
			await rm(this.pendingArchiveSource, { force: true }).catch(error => this.core.log.warn("已恢复的工作区源路径未清理", error));
			return true;
		} finally {
			if (candidate && !switched) await this.discardCandidate(candidate, candidateReady).catch(error => this.core.log.warn("待恢复 Windows 工作区清理失败", error));
			this.changing = false;
			this.changed();
		}
	}

	/** The storage move has committed. The archived source still owns its physical files. */
	async retireMovedGitWorkspace(path: string | undefined): Promise<void> {
		if (!path || path.toLowerCase() === this.status().workspaceDir?.toLowerCase()) return;
		const entry = readNativePlacements(this.core.paths.dataDir).entries.find(item => win32.join(gitWorkspaceRoot(item), "workspace").toLowerCase() === path.toLowerCase());
		if (!entry) return;
		if (!ownsGitWorkspace(this.core.paths.dataDir, entry)) throw new Error("搬迁前的 Git 兼容工作区归属无法确认，已保留。");
		this.retained = path;
		this.saveFlag(RETAINED_FLAG, path);
		const config = { ...this.config(entry.profileId, false), dataDir: compatibleParent(entry.standardDir) };
		if (await appContainerProvisioned(config)) await removeAppContainerProfile(config);
	}

	async stop(): Promise<void> {
		this.closing = true;
		await this.stopChildren();
		await this.transitionWork?.catch(() => {});
		await this.provisionTask?.catch(() => {});
	}

	private async selfTest(): Promise<SelfTestItem[]> {
		if (!this.provisioned || this.changing || this.closing) return [{ name: "windows-workspace", passed: false, detail: "工作区还没就绪。" }];
		return this.testWorkspace(this.config());
	}

	private async testWorkspace(config: AppContainerConfig): Promise<SelfTestItem[]> {
		const files = appContainerFileAccess(config);
		const file = `.self-test-${randomUUID()}.txt`;
		try {
			await files.write(file, "DreamFlutter workspace check", null);
			const read = await files.read(file);
			return [{ name: "windows-workspace", passed: read.data.toString("utf8") === "DreamFlutter workspace check", detail: null }];
		} catch (error) {
			return [{ name: "windows-workspace", passed: false, detail: error instanceof Error ? error.message : String(error) }];
		} finally {
			try {
				const child = appContainerSandboxEnv(config).spawn("node", ["-e", "require('node:fs').rmSync(process.argv[1], {force:true})", file], "/workspace");
				child.stdout?.resume(); child.stderr?.resume();
				await once(child, "close");
			} catch { /* core shutdown may stop the check */ }
		}
	}
}
