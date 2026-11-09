/**
 * Builds 蝶君's sandbox image (Debian 13 with the tools installed) into
 * core/sandbox-image/, where the core and scripts/package-windows.ps1 find it.
 *   node --disable-warning=ExperimentalWarning scripts/build-sandbox-image.ts
 *   … build-sandbox-image.ts --out <file.tar.gz>   (a trial build somewhere else)
 * Offline office layer over the SHA-256-pinned v0.6 base in the bundle cache.
 * Needs WSL 2 and a builder distro (default DreamFlutterSandbox); writes only a disposable /tmp tree.
 * --refresh-base explicitly runs the older online Debian builder; review/re-pin a changed base before reuse.
 */
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildImage, IMAGE_FILE } from "../src/sandbox/image.ts";
import { runWsl } from "../src/sandbox/sandbox.ts";
import { spawnSync } from "node:child_process";
import { bundledPython } from "../src/agent/toolchain.ts";
import { readFileSync } from "node:fs";

const outArg = process.argv.indexOf("--out");
const out =
	outArg > 0 && process.argv[outArg + 1]
		? resolve(process.argv[outArg + 1]!)
		: fileURLToPath(new URL(`../sandbox-image/${IMAGE_FILE}`, import.meta.url));
const started = Date.now();
let last = "";
// Normal packaging is offline and reuses the hash-pinned base. Refreshing Debian is an explicit maintainer action.
if (process.argv.includes("--refresh-base")) {
const refreshed = await buildImage({
	out,
	workDir: join(tmpdir(), "df-sandbox-image-build"),
	wsl: runWsl,
	onStep: (step, progress) => {
		const line = `${step}${progress != null ? ` ${Math.round(progress * 100)}%` : ""}`;
		if (line !== last) console.log(`  · ${line}`);
		last = line;
	},
});
const pinned = JSON.parse(readFileSync(fileURLToPath(new URL("../bundled-runtime.lock.json", import.meta.url)), "utf8"));
if (refreshed.sha256 !== pinned.baseImage.sha256) throw new Error("Refreshed Debian base differs from the pinned image. Review and update the lock explicitly before applying the office layer.");
}
// A refreshed Debian base must be explicitly reviewed/pinned before the office layer accepts it.
const python = bundledPython();
if (!python) throw new Error("Prepare the portable Python/toolchain first");
const cache = process.env.DREAMFLUTTER_BUNDLE_CACHE ?? fileURLToPath(new URL("../bin/.bundle-cache", import.meta.url));
const office = spawnSync(python, ["-I", "-B", fileURLToPath(new URL("../../scripts/bundle-office-image.py", import.meta.url)), "--cache", cache, "--out", out], { windowsHide: true, stdio: "inherit" });
if (office.status !== 0) throw new Error("Pinned offline office image layer failed; base/lock mismatch requires explicit review");
console.log(`built pinned offline office image ${out} in ${Math.round((Date.now() - started) / 1000)} s`);
