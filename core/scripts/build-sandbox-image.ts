/**
 * Builds 蝶君's sandbox image (Debian 13 with the tools installed) into
 * core/sandbox-image/, where the core and scripts/package-windows.ps1 find it.
 *   node --disable-warning=ExperimentalWarning scripts/build-sandbox-image.ts
 * Takes 10–20 minutes (downloads from the Aliyun mirror). Needs WSL 2.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildImage, IMAGE_FILE } from "../src/sandbox/image.ts";
import { runWsl } from "../src/sandbox/sandbox.ts";

const out = fileURLToPath(new URL(`../sandbox-image/${IMAGE_FILE}`, import.meta.url));
const started = Date.now();
let last = "";
const info = await buildImage({
	out,
	workDir: join(tmpdir(), "df-sandbox-image-build"),
	wsl: runWsl,
	onStep: (step, progress) => {
		const line = `${step}${progress != null ? ` ${Math.round(progress * 100)}%` : ""}`;
		if (line !== last) console.log(`  · ${line}`);
		last = line;
	},
});
console.log(`built ${out}`);
console.log(`  ${(info.bytes / 1024 / 1024).toFixed(0)} MB, ${info.packages} packages, Debian ${info.debian}, ${Math.round((Date.now() - started) / 1000)} s`);
