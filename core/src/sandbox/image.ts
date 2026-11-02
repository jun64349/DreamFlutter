import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadFile, fetchText, probeSpeed } from "./download.ts";
import { AGENT_UID, MIRRORS, type Mirror, newestBase, SANDBOX_WORKSPACE, type WslRunner } from "./sandbox.ts";

/**
 * 蝶君's sandbox image (v0.3, user's call 2026-11-02): a Debian 13 system
 * with every tool already installed, shipped with the app so setting the
 * sandbox up needs no download. Debian rather than Ubuntu because Debian may
 * be redistributed modified (Ubuntu's trademark policy restricts modified
 * images). Built from Debian's own packages with debootstrap, inside a
 * throwaway Ubuntu Base distro (WSL has no Debian of its own to start from).
 *
 * The image comes with a JSON sidecar (checksum, Debian release, build time)
 * and the list of every package and version in it (the sources are Debian's,
 * at the versions listed).
 */

export const IMAGE_FILE = "dreamflutter-sandbox.tar.gz";
export const DEBIAN_RELEASE = "trixie";
export const DEBIAN_VERSION = "13";

export interface DebianMirror {
	name: string;
	debian: string;
	security: string;
}

/**
 * Direct connections; the fastest one at build time wins (pickFastest). Measured
 * from this machine on 2026-11-02: deb.debian.org (a CDN) 4.5 MB/s, Huawei Cloud
 * 2.3 MB/s, Aliyun 0.24 MB/s; TUNA, USTC and 163 did not answer.
 */
export const DEBIAN_MIRRORS: DebianMirror[] = [
	{ name: "Debian 官方", debian: "http://deb.debian.org/debian/", security: "http://deb.debian.org/debian-security/" },
	{ name: "华为云", debian: "http://mirrors.huaweicloud.com/debian/", security: "http://mirrors.huaweicloud.com/debian-security/" },
	{ name: "阿里云", debian: "http://mirrors.aliyun.com/debian/", security: "http://mirrors.aliyun.com/debian-security/" },
];

/** The candidate that downloads fastest (probed side by side); its speed in bytes per second. */
export async function pickFastest<T>(candidates: T[], probeUrl: (c: T) => string): Promise<{ pick: T; speed: number } | undefined> {
	const speeds = await Promise.all(candidates.map((c) => probeSpeed(probeUrl(c))));
	let best = -1;
	for (let i = 0; i < candidates.length; i++) if (speeds[i]! > 0 && (best < 0 || speeds[i]! > speeds[best]!)) best = i;
	return best < 0 ? undefined : { pick: candidates[best]!, speed: speeds[best]! };
}

/**
 * The tools on top of Debian's minimal base (Debian packages, so no pip builds on
 * first use), useradd, and a small Chinese font so charts can show Chinese.
 * (Kept here, not in sandbox.ts: the two modules import each other, and only
 * functions may cross that loop.)
 */
export const IMAGE_PACKAGES = [
	"ca-certificates", "curl", "git", "jq", "ripgrep", "fd-find", "unzip", "zip", "less", "file", "procps", "nftables",
	"python3", "python3-venv", "python3-pip", "python3-numpy", "python3-pandas", "python3-matplotlib", "python3-openpyxl",
	"passwd", "fonts-wqy-microhei",
];

export interface ImageInfo {
	file: string;
	sha256: string;
	debian: string;
	builtAt: number;
	bytes: number;
	packages: number;
}

/** The image shipped with the app: <core>/sandbox-image/, or DREAMFLUTTER_SANDBOX_IMAGE. */
export function bundledImage(): string | undefined {
	const fromEnv = process.env.DREAMFLUTTER_SANDBOX_IMAGE;
	if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
	const path = fileURLToPath(new URL(`../../sandbox-image/${IMAGE_FILE}`, import.meta.url));
	return existsSync(path) && existsSync(infoPath(path)) ? path : undefined;
}

export function infoPath(image: string): string {
	return image.replace(/\.tar\.gz$/, ".json");
}

export function packagesPath(image: string): string {
	return image.replace(/\.tar\.gz$/, ".packages.txt");
}

export async function fileSha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

/** Whether [image] matches the checksum its sidecar records. */
export async function verifyImage(image: string): Promise<ImageInfo> {
	let info: ImageInfo;
	try {
		info = JSON.parse(await readFile(infoPath(image), "utf8")) as ImageInfo;
	} catch {
		throw new Error("沙箱镜像缺少说明文件，可能不完整。请重新安装 DreamFlutter。");
	}
	if ((await fileSha256(image)) !== info.sha256) throw new Error("沙箱镜像校验不通过，文件可能损坏。请重新安装 DreamFlutter。");
	return info;
}

/** Run as root in the Ubuntu builder: debootstrap Debian into /target, install the tools, lock it down, pack it. */
export function buildScript(ubuntu: Mirror, debian: DebianMirror): string {
	return `set -e
export DEBIAN_FRONTEND=noninteractive
cat > /etc/apt/sources.list.d/ubuntu.sources <<'SRC'
Types: deb
URIs: ${ubuntu.apt}
Suites: noble noble-updates
Components: main universe
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
SRC
apt-get update -q
apt-get install -y -q --no-install-recommends debootstrap debian-archive-keyring ca-certificates
rm -rf /target
mkdir -p /target
debootstrap --variant=minbase --keyring=/usr/share/keyrings/debian-archive-keyring.gpg ${DEBIAN_RELEASE} /target ${debian.debian}
rm -f /target/etc/apt/sources.list
cat > /target/etc/apt/sources.list.d/debian.sources <<'SRC'
Types: deb
URIs: ${debian.debian}
Suites: ${DEBIAN_RELEASE} ${DEBIAN_RELEASE}-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: ${debian.security}
Suites: ${DEBIAN_RELEASE}-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
SRC
mount -t proc proc /target/proc
trap 'umount /target/proc 2>/dev/null || true' EXIT
rm -f /target/etc/resolv.conf
cat /etc/resolv.conf > /target/etc/resolv.conf
chroot /target apt-get update -q
chroot /target apt-get install -y -q --no-install-recommends ${IMAGE_PACKAGES.join(" ")}
chroot /target apt-get clean
ln -sf /usr/bin/fdfind /target/usr/local/bin/fd
# Charts with Chinese labels.
printf '\\nfont.sans-serif: WenQuanYi Micro Hei, DejaVu Sans\\naxes.unicode_minus: False\\n' >> /target/etc/matplotlibrc
cat > /target/etc/wsl.conf <<'CONF'
${WSL_CONF}CONF
# The agent: an ordinary user, no sudo (none is installed), root locked.
chroot /target useradd --create-home --uid ${AGENT_UID} --user-group --shell /bin/bash agent
chroot /target passwd -l root >/dev/null
mkdir -p /target${SANDBOX_WORKSPACE}/inbox /target${SANDBOX_WORKSPACE}/scratch /target${SANDBOX_WORKSPACE}/outbox
chroot /target chown -R agent:agent ${SANDBOX_WORKSPACE}
mkdir -p /target/usr/share/dreamflutter
chroot /target dpkg-query -W -f '\${Package}\\t\${Version}\\n' > /target/usr/share/dreamflutter/packages.txt
if chroot /target dpkg -s sudo >/dev/null 2>&1; then echo "sudo got installed" >&2; exit 1; fi
umount /target/proc
trap - EXIT
rm -f /target/etc/resolv.conf
rm -rf /target/var/lib/apt/lists/* /target/var/cache/apt/*.bin /target/var/log/*.log /target/var/log/apt/* /target/tmp/* /target/root/.bash_history
cp /target/usr/share/dreamflutter/packages.txt /tmp/df-packages.txt
tar --numeric-owner -C /target -czf /tmp/df-image.tar.gz .
echo BUILD_OK
`;
}

/** /etc/wsl.conf of the sandbox: no drives, no Windows programs, the agent by default. */
export const WSL_CONF = `[automount]
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
`;

export interface BuildOptions {
	/** Where the image goes (its .json and .packages.txt beside it). */
	out: string;
	/** Scratch folder for the builder distro and the Ubuntu Base download. */
	workDir: string;
	wsl: WslRunner;
	ubuntuMirrors?: Mirror[];
	debianMirrors?: DebianMirror[];
	onStep?: (step: string, progress?: number | null) => void;
}

/**
 * Builds the image (about 10–20 minutes, mostly downloads): Ubuntu Base as a
 * throwaway builder, Debian assembled inside it, packed as a tar.gz. The
 * builder distro is always removed afterwards.
 */
export async function buildImage(options: BuildOptions): Promise<ImageInfo> {
	const { wsl, workDir } = options;
	const step = options.onStep ?? (() => {});
	const builder = `DFSandboxBuilder${process.pid}`;
	await mkdir(workDir, { recursive: true });
	await mkdir(dirname(options.out), { recursive: true });
	try {
		step("寻找可用的下载源");
		const { mirror, file, hash } = await pickUbuntuBase(options.ubuntuMirrors ?? MIRRORS);
		const debian = await pickDebianMirror(options.debianMirrors ?? DEBIAN_MIRRORS);
		const tarball = join(workDir, file);
		if (!(existsSync(tarball) && (await fileSha256(tarball)) === hash)) {
			step(`下载构建用的系统（${mirror.name}）`, 0);
			let shown = 0;
			const got = await downloadFile(`${mirror.image}${file}`, tarball, (received, total) => {
				if (total <= 0) return;
				const progress = received / total;
				if (progress - shown >= 0.05) {
					shown = progress;
					step(`下载构建用的系统（${mirror.name}）`, progress);
				}
			});
			if (got !== hash) {
				await rm(tarball, { force: true });
				throw new Error("下载的系统镜像校验不通过，已删除。请稍后重试。");
			}
		}
		step("准备构建环境");
		await wsl(["--unregister", builder], { timeoutMs: 60_000 });
		const imported = await wsl(["--import", builder, join(workDir, "builder"), tarball, "--version", "2"], { timeoutMs: 300_000 });
		if (imported.code !== 0) throw new Error(`导入构建环境失败：${imported.stderr.trim() || imported.stdout.trim()}`);
		step(`组装 Debian ${DEBIAN_VERSION} 并安装 Python 和常用工具（${debian.name}，约 10–20 分钟）`);
		const built = await wsl(["-d", builder, "-u", "root", "--", "sh", "-s"], { input: buildScript(mirror, debian), timeoutMs: 3_600_000 });
		if (!built.stdout.includes("BUILD_OK")) throw new Error(`构建沙箱镜像失败：${(built.stderr || built.stdout).trim().split("\n").slice(-8).join("\n")}`);
		step("保存沙箱镜像");
		const unc = `\\\\wsl.localhost\\${builder}\\tmp\\`;
		await copyFile(`${unc}df-image.tar.gz`, options.out);
		await copyFile(`${unc}df-packages.txt`, packagesPath(options.out));
		const packages = (await readFile(packagesPath(options.out), "utf8")).split("\n").filter((l) => l.trim()).length;
		const info: ImageInfo = {
			file: IMAGE_FILE,
			sha256: await fileSha256(options.out),
			debian: `${DEBIAN_VERSION} (${DEBIAN_RELEASE})`,
			builtAt: Date.now(),
			bytes: (await stat(options.out)).size,
			packages,
		};
		await writeFile(infoPath(options.out), `${JSON.stringify(info, null, "\t")}\n`);
		return info;
	} finally {
		await wsl(["--unregister", builder], { timeoutMs: 60_000 });
		await rm(join(workDir, "builder"), { recursive: true, force: true });
	}
}

/** The newest Ubuntu Base for the builder (checksums from Ubuntu itself when reachable), from the fastest mirror. */
export async function pickUbuntuBase(mirrors: Mirror[]): Promise<{ mirror: Mirror; file: string; hash: string }> {
	let sums: string | undefined;
	try {
		sums = await fetchText("https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/SHA256SUMS", 8_000);
	} catch {}
	for (const mirror of mirrors) {
		if (sums) break;
		try {
			sums = await fetchText(`${mirror.image}SHA256SUMS`, 8_000);
		} catch {}
	}
	const newest = sums ? newestBase(sums) : undefined;
	if (!newest) throw new Error("所有下载源都连不上。请检查网络后重试。");
	// Timing the file itself also proves the mirror serves it.
	const fastest = await pickFastest(mirrors, (m) => `${m.image}${newest[0]}`);
	if (!fastest) throw new Error("所有下载源都连不上。请检查网络后重试。");
	return { mirror: fastest.pick, file: newest[0], hash: newest[1] };
}

async function pickDebianMirror(mirrors: DebianMirror[]): Promise<DebianMirror> {
	const fastest = await pickFastest(mirrors, (m) => `${m.debian}dists/${DEBIAN_RELEASE}/main/binary-amd64/Packages.xz`);
	if (!fastest) throw new Error("连不上 Debian 的下载源。请检查网络后重试。");
	return fastest.pick;
}
