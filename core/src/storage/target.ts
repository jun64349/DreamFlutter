import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { RpcError } from "../core.ts";

export interface DarwinVolumeInfo {
	fsType: string;
	local: boolean;
}

const DARWIN_REMOTE_FS = new Set(["smbfs", "afpfs", "nfs", "webdav", "ftp", "osxfuse", "macfuse", "fuse", "fusefs", "autofs", "cddafs", "lofs"]);

export function parseDarwinMountOutput(mountOutput: string, path: string): DarwinVolumeInfo | undefined {
	const normalized = path.replaceAll("\\", "/");
	let bestMount = "";
	let bestInfo: DarwinVolumeInfo | undefined;
	for (const line of mountOutput.split(/\r?\n/)) {
		const match = /^(.+?)\s+on\s+(\/.*)\s+\(([^)]+)\)$/.exec(line.trim());
		if (!match) continue;
		const device = match[1]!.trim();
		const mountPoint = match[2]!.trim().replace(/\/+$/, "") || "/";
		const within = mountPoint === "/" ? normalized.startsWith("/") : normalized === mountPoint || normalized.startsWith(`${mountPoint}/`);
		if (!within || mountPoint.length < bestMount.length) continue;
		const flags = match[3]!.split(",").map((s) => s.trim().toLowerCase());
		const fsType = flags[0] ?? "";
		const remoteDevice = device.startsWith("//") || /^[a-z0-9._-]+:/i.test(device);
		const local = flags.includes("local") && !DARWIN_REMOTE_FS.has(fsType) && !remoteDevice;
		bestMount = mountPoint;
		bestInfo = { fsType, local };
	}
	return bestInfo;
}

function existingAncestor(target: string): string {
	let current = target;
	for (;;) {
		if (existsSync(current)) return realpathSync(current);
		const parent = dirname(current);
		if (parent === current) return current;
		current = parent;
	}
}

function defaultDarwinVolume(target: string): DarwinVolumeInfo {
	const probePath = existingAncestor(target);
	const output = execFileSync("/sbin/mount", [], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
	const info = parseDarwinMountOutput(output, probePath);
	if (!info) throw new Error("volume not found in mount output");
	return info;
}

/** DriveInfo uses Windows GetDriveType, so mapped shares are remote even when written as Z:\. */
function windowsDriveType(root: string): number {
  if (!/^[A-Za-z]:\\$/.test(root)) throw new Error("invalid drive root");
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // Only a validated drive letter enters this fixed command, never the user-supplied path.
  const output = execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop'; [int]([System.IO.DriveInfo]::new('${root}').DriveType)`],
    { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (!/^[0-6]$/.test(output)) throw new Error("invalid drive type");
  return Number(output);
}

/** Database/WAL needs a local volume. Check before any exists/realpath calls can open a UNC share. */
export function localDatabaseTarget(
  target: string,
  driveType = windowsDriveType,
  platform: NodeJS.Platform = process.platform,
  darwinVolume: (target: string) => DarwinVolumeInfo = defaultDarwinVolume,
): string {
  if (platform === "darwin") {
    if (!target.startsWith("/")) {
      throw new RpcError("bad_request", "请选择完整的本地绝对目录，例如 /Users/yourname/DreamFlutterData/database");
    }
    let volume: DarwinVolumeInfo;
    try { volume = darwinVolume(target); }
    catch { throw new RpcError("bad_request", "无法确认数据库目标为本地磁盘，未执行搬迁，请检查磁盘是否可用"); }
    if (!volume.local || DARWIN_REMOTE_FS.has(volume.fsType.toLowerCase())) {
      throw new RpcError("bad_request", "数据库位置不支持网络挂载或远程卷，请选择本地磁盘上的新目录");
    }
    return target;
  }
  if (platform !== "win32") return target;
  const path = target.replaceAll("/", "\\");
  const local = /^(?:\\\\\?\\)?([A-Za-z]:\\)/.exec(path);
  if (path.startsWith("\\\\") && !local) {
    throw new RpcError("bad_request", "数据库位置不支持网络路径，请选择本地磁盘上的新目录");
  }
  // A root-relative path (\new-db) could inherit a mapped current drive; require its volume explicitly.
  if (!local) throw new RpcError("bad_request", "请选择完整的本地绝对目录，例如 C:\\data\\database");
  let type: number;
  try { type = driveType(local[1]!); }
  catch { throw new RpcError("bad_request", "无法确认数据库目标为本地磁盘，未执行搬迁，请检查磁盘是否可用"); }
  if (type === 4) throw new RpcError("bad_request", "数据库位置不支持映射的网络盘，请选择本地磁盘上的新目录");
  if (!Number.isInteger(type) || type < 2 || type > 6) {
    throw new RpcError("bad_request", "无法确认数据库目标为本地磁盘，未执行搬迁，请检查磁盘是否可用");
  }
  // Compare realpath and persist one canonical spelling; \\?\C:\ must not look like a junction/UNC.
  return path.startsWith("\\\\?\\") ? path.slice(4) : target;
}
