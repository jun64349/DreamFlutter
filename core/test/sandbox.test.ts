import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScript, DEBIAN_MIRRORS, fileSha256, IMAGE_FILE, IMAGE_PACKAGES, infoPath, verifyImage, WSL_CONF } from "../src/sandbox/image.ts";
import { AGENT_UID, bootScript, CHECK_SCRIPT, MIRRORS, newestBase, parseSelfTest, SELF_TEST_SCRIPT, type WslRunner } from "../src/sandbox/sandbox.ts";
import { startTestCore } from "./harness.ts";

/** Pure parts of 蝶君's sandbox; scripts/live-sandbox.ts runs the real thing on WSL. */
describe("sandbox (v0.3 3.3)", () => {
	it("picks the newest Ubuntu Base for amd64 from the checksums", () => {
		const sums = [
			"6bc2cde3930ad088b3bb46fa45279e96d25bc3810f209850ecbe4722711874f9 *ubuntu-base-24.04.3-base-amd64.tar.gz",
			"e77b6f10c2590cef872b33ee9f635a0e3fd1f57fb074c0e52b5c7f56147a0c86 *ubuntu-base-24.04.5-base-amd64.tar.gz",
			"1111111111111111111111111111111111111111111111111111111111111111 *ubuntu-base-24.04.10-base-arm64.tar.gz",
			"c1e67ef7b17a6300e136118bd1dc04725009cb376c1aad10abcf8cd453628d58 *ubuntu-base-24.04.4-base-amd64.tar.gz",
		].join("\n");
		assert.deepEqual(newestBase(sums), ["ubuntu-base-24.04.5-base-amd64.tar.gz", "e77b6f10c2590cef872b33ee9f635a0e3fd1f57fb074c0e52b5c7f56147a0c86"]);
		assert.equal(newestBase("nothing"), undefined);
	});

	it("builds a Debian image without drives, interop or sudo, for an agent with its own uid", () => {
		const script = buildScript(MIRRORS[0]!, DEBIAN_MIRRORS[0]!);
		assert.match(script, /\[automount\]\nenabled = false/);
		assert.match(script, /\[interop\]\nenabled = false/);
		assert.match(script, /\[user\]\ndefault = agent/);
		assert.match(script, new RegExp(`useradd .*--uid ${AGENT_UID}`));
		assert.match(script, /passwd -l root/);
		assert.ok(!IMAGE_PACKAGES.includes("sudo"), "never installs sudo");
		assert.match(script, /if chroot \/target dpkg -s sudo/, "and refuses an image that got it as a dependency");
		// Debian, from Debian's own packages (signature checked), through the mirror picked.
		const huawei = DEBIAN_MIRRORS.find((m) => m.name === "华为云")!;
		const fromHuawei = buildScript(MIRRORS[0]!, huawei);
		assert.ok(fromHuawei.includes(`debootstrap --variant=minbase --keyring=/usr/share/keyrings/debian-archive-keyring.gpg trixie /target ${huawei.debian}`));
		assert.ok(fromHuawei.includes(`URIs: ${huawei.security}`));
		assert.ok(fromHuawei.includes(`URIs: ${MIRRORS[0]!.apt}`), "the builder's own packages from the Ubuntu mirror picked");
		assert.match(script, /fonts-wqy-microhei/);
		assert.match(script, /font\.sans-serif: WenQuanYi Micro Hei/);
		// Every package and version listed beside the image; nothing of the build left inside.
		assert.match(script, /dpkg-query -W -f '\$\{Package\}\\t\$\{Version\}\\n'/);
		assert.match(script, /rm -f \/target\/etc\/resolv\.conf/);
		assert.match(script, /tar --numeric-owner -C \/target -czf/);
		assert.equal(WSL_CONF.split("\n")[0], "[automount]");
	});

	it("checks an imported image is the sandbox it should be", () => {
		assert.match(CHECK_SCRIPT, new RegExp(`id -u agent \\| grep -qx ${AGENT_UID}`));
		assert.match(CHECK_SCRIPT, /if command -v sudo >\/dev\/null; then .*exit 1; fi/);
		assert.match(CHECK_SCRIPT, /for tool in python3 rg fd nft curl git/);
	});

	it("uses the shipped image only when its checksum matches", async () => {
		const dir = mkdtempSync(join(tmpdir(), "df-image-"));
		try {
			const image = join(dir, IMAGE_FILE);
			writeFileSync(image, "pretend tarball");
			await assert.rejects(verifyImage(image), /缺少说明文件/);
			writeFileSync(infoPath(image), JSON.stringify({ sha256: await fileSha256(image) }));
			assert.ok(await verifyImage(image));
			writeFileSync(image, "changed");
			await assert.rejects(verifyImage(image), /校验不通过/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("goes offline by dropping only the agent's traffic, never by switching the shared network off", () => {
		const online = bootScript(true);
		const offline = bootScript(false);
		for (const script of [online, offline]) {
			assert.match(script, /umount -l \/mnt\/wslg/);
			assert.match(script, /umount -l \/mnt\/wsl/);
			assert.ok(!script.includes("ip link"), "every distro shares the network card");
			assert.match(script, new RegExp(`meta skuid ${AGENT_UID}`));
		}
		assert.match(online, /192\.168\.0\.0\/16/, "online still keeps the agent off the local network");
		assert.match(offline, new RegExp(`meta skuid ${AGENT_UID} drop`));
	});

	it("keeps DNS working after cutting /mnt/wsl: WSL links /etc/resolv.conf there again at every launch", () => {
		const script = bootScript(true);
		// The shared mount goes, a private one with only resolv.conf takes its place (once).
		assert.match(script, /grep -q '\^dfresolv \/mnt\/wsl ' \/proc\/mounts/);
		assert.match(script, /mount -t tmpfs -o size=64k,mode=755 dfresolv \/mnt\/wsl/);
		assert.ok(script.indexOf("cat /mnt/wsl/resolv.conf > /tmp/df-resolv") < script.indexOf("umount -l /mnt/wsl"), "copied before the shared mount goes");
		assert.match(script, /ln -sfn \/mnt\/wsl\/resolv\.conf \/etc\/resolv\.conf/);
		assert.match(script, /NS=\$\(awk '\/\^nameserver\/ \{print \$2; exit\}' \/mnt\/wsl\/resolv\.conf/);
		// The self-test still counts WSL's shared mount, and checks the agent cannot point DNS elsewhere.
		assert.match(SELF_TEST_SCRIPT, /grep -qv "\^dfresolv \/mnt\/wsl "/);
		assert.match(SELF_TEST_SCRIPT, /check dns-locked/);
	});

	it("reads the self-test's lines", () => {
		const items = parseSelfTest("PASS uid\nFAIL no-drives\nnoise\nFAIL no-windows-programs: PC\\user\n");
		assert.deepEqual(items, [
			{ name: "uid", passed: true, detail: null },
			{ name: "no-drives", passed: false, detail: null },
			{ name: "no-windows-programs", passed: false, detail: "PC\\user" },
		]);
		assert.match(SELF_TEST_SCRIPT, /\*\\\\\*/, "a backslash in whoami's output means a Windows program ran");
	});

	it("reports no WSL as its own state", async () => {
		const wsl: WslRunner = async () => ({ code: null, stdout: "", stderr: "spawn wsl.exe ENOENT" });
		const t = await startTestCore(undefined, { sandbox: { distro: "DFTestNoWsl", wsl } });
		try {
			const status = (await t.core.call("sandbox.status", {})) as { state: string; online: boolean };
			assert.equal(status.state, "no-wsl");
			assert.equal(status.online, true);
		} finally {
			await t.cleanup();
		}
	});
});
