import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import yauzl from "yauzl";
import yazl from "yazl";

/**
 * Backup packages are zip files (zip64 when large). Writing streams files
 * from disk; reading checks every entry up front: names (no absolute paths,
 * drive letters, `..`, duplicates), no links, sizes and compression ratios
 * (zip bombs), before anything is extracted.
 */

export interface ArchiveFile {
	/** Name inside the archive, forward slashes. */
	name: string;
	/** Source on disk. */
	path: string;
	/** Already compressed (tar.gz): stored as is. */
	stored?: boolean;
}

export class ArchiveError extends Error {}

export async function writeArchive(out: string, files: ArchiveFile[], buffers: { name: string; data: Buffer }[], signal?: AbortSignal): Promise<void> {
	const zip = new yazl.ZipFile();
	for (const file of files) zip.addFile(file.path, file.name, { compress: !file.stored });
	for (const buffer of buffers) zip.addBuffer(buffer.data, buffer.name);
	zip.end();
	await mkdir(dirname(out), { recursive: true });
	await pipeline(zip.outputStream, createWriteStream(out), { signal });
}

/** Limits for reading a package. */
export const ARCHIVE_LIMITS = {
	entries: 500_000,
	totalBytes: 64 * 1024 ** 3,
	/** Entries bigger than this must not be compressed more than [ratio]:1. */
	ratioFloor: 64 * 1024 ** 2,
	ratio: 200,
	/** manifest.json and other buffers read into memory. */
	bufferBytes: 32 * 1024 ** 2,
};

export interface ArchiveEntry {
	name: string;
	size: number;
	compressedSize: number;
}

/** An opened package whose entry list passed the checks. */
export class Archive {
	readonly entries = new Map<string, ArchiveEntry>();
	private readonly zip: yauzl.ZipFile;
	private readonly raw = new Map<string, yauzl.Entry>();

	private constructor(zip: yauzl.ZipFile) {
		this.zip = zip;
	}

	static async open(path: string): Promise<Archive> {
		let zip: yauzl.ZipFile;
		try {
			zip = await yauzl.openPromise(path, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true, decodeStrings: true });
		} catch (error) {
			throw new ArchiveError(`不是有效的备份包（${(error as Error).message}）`);
		}
		const archive = new Archive(zip);
		try {
			await archive.scan();
		} catch (error) {
			zip.close();
			if (error instanceof ArchiveError) throw error;
			const message = (error as Error).message;
			// yauzl checks names itself before handing an entry over.
			if (/invalid relative path|absolute path|invalid characters|backslash/i.test(message)) throw new ArchiveError(`备份包里有不安全的路径（${message}）`);
			throw new ArchiveError(`备份包已损坏（${message}）`);
		}
		return archive;
	}

	private scan(): Promise<void> {
		const seen = new Set<string>();
		let total = 0;
		return new Promise((resolve, reject) => {
			this.zip.on("error", reject);
			this.zip.on("end", () => resolve());
			this.zip.on("entry", (entry: yauzl.Entry) => {
				try {
					const name = entry.fileName;
					if (name.endsWith("/")) return this.zip.readEntry();
					const problem = unsafeName(name);
					if (problem) throw new ArchiveError(`备份包里有不安全的路径「${name}」（${problem}）`);
					const folded = name.toLowerCase();
					if (seen.has(folded)) throw new ArchiveError(`备份包里有重复的文件「${name}」`);
					seen.add(folded);
					const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
					if (mode === 0o120000) throw new ArchiveError(`备份包里有链接「${name}」，不能导入`);
					if (seen.size > ARCHIVE_LIMITS.entries) throw new ArchiveError("备份包里的文件太多");
					total += entry.uncompressedSize;
					if (total > ARCHIVE_LIMITS.totalBytes) throw new ArchiveError("备份包解开后太大");
					if (entry.uncompressedSize > ARCHIVE_LIMITS.ratioFloor && entry.uncompressedSize > entry.compressedSize * ARCHIVE_LIMITS.ratio) {
						throw new ArchiveError(`备份包里的「${name}」压缩比异常，可能是恶意文件`);
					}
					this.raw.set(name, entry);
					this.entries.set(name, { name, size: entry.uncompressedSize, compressedSize: entry.compressedSize });
					this.zip.readEntry();
				} catch (error) {
					reject(error);
				}
			});
			this.zip.readEntry();
		});
	}

	get totalSize(): number {
		let total = 0;
		for (const entry of this.entries.values()) total += entry.size;
		return total;
	}

	async readBuffer(name: string): Promise<Buffer> {
		const entry = this.raw.get(name);
		if (!entry) throw new ArchiveError(`备份包里缺少 ${name}`);
		if (entry.uncompressedSize > ARCHIVE_LIMITS.bufferBytes) throw new ArchiveError(`${name} 太大`);
		const chunks: Buffer[] = [];
		for await (const chunk of await this.zip.openReadStreamPromise(entry)) chunks.push(chunk as Buffer);
		return Buffer.concat(chunks);
	}

	/** Extracts [name] to [dest]; returns its sha256 (hex). */
	async extract(name: string, dest: string, signal?: AbortSignal): Promise<string> {
		const entry = this.raw.get(name);
		if (!entry) throw new ArchiveError(`备份包里缺少 ${name}`);
		await mkdir(dirname(dest), { recursive: true });
		const hash = createHash("sha256");
		const tap = new Transform({
			transform(chunk: Buffer, _enc, done) {
				hash.update(chunk);
				done(null, chunk);
			},
		});
		await pipeline(await this.zip.openReadStreamPromise(entry), tap, createWriteStream(dest), { signal });
		return hash.digest("hex");
	}

	close(): void {
		this.zip.close();
	}
}

/** Why [name] may not be extracted, or null. */
export function unsafeName(name: string): string | null {
	if (name.includes("\\")) return "反斜杠";
	if (/^[a-zA-Z]:/.test(name) || name.startsWith("/")) return "绝对路径";
	if (name.split("/").some((part) => part === ".." || part === ".")) return "越界路径";
	if (name.split("/").some((part) => part === "")) return "空的路径段";
	if (/[\x00-\x1f<>:"|?*]/.test(name)) return "非法字符";
	return yauzl.validateFileName(name);
}

/** [dir]/[name] for a checked archive name. */
export function under(dir: string, name: string): string {
	return join(dir, ...name.split("/"));
}
