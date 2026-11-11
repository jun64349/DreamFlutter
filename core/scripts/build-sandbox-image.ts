/**
 * Builds 蝶君's sandbox image (Debian 13 with the tools installed) into
 * core/sandbox-image/, where the core and scripts/package-windows.ps1 find it.
 *   node --disable-warning=ExperimentalWarning scripts/build-sandbox-image.ts
 *   … build-sandbox-image.ts --out <file.tar.gz>   (a trial build somewhere else)
 * Offline Chromium layer over the SHA-256-pinned T-75 office image in the bundle cache.
 * --download-browser explicitly prepares the pinned Debian archives before assembly.
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
const python = bundledPython();
if (!python) throw new Error("Prepare the portable Python/toolchain first");
const cache = process.env.DREAMFLUTTER_BUNDLE_CACHE ?? fileURLToPath(new URL("../bin/.bundle-cache", import.meta.url));
const distroArg = process.argv.indexOf("--distro");
const distro = distroArg > 0 ? process.argv[distroArg + 1] : undefined;
if (distroArg > 0 && !distro) throw new Error("--distro needs a WSL builder name");
const builder = distro ? ["--distro", distro] : [];

// Refreshing the old Debian base is an explicit maintainer action.
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
const office = spawnSync(python, ["-I", "-B", fileURLToPath(new URL("../../scripts/bundle-office-image.py", import.meta.url)),
	"--cache", cache, "--out", out, ...builder], { windowsHide: true, stdio: "inherit" });
if (office.status !== 0) throw new Error("Pinned offline office image layer failed; base/lock mismatch requires explicit review");
}
const browser = spawnSync(python, ["-I", "-B", fileURLToPath(new URL("../../scripts/bundle-chromium-image.py", import.meta.url)),
	"--cache", cache, "--out", out, ...builder, ...(process.argv.includes("--download-browser") ? ["--download-browser"] : [])],
	{ windowsHide: true, stdio: "inherit" });
if (browser.status !== 0) throw new Error("Pinned sandbox browser layer failed; restore the T-75 base and prepare the pinned Debian archives");
console.log(`built pinned sandbox image with Chromium ${out} in ${Math.round((Date.now() - started) / 1000)} s`);
