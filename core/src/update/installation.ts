import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { APP_ROOT } from "../paths.ts";
import { CORE_VERSION } from "../core.ts";

export interface BuildInfo { version: string; build: string; platform: string; arch: string; signed: boolean; }
export function buildInfo(appRoot = APP_ROOT): BuildInfo {
  try {
    const data = JSON.parse(readFileSync(join(appRoot, "build-info.json"), "utf8"));
    if (typeof data.version === "string" && typeof data.build === "string") return { ...data, signed: data.signed === true };
  } catch { /* A source checkout has no generated build manifest. */ }
  return { version: CORE_VERSION, build: "development", platform: process.platform, arch: process.arch, signed: false };
}
export function installation(appRoot = APP_ROOT): { root: string; current: string; helper: string } | undefined {
  const current = resolve(appRoot), root = dirname(current), helper = join(current, "app", "dreamflutter_update.exe");
  return existsSync(join(current, "sq.version")) && existsSync(join(root, "Update.exe")) && existsSync(helper) ? { root, current, helper } : undefined;
}
/**
 * Velopack's Setup leaves the whole full package (about as big as the program) in <root>\packages.
 * Our updater keeps its own verified package cache (velopack_helper.cpp sets PackagesDir to it),
 * so that copy is never read again: remove it (0.13.1 step 3). Plain files only, by exact name.
 */
export function dropLeftoverPackages(root: string): number {
  const folder = join(root, "packages");
  let freed = 0;
  let names: string[];
  try { names = readdirSync(folder); } catch { return 0; }
  for (const name of names) {
    if (!/^DreamFlutter-[0-9A-Za-z.+-]+-full\.nupkg$/.test(name)) continue;
    const path = join(folder, name);
    try {
      const entry = lstatSync(path);
      if (!entry.isFile()) continue;
      rmSync(path);
      freed += entry.size;
    } catch { /* in use or gone: try again next start */ }
  }
  return freed;
}
export function piVersion(appRoot = APP_ROOT): string {
  try { return JSON.parse(readFileSync(join(appRoot, "core", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8")).version; } catch { return "unknown"; }
}
