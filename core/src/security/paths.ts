import { realpath, lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export type PathDecision = "allow" | "confirm" | "deny";
export interface PathRoots { home: string; localAppData: string; appData: string; secrets: string; }
export interface PathReading { path: string; decision: PathDecision; reason: string; }

export function pathKey(path: string): string {
	return path.replace(/^\\\\\?\\UNC\\/i, "//").replace(/^\\\\\?\\/, "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

/** Resolve links even for a not-yet-created descendant. Permission failures are not ignored. */
export async function canonicalPath(path: string, cwd: string): Promise<string> {
	const absolute = resolve(cwd, path);
	let current = absolute;
	const suffix: string[] = [];
	for (;;) {
		try { return join(await realpath(current), ...suffix.reverse()); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			// A broken symlink must not become a lexically permitted path.
			try { if ((await lstat(current)).isSymbolicLink()) throw new Error("不能解析符号链接目标"); }
			catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ENOENT") throw probe; }
			const parent = dirname(current);
			if (parent === current) throw error;
			suffix.push(basename(current)); current = parent;
		}
	}
}

function within(path: string, root: string): boolean { return path === root || path.startsWith(`${root}/`); }

/** Only classification: never opens a sensitive file's contents. */
export function classifyPath(path: string, roots: PathRoots): PathReading {
	const key = pathKey(path);
	const home = pathKey(roots.home), local = pathKey(roots.localAppData), roaming = pathKey(roots.appData);
	const parts = key.split("/");
	const file = (parts.at(-1) ?? "").split(":")[0]!.replace(/[. ]+$/, "");
	const fileKey = [...parts.slice(0, -1), file].join("/");
	const denied = [pathKey(roots.secrets), `${local}/google/chrome/user data`, `${local}/microsoft/edge/user data`,
		`${roaming}/mozilla/firefox`, `${local}/mozilla/firefox`, `${local}/microsoft/credentials`,
		`${roaming}/microsoft/credentials`, `${local}/microsoft/vault`, `${roaming}/microsoft/vault`];
	if (denied.some((root) => root && within(key, root))) return { path, decision: "deny", reason: "凭据或浏览器用户数据目录" };
	if (within(key, `${home}/.ssh`) && /^id_/.test(file) && !file.endsWith(".pub")) return { path, decision: "deny", reason: "SSH 私钥" };
	if ((file === ".env" || file.startsWith(".env.")) && ![".env.example", ".env.sample", ".env.template"].includes(file)) {
		return { path, decision: "deny", reason: "环境凭据文件" };
	}
	if ([`${home}/.aws`, `${home}/.kube`, `${roaming}/gcloud`, `${home}/.config/gcloud`].some((root) => within(key, root)) ||
		[`${home}/.ssh/config`, `${home}/.ssh/known_hosts`].includes(fileKey) || [".git-credentials", ".npmrc", ".pypirc"].includes(file)) {
		return { path, decision: "confirm", reason: "可能包含凭据的配置" };
	}
	return { path, decision: "allow", reason: "普通路径" };
}
