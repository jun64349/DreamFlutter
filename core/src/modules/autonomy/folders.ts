import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, opendir, realpath } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import type { Core } from "../../core.ts";
import { sandboxEnv } from "../../agent/state.ts";
import { canonicalPath, pathKey } from "../../security/paths.ts";
import { hostKey, inside } from "./rules.ts";

export const FOLDER_POLL_MS = 30_000;
export interface FolderFile { folder: string; path: string; size: number; mtime: number }

export function stableId(...fields: (string | number)[]): string {
	return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

export async function scanFolder(folder: string, found: (file: FolderFile) => void, live: () => boolean): Promise<void> {
	if (pathKey(await realpath(folder)) !== hostKey(folder)) throw new Error("Folder path redirected");
	for await (const entry of await opendir(folder)) {
		if (!live()) break;
		if (!entry.isFile() || /[\\/:\x00-\x1f]/.test(entry.name)) continue;
		const path = join(folder, entry.name);
		const info = await lstat(path).catch(() => null);
		if (info?.isFile() && info.nlink === 1) found({ folder, path, size: info.size, mtime: info.mtimeMs });
	}
}

export function inboxPath(id: string, file: FolderFile): string {
	return posix.join("/workspace/inbox/autonomy", id, basename(file.path));
}

export async function localSandboxPath(core: Core, path: string): Promise<string> {
	const provider = core.sandboxProvider?.();
	if (!provider || !inside(path, "/workspace")) throw new Error("蝶君的沙箱或交付路径不可用");
	const env = sandboxEnv(provider.distro);
	const root = await realpath(env.local("/workspace"));
	const local = env.local(path);
	const canonical = await canonicalPath(local, root);
	const expected = join(root, ...path.slice("/workspace".length).split("/").filter(Boolean));
	if (pathKey(canonical) !== pathKey(expected)) throw new Error("沙箱路径发生重定向");
	return local;
}

export async function copyInput(core: Core, file: FolderFile, target: string, sandboxFile: (path: string) => Promise<string>,
	authorize: () => boolean, expect: (sha: string) => void): Promise<void> {
	const source = await core.security.inspect(file.path, file.folder);
	const info = await lstat(file.path);
	if (source.decision !== "allow" || pathKey(source.path) !== hostKey(file.path) || !info.isFile() || info.nlink !== 1 ||
		info.size !== file.size || info.mtimeMs !== file.mtime) throw new Error("来源文件已变更、不可读取或路径发生重定向");
	const local = await sandboxFile(target);
	if (!authorize()) throw new Error("资料来源授权已收回");
	await mkdir(dirname(local), { recursive: true });
	await sandboxFile(target);
	if (!authorize()) throw new Error("资料来源授权已收回");
	const sha = await digest(file.path);
	expect(sha);
	if (!authorize()) throw new Error("资料来源授权已收回");
	await copyFile(file.path, local, constants.COPYFILE_EXCL);
	if (await digest(local) !== sha) throw new Error("复制期间资料发生变化");
}

export async function digest(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}
