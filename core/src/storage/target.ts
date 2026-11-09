import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { RpcError } from "../core.ts";

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
export function localDatabaseTarget(target: string, driveType = windowsDriveType, platform: NodeJS.Platform = process.platform): string {
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
