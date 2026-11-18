import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { imageReleaseTag, imageSources } from "../src/sandbox/image.ts";
import { Sandbox, type SandboxOptions, type WslRunner } from "../src/sandbox/sandbox.ts";
import { startTestCore } from "./harness.ts";

/** 0.13.1 step 3: the sandbox image is downloaded from the repository's GitHub Release on first set-up. */
describe("sandbox image download (0.13.1 step 3)", () => {
	const image = Buffer.from("fake image ".repeat(400));
	const info = { file: "dreamflutter-sandbox.tar.gz", sha256: createHash("sha256").update(image).digest("hex"), debian: "13", builtAt: 1, bytes: image.length, packages: 1 };

	function fakeWsl(dir: string, calls: string[][]): WslRunner {
		return async (args) => {
			calls.push(args);
			if (args[0] === "--import") {
				mkdirSync(join(dir, "disk"), { recursive: true });
				writeFileSync(join(dir, "disk", "ext4.vhdx"), readFileSync(args[3]!));
			}
			return { code: 0, stdout: args.includes("sh") ? "CHECK_OK BOOT_OK" : "", stderr: "" };
		};
	}

	async function start(options: (dir: string, infoFile: string) => SandboxOptions) {
		const root = mkdtempSync(join(tmpdir(), "df-core-"));
		const dir = join(root, "sbx");
		const infoFile = join(root, "shipped.json");
		writeFileSync(infoFile, JSON.stringify(info));
		const t = await startTestCore(root, { sandbox: options(dir, infoFile) });
		return { t, dir, sandbox: t.core.module(Sandbox)! };
	}

	it("downloads from the release, imports it and keeps no copy of the image", async () => {
		const calls: string[][] = [];
		const asked: string[] = [];
		const { t, dir, sandbox } = await start((dir, infoFile) => ({ dir, distro: "df-test-download", image: null, remoteImage: infoFile, wsl: fakeWsl(dir, calls),
			fetchImpl: async (url) => { asked.push(url); return new Response(image, { status: 200 }); } }));
		try {
			await sandbox.provision();
			assert.deepEqual(asked, imageSources(info));
			assert.match(asked[0]!, new RegExp(`^https://github\\.com/jun64349/DreamFlutter/releases/download/${imageReleaseTag(info)}/dreamflutter-sandbox\\.tar\\.gz$`));
			const imported = calls.find(c => c[0] === "--import")!;
			assert.equal(imported[3], join(dir, "download", info.file));
			assert.deepEqual(readFileSync(join(dir, "clean.vhdx")), image);
			assert.equal(existsSync(join(dir, "download")), false);
			assert.equal((await sandbox.status()).mirror, "从 GitHub 下载");
		} finally { await t.cleanup(); }
	});

	it("a failed download falls back to building the image here", async () => {
		// No mirrors: the build itself then fails, which shows it was tried after the download failed.
		const { t, sandbox } = await start((dir, infoFile) => ({ dir, distro: "df-test-fallback", image: null, remoteImage: infoFile, wsl: fakeWsl(dir, []), mirrors: [],
			fetchImpl: async () => new Response("tampered", { status: 200 }) }));
		try {
			await assert.rejects(sandbox.provision());
			assert.equal((await sandbox.status()).mirror, "在线构建");
		} finally { await t.cleanup(); }
	});
});
