import { execFile, spawn } from "node:child_process";
import { appendFileSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import WebSocket from "ws";
import { pidAlive } from "../instance.ts";
import { runWsl } from "../sandbox/sandbox.ts";
import { quarantine, type UninstallDeps } from "./cleanup.ts";
import { safePath, systemProtectedPaths } from "./plan.ts";

const exec = promisify(execFile);
const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");

export async function stopCore(dataDir: string): Promise<void> {
	const file = join(dataDir, "core.lock");
	safePath(file);
	if (!lstatSync(file, { throwIfNoEntry: false })) return;
	const pid = Number(readFileSync(file, "utf8").trim());
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid_lock");
	if (!pidAlive(pid)) return;
	const infoFile = join(dataDir, "core.json");
	safePath(infoFile);
	const info = JSON.parse(readFileSync(infoFile, "utf8"));
	if (info.pid !== pid || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535 ||
		typeof info.token !== "string" || !/^[a-f0-9]{64}$/i.test(info.token)) throw new Error("unverified_core");
	const socket = new WebSocket(`ws://127.0.0.1:${info.port}`, {
		headers: { Authorization: `Bearer ${info.token}` }, handshakeTimeout: 1000, maxPayload: 4096,
	});
	socket.on("error", () => {});
	socket.once("open", () => socket.send(JSON.stringify({ id: 1, method: "core.shutdown", params: {} }), () => {}));
	try {
		for (let i = 0; i < 30; i++) {
			if (!pidAlive(pid) || !lstatSync(file, { throwIfNoEntry: false })) return;
			await delay(100);
		}
		throw new Error("core_still_running");
	} finally { socket.terminate(); }
}

export async function registeredDisk(distro: string): Promise<string | undefined> {
	const key = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss";
	const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if (!(Test-Path -LiteralPath '${key}')) { exit 0 }
$entry = @(Get-ChildItem -LiteralPath '${key}' | ForEach-Object {
    Get-ItemProperty -LiteralPath $_.PSPath
} | Where-Object { $_.DistributionName -eq $env:DF_UNINSTALL_DISTRO })
if ($entry.Count -eq 0) { exit 0 }
if ($entry.Count -ne 1 -or !$entry[0].BasePath -or $entry[0].Version -ne 2) { exit 2 }
$name = if ($entry[0].VhdFileName) { $entry[0].VhdFileName } else { 'ext4.vhdx' }
if ($name -notmatch '^[a-zA-Z0-9._-]+\\.vhdx$') { exit 2 }
[Console]::Write(($entry[0].BasePath.TrimEnd('\\') + '\\' + $name))
`;
	const { stdout } = await exec(ps, ["-NoProfile", "-NonInteractive", "-Command", script],
		{ windowsHide: true, timeout: 2500, env: { ...process.env, DF_UNINSTALL_DISTRO: distro } });
	const path = stdout.trim().replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, "");
	return path || undefined;
}

export function windowsDependencies(root: string, legacy: UninstallDeps["legacy"], logPath: string, waitForCleanup = false) {
	const pending: { path: string; directory: string }[] = [];
	const deps: UninstallDeps = {
		legacy, stopCore, registeredDisk, wsl: runWsl,
		protectedPaths: systemProtectedPaths(),
		async remove(path, tree) {
			if (!tree) { await rm(path, { force: true }); return; }
			const moved = quarantine(path, tree, root);
			if (!moved) return;
			pending.push(moved);
			appendFileSync(logPath, JSON.stringify({
				at: new Date().toISOString(), step: "bulk.queue", status: "scheduled", path: moved.path,
			}) + "\n");
			return "scheduled";
		},
	};
	const finish = async () => {
		if (!pending.length) return;
		// Absolute paths travel in a private queue file, never via shell interpolation.
		const script = `
$ErrorActionPreference = 'Stop'
$data = [IO.File]::ReadAllText($env:DF_UNINSTALL_QUEUE) | ConvertFrom-Json
function Remove-Tree([string] $path) {
  $target = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  if (!$target) { return }
  if ($target.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    if ($target.PSIsContainer) { [IO.Directory]::Delete($path) }
    else { [IO.File]::Delete($path) }
  } elseif ($target.PSIsContainer) {
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($path)) { Remove-Tree $entry }
    [IO.Directory]::Delete($path)
  } else {
    Remove-Item -LiteralPath $path -Force
  }
}
foreach ($item in $data.targets) {
  $status = 'remaining'
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      $parent = Get-Item -LiteralPath $item.directory -Force
      if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'linked_quarantine' }
      Remove-Tree $item.path
      [IO.Directory]::Delete($item.directory)
      $status = 'ok'
      break
    } catch { Start-Sleep -Milliseconds 500 }
  }
  $line = @{at=[DateTime]::UtcNow.ToString('o');step='bulk.remove';status=$status;path=$item.path} | ConvertTo-Json -Compress
  [IO.File]::AppendAllText($data.log, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}
[IO.File]::Delete($env:DF_UNINSTALL_QUEUE)
`;
		const code = Buffer.from(script, "utf16le").toString("base64");
		const queue = join(dirname(logPath), "bulk.json");
		writeFileSync(queue, JSON.stringify({ log: logPath, targets: pending }), { flag: "wx", mode: 0o600 });
		const options = { windowsHide: true, cwd: dirname(logPath), env: { ...process.env, DF_UNINSTALL_QUEUE: queue } };
		const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", code];
		// Let small cleanups finish in the hook. Large trees can continue outside the
		// install directory, and their queued paths are already in the persistent log.
		const child = spawn(ps, args, { ...options, stdio: "ignore" });
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("spawn", resolve);
		});
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				child.unref();
				if (waitForCleanup) reject(new Error("bulk_cleanup_timeout"));
				else resolve();
			}, waitForCleanup ? 15_000 : 1600);
			child.once("exit", code => {
				clearTimeout(timer);
				if (code === 0) resolve();
				else reject(new Error("bulk_cleanup_failed"));
			});
		});
	};
	return { deps, finish };
}

