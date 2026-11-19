import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import type { Core, CoreModule } from "../core.ts";
import { storageLocations } from "../storage/locations.ts";
import type { ExecEnv } from "../agent/state.ts";
import { toolchainEnv } from "../agent/toolchain.ts";
import type { SandboxStatus, SelfTestItem } from "./sandbox.ts";

const execFileAsync = promisify(execFile);

export const SEATBELT_DISTRO = "macos-seatbelt";
const PROFILE_FILE = "seatbelt.sb";
const PENDING_RESTORE = "pending-restore.tar.gz";

export interface SeatbeltConfig {
	dir: string;
	workspaceDir: string;
	agentHomeDir: string;
	tmpDir: string;
	rootfsDir: string;
	profilePath: string;
	userHome: string;
	secretsDir: string;
	deniedDataDirs: string[];
	online: () => boolean;
}

export interface SeatbeltProfileOptions {
	workspaceDir: string;
	agentHomeDir: string;
	tmpDir: string;
	userHome: string;
	deniedPaths: string[];
	allowNetwork: boolean;
}

function realOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function uniqueVariants(paths: string[]): string[] {
	const out = new Set<string>();
	for (const p of paths) {
		if (!p) continue;
		const normalized = p.replaceAll("\\", "/").replace(/\/+$/, "");
		if (normalized) out.add(normalized);
		const real = realOrSelf(p).replaceAll("\\", "/").replace(/\/+$/, "");
		if (real) out.add(real);
	}
	return [...out];
}

function sbplString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Generates a macOS `sandbox-exec` (Seatbelt) SBPL profile isolating writes and sensitive user data. */
export function buildSeatbeltProfile(options: SeatbeltProfileOptions): string {
	const writeSubpaths = uniqueVariants([options.workspaceDir, options.agentHomeDir, options.tmpDir]);
	const home = options.userHome;
	const deniedSubpaths = uniqueVariants([
		`${home}/.ssh`,
		`${home}/.aws`,
		`${home}/.kube`,
		`${home}/.gnupg`,
		`${home}/.config/gcloud`,
		`${home}/Library/Keychains`,
		`${home}/Library/Application Support/Google/Chrome`,
		`${home}/Library/Application Support/Microsoft Edge`,
		`${home}/Library/Application Support/Firefox`,
		`${home}/Library/Safari`,
		`${home}/Library/Cookies`,
		`${home}/Library/Mail`,
		`${home}/Library/Messages`,
		...options.deniedPaths,
	]);

	const body = [
		"(version 1)",
		"(allow default)",
		"",
		";; Restrict writes strictly to DreamFlutter sandbox workspace, agent home, temp dir and character devices.",
		"(deny file-write*)",
		"(allow file-write*",
		...writeSubpaths.map((p) => `  (subpath ${sbplString(p)})`),
		'  (literal "/dev/null")',
		'  (literal "/dev/zero")',
		'  (literal "/dev/dtracehelper")',
		'  (regex #"^/dev/tty.*")',
		'  (regex #"^/dev/fd/.*"))',
		"",
		";; Deny read and write access to credentials, keychains, browser user data, and DreamFlutter secrets/db.",
		"(deny file-read* file-write*",
		...deniedSubpaths.slice(0, -1).map((p) => `  (subpath ${sbplString(p)})`),
		`  (subpath ${sbplString(deniedSubpaths.at(-1)!)}))`,
	];

	if (!options.allowNetwork) {
		body.push(
			"",
			";; Offline mode: block remote network sockets while keeping local IPC functional.",
			"(deny network-outbound (remote ip))",
			"(deny network-inbound (remote ip))",
		);
	}

	return body.join("\n") + "\n";
}

function insidePosix(candidate: string, root: string): boolean {
	const a = candidate.replaceAll("\\", "/").replace(/\/+$/, "");
	const b = root.replaceAll("\\", "/").replace(/\/+$/, "");
	return a === b || a.startsWith(`${b}/`);
}

function safeChildPath(baseDir: string, relSuffix: string): string {
	const parts = relSuffix.split("/").filter((part) => part && part !== ".");
	if (parts.some((part) => part === "..")) {
		throw new Error(`沙箱路径越界：${relSuffix}`);
	}
	return join(baseDir, ...parts);
}

/** Resolves a model/caller path (either physical `<workspaceDir>/...` or logical `/workspace/...`) to a safe host path inside the sandbox. */
export function resolveSeatbeltHostPath(config: SeatbeltConfig, rawPath: string): string {
	if (rawPath.includes("\0")) throw new Error("路径包含非法空字符");
	const normalized = rawPath.replaceAll("\\", "/");
	const cleanPosix = posix.resolve("/", normalized);
	const workspaceRoot = config.workspaceDir.replaceAll("\\", "/").replace(/\/+$/, "");
	const agentRoot = config.agentHomeDir.replaceAll("\\", "/").replace(/\/+$/, "");
	const tmpRoot = config.tmpDir.replaceAll("\\", "/").replace(/\/+$/, "");

	if (insidePosix(normalized, workspaceRoot)) {
		return safeChildPath(config.workspaceDir, normalized.slice(workspaceRoot.length));
	}
	if (insidePosix(normalized, agentRoot)) {
		return safeChildPath(config.agentHomeDir, normalized.slice(agentRoot.length));
	}
	if (insidePosix(normalized, tmpRoot)) {
		return safeChildPath(config.tmpDir, normalized.slice(tmpRoot.length));
	}
	if (cleanPosix === "/workspace" || cleanPosix.startsWith("/workspace/")) {
		return safeChildPath(config.workspaceDir, cleanPosix.slice("/workspace".length));
	}
	if (cleanPosix === "/home/agent" || cleanPosix.startsWith("/home/agent/")) {
		return safeChildPath(config.agentHomeDir, cleanPosix.slice("/home/agent".length));
	}
	if (cleanPosix === "/tmp" || cleanPosix.startsWith("/tmp/")) {
		return safeChildPath(config.tmpDir, cleanPosix.slice("/tmp".length));
	}
	return safeChildPath(config.rootfsDir, cleanPosix.slice(1));
}

export function ensureSeatbeltProfile(config: SeatbeltConfig): string {
	mkdirSync(config.dir, { recursive: true });
	const content = buildSeatbeltProfile({
		workspaceDir: config.workspaceDir,
		agentHomeDir: config.agentHomeDir,
		tmpDir: config.tmpDir,
		userHome: config.userHome,
		deniedPaths: [config.secretsDir, ...config.deniedDataDirs],
		allowNetwork: config.online(),
	});
	writeFileSync(config.profilePath, content, "utf8");
	return config.profilePath;
}

export function seatbeltSandboxEnv(config: SeatbeltConfig): ExecEnv {
	return {
		kind: "sandbox",
		resolve: (cwd, path) => {
			if (path.startsWith("/workspace") || path.startsWith("/home/agent")) return resolveSeatbeltHostPath(config, path);
			const base = cwd.startsWith("/workspace") || cwd.startsWith("/home/agent") ? resolveSeatbeltHostPath(config, cwd) : cwd;
			return posix.resolve(base.replaceAll("\\", "/"), path.replaceAll("\\", "/"));
		},
		local: (path) => resolveSeatbeltHostPath(config, path),
		spawn: (command, args, cwd) => {
			const profile = ensureSeatbeltProfile(config);
			const hostCwd = resolveSeatbeltHostPath(config, cwd);
			mkdirSync(hostCwd, { recursive: true });
			return spawn("/usr/bin/sandbox-exec", ["-f", profile, command, ...args], {
				cwd: hostCwd,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: toolchainEnv({
					...process.env,
					HOME: config.workspaceDir,
					TMPDIR: config.tmpDir,
					LANG: "C.UTF-8",
					PYTHONIOENCODING: "utf-8",
					PYTHONUTF8: "1",
					MPLBACKEND: "Agg",
				}),
			});
		},
	};
}

function directoryBytes(root: string): number {
	if (!existsSync(root)) return 0;
	let total = 0;
	const stack = [root];
	while (stack.length) {
		const current = stack.pop()!;
		let stat;
		try {
			stat = lstatSync(current);
		} catch {
			continue;
		}
		if (stat.isSymbolicLink()) continue;
		if (stat.isFile()) {
			total += stat.size;
			continue;
		}
		if (stat.isDirectory()) {
			for (const entry of readdirSync(current)) stack.push(join(current, entry));
		}
	}
	return total;
}

export interface MacSeatbeltSandboxOptions {
	dir?: string;
	userHome?: string;
}

/**
 * macOS native `sandbox-exec` (Seatbelt) sandbox for 蝶君:
 * zero VM overhead, instant startup, directory & credential isolation, and online/offline toggle.
 */
export class MacSeatbeltSandbox implements CoreModule {
	readonly modelFacing = false;
	readonly distro = SEATBELT_DISTRO;
	readonly dir: string;
	readonly config: SeatbeltConfig;
	private readonly core: Core;

	constructor(core: Core, options: MacSeatbeltSandboxOptions = {}) {
		this.core = core;
		const locations = storageLocations(core.paths.dataDir);
		this.dir = options.dir ?? locations.sandbox;
		const workspaceDir = join(this.dir, "workspace");
		const agentHomeDir = join(this.dir, "home", "agent");
		const tmpDir = join(this.dir, "tmp");
		const rootfsDir = join(this.dir, "rootfs");
		this.ensureDirectories(workspaceDir, agentHomeDir, tmpDir, rootfsDir);
		const resolvedSandbox = realOrSelf(this.dir);
		const candidateProtected = [
			locations.secrets,
			locations.configuration,
			core.paths.dbFile,
			`${core.paths.dbFile}-wal`,
			`${core.paths.dbFile}-shm`,
			core.paths.logFile,
			core.paths.infoFile,
			locations.database,
			locations.logs,
			join(core.paths.dataDir, "backups"),
		].filter((p) => !insidePosix(resolvedSandbox, realOrSelf(p)));
		this.config = {
			dir: this.dir,
			workspaceDir: realOrSelf(workspaceDir),
			agentHomeDir: realOrSelf(agentHomeDir),
			tmpDir: realOrSelf(tmpDir),
			rootfsDir: realOrSelf(rootfsDir),
			profilePath: join(resolvedSandbox, PROFILE_FILE),
			userHome: options.userHome ?? homedir(),
			secretsDir: locations.secrets,
			deniedDataDirs: candidateProtected,
			online: () => this.core.settings.get().sandboxOnline,
		};

		core.sandboxProvider = () => ({
			kind: "seatbelt",
			distro: this.distro,
			workspaceDir: this.config.workspaceDir,
			seatbelt: this.config,
			ready: () => this.prepare(),
			online: () => this.core.settings.get().sandboxOnline,
		});

		core.register("sandbox.status", () => this.status());
		core.register("sandbox.provision", async () => {
			await this.prepare();
			this.changed();
			return this.status();
		});
		core.register("sandbox.reset", async () => {
			await this.reset();
			this.changed();
			return this.status();
		});
		core.register("sandbox.selfTest", async () => ({ items: await this.selfTest() }));
		core.register("sandbox.setOnline", async (params) => {
			core.settings.update({ sandboxOnline: params.online === true });
			ensureSeatbeltProfile(this.config);
			this.changed();
			return this.status();
		});
		core.register("sandbox.restartComputer", () => {
			throw new Error("macOS 沙箱无需重启电脑");
		});
		core.register("sandbox.remove", async () => {
			await this.reset();
			this.changed();
			return this.status();
		});
	}

	private ensureDirectories(workspaceDir = this.config?.workspaceDir, agentHomeDir = this.config?.agentHomeDir, tmpDir = this.config?.tmpDir, rootfsDir = this.config?.rootfsDir): void {
		for (const sub of ["inbox", "outbox", "scratch", "skills"]) {
			mkdirSync(join(workspaceDir, sub), { recursive: true });
		}
		mkdirSync(agentHomeDir, { recursive: true });
		mkdirSync(tmpDir, { recursive: true });
		mkdirSync(rootfsDir, { recursive: true });
	}

	private changed(): void {
		void this.status().then((status) => this.core.broadcast({ event: "sandbox.changed", status }));
	}

	async prepare(): Promise<void> {
		this.ensureDirectories();
		ensureSeatbeltProfile(this.config);
		try {
			await this.restorePending();
		} catch (error) {
			this.core.log.warn("seatbelt sandbox: could not restore pending archive", error);
		}
	}

	async status(): Promise<SandboxStatus> {
		const bytes = directoryBytes(this.config.workspaceDir) + directoryBytes(this.config.agentHomeDir);
		return {
			kind: "seatbelt",
			state: "ready",
			step: null,
			progress: null,
			error: null,
			online: this.core.settings.get().sandboxOnline,
			diskBytes: bytes,
			distro: this.distro,
			workspaceDir: this.config.workspaceDir,
			mirror: null,
			bundled: true,
		};
	}

	async reset(): Promise<void> {
		await rm(this.config.workspaceDir, { recursive: true, force: true });
		await rm(this.config.agentHomeDir, { recursive: true, force: true });
		await rm(this.config.tmpDir, { recursive: true, force: true });
		this.ensureDirectories();
		ensureSeatbeltProfile(this.config);
	}

	local = (path: string): string => resolveSeatbeltHostPath(this.config, path);

	async archiveWorkspace(dest: string): Promise<boolean> {
		this.ensureDirectories();
		mkdirSync(dirname(dest), { recursive: true });
		await execFileAsync("/usr/bin/tar", ["-czf", dest, "-C", this.dir, "workspace", "home/agent"], { timeout: 3_600_000 });
		return true;
	}

	private get pendingRestore(): string {
		return join(this.dir, PENDING_RESTORE);
	}

	async restorePending(): Promise<boolean> {
		if (!existsSync(this.pendingRestore)) return false;
		const { stdout } = await execFileAsync("/usr/bin/tar", ["-tzf", this.pendingRestore], { timeout: 120_000 });
		for (const entry of stdout.split(/\r?\n/)) {
			const clean = entry.trim();
			if (!clean) continue;
			if (clean.startsWith("/") || clean.split("/").includes("..")) {
				throw new Error(`备份压缩包包含不安全路径：${clean}`);
			}
			if (clean !== "workspace" && !clean.startsWith("workspace/") && clean !== "home" && !clean.startsWith("home/agent")) {
				throw new Error(`备份压缩包包含预期之外的目录：${clean}`);
			}
		}
		const staging = join(this.dir, "restore-staging");
		await rm(staging, { recursive: true, force: true });
		await mkdir(staging, { recursive: true });
		try {
			await execFileAsync("/usr/bin/tar", ["-xzf", this.pendingRestore, "-C", staging, "workspace", "home/agent"], { timeout: 3_600_000 });
			const nextWorkspace = join(staging, "workspace");
			const nextHome = join(staging, "home", "agent");
			const backupOld = join(this.dir, `restore-old-${Date.now()}`);
			await mkdir(backupOld, { recursive: true });
			if (existsSync(nextWorkspace)) {
				if (existsSync(this.config.workspaceDir)) await rename(this.config.workspaceDir, join(backupOld, "workspace"));
				await cp(nextWorkspace, this.config.workspaceDir, { recursive: true });
			}
			if (existsSync(nextHome)) {
				if (existsSync(this.config.agentHomeDir)) await rename(this.config.agentHomeDir, join(backupOld, "agent"));
				mkdirSync(dirname(this.config.agentHomeDir), { recursive: true });
				await cp(nextHome, this.config.agentHomeDir, { recursive: true });
			}
			await rm(backupOld, { recursive: true, force: true }).catch(() => {});
			await rm(this.pendingRestore, { force: true });
			this.ensureDirectories();
			return true;
		} finally {
			await rm(staging, { recursive: true, force: true }).catch(() => {});
		}
	}

	async selfTest(): Promise<SelfTestItem[]> {
		await this.prepare();
		const profile = ensureSeatbeltProfile(this.config);
		const probeHost = join(this.config.userHome, `.df-seatbelt-probe-${Date.now()}`);
		const probeWork = join(this.config.workspaceDir, "scratch", `.df-seatbelt-ok-${Date.now()}`);
		const run = (cmd: string) =>
			new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
				const child = spawn("/usr/bin/sandbox-exec", ["-f", profile, "/bin/sh", "-c", cmd], {
					cwd: this.config.workspaceDir,
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stdout = "", stderr = "";
				child.stdout.on("data", (d) => (stdout += d));
				child.stderr.on("data", (d) => (stderr += d));
				child.on("close", (code) => done({ code, stdout, stderr }));
			});

		const wOk = await run(`touch "${probeWork}" && rm -f "${probeWork}"`);
		const wDeny = await run(`touch "${probeHost}" 2>/dev/null`);
		if (existsSync(probeHost)) rmSync(probeHost, { force: true });
		const rDeny = await run(`ls "${join(this.config.userHome, "Library", "Keychains")}" >/dev/null 2>&1`);

		return [
			{
				name: "workspace-write",
				passed: wOk.code === 0,
				detail: wOk.code === 0 ? "可在沙箱 workspace 内正常读写" : (wOk.stderr || `exit ${wOk.code}`),
			},
			{
				name: "host-write-blocked",
				passed: wDeny.code !== 0,
				detail: wDeny.code !== 0 ? "Seatbelt 已拒绝写入沙箱外部目录" : "意外允许写入沙箱外路径",
			},
			{
				name: "sensitive-read-blocked",
				passed: rDeny.code !== 0,
				detail: rDeny.code !== 0 ? "Seatbelt 已拒绝读取敏感目录" : "意外允许读取钥匙串目录",
			},
		];
	}
}
