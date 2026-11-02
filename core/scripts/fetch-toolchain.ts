/**
 * Fetches the workbench toolchain (roadmap 3.6) into core/bin and core/python,
 * where the core and scripts/package-windows.ps1 find it:
 *   core/bin/uv.exe, uvx.exe  latest uv release (checksum verified)
 *   core/python/cpython-3.13.*  portable Python, installed by uv (python-build-standalone, verified by uv)
 *   node --disable-warning=ExperimentalWarning scripts/fetch-toolchain.ts
 * Build-time only: downloads go through curl, which honours the proxy settings.
 * rg and fd come from Pi's bin folder when packaging (package-windows.ps1).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledPython, PYTHON_DIR, TOOLS_DIR } from "../src/agent/toolchain.ts";

const PYTHON_VERSION = "3.13";
const UV_ASSET = "uv-x86_64-pc-windows-msvc.zip";

function run(command: string, args: string[]): string {
	const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout || result.error?.message}`);
	return result.stdout;
}

const curl = (url: string, out?: string) => run("curl.exe", ["-sSL", "--fail", "--retry", "3", ...(out ? ["-o", out] : []), url]);
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

mkdirSync(TOOLS_DIR, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "df-toolchain-"));
try {
	// uv: the latest release (GitHub's latest/download links, no API rate limit), checked against the checksum published beside it.
	const latest = `https://github.com/astral-sh/uv/releases/latest/download/${UV_ASSET}`;
	const zip = join(work, UV_ASSET);
	curl(latest, zip);
	const expected = curl(`${latest}.sha256`).trim().split(/\s+/)[0]!.toLowerCase();
	if (sha256(zip) !== expected) throw new Error("uv download does not match its published checksum");
	// Windows' own tar (bsdtar) reads zip; Git's GNU tar does not.
	run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", zip, "-C", TOOLS_DIR]);
	const uv = join(TOOLS_DIR, "uv.exe");
	console.log(run(uv, ["--version"]).trim());

	// Python: uv installs a python-build-standalone build (and checks its hash) into core/python.
	if (!bundledPython()) {
		run(uv, ["python", "install", PYTHON_VERSION, "--install-dir", PYTHON_DIR, "--no-bin"]);
	}
	const python = bundledPython();
	if (!python) throw new Error(`no Python under ${PYTHON_DIR} after uv python install`);
	console.log(`python: ${python}\n  ${run(python, ["--version"]).trim()}`);
	for (const exe of ["rg.exe", "fd.exe"]) {
		if (!existsSync(join(TOOLS_DIR, exe))) console.log(`note: ${exe} is not in core/bin; the core uses Pi's copy (packaging copies it in)`);
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
