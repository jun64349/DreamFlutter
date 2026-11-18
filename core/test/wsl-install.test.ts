import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DECLINED, installWsl, WslInstallError, type WslInstallDeps } from "../src/sandbox/wsl-install.ts";
import { AFTER_RESTART, Sandbox, type WslRunner } from "../src/sandbox/sandbox.ts";
import { startTestCore } from "./harness.ts";

/** Route step 4 (user 2026-11-18): one-click sandbox installs WSL when the computer has none. */
describe("one-click WSL", () => {
	const virtualizationOn = async () => "True,False";
	function deps(over: Partial<WslInstallDeps>): WslInstallDeps & { scripts: string[] } {
		const scripts: string[] = [];
		return { scripts, powershell: virtualizationOn, wslAvailable: async () => false, ...over, elevate: async (script) => { scripts.push(script); return over.elevate ? over.elevate(script) : 0; } };
	}

	it("Windows' own installer: ready at once, or after a restart", async () => {
		assert.equal(await installWsl(deps({ wslAvailable: async () => true })), "ready");
		const d = deps({});
		assert.equal(await installWsl(d), "restart");
		assert.equal(d.scripts.length, 1);
		assert.match(d.scripts[0]!, /wsl\.exe --install --no-distribution/);
	});

	it("declining the administrator prompt, or virtualization off, says what to do", async () => {
		await assert.rejects(installWsl(deps({ elevate: async () => DECLINED })), (e: unknown) => e instanceof WslInstallError && e.code === "declined" && /管理员确认/.test(e.message));
		const off = deps({ powershell: async () => "False,False" });
		await assert.rejects(installWsl(off), (e: unknown) => e instanceof WslInstallError && e.code === "no_virtualization" && /BIOS/.test(e.message));
		assert.equal(off.scripts.length, 0, "no prompt when it cannot work");
	});

	it("falls back to Microsoft's signed MSI, checked by hash and signature", async () => {
		const msi = Buffer.from("fake msi");
		const sha = createHash("sha256").update(msi).digest("hex");
		const work = mkdtempSync(join(tmpdir(), "df-wsl-msi-"));
		const d = deps({
			workDir: work,
			elevate: async (script) => (script.includes("--install") ? 1 : 0),
			fetchImpl: async (url) => url.includes("api.github.com")
				? new Response(JSON.stringify({ assets: [{ name: "wsl.2.6.1.0.arm64.msi", size: 1, browser_download_url: "https://github.com/x/arm", digest: "sha256:" + sha }, { name: "wsl.2.6.1.0.x64.msi", size: msi.length, browser_download_url: "https://github.com/microsoft/WSL/releases/download/2.6.1/wsl.2.6.1.0.x64.msi", digest: "sha256:" + sha }] }))
				: new Response(msi, { status: 200 }),
		});
		assert.equal(await installWsl(d), "restart");
		assert.equal(d.scripts.length, 2);
		assert.match(d.scripts[1]!, /Get-AuthenticodeSignature/);
		assert.match(d.scripts[1]!, /O=Microsoft Corporation/);
		assert.match(d.scripts[1]!, /wsl\.2\.6\.1\.0\.x64\.msi/);
		assert.match(d.scripts[1]!, /VirtualMachinePlatform/);
		assert.equal(existsSync(join(work, "wsl.2.6.1.0.x64.msi")), false, "the MSI is deleted afterwards");

		const tampered = deps({ workDir: mkdtempSync(join(tmpdir(), "df-wsl-msi-")), elevate: async (s) => (s.includes("--install") ? 1 : 0),
			fetchImpl: async (url) => url.includes("api.github.com") ? new Response(JSON.stringify({ assets: [{ name: "wsl.2.6.1.0.x64.msi", size: msi.length, browser_download_url: "https://x/y", digest: "sha256:" + sha }] })) : new Response("other!!!", { status: 200 }) });
		await assert.rejects(installWsl(tampered), (e: unknown) => e instanceof WslInstallError && e.code === "failed");
		assert.equal(tampered.scripts.length, 1, "never installs an unverified package");
	});

	it("the sandbox waits for the restart, relaunches the app and carries on after it", async () => {
		const root = mkdtempSync(join(tmpdir(), "df-core-"));
		const dir = join(root, "sbx");
		let wslThere = false;
		const relaunched: string[] = [];
		const wsl: WslRunner = async (args) => {
			if (args[0] === "--status") return { code: wslThere ? 0 : 1, stdout: "", stderr: "" };
			if (args[0] === "--import") { mkdirSync(join(dir, "disk"), { recursive: true }); writeFileSync(join(dir, "disk", "ext4.vhdx"), "disk"); }
			if (args[0] === "--list") return { code: 0, stdout: wslThere && existsSync(join(dir, "clean.vhdx")) ? "df-test-restart" : "", stderr: "" };
			return { code: 0, stdout: args.includes("sh") ? "CHECK_OK BOOT_OK" : "", stderr: "" };
		};
		const image = join(root, "image.tar.gz");
		writeFileSync(image, "image");
		writeFileSync(image.replace(/\.tar\.gz$/, ".json"), JSON.stringify({ sha256: createHash("sha256").update("image").digest("hex") }));
		const t = await startTestCore(root, { sandbox: { dir, distro: "df-test-restart", image, wsl, wslInstall: {
			powershell: virtualizationOn, elevate: async () => 0, relaunchAfterRestart: async () => { relaunched.push("runonce"); }, restart: () => relaunched.push("restart"),
		} } });
		try {
			const sandbox = t.core.module(Sandbox)!;
			assert.equal((await sandbox.status()).state, "no-wsl");
			await sandbox.provision();
			assert.equal((await sandbox.status()).state, "restart-needed");
			assert.ok(existsSync(join(dir, AFTER_RESTART)));
			assert.deepEqual(relaunched, ["runonce"]);
			await t.core.call("sandbox.restartComputer", {}, t.client);
			assert.deepEqual(relaunched, ["runonce", "restart"]);
			// After the restart: WSL works, the next start finishes the job.
			wslThere = true;
			await sandbox.start();
			await new Promise((r) => setTimeout(r, 50));
			await sandbox.provision();
			assert.equal(existsSync(join(dir, AFTER_RESTART)), false);
			assert.equal((await sandbox.status()).state, "ready");
			assert.equal(readFileSync(join(dir, "clean.vhdx"), "utf8"), "disk");
		} finally { await t.cleanup(); }
	});
});
