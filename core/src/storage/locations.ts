import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const STORAGE_KINDS = ["database", "configuration", "secrets", "logs", "sessions", "skills", "templates", "cards", "cache", "sandbox"] as const;
export type StorageKind = typeof STORAGE_KINDS[number];
export type StorageLocations = Record<StorageKind, string>;
export interface LocationConfig { version: 1; layout?: "three-layer"; paths: Partial<StorageLocations>; }
export const locationFile = (root: string) => join(root, "storage-locations.json");

export function atomicJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
}

export function readLocationConfig(root: string): LocationConfig | undefined {
  if (!existsSync(locationFile(root))) return undefined;
  const config = JSON.parse(readFileSync(locationFile(root), "utf8")) as LocationConfig;
  if (config.version !== 1 || !config.paths || typeof config.paths !== "object" || Array.isArray(config.paths)) throw new Error("数据位置配置无效，请恢复 storage-locations.json 后重试");
  for (const [key, value] of Object.entries(config.paths)) if (!STORAGE_KINDS.includes(key as StorageKind) || typeof value !== "string" || !isAbsolute(value)) throw new Error("数据位置配置需要已知类别和绝对路径");
  return config;
}

/** Reading never rearranges an existing installation. Explicit CLI directories remain the fallback. */
export function storageLocations(root: string, agentDir?: string, sessionsDir?: string): StorageLocations {
  const agent = agentDir ?? join(root, "pi");
  const paths = { database: root, configuration: agent, secrets: join(root, "secrets"), logs: root,
    sessions: join(agent, "sessions"), skills: join(agent, "skills"), templates: join(agent, "prompts"),
    cards: join(root, "cards"), cache: join(root, "cache"), sandbox: join(root, "sandbox"), ...readLocationConfig(root)?.paths };
  if (agentDir) paths.configuration = agentDir;
  if (sessionsDir) paths.sessions = sessionsDir;
  return paths;
}

/** Only a genuinely new normal startup gets the three-layer defaults. */
export function initializeLocations(root: string): void {
  if (readLocationConfig(root) || ["core.db", "pi", "cards", "butterfly", "sandbox"].some((name) => existsSync(join(root, name)))) return;
  const application = join(resolve(root), "application-data");
  const content = join(resolve(root), "user-content");
  atomicJson(locationFile(root), { version: 1, layout: "three-layer", paths: {
    database: join(application, "database"), configuration: join(application, "pi"), secrets: join(application, "secrets"),
    logs: join(application, "logs"), sessions: join(content, "sessions"), skills: join(content, "skills"),
    templates: join(content, "templates"), cards: join(content, "cards"), cache: join(resolve(root), "cache"), sandbox: join(application, "sandbox"),
  } } satisfies LocationConfig);
}

export function materialLocation(root: string): string {
  return readLocationConfig(root)?.layout === "three-layer" ? join(root, "user-content", "butterfly") : join(root, "butterfly");
}

/** Pi's public resource paths keep relocated skills/prompts visible without editing its runtime. */
export function configureResourcePaths(root: string, agentDir: string, sessionsDir?: string): void {
  if (!readLocationConfig(root)) return;
  const paths = storageLocations(root, agentDir, sessionsDir);
  const file = join(agentDir, "settings.json");
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> : {};
  let changed = false;
  for (const [key, path] of [["skills", paths.skills], ["prompts", paths.templates]] as const) {
    const entries = settings[key] ?? [];
    if (!Array.isArray(entries)) throw new Error(`Pi ${key} 路径配置无效`);
    if (!entries.includes(path)) { settings[key] = [...entries, path]; changed = true; }
  }
  if (changed) atomicJson(file, settings);
}
