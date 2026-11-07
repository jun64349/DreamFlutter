import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { writeArchive } from "../backup/archive.ts";
import type { Core } from "../core.ts";
import { redact } from "../security/redaction.ts";
import { buildInfo, piVersion } from "./installation.ts";

export async function exportDiagnostics(core: Core, appRoot: string): Promise<{ path: string; files: number }> {
  const output = join(core.paths.dataDir, "updates", "diagnostics"); mkdirSync(output, { recursive: true });
  const path = join(output, `DreamFlutter-diagnostics-${Date.now()}.zip`);
  const encode = (value: unknown) => Buffer.from(redact(typeof value === "string" ? value : JSON.stringify(value, null, 2), true));
  const buffers = [{ name: "summary.json", data: encode({ exportedAt: new Date().toISOString(), application: buildInfo(appRoot), core: (await core.call("core.hello", {} ) as any).version, pi: piVersion(appRoot), platform: process.platform, arch: process.arch, node: process.version, settings: core.settings.get() }) }];
  const directory = join(core.paths.logFile, "..");
  const logs = existsSync(directory) ? readdirSync(directory).filter((name) => /^core\.log(?:\.\d+)?$/.test(name)).sort().slice(0, 3) : [];
  for (const name of logs) {
    const file = join(directory, name), size = statSync(file).size;
    if (size > 8 * 1024 * 1024) { buffers.push({ name: `logs/${name}.txt`, data: encode("日志超过8MiB；请在应用中查看原日志。") }); continue; }
    buffers.push({ name: `logs/${name}`, data: encode(readFileSync(file, "utf8")) });
  }
  await writeArchive(path, [], buffers); return { path, files: buffers.length };
}
export function licenseManifest(appRoot: string): { generated: boolean; entries: unknown[] } {
  try {
    const data = JSON.parse(readFileSync(join(appRoot, "licenses", "third-party.json"), "utf8"));
    if (Array.isArray(data.entries)) return { generated: true, entries: data.entries };
  } catch { /* Development builds do not ship the generated package manifest. */ }
  return { generated: false, entries: [] };
}
export function licenseText(appRoot: string, id: string): { text: string } {
  const entry = licenseManifest(appRoot).entries.find((item: any) => item.id === id) as { path?: string; notice?: string } | undefined;
  if (!entry?.path) return { text: entry?.notice ?? "此条目没有单独的许可证文本。" };
  const root = realpathSync(join(appRoot, "licenses")), path = realpathSync(resolve(appRoot, entry.path));
  if (!path.toLowerCase().startsWith((root + sep).toLowerCase()) || statSync(path).size > 16 * 1024 * 1024) throw Error("Invalid bundled license path");
  return { text: readFileSync(path, "utf8") };
}
