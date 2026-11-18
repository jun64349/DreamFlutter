import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadVerified, type Fetch } from "../net/resumable.ts";

/**
 * One-click WSL for 蝶君's sandbox (route step 4, user 2026-11-18): when the computer has no
 * WSL, setting the sandbox up installs it — Windows asks the user for administrator approval —
 * first with Windows' own `wsl --install --no-distribution`, and if that fails with the official
 * MSI from Microsoft's WSL releases on GitHub (hash and Microsoft signature checked). Most
 * computers then need a restart; the app opens itself after it and carries on (sandbox.ts).
 */

export type InstallOutcome = "ready" | "restart";

/** Exit code PowerShell's Start-Process -Verb RunAs reports when the user declines the prompt. */
export const DECLINED = 1223;

export class WslInstallError extends Error {
	readonly code: "declined" | "no_virtualization" | "failed";
	constructor(code: WslInstallError["code"], message: string) { super(message); this.code = code; }
}

export interface WslInstallDeps {
	/** Runs a PowerShell script as administrator (one UAC prompt); its exit code, or DECLINED. */
	elevate(script: string): Promise<number>;
	/** Runs a PowerShell command as the user; its standard output. */
	powershell(command: string): Promise<string>;
	wslAvailable(): Promise<boolean>;
	fetchImpl?: Fetch;
	/** Folder for the downloaded MSI (deleted afterwards). */
	workDir?: string;
	onStep?(step: string, progress?: number | null): void;
}

const VIRTUALIZATION_OFF = "这台电脑没有开启硬件虚拟化，WSL 用不了。请重启电脑进入 BIOS / UEFI 设置，打开 Intel VT-x（或 AMD SVM / AMD-V），保存后再回来点「建立沙箱」。";
const DECLINED_MESSAGE = "需要你在 Windows 的管理员确认里点「是」才能安装 WSL。再点一次「建立沙箱」重试。";

/** Whether the processor's virtualization is on (or a hypervisor already runs, which hides that flag). */
export async function virtualizationOn(powershell: WslInstallDeps["powershell"]): Promise<boolean | undefined> {
	try {
		const out = (await powershell("$s=(Get-CimInstance Win32_ComputerSystem).HypervisorPresent; $f=@(Get-CimInstance Win32_Processor)[0].VirtualizationFirmwareEnabled; \"$s,$f\"")).trim().toLowerCase();
		const [hypervisor, firmware] = out.split(",");
		if (hypervisor === "true" || firmware === "true") return true;
		if (hypervisor === "false" && firmware === "false") return false;
	} catch { /* unknown: let the installer try */ }
	return undefined;
}

export async function installWsl(deps: WslInstallDeps): Promise<InstallOutcome> {
	const step = deps.onStep ?? (() => {});
	step("检查这台电脑能不能用 WSL");
	if (await virtualizationOn(deps.powershell) === false) throw new WslInstallError("no_virtualization", VIRTUALIZATION_OFF);

	step("安装 WSL（请在弹出的管理员确认里点「是」）");
	const inbox = await deps.elevate("& wsl.exe --install --no-distribution; exit $LASTEXITCODE");
	if (inbox === DECLINED) throw new WslInstallError("declined", DECLINED_MESSAGE);
	if (inbox === 0) return (await deps.wslAvailable()) ? "ready" : "restart";

	// Windows' own installer failed (older builds, store blocked, REGDB_E_CLASSNOTREG): the official MSI.
	const msi = await downloadMsi(deps, step);
	try {
		step("安装 WSL 官方安装包（请在弹出的管理员确认里点「是」）");
		const code = await deps.elevate([
			`$m = '${msi.replaceAll("'", "''")}'`,
			// Checked again as administrator: only a Microsoft-signed package is installed.
			"$sig = Get-AuthenticodeSignature -LiteralPath $m",
			"if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { exit 2 }",
			"$p = Start-Process msiexec.exe -ArgumentList '/i', ('\"' + $m + '\"'), '/qb', '/norestart' -Wait -PassThru",
			"if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { exit $p.ExitCode }",
			// The MSI brings WSL itself; the Virtual Machine Platform feature still has to be on.
			"& dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart | Out-Null",
			"if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010) { exit $LASTEXITCODE }",
			"exit 0",
		].join("\n"));
		if (code === DECLINED) throw new WslInstallError("declined", DECLINED_MESSAGE);
		if (code !== 0) throw new WslInstallError("failed", `WSL 没有装上（系统自带的安装返回 ${inbox}，官方安装包返回 ${code}）。可以到 github.com/microsoft/WSL/releases 下载 x64 的 .msi 手动安装，装好后再点「建立沙箱」。`);
	} finally {
		rmSync(msi, { force: true });
	}
	return (await deps.wslAvailable()) ? "ready" : "restart";
}

async function downloadMsi(deps: WslInstallDeps, step: (s: string, p?: number | null) => void): Promise<string> {
	step("查找 WSL 官方安装包");
	const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
	let asset: { name: string; size: number; browser_download_url: string; digest?: string } | undefined;
	try {
		const response = await fetchImpl("https://api.github.com/repos/microsoft/WSL/releases/latest", { headers: { "User-Agent": "DreamFlutter", Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const release = await response.json() as { assets?: typeof asset[] };
		asset = (release.assets ?? []).find(a => a && /^wsl\.[\d.]+\.x64\.msi$/i.test(a.name));
	} catch (error) {
		throw new WslInstallError("failed", `系统自带的 WSL 安装没有成功，也连不上 WSL 的官方发布页（${error instanceof Error ? error.message : String(error)}）。请检查网络后再试。`);
	}
	const sha256 = /^sha256:([a-f\d]{64})$/i.exec(asset?.digest ?? "")?.[1]?.toLowerCase();
	if (!asset || !sha256) throw new WslInstallError("failed", "系统自带的 WSL 安装没有成功，官方发布页上也没找到可校验的 x64 安装包。");
	const folder = deps.workDir ?? mkdtempSync(join(tmpdir(), "dreamflutter-wsl-"));
	const path = join(folder, asset.name);
	const mb = (n: number) => Math.round(n / 1_048_576);
	await downloadVerified({ bytes: asset.size, sha256, sources: [asset.browser_download_url] }, path, {
		fetchImpl: deps.fetchImpl,
		onProgress: (received, total) => step(`下载 WSL 官方安装包（${mb(received)} / ${mb(total)} MB）`, received / total),
	}).catch((error) => { throw new WslInstallError("failed", `WSL 官方安装包没有下载成功（${error instanceof Error ? error.message : String(error)}）。请检查网络后再试。`); });
	return path;
}

/** The real runners: PowerShell as the user, and as administrator through one UAC prompt. */
export function windowsDeps(): Pick<WslInstallDeps, "elevate" | "powershell"> {
	const run = (args: string[]) => new Promise<{ code: number | null; out: string }>((resolve) => {
		const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], { windowsHide: true });
		let out = "";
		child.stdout.on("data", (c: Buffer) => { out += c.toString("utf8"); });
		child.on("error", () => resolve({ code: null, out }));
		child.on("close", (code) => resolve({ code, out }));
	});
	return {
		async powershell(command) { return (await run(["-Command", command])).out; },
		async elevate(script) {
			const folder = mkdtempSync(join(tmpdir(), "dreamflutter-elevated-"));
			const file = join(folder, "run.ps1");
			// UTF-8 with BOM so Windows PowerShell 5.1 reads any non-ASCII path correctly.
			writeFileSync(file, "﻿" + script, "utf8");
			try {
				const launcher = [
					`try { $p = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','"${file.replaceAll("'", "''")}"'; exit $p.ExitCode }`,
					`catch { exit ${DECLINED} }`,
				].join("\n");
				const { code } = await run(["-Command", launcher]);
				return code ?? 1;
			} finally {
				try { readFileSync(file); rmSync(folder, { recursive: true, force: true }); } catch { /* gone */ }
			}
		},
	};
}
