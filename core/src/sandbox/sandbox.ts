import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Core, CoreModule } from "../core.ts";
import { buildImage, bundledImage, IMAGE_FILE, verifyImage } from "./image.ts";

/**
 * 蝶君's sandbox: a WSL2 distro of its own (roadmap 3.3, docs/v0.3-design.md).
 *
 * Checked by hand on 2026-11-02 (docs/HANDOFF.md, v0.3 sandbox):
 * - wsl.conf without automount and interop keeps Windows drives out, and the
 *   host refuses to start Windows programs from inside;
 * - the agent user has no sudo, so it cannot mount drives, edit wsl.conf or
 *   register interop again;
 * - every WSL distro shares one VM and its network: switching the network
 *   card off cuts all of them, so going offline drops only the agent user's
 *   traffic (nftables, by uid), which it cannot undo;
 * - /mnt/wsl (shared between distros) and /mnt/wslg (the GUI bridge) are
 *   unmounted by root at every start; WSL links /etc/resolv.conf to
 *   /mnt/wsl/resolv.conf again at every launch (checked 2026-11-02: a copy in
 *   /etc was gone at the next wsl.exe call, which cut the agent's DNS), so a
 *   private tmpfs with only resolv.conf takes /mnt/wsl's place.
 */

export const SANDBOX_DISTRO = "DreamFlutterSandbox";
/** An unusual uid, so firewall rules by uid touch nobody in the user's other distros (they share the network). */
export const AGENT_UID = 23456;
export const SANDBOX_WORKSPACE = "/workspace";
const BASE_RELEASE = "24.04";

export interface Mirror {
	id: string;
	name: string;
	/** Ubuntu Base release folder. */
	image: string;
	/** apt archive. */
	apt: string;
}

/** Ubuntu Base for the throwaway builder of the sandbox image (image.ts). Direct connections, no proxy; the fastest wins. */
export const MIRRORS: Mirror[] = [
	// 7 MB/s from this machine on 2026-11-02, when Aliyun gave 0.23 MB/s; the builder takes the fastest.
	{ id: "huawei", name: "华为云", image: `https://mirrors.huaweicloud.com/ubuntu-cdimage/ubuntu-base/releases/${BASE_RELEASE}/release/`, apt: "http://mirrors.huaweicloud.com/ubuntu/" },
	{ id: "aliyun", name: "阿里云", image: `https://mirrors.aliyun.com/ubuntu-cdimage/ubuntu-base/releases/${BASE_RELEASE}/release/`, apt: "http://mirrors.aliyun.com/ubuntu/" },
	{ id: "tuna", name: "清华", image: `https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cdimage/ubuntu-base/releases/${BASE_RELEASE}/release/`, apt: "http://mirrors.tuna.tsinghua.edu.cn/ubuntu/" },
	{ id: "ustc", name: "中科大", image: `https://mirrors.ustc.edu.cn/ubuntu-cdimage/ubuntu-base/releases/${BASE_RELEASE}/release/`, apt: "http://mirrors.ustc.edu.cn/ubuntu/" },
	{ id: "ubuntu", name: "Ubuntu 官方", image: `https://cdimage.ubuntu.com/ubuntu-base/releases/${BASE_RELEASE}/release/`, apt: "http://archive.ubuntu.com/ubuntu/" },
];

export type SandboxState = "no-wsl" | "absent" | "provisioning" | "ready" | "error";

export interface SandboxStatus {
	state: SandboxState;
	/** What provisioning is doing, for the window. */
	step: string | null;
	/** 0–1 while downloading. */
	progress: number | null;
	error: string | null;
	online: boolean;
	diskBytes: number | null;
	distro: string;
	mirror: string | null;
	/** The app ships the sandbox image: setting up needs no download. */
	bundled: boolean;
}

export interface WslResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Runs wsl.exe; tests swap it. */
export type WslRunner = (args: string[], options?: { input?: string | Buffer; timeoutMs?: number }) => Promise<WslResult>;

export const runWsl: WslRunner = (args, options = {}) =>
	new Promise((resolve) => {
		// WSL_UTF8: wsl.exe's own messages in UTF-8 instead of UTF-16.
		const child = spawn("wsl.exe", args, { windowsHide: true, env: { ...process.env, WSL_UTF8: "1" } });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined;
		child.stdout.on("data", (c: Buffer) => out.push(c));
		child.stderr.on("data", (c: Buffer) => err.push(c));
		child.on("error", (error) => {
			if (timer) clearTimeout(timer);
			resolve({ code: null, stdout: "", stderr: error.message });
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			const clean = (b: Buffer[]) => Buffer.concat(b).toString("utf8").replaceAll("\0", "");
			resolve({ code, stdout: clean(out), stderr: clean(err) });
		});
		if (options.input !== undefined) child.stdin.end(options.input);
		else child.stdin.end();
	});

/** Run as root after importing the image: is it the sandbox it should be? */
export const CHECK_SCRIPT = `set -e
id -u agent | grep -qx ${AGENT_UID}
grep -q "default = agent" /etc/wsl.conf
grep -q "enabled = false" /etc/wsl.conf
test -d ${SANDBOX_WORKSPACE}/outbox
for tool in python3 rg fd nft curl git; do command -v $tool >/dev/null; done
if command -v sudo >/dev/null; then echo "sudo is installed" >&2; exit 1; fi
echo CHECK_OK
`;

/** Run as root at every start: cut the shared mounts, set the agent's network rules, check no drive is mounted. */
export function bootScript(online: boolean): string {
	const uid = `meta skuid ${AGENT_UID}`;
	const rules = online
		? `${uid} oifname "lo" accept
    ${uid} ip daddr $NS udp dport 53 accept
    ${uid} ip daddr $NS tcp dport 53 accept
    ${uid} ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10 } drop
    ${uid} ip6 daddr { fc00::/7, fe80::/10 } drop`
		: `${uid} oifname "lo" accept
    ${uid} drop`;
	// WSL keeps the DNS settings in /mnt/wsl (shared between distros) and links
	// /etc/resolv.conf there again at every launch, so a copy in /etc is lost at
	// the next command. Instead /mnt/wsl becomes a private tmpfs (source
	// "dfresolv") holding only resolv.conf, writable by root alone.
	return `if [ -s /mnt/wsl/resolv.conf ]; then cat /mnt/wsl/resolv.conf > /tmp/df-resolv; fi
umount -l /mnt/wslg 2>/dev/null || true
if ! grep -q '^dfresolv /mnt/wsl ' /proc/mounts; then
  umount -l /mnt/wsl 2>/dev/null || true
  mkdir -p /mnt/wsl && mount -t tmpfs -o size=64k,mode=755 dfresolv /mnt/wsl
fi
if [ -s /tmp/df-resolv ]; then cat /tmp/df-resolv > /mnt/wsl/resolv.conf; rm -f /tmp/df-resolv; fi
ln -sfn /mnt/wsl/resolv.conf /etc/resolv.conf
rm -rf /tmp/.X11-unix 2>/dev/null || true
NS=$(awk '/^nameserver/ {print $2; exit}' /mnt/wsl/resolv.conf 2>/dev/null)
NS=\${NS:-127.0.0.53}
nft delete table inet dreamflutter 2>/dev/null || true
nft -f - <<EOF
table inet dreamflutter {
  chain out {
    type filter hook output priority 0; policy accept;
    ${rules}
  }
}
EOF
if grep -q 'aname=drvfs' /proc/mounts; then echo DRVFS_MOUNTED; fi
echo BOOT_OK
`;
}

/** Escape checks, run as the agent. One "PASS name" or "FAIL name: detail" line each. */
export const SELF_TEST_SCRIPT = `check() { if eval "$2" >/dev/null 2>&1; then echo "PASS $1"; else echo "FAIL $1"; fi; }
check uid '[ "$(id -u)" = "${AGENT_UID}" ]'
check no-drives '! grep -q "aname=drvfs" /proc/mounts'
check no-mount '! mount -t drvfs C: /tmp/df-c'
check no-sudo '! command -v sudo'
check no-su-root '! su -c true root </dev/null'
check wsl-conf-locked '! sh -c "echo x >> /etc/wsl.conf"'
check interop-locked '! sh -c "echo :x:M::MZ::/init:PF > /proc/sys/fs/binfmt_misc/register"'
check no-shared-mounts '! grep -E " /mnt/(wsl|wslg)( |/)" /proc/mounts | grep -qv "^dfresolv /mnt/wsl "'
check dns-locked '! sh -c "echo nameserver 1.1.1.1 > /mnt/wsl/resolv.conf"'
check firewall-locked '! nft flush ruleset'
if [ -x /tmp/df-probe.exe ]; then
  out=$(timeout 20 /tmp/df-probe.exe 2>/dev/null)
  case "$out" in *\\\\*) echo "FAIL no-windows-programs: $out";; *) echo "PASS no-windows-programs";; esac
fi
`;

export interface SelfTestItem {
	name: string;
	passed: boolean;
	detail: string | null;
}

export function parseSelfTest(output: string): SelfTestItem[] {
	const items: SelfTestItem[] = [];
	for (const line of output.split("\n")) {
		const match = /^(PASS|FAIL) ([\w-]+)(?::\s*(.*))?$/.exec(line.trim());
		if (match) items.push({ name: match[2]!, passed: match[1] === "PASS", detail: match[3] ?? null });
	}
	return items;
}

/** Picks the newest Ubuntu Base for amd64 from a SHA256SUMS file: [file, sha256]. */
export function newestBase(sums: string): [string, string] | undefined {
	const entries = [...sums.matchAll(/^([0-9a-f]{64}) \*?(ubuntu-base-([\d.]+)-base-amd64\.tar\.gz)$/gm)].map((m) => ({ hash: m[1]!, file: m[2]!, version: m[3]!.split(".").map(Number) }));
	entries.sort((a, b) => {
		for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
			const d = (b.version[i] ?? 0) - (a.version[i] ?? 0);
			if (d !== 0) return d;
		}
		return 0;
	});
	return entries[0] ? [entries[0].file, entries[0].hash] : undefined;
}

export interface SandboxOptions {
	distro?: string;
	/** Folder holding the disk, the clean copy and downloads (default <data>/sandbox). */
	dir?: string;
	wsl?: WslRunner;
	/** Ubuntu mirrors for building the image when none is shipped. */
	mirrors?: Mirror[];
	/** The sandbox image; null = none shipped (build it). Default: the one shipped with the app. */
	image?: string | null;
}

export class Sandbox implements CoreModule {
	readonly distro: string;
	readonly dir: string;
	private readonly core: Core;
	private readonly wsl: WslRunner;
	private readonly mirrors: Mirror[];
	private readonly image: string | undefined;
	private state: SandboxState | null = null;
	private step: string | null = null;
	private progress: number | null = null;
	private error: string | null = null;
	private mirror: string | null = null;
	private provisioning: Promise<void> | null = null;
	private booted = false;

	constructor(core: Core, options: SandboxOptions = {}) {
		this.core = core;
		this.distro = options.distro ?? SANDBOX_DISTRO;
		this.dir = options.dir ?? join(core.paths.dataDir, "sandbox");
		this.wsl = options.wsl ?? runWsl;
		this.mirrors = options.mirrors ?? MIRRORS;
		this.image = options.image === undefined ? bundledImage() : (options.image ?? undefined);
		core.sandboxProvider = () => (existsSync(this.cleanPath) ? { distro: this.distro, ready: () => this.prepare() } : undefined);
		core.register("sandbox.status", () => this.status());
		core.register("sandbox.provision", () => {
			void this.provision().catch(() => {});
			return this.status();
		});
		core.register("sandbox.reset", async () => {
			await this.reset();
			return this.status();
		});
		core.register("sandbox.selfTest", async () => ({ items: await this.selfTest() }));
		core.register("sandbox.setOnline", async (params) => {
			core.settings.update({ sandboxOnline: params.online === true });
			if (this.booted) await this.boot();
			return this.status();
		});
		core.register("sandbox.remove", async () => {
			await this.remove();
			return this.status();
		});
	}

	/** The core is quitting: stop the sandbox so its VM memory is freed (other distros are left alone). */
	async stop(): Promise<void> {
		if (!this.booted) return;
		this.booted = false;
		await this.wsl(["--terminate", this.distro], { timeoutMs: 30_000 });
	}

	private get diskPath(): string {
		return join(this.dir, "disk", "ext4.vhdx");
	}

	private get cleanPath(): string {
		return join(this.dir, "clean.vhdx");
	}

	private changed(): void {
		void this.status().then((status) => this.core.broadcast({ event: "sandbox.changed", status }));
	}

	private setStep(step: string | null, progress: number | null = null): void {
		this.step = step;
		this.progress = progress;
		this.changed();
	}

	/** Whether WSL 2 is installed and answers. */
	async wslAvailable(): Promise<boolean> {
		const result = await this.wsl(["--status"], { timeoutMs: 20_000 });
		return result.code === 0;
	}

	async registered(): Promise<boolean> {
		const result = await this.wsl(["--list", "--quiet"], { timeoutMs: 20_000 });
		return result.code === 0 && result.stdout.split(/\r?\n/).some((line) => line.trim() === this.distro);
	}

	async status(): Promise<SandboxStatus> {
		let state = this.state;
		if (state !== "provisioning") {
			if (!(await this.wslAvailable())) state = "no-wsl";
			else if ((await this.registered()) && existsSync(this.cleanPath)) state = this.state === "error" ? "error" : "ready";
			else state = this.state === "error" ? "error" : "absent";
		}
		let diskBytes: number | null = null;
		try {
			diskBytes = (await stat(this.diskPath)).size;
		} catch {}
		return {
			state,
			step: this.step,
			progress: this.progress,
			error: this.error,
			online: this.core.settings.get().sandboxOnline,
			diskBytes,
			distro: this.distro,
			mirror: this.mirror,
			bundled: this.image !== undefined,
		};
	}

	/** Downloads Ubuntu Base, imports it as the sandbox, installs the tools and keeps a clean copy. One at a time. */
	provision(): Promise<void> {
		this.provisioning ??= this.doProvision().finally(() => {
			this.provisioning = null;
		});
		return this.provisioning;
	}

	private async doProvision(): Promise<void> {
		this.state = "provisioning";
		this.error = null;
		let built: string | undefined;
		try {
			this.setStep("检查 WSL");
			if (!(await this.wslAvailable())) throw new Error("没有找到 WSL 2。请先安装 WSL（设置 › 蝶君沙箱里有步骤）。");
			if (await this.registered()) {
				this.setStep("移除旧的沙箱");
				await this.wsl(["--unregister", this.distro], { timeoutMs: 60_000 });
			}
			await mkdir(this.dir, { recursive: true });

			// The image shipped with the app; without one (a development checkout), build it here.
			let image = this.image;
			if (image) {
				this.setStep("检查沙箱镜像");
				await verifyImage(image);
				this.mirror = "随应用附带";
			} else {
				built = join(this.dir, IMAGE_FILE);
				this.mirror = "在线构建";
				await buildImage({ out: built, workDir: join(this.dir, "build"), wsl: this.wsl, ubuntuMirrors: this.mirrors, onStep: (step, progress) => this.setStep(step, progress ?? null) });
				image = built;
			}

			this.setStep("导入沙箱");
			const imported = await this.wsl(["--import", this.distro, join(this.dir, "disk"), image, "--version", "2"], { timeoutMs: 600_000 });
			if (imported.code !== 0) throw new Error(`导入失败：${imported.stderr.trim() || imported.stdout.trim()}`);

			this.setStep("检查沙箱");
			const check = await this.wsl(["-d", this.distro, "-u", "root", "--", "sh", "-s"], { input: CHECK_SCRIPT, timeoutMs: 120_000 });
			if (!check.stdout.includes("CHECK_OK")) throw new Error(`沙箱镜像不完整：${(check.stderr || check.stdout).trim().split("\n").slice(-5).join("\n")}`);

			this.setStep("保存干净的快照");
			await this.wsl(["--terminate", this.distro], { timeoutMs: 60_000 });
			await copyFile(this.diskPath, this.cleanPath);
			this.booted = false;
			this.state = "ready";
			this.setStep(null);
		} catch (error) {
			this.state = "error";
			this.error = error instanceof Error ? error.message : String(error);
			this.setStep(null);
			throw error;
		} finally {
			// An image built here is only needed for the import: the clean snapshot is what resets use.
			if (built) await rm(built, { force: true }).catch(() => {});
			await rm(join(this.dir, "build"), { recursive: true, force: true }).catch(() => {});
		}
	}

	/** Prepares a started sandbox: shared mounts gone, the agent's network rules in place, no drive mounted. */
	async boot(): Promise<void> {
		const result = await this.wsl(["-d", this.distro, "-u", "root", "--", "sh", "-s"], { input: bootScript(this.core.settings.get().sandboxOnline), timeoutMs: 60_000 });
		if (!result.stdout.includes("BOOT_OK")) throw new Error(`沙箱启动失败：${(result.stderr || result.stdout).trim()}`);
		if (result.stdout.includes("DRVFS_MOUNTED")) {
			await this.wsl(["--terminate", this.distro]);
			throw new Error("沙箱里挂载了 Windows 磁盘，已停止。请在设置里重置沙箱。");
		}
		this.booted = true;
		try {
			await this.restorePending();
		} catch (error) {
			// The archive stays for the next start; the sandbox itself works.
			this.core.log.warn("sandbox: could not restore files from a backup", error);
		}
	}

	private booting: Promise<void> | null = null;

	/**
	 * Boots for a shell that just started (and so holds the distro running).
	 * Every start: a distro that idled out and came back has /mnt/wsl again.
	 * Shells starting together share one boot.
	 */
	prepare(): Promise<void> {
		this.booting ??= this.boot().finally(() => {
			this.booting = null;
		});
		return this.booting;
	}

	/**
	 * Puts the clean copy back: everything the agent did inside is gone. The
	 * WSL VM keeps a stopped distro's disk attached, so the distro is
	 * unregistered (which lets go of the disk) and the copy registered in place.
	 */
	async reset(): Promise<void> {
		if (!existsSync(this.cleanPath)) throw new Error("沙箱还没有建好");
		this.booted = false;
		await this.wsl(["--unregister", this.distro], { timeoutMs: 60_000 });
		await mkdir(join(this.dir, "disk"), { recursive: true });
		await copyFile(this.cleanPath, this.diskPath);
		const result = await this.wsl(["--import-in-place", this.distro, this.diskPath], { timeoutMs: 120_000 });
		if (result.code !== 0) throw new Error(`重置失败：${(result.stderr || result.stdout).trim()}`);
		this.changed();
	}

	async remove(): Promise<void> {
		await this.wsl(["--unregister", this.distro], { timeoutMs: 60_000 });
		await rm(this.dir, { recursive: true, force: true });
		this.state = null;
		this.booted = false;
		this.changed();
	}

	/**
	 * Moves a sandbox set up by v0.3.1 (under %APPDATA%) into this data folder
	 * (v0.3.2). WSL remembers where a distro's disk is, so: copy the disk and
	 * the clean copy over, unregister (which deletes the old disk) and register
	 * the copy in place. Nothing to do without an old sandbox or with one here.
	 */
	async adopt(oldDir: string): Promise<boolean> {
		const oldClean = join(oldDir, "clean.vhdx");
		const oldDisk = join(oldDir, "disk", "ext4.vhdx");
		if (existsSync(this.cleanPath) || !existsSync(oldClean) || !existsSync(oldDisk) || !(await this.registered())) return false;
		this.booted = false;
		await this.wsl(["--terminate", this.distro], { timeoutMs: 60_000 });
		await mkdir(join(this.dir, "disk"), { recursive: true });
		await copyFile(oldDisk, this.diskPath);
		await copyFile(oldClean, this.cleanPath);
		const unregistered = await this.wsl(["--unregister", this.distro], { timeoutMs: 60_000 });
		if (unregistered.code !== 0) {
			// Still registered at the old place: leave everything as it was.
			await rm(this.cleanPath, { force: true });
			await rm(this.diskPath, { force: true });
			throw new Error(`搬沙箱失败：${(unregistered.stderr || unregistered.stdout).trim()}`);
		}
		const result = await this.wsl(["--import-in-place", this.distro, this.diskPath], { timeoutMs: 120_000 });
		if (result.code !== 0) throw new Error(`搬沙箱后重新登记失败（可以在设置里重新建立）：${(result.stderr || result.stdout).trim()}`);
		await rm(oldDir, { recursive: true, force: true }).catch(() => {});
		this.core.log.info(`sandbox: moved from ${oldDir} to ${this.dir}`);
		this.changed();
		return true;
	}

	/** Where this machine opens a path inside the sandbox; tests point it at a folder. */
	local = (path: string): string => `\\\\wsl.localhost\\${this.distro}${path.replaceAll("/", "\\")}`;

	/**
	 * For a backup: 蝶君's files (/workspace and /home/agent, owners kept) as
	 * a tar.gz at [dest]. False when there is no sandbox. The disk itself is
	 * not backed up: a restore rebuilds the sandbox from the shipped image.
	 */
	async archiveWorkspace(dest: string): Promise<boolean> {
		if (!existsSync(this.cleanPath) || !(await this.registered())) return false;
		const wasRunning = this.booted;
		const tmp = "/tmp/df-backup.tar.gz";
		try {
			const result = await this.wsl(["-d", this.distro, "-u", "root", "--", "tar", "-czf", tmp, "--numeric-owner", "-C", "/", "workspace", "home/agent"], { timeoutMs: 3_600_000 });
			// 1 = a file changed while it was read: still a usable archive.
			if (result.code !== 0 && result.code !== 1) throw new Error(`打包沙箱里的文件失败：${(result.stderr || result.stdout).trim()}`);
			await copyFile(this.local(tmp), dest);
		} finally {
			await this.wsl(["-d", this.distro, "-u", "root", "--", "rm", "-f", tmp], { timeoutMs: 60_000 });
			if (!wasRunning && !this.booted) await this.wsl(["--terminate", this.distro], { timeoutMs: 60_000 });
		}
		return true;
	}

	/** A restore left 蝶君's files to put back (backup/switch.ts). */
	private get pendingRestore(): string {
		return join(this.dir, "pending-restore.tar.gz");
	}

	/** Puts restored files back into a booted sandbox, replacing /workspace and /home/agent. */
	async restorePending(): Promise<boolean> {
		if (!existsSync(this.pendingRestore)) return false;
		const tmp = "/tmp/df-restore.tar.gz";
		await copyFile(this.pendingRestore, this.local(tmp));
		const script = `set -e
find /workspace /home/agent -mindepth 1 -delete
tar -xzpf ${tmp} --numeric-owner -C /
rm -f ${tmp}
echo RESTORE_OK`;
		const result = await this.wsl(["-d", this.distro, "-u", "root", "--", "sh", "-s"], { input: script, timeoutMs: 3_600_000 });
		if (!result.stdout.includes("RESTORE_OK")) throw new Error(`放回沙箱里的文件失败：${(result.stderr || result.stdout).trim()}`);
		await rm(this.pendingRestore, { force: true });
		this.core.log.info("sandbox: restored files from a backup");
		return true;
	}

	/** Runs the escape checks as the agent (after a boot), with a Windows program to try. */
	async selfTest(): Promise<SelfTestItem[]> {
		await this.boot();
		const probe = await readFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe")).catch(() => undefined);
		if (probe) {
			await this.wsl(["-d", this.distro, "-u", "root", "--", "sh", "-c", "cat > /tmp/df-probe.exe && chmod 755 /tmp/df-probe.exe"], { input: probe, timeoutMs: 30_000 });
		}
		const result = await this.wsl(["-d", this.distro, "-u", "agent", "--cd", SANDBOX_WORKSPACE, "--", "bash", "-s"], { input: SELF_TEST_SCRIPT, timeoutMs: 90_000 });
		await this.wsl(["-d", this.distro, "-u", "root", "--", "rm", "-f", "/tmp/df-probe.exe"], { timeoutMs: 30_000 });
		const items = parseSelfTest(result.stdout);
		if (items.length === 0) throw new Error(`自检没有结果：${result.stderr.trim()}`);
		return items;
	}
}
