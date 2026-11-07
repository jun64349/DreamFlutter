import { AsyncLocalStorage } from "node:async_hooks";

export type SourceLayer = "existing" | "project" | "application";
export interface SourceChoice { layer: SourceLayer; preset: string; reason: string; }
export interface SourceSnapshot {
  at: number; platform: "host" | "sandbox"; cwd: string; workspace: string; distro?: string;
  uv: SourceChoice; pip: SourceChoice; npm: SourceChoice;
  locks: { uv: boolean; npm: boolean };
}
export interface ToolEnvironment {
  variables: Record<string, string>; unset: string[]; fingerprint: string; snapshot: SourceSnapshot;
}
export interface ToolEnvironmentProvider {
  host(cwd: string, workspace: string, command?: string): ToolEnvironment;
  sandbox(distro: string, cwd: string, workspace: string, command?: string): Promise<ToolEnvironment>;
}
export interface ToolEnvironmentScope { provider: ToolEnvironmentProvider; workspace: string; }
const scope = new AsyncLocalStorage<ToolEnvironmentScope>();
export const currentToolEnvironment = () => scope.getStore();
export function withToolEnvironment<T>(context: ToolEnvironmentScope, action: () => T): T { return scope.run(context, action); }

/** Only child-process settings. Windows keys must be replaced case-insensitively. */
export function applyToolEnvironment(base: NodeJS.ProcessEnv, result?: ToolEnvironment): NodeJS.ProcessEnv {
  const env = { ...base };
  if (!result) return env;
  const replaced = new Set([...result.unset, ...Object.keys(result.variables)].map((key) => key.toLowerCase()));
  for (const key of Object.keys(env)) if (replaced.has(key.toLowerCase())) delete env[key];
  Object.assign(env, result.variables);
  return env;
}
