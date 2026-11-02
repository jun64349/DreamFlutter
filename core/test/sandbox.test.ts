import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_UID, bootScript, MIRRORS, newestBase, parseSelfTest, SELF_TEST_SCRIPT, setupScript, type WslRunner } from "../src/sandbox/sandbox.ts";
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

	it("sets the distro up without drives, interop or sudo, for an agent with its own uid", () => {
		const script = setupScript(MIRRORS[0]!);
		assert.match(script, /\[automount\]\nenabled = false/);
		assert.match(script, /\[interop\]\nenabled = false/);
		assert.match(script, /\[user\]\ndefault = agent/);
		assert.match(script, new RegExp(`useradd .*--uid ${AGENT_UID}`));
		assert.ok(!/\bsudo\b/.test(script.replace(/no sudo/g, "")), "never installs sudo");
		assert.match(script, /URIs: http:\/\/mirrors\.aliyun\.com\/ubuntu\//);
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
