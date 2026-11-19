import { realpathSync } from "node:fs";
import { realpath, lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type PathDecision = "allow" | "confirm" | "deny";
export interface PathRoots { home: string; localAppData: string; appData: string; secrets: string; }
export interface PathReading { path: string; decision: PathDecision; reason: string; }

export function pathKey(path: string): string {
	return path.replace(/^\\\\\?\\UNC\\/i, "//").replace(/^\\\\\?\\/, "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function canonicalRootSync(path: string): string {
	if (!path || !isAbsolute(path)) return path || "";
	if (process.platform === "win32" && path.startsWith("/")) return path;
	let current = path;
	const suffix: string[] = [];
	for (;;) {
		try {
			return join(realpathSync(current), ...suffix.reverse());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return path;
			const parent = dirname(current);
			if (parent === current) return path;
			suffix.push(basename(current));
			current = parent;
		}
	}
}

function rootKeys(path: string): string[] {
	const out = new Set<string>();
	for (const candidate of [path, canonicalRootSync(path)]) {
		const k = pathKey(candidate);
		if (k) out.add(k);
	}
	return [...out];
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
	const homes = rootKeys(roots.home);
	const locals = rootKeys(roots.localAppData);
	const roamings = rootKeys(roots.appData);
	const secrets = rootKeys(roots.secrets);
	const parts = key.split("/");
	const file = (parts.at(-1) ?? "").split(":")[0]!.replace(/[. ]+$/, "");
	const fileKey = [...parts.slice(0, -1), file].join("/");
	const denied = [
		...secrets,
		...locals.flatMap((local) => [
			`${local}/google/chrome/user data`,
			`${local}/microsoft/edge/user data`,
			`${local}/mozilla/firefox`,
			`${local}/microsoft/credentials`,
			`${local}/microsoft/vault`,
		]),
		...roamings.flatMap((roaming) => [
			`${roaming}/mozilla/firefox`,
			`${roaming}/microsoft/credentials`,
			`${roaming}/microsoft/vault`,
		]),
		...homes.flatMap((home) => [
			`${home}/library/keychains`,
			`${home}/library/application support/google/chrome`,
			`${home}/library/application support/microsoft edge`,
			`${home}/library/application support/firefox`,
			`${home}/library/safari`,
			`${home}/library/cookies`,
			`${home}/library/mail`,
			`${home}/library/messages`,
		]),
	];
	if (denied.some((root) => root && within(key, root))) return { path, decision: "deny", reason: "凭据或浏览器用户数据目录" };
	if (homes.some((home) => within(key, `${home}/.ssh`)) && /^id_/.test(file) && !file.endsWith(".pub")) return { path, decision: "deny", reason: "SSH 私钥" };
	if ((file === ".env" || file.startsWith(".env.")) && ![".env.example", ".env.sample", ".env.template"].includes(file)) {
		return { path, decision: "deny", reason: "环境凭据文件" };
	}
	const confirmRoots = [
		...homes.flatMap((home) => [`${home}/.aws`, `${home}/.kube`, `${home}/.config/gcloud`]),
		...roamings.map((roaming) => `${roaming}/gcloud`),
	];
	const confirmFiles = homes.flatMap((home) => [`${home}/.ssh/config`, `${home}/.ssh/known_hosts`]);
	if (confirmRoots.some((root) => within(key, root)) || confirmFiles.includes(fileKey) || [".git-credentials", ".npmrc", ".pypirc"].includes(file)) {
		return { path, decision: "confirm", reason: "可能包含凭据的配置" };
	}
	return { path, decision: "allow", reason: "普通路径" };
}
