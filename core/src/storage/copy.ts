import { createHash } from "node:crypto";
import { closeSync, copyFileSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { checkDatabase } from "./memory-maintenance.ts";

export interface CopyEntry { path: string; bytes: number; sha256: string }
export interface CopyInventory { files: CopyEntry[]; directories: string[]; bytes: number }

function hashFile(path: string): string {
	const fd = openSync(path, "r");
	try {
		const hash = createHash("sha256"); const buffer = Buffer.alloc(1024 * 1024);
		for (;;) { const n = readSync(fd, buffer); if (!n) return hash.digest("hex"); hash.update(buffer.subarray(0, n)); }
	} finally { closeSync(fd); }
}

/** Fail closed for links/special files: never traverse an arbitrary workspace or VHD junction. */
export function inventory(directory: string): CopyInventory {
	const files: CopyEntry[] = []; const directories: string[] = [];
	const walk = (path: string): void => {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) throw new Error(`搬迁目录包含链接，请先处理：${path}`);
		if (stat.isDirectory()) {
			directories.push(relative(directory, path));
			for (const name of readdirSync(path).sort()) walk(join(path, name));
		} else if (stat.isFile()) {
			files.push({ path: relative(directory, path), bytes: stat.size, sha256: hashFile(path) });
		} else throw new Error(`不支持搬迁的文件类型：${path}`);
	};
	walk(directory);
	return { files, directories, bytes: files.reduce((n, f) => n + f.bytes, 0) };
}

function inside(parent: string, child: string): boolean {
	const p = resolve(parent).toLowerCase(); const c = resolve(child).toLowerCase();
	return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Preparation only, before any location switch. The caller must have stopped
 * writers and owns restart/rollback; Q-02 must be resolved before wiring it up.
 * Never deletes or renames the source. Never overwrites an existing target.
 */
export async function prepareDirectoryCopy(options: {
	source: string; target: string;
	stopWriters: () => Promise<void>;
	backup: () => Promise<string>;
	/** Relative SQLite files in this owned directory; checked after byte verification. */
	databases?: string[];
}): Promise<{ backup: string; manifest: CopyInventory; target: string }> {
	if (!isAbsolute(options.source) || !isAbsolute(options.target)) throw new Error("搬迁需要绝对路径");
	const source = resolve(options.source); const target = resolve(options.target);
	if (inside(source, target) || inside(target, source)) throw new Error("新旧目录不能相同或互相包含");
	if (realpathSync(source).toLowerCase() !== source.toLowerCase() || realpathSync(dirname(target)).toLowerCase() !== dirname(target).toLowerCase())
		throw new Error("搬迁路径不能经过链接");
	for (const file of options.databases ?? []) if (isAbsolute(file) || !inside(source, join(source, file))) throw new Error("数据库路径超出搬迁目录");
	await options.stopWriters();
	const backup = await options.backup();
	const before = inventory(source);
	// mkdir without recursive: this must be a fresh, exclusively owned destination.
	mkdirSync(target);
	try {
		for (const path of before.directories) if (path) mkdirSync(join(target, path));
		for (const file of before.files) copyFileSync(join(source, file.path), join(target, file.path), 1 /* COPYFILE_EXCL */);
		const after = inventory(target);
		if (JSON.stringify(after) !== JSON.stringify(before) || JSON.stringify(inventory(source)) !== JSON.stringify(before))
			throw new Error("搬迁校验失败：文件数量、大小或内容不一致，原目录未切换");
		for (const file of options.databases ?? []) checkDatabase(join(target, file));
		return { backup, manifest: after, target };
	} catch (error) {
		// Only the directory created above; never a pre-existing target or source.
		if (realpathSync(target).toLowerCase() === target.toLowerCase()) rmSync(target, { recursive: true, force: true });
		throw error;
	}
}
