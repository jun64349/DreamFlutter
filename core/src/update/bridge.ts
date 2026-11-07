import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UpdateError, type ReleaseAsset } from "./release.ts";

export function bridgeCall(helper: string, args: string[], timeout = 30_000): Promise<string> {
  return new Promise((done, reject) => execFile(helper, args, { windowsHide: true, timeout, maxBuffer: 128 * 1024, encoding: "utf8" }, (error, stdout) => {
    if (error) reject(new UpdateError("updater_failed", "Velopack 更新步骤失败，已保留备份和阶段记录。")); else done(stdout.trim());
  }));
}
export async function makeFeed(directory: string, path: string, asset: ReleaseAsset, version: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await cp(path, join(directory, asset.name));
  const legacyHash = createHash("sha1"); for await (const chunk of createReadStream(path)) legacyHash.update(chunk);
  await writeFile(join(directory, "releases.win-x64.json"), JSON.stringify({ Assets: [{ PackageId: "DreamFlutter", Version: version, Type: "Full", FileName: asset.name, SHA1: legacyHash.digest("hex").toUpperCase(), SHA256: asset.sha256.toUpperCase(), Size: asset.size }] }), { mode: 0o600 });
}
export async function prepareGuardian(appRoot: string, guardDir: string): Promise<{ node: string; script: string; helper: string }> {
  await mkdir(join(guardDir, "node_modules"), { recursive: true });
  // All executable bytes originate in the currently installed, already-running application.
  // Only Velopack performs application replacement; these are out-of-tree process supervisors.
  const node = join(guardDir, "node.exe"), helper = join(guardDir, "dreamflutter_update.exe"), script = join(guardDir, "guardian.mjs");
  await cp(process.execPath, node);
  for (const name of ["dreamflutter_update.exe", "velopack_libc.dll", "msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"]) {
    const source = join(appRoot, "app", name); if (existsSync(source)) await cp(source, join(guardDir, name));
  }
  await cp(join(appRoot, "core", "node_modules", "ws"), join(guardDir, "node_modules", "ws"), { recursive: true });
  await cp(join(dirname(fileURLToPath(import.meta.url)), "guardian.mjs"), script);
  return { node, script, helper };
}
export function launchGuardian(node: string, script: string, config: string): number {
  const child = spawn(node, [script, config], { detached: true, windowsHide: true, stdio: "ignore", env: process.env });
  child.unref(); if (!child.pid) throw new UpdateError("updater_failed", "无法启动更新守护进程。"); return child.pid;
}
