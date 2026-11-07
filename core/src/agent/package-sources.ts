import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import type { SourceChoice, ToolEnvironment } from "./tool-environment.ts";

export const PYTHON_SOURCES = { inherit: null, pypi: "https://pypi.org/simple", tuna: "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple", ustc: "https://mirrors.ustc.edu.cn/pypi/simple" } as const;
export const NPM_SOURCES = { inherit: null, npm: "https://registry.npmjs.org", npmmirror: "https://registry.npmmirror.com" } as const;
export interface PackageSourceSettings { pythonPackageSource: keyof typeof PYTHON_SOURCES; npmPackageSource: keyof typeof NPM_SOURCES; }
export interface ProjectFile { state: "missing" | "file" | "unknown"; text?: string; }
export type ProjectFiles = Record<string, ProjectFile>;
const FILES = ["pyproject.toml", "uv.toml", "pip.conf", "pip.ini", ".npmrc", "uv.lock", "package-lock.json"];
const MAX_CONFIG_BYTES = 64 * 1024;

export function projectPaths(cwd: string, workspace: string, linux = false): string[] {
  const path = linux ? posix : { dirname, join, relative, resolve };
  let current = path.resolve(cwd);
  const root = path.resolve(workspace);
  const rel = path.relative(root, current);
  const inside = rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !/^[A-Za-z]:/.test(rel));
  const paths: string[] = [];
  for (let depth = 0; depth < 32; depth++) {
    paths.push(...FILES.map((file) => path.join(current, file)));
    if (current === root || !inside || path.dirname(current) === current) break;
    current = path.dirname(current);
  }
  return paths;
}

export function hostProjectFiles(paths: string[]): ProjectFiles {
  return Object.fromEntries(paths.map((path) => {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return [path, { state: "unknown" }];
      if (path.endsWith(".lock") || path.endsWith("package-lock.json")) return [path, { state: "file" }];
      return [path, stat.size > MAX_CONFIG_BYTES ? { state: "unknown" } : { state: "file", text: readFileSync(path, "utf8") }];
    } catch (error) { return [path, { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unknown" }]; }
  }));
}

/** Metadata only, as the Linux agent, after SandboxShell.ready has applied its existing network rules. */
export async function sandboxProjectFiles(distro: string, paths: string[]): Promise<ProjectFiles> {
  const script = `import os,sys,json,base64,stat
paths=json.loads(base64.b64decode(sys.argv[1])); result={}
for path in paths:
 try:
  s=os.lstat(path)
  if not stat.S_ISREG(s.st_mode): result[path]={'state':'unknown'}
  elif path.endswith('.lock') or path.endswith('package-lock.json'): result[path]={'state':'file'}
  elif s.st_size>65536: result[path]={'state':'unknown'}
  else:
   with open(path,encoding='utf-8') as f: result[path]={'state':'file','text':f.read()}
 except FileNotFoundError: result[path]={'state':'missing'}
 except Exception: result[path]={'state':'unknown'}
print(json.dumps(result))`;
  return new Promise((done) => execFile("wsl.exe", ["-d", distro, "-u", "agent", "--", "python3", "-c", script, Buffer.from(JSON.stringify(paths)).toString("base64")],
    { windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", env: { ...process.env, WSL_UTF8: "1" } }, (error, stdout) => {
      try { if (error) throw error; done(JSON.parse(stdout)); }
      catch { done(Object.fromEntries(paths.map((path) => [path, { state: "unknown" }]))); }
    }));
}

/** Conservative source detection: never interprets project code or logs configuration contents. */
export function packageEnvironment(settings: PackageSourceSettings, files: ProjectFiles, options: { cwd: string; workspace: string; platform: "host" | "sandbox"; distro?: string; command?: string }): ToolEnvironment {
  const python = settings.pythonPackageSource, npm = settings.npmPackageSource;
  const entries = Object.entries(files);
  const ending = (path: string, file: string) => path.replaceAll("\\", "/").endsWith("/" + file);
  const uvFiles = entries.filter(([p]) => ending(p, "uv.toml") || ending(p, "pyproject.toml"));
  const pipFiles = entries.filter(([p]) => ending(p, "pip.conf") || ending(p, "pip.ini"));
  const npmFiles = entries.filter(([p]) => ending(p, ".npmrc"));
  const unknownUv = uvFiles.some(([, f]) => f.state === "unknown");
  const projectUv = uvFiles.some(([p, f]) => f.state === "file" && (ending(p, "uv.toml") || /\[\[?\s*tool\.uv(?:\.[^\]]*)?\]?/i.test(f.text ?? "") && /(?:index|sources|find-links)/i.test(f.text ?? "")));
  const projectPip = pipFiles.find(([, f]) => f.state === "file");
  const unknownPip = pipFiles.some(([, f]) => f.state === "unknown");
  const unknownNpm = npmFiles.some(([, f]) => f.state === "unknown");
  const projectNpm = npmFiles.some(([, f]) => f.state === "file" && /^(?!\s*[#;])\s*(?:@[^:\s]+:)?registry\s*=/mi.test(f.text ?? ""));
  // If a command changes directory internally, its new project cannot be resolved in advance.
  const changesDirectory = /(?:^|[;|&\n])\s*(?:cd|chdir|pushd|popd|Set-Location|Push-Location|Pop-Location)\b/i.test(options.command ?? "");
  const choice = (preset: string, project: boolean, uncertain: boolean): SourceChoice => preset === "inherit"
    ? { layer: "existing", preset, reason: "inherit" }
    : project ? { layer: "project", preset, reason: "project-config" }
    : uncertain || changesDirectory ? { layer: "existing", preset, reason: "project-uncertain" }
    : { layer: "application", preset, reason: "preset" };
  const uv = choice(python, projectUv, unknownUv), pip = choice(python, !!projectPip, unknownPip), node = choice(npm, projectNpm, unknownNpm);
  const variables: Record<string, string> = {}, unset: string[] = [];
  const uvKeys = ["UV_DEFAULT_INDEX", "UV_INDEX_URL", "UV_INDEX", "UV_EXTRA_INDEX_URL"];
  const pipKeys = ["PIP_INDEX_URL", "PIP_PYPI_URL", "PIP_EXTRA_INDEX_URL"];
  if (uv.layer === "application") { unset.push(...uvKeys); variables.UV_DEFAULT_INDEX = PYTHON_SOURCES[python]!; }
  if (pip.layer === "application") { unset.push(...pipKeys); variables.PIP_INDEX_URL = PYTHON_SOURCES[python]!; }
  if (node.layer === "application") variables.npm_config_registry = NPM_SOURCES[npm]!;
  if (uv.layer === "project") unset.push(...uvKeys);
  if (pip.layer === "project" && projectPip) { unset.push(...pipKeys); variables.PIP_CONFIG_FILE = projectPip[0]; }
  if (node.layer === "project") unset.push("npm_config_registry");
  const snapshot = { at: Date.now(), platform: options.platform, cwd: options.cwd, workspace: options.workspace, distro: options.distro, uv, pip, npm: node,
    locks: { uv: entries.some(([p, f]) => ending(p, "uv.lock") && f.state !== "missing"), npm: entries.some(([p, f]) => ending(p, "package-lock.json") && f.state !== "missing") } };
  // The child needs rebuilding only when its effective environment/settings change.
  // Inherit + cd must retain ordinary persistent-shell variables and functions.
  const fingerprint = createHash("sha256").update(JSON.stringify({ settings, variables, unset })).digest("hex");
  return { variables, unset, fingerprint, snapshot };
}
