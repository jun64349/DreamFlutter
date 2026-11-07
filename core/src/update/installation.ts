import { existsSync, readFileSync } from "node:fs";
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
export function piVersion(appRoot = APP_ROOT): string {
  try { return JSON.parse(readFileSync(join(appRoot, "core", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8")).version; } catch { return "unknown"; }
}
