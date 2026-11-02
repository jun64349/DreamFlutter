import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Core, CoreModule } from "../core.ts";
import { downloadFile, fetchText } from "./download.ts";

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
 *   unmounted by root at every start.
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

/** Tried in order; the first that answers wins. Direct connections, no proxy. */
export const MIRRORS: Mirror[] = [
	{ id: "aliyun", name: "阿里云", image: `https://mirrors.aliyun.com/ubuntu-cdimage/ubuntu-base/releases/${BASE_RELEASE}/release/`, apt: "http://mirrors.aliyun.com/ubuntu/" },
	{ id: "tuna", name: "清华", image: `https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cdimage/ubuntu-base/releases/${BASE_RELEASE}/release/`, apt: "http://mirrors.tuna.tsinghua.edu.cn/ubuntu/" },
	{ id: "ustc", name: "中科大", image: `https://mirrors.ustc.edu.cn/ubuntu-cdimage/ubuntu-base/releases/${BASE_RELEASE}/release/`, apt: "http://mirrors.ustc.edu.cn/ubuntu/" },
	{ id: "ubuntu", name: "Ubuntu 官方", image: `https://cdimage.ubuntu.com/ubuntu-base/releases/${BASE_RELEASE}/release/`, apt: "http://archive.ubuntu.com/ubuntu/" },
];
const OFFICIAL_SUMS = `https://cdimage.ubuntu.com/ubuntu-base/releases/${BASE_RELEASE}/release/SHA256SUMS`;

/** Packages the sandbox starts with (apt, so no pip builds on first use). */
export const SANDBOX_PACKAGES = [
	"ca-certificates", "curl", "git", "jq", "ripgrep", "fd-find", "unzip", "zip", "less", "file", "procps", "nftables",
	"python3", "python3-venv", "python3-pip", "python3-numpy", "python3-pandas", "python3-matplotlib", "python3-openpyxl",
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

/** The script that turns Ubuntu Base into the sandbox (root, once). */
export function setupScript(mirror: Mirror): string {
	return `set -e
cat > /etc/wsl.conf <<'CONF'
[automount]
enabled = false
mountFsTab = false

[interop]
enabled = false
appendWindowsPath = false

[network]
generateHosts = true
generateResolvConf = true
hostname = dreamflutter-sandbox

[user]
default = agent

[boot]
systemd = false
CONF
cat > /etc/apt/sources.list.d/ubuntu.sources <<'SRC'
Types: deb
URIs: ${mirror.apt}
Suites: noble noble-updates noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
SRC
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends ${SANDBOX_PACKAGES.join(" ")}
ln -sf /usr/bin/fdfind /usr/local/bin/fd
apt-get clean
rm -rf /var/lib/apt/lists/*
# The agent: an ordinary user, no sudo (none is installed), root locked.
id agent >/dev/null 2>&1 || useradd --create-home --uid ${AGENT_UID} --user-group --shell /bin/bash agent
passwd -l root >/dev/null
mkdir -p ${SANDBOX_WORKSPACE}/inbox ${SANDBOX_WORKSPACE}/scratch ${SANDBOX_WORKSPACE}/outbox
chown -R agent:agent ${SANDBOX_WORKSPACE}
echo SETUP_OK
`;
}

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
	// WSL keeps the DNS settings in /mnt/wsl and links /etc/resolv.conf there: keep a real copy before cutting /mnt/wsl.
	return `if [ -s /mnt/wsl/resolv.conf ]; then cat /mnt/wsl/resolv.conf > /tmp/df-resolv && rm -f /etc/resolv.conf && cat /tmp/df-resolv > /etc/resolv.conf && rm -f /tmp/df-resolv; fi
umount -l /mnt/wslg 2>/dev/null || true
umount -l /mnt/wsl 2>/dev/null || true
rm -rf /tmp/.X11-unix 2>/dev/null || true
NS=$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf)
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
check no-shared-mounts '! grep -qE " /mnt/(wsl|wslg)( |/)" /proc/mounts'
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
	mirrors?: Mirror[];
}

export class Sandbox implements CoreModule {
	readonly distro: string;
	readonly dir: string;
	private readonly core: Core;
	private readonly wsl: WslRunner;
	private readonly mirrors: Mirror[];
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
		try {
			this.setStep("检查 WSL");
			if (!(await this.wslAvailable())) throw new Error("没有找到 WSL 2。请先安装 WSL（设置 › 蝶君沙箱里有步骤）。");
			if (await this.registered()) {
				this.setStep("移除旧的沙箱");
				await this.wsl(["--unregister", this.distro], { timeoutMs: 60_000 });
			}
			await mkdir(this.dir, { recursive: true });

			this.setStep("寻找可用的下载源");
			const { mirror, file, hash } = await this.pickMirror();
			this.mirror = mirror.name;
			const tarball = join(this.dir, file);
			let ok = existsSync(tarball) && (await sha256(tarball)) === hash;
			if (!ok) {
				this.setStep(`下载系统镜像（${mirror.name}）`, 0);
				let shown = 0;
				const got = await downloadFile(`${mirror.image}${file}`, tarball, (received, total) => {
					if (total <= 0) return;
					this.progress = received / total;
					// The window hears about every 5%.
					if (this.progress - shown >= 0.05) {
						shown = this.progress;
						this.changed();
					}
				});
				if (got !== hash) {
					await rm(tarball, { force: true });
					throw new Error("下载的系统镜像校验不通过，已删除。请稍后重试。");
				}
				ok = true;
			}

			this.setStep("导入沙箱");
			const imported = await this.wsl(["--import", this.distro, join(this.dir, "disk"), tarball, "--version", "2"], { timeoutMs: 300_000 });
			if (imported.code !== 0) throw new Error(`导入失败：${imported.stderr.trim() || imported.stdout.trim()}`);

			this.setStep(`安装 Python 和常用工具（${mirror.name}，约 3–5 分钟）`);
			const setup = await this.wsl(["-d", this.distro, "-u", "root", "--", "sh", "-s"], { input: setupScript(mirror), timeoutMs: 1_200_000 });
			if (!setup.stdout.includes("SETUP_OK")) throw new Error(`安装工具失败：${(setup.stderr || setup.stdout).trim().split("\n").slice(-5).join("\n")}`);

			this.setStep("保存干净的快照");
			await this.wsl(["--terminate", this.distro], { timeoutMs: 60_000 });
			await copyFile(this.diskPath, this.cleanPath);
			await rm(tarball, { force: true });
			this.booted = false;
			this.state = "ready";
			this.setStep(null);
		} catch (error) {
			this.state = "error";
			this.error = error instanceof Error ? error.message : String(error);
			this.setStep(null);
			throw error;
		}
	}

	private async pickMirror(): Promise<{ mirror: Mirror; file: string; hash: string }> {
		let official: string | undefined;
		try {
			official = await fetchText(OFFICIAL_SUMS, 8_000);
		} catch {}
		for (const mirror of this.mirrors) {
			try {
				const sums = official ?? (await fetchText(`${mirror.image}SHA256SUMS`, 8_000));
				const newest = newestBase(sums);
				if (!newest) continue;
				// The mirror must actually serve the file the checksums name.
				await fetchText(`${mirror.image}SHA256SUMS`, 8_000);
				return { mirror, file: newest[0], hash: newest[1] };
			} catch {}
		}
		throw new Error("所有下载源都连不上。请检查网络后重试。");
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

async function sha256(path: string): Promise<string> {
	const { createHash } = await import("node:crypto");
	return createHash("sha256").update(await readFile(path)).digest("hex");
}
