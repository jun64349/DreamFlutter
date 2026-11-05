/**
 * Builds 蝶君's sandbox image (Debian 13 with the tools installed) into
 * core/sandbox-image/, where the core and scripts/package-windows.ps1 find it.
 *   node --disable-warning=ExperimentalWarning scripts/build-sandbox-image.ts
 *   … build-sandbox-image.ts --out <file.tar.gz>   (a trial build somewhere else)
 * Takes 10–20 minutes (downloads from the fastest mirror). Needs WSL 2.
 */
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildImage, IMAGE_FILE } from "../src/sandbox/image.ts";
import { runWsl } from "../src/sandbox/sandbox.ts";

const outArg = process.argv.indexOf("--out");
const out =
	outArg > 0 && process.argv[outArg + 1]
		? resolve(process.argv[outArg + 1]!)
		: fileURLToPath(new URL(`../sandbox-image/${IMAGE_FILE}`, import.meta.url));
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
