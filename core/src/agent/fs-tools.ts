import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { generateUnifiedPatch, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { FsError, type HarnessState, remediate, versionOf } from "./state.ts";

/**
 * dsh's file tools (packages/fs/tool-fs): read, write, edit and read_image
 * with dsh's schemas, descriptions and model-facing output, over the local
 * file system. The observation policy is dsh's default: edit needs a prior
 * read; write may create a file but not overwrite one it has not read; any
 * change since that read is stale.
 */

export const READ_LIMIT = 2000;
const READ_MAX_LINE_LENGTH = 2000;
const READ_MAX_BYTES = 50 * 1024;

type Tool = ToolDefinition;

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: {} as Record<string, unknown> };
}

function positiveInteger(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
	return value;
}

/** read-render.ts formatReadOutput. */
export function formatRead(path: string, offset: number, lines: { number: number; text: string }[], totalLines: number, truncatedByBytes: boolean): string {
	const endLine = lines.at(-1)?.number ?? Math.max(0, offset - 1);
	const footer = truncatedByBytes
		? `(Output capped. Showing lines ${offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
		: endLine < totalLines
			? `(Showing lines ${offset}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.)`
			: `(End of file - total ${totalLines} lines)`;
	const body = lines.length > 0 ? `${lines.map((l) => `${l.number}: ${l.text}`).join("\n")}\n\n${footer}` : footer;
	return `<path>${path}</path>\n<type>file</type>\n<content>\n${body}\n</content>`;
}

/** read-render.ts buildWindow over a whole file. */
export function readWindow(content: string, offset: number, limit: number, path: string) {
	const lines: { number: number; text: string }[] = [];
	let total = 0;
	let bytes = 0;
	let truncatedByBytes = false;
	const raw = content.split("\n");
	if (raw.at(-1) === "") raw.pop();
	for (const rawLine of raw) {
		total += 1;
		if (truncatedByBytes || total < offset || lines.length >= limit) continue;
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		const shown = line.length > READ_MAX_LINE_LENGTH ? `${line.substring(0, READ_MAX_LINE_LENGTH)}... (line truncated to ${READ_MAX_LINE_LENGTH} chars)` : line;
		const size = Buffer.byteLength(shown, "utf8") + (lines.length > 0 ? 1 : 0);
		if (bytes + size > READ_MAX_BYTES) {
			truncatedByBytes = true;
			continue;
		}
		bytes += size;
		lines.push({ number: total, text: shown });
	}
	if (!truncatedByBytes && offset > total && !(total === 0 && offset === 1)) {
		throw new FsError(`offset ${offset} is out of range for "${path}" (${total} lines)`, "FS_NOT_FOUND");
	}
	return { lines, totalLines: total, truncatedByBytes };
}

export function readTool(state: HarnessState): Tool {
	return {
		name: "read",
		label: "读取",
		description: "Read a UTF-8 text file and return line-numbered content.",
		parameters: {
			type: "object",
			properties: {
				file_path: { type: "string", description: "Path to read, resolved by the filesystem backend." },
				offset: { type: "number", description: "1-based first line to return. Defaults to 1." },
				limit: { type: "number", description: `Maximum number of lines to return. Defaults to ${READ_LIMIT}.` },
			},
			required: ["file_path"],
		} as never,
		async execute(_id, params: { file_path: string; offset?: number; limit?: number }) {
			if (params.file_path.trim().length === 0) throw new Error("file_path must be a non-empty string");
			const offset = params.offset === undefined ? 1 : positiveInteger(params.offset, "offset");
			const limit = params.limit === undefined ? READ_LIMIT : positiveInteger(params.limit, "limit");
			if (limit > READ_LIMIT) throw new Error(`limit must be less than or equal to ${READ_LIMIT}`);
			const path = state.resolve(params.file_path);
			const info = await versionOf(path);
			if (!info) throw new FsError(`cannot read "${path}": not found`, "FS_NOT_FOUND");
			if (!info.isFile) throw new FsError(`cannot read "${path}": not a regular file`, "FS_NOT_REGULAR_FILE");
			const content = stripBom(await readFile(path, "utf8"));
			const window = readWindow(content, offset, limit, path);
			state.observe(path, { kind: "present", version: info.version });
			const result = text(formatRead(path, offset, window.lines, window.totalLines, window.truncatedByBytes));
			result.details = { path, offset, totalLines: window.totalLines };
			return result;
		},
	};
}

function stripBom(content: string): string {
	return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

export function writeTool(state: HarnessState): Tool {
	return {
		name: "write",
		label: "写入",
		description: "Create or fully replace a UTF-8 text file.",
		parameters: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description: "Path to write, resolved by the filesystem backend. Provide `file_path` before `content` in the arguments.",
				},
				content: { type: "string", description: "Full UTF-8 text content to write." },
			},
			required: ["file_path", "content"],
		} as never,
		async execute(_id, params: { file_path: string; content: string }) {
			if (params.file_path.trim().length === 0) throw new Error("file_path must be a non-empty string");
			const path = state.resolve(params.file_path);
			return state.withLock(path, async () => {
			try {
				const existing = await versionOf(path);
				if (existing && !existing.isFile) throw new FsError(`cannot write "${path}": not a regular file`, "FS_NOT_REGULAR_FILE");
				const seen = state.observed(path);
				if (seen?.kind === "present") {
					if (!existing) throw new FsError(`cannot write "${path}": file no longer exists`, "FS_STALE_VERSION");
					if (existing.version !== seen.version) throw new FsError(`cannot write "${path}": file changed since it was read`, "FS_STALE_VERSION");
				} else if (existing) {
					throw new FsError(`cannot overwrite existing "${path}" without reading it first`, "FS_NOT_OBSERVED");
				}
				const before = existing ? normalize(stripBom(await readFile(path, "utf8"))) : "";
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, params.content, "utf8");
				const after = await versionOf(path);
				if (after) state.observe(path, { kind: "present", version: after.version });
				const verb = existing ? "Updated" : "Created";
				const result = text(`<path>${path}</path>\n<type>file</type>\n<content>\n${verb} file\n</content>`);
				result.details = { path, patch: generateUnifiedPatch(path, before, normalize(params.content)), created: !existing };
				return result;
			} catch (error) {
				throw remediate(error, path);
			}
			});
		},
	};
}

function normalize(content: string): string {
	return content.replaceAll("\r\n", "\n");
}

function detectCrlf(raw: string): boolean {
	const sample = raw.slice(0, 4096);
	const crlf = sample.split("\r\n").length - 1;
	const lf = sample.split("\n").length - 1 - crlf;
	return crlf > lf;
}

function countOccurrences(content: string, needle: string): number {
	let count = 0;
	let index = 0;
	while ((index = content.indexOf(needle, index)) !== -1) {
		count += 1;
		index += needle.length;
	}
	return count;
}

export function editTool(state: HarnessState): Tool {
	return {
		name: "edit",
		label: "修改",
		description: "Edit an existing UTF-8 text file by replacing literal text.",
		parameters: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description: "Path to edit, resolved by the filesystem backend. Provide `file_path` before `old_string` and `new_string` in the arguments.",
				},
				old_string: { type: "string", description: "Literal text to replace." },
				new_string: { type: "string", description: "Literal replacement text. Use an empty string to delete the match." },
				replace_all: { type: "boolean", description: "Replace all matches. Defaults to false; when false, old_string must appear exactly once." },
			},
			required: ["file_path", "old_string", "new_string"],
		} as never,
		async execute(_id, params: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }) {
			if (params.file_path.trim().length === 0) throw new Error("file_path must be a non-empty string");
			if (params.old_string.length === 0) throw new Error("old_string must be a non-empty string");
			if (params.old_string === params.new_string) throw new Error("old_string and new_string must differ");
			const replaceAll = params.replace_all ?? false;
			const path = state.resolve(params.file_path);
			return state.withLock(path, async () => {
			try {
				const seen = state.observed(path);
				if (seen === undefined) throw new FsError(`edit requires reading "${path}" first`, "FS_NOT_OBSERVED");
				if (seen.kind === "absent") throw new FsError(`cannot edit "${path}": not found`, "FS_NOT_FOUND");
				const existing = await versionOf(path);
				if (!existing) throw new FsError(`cannot edit "${path}": file changed since it was read`, "FS_STALE_VERSION");
				if (!existing.isFile) throw new FsError(`cannot edit "${path}": not a regular file`, "FS_NOT_REGULAR_FILE");
				if (existing.version !== seen.version) throw new FsError(`cannot edit "${path}": file changed since it was read`, "FS_STALE_VERSION");
				const raw = await readFile(path, "utf8");
				const bom = raw.charCodeAt(0) === 0xfeff ? "﻿" : "";
				const crlf = detectCrlf(raw);
				const content = normalize(stripBom(raw));
				const oldNorm = normalize(params.old_string);
				const newNorm = normalize(params.new_string);
				const matches = countOccurrences(content, oldNorm);
				if (matches === 0) throw new FsError(`old_string was not found in "${path}"`, "FS_EDIT_NOT_FOUND");
				if (!replaceAll && matches > 1) {
					throw new FsError(`old_string matched ${matches} times in "${path}"; provide a more specific old_string or set replace_all to true`, "FS_AMBIGUOUS_EDIT");
				}
				const edited = content.split(oldNorm).join(newNorm);
				await writeFile(path, bom + (crlf ? edited.split("\n").join("\r\n") : edited), "utf8");
				const after = await versionOf(path);
				if (after) state.observe(path, { kind: "present", version: after.version });
				const result = text(
					replaceAll ? `The file ${path} has been updated. All occurrences were successfully replaced.` : `The file ${path} has been updated successfully.`,
				);
				result.details = { path, patch: generateUnifiedPatch(path, content, edited) };
				return result;
			} catch (error) {
				throw remediate(error, path);
			}
			});
		},
	};
}

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

function sniffImage(bytes: Buffer): string | undefined {
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
	if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	return undefined;
}

/** Width and height from the image header (no decoding). */
export function imageSize(bytes: Buffer, mediaType: string): { width: number; height: number } | undefined {
	try {
		if (mediaType === "image/png") return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
		if (mediaType === "image/gif") return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
		if (mediaType === "image/webp") {
			const chunk = bytes.subarray(12, 16).toString("ascii");
			if (chunk === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
			if (chunk === "VP8L") {
				const b = bytes.readUInt32LE(21);
				return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
			}
			return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
		}
		if (mediaType === "image/jpeg") {
			let offset = 2;
			while (offset + 9 < bytes.length) {
				if (bytes[offset] !== 0xff) return undefined;
				const marker = bytes[offset + 1]!;
				const length = bytes.readUInt16BE(offset + 2);
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
					return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
				}
				offset += 2 + length;
			}
		}
	} catch {
		// Malformed header: size unknown.
	}
	return undefined;
}

export function readImageTool(state: HarnessState, modelAcceptsImages: () => { ok: boolean; model: string }): Tool {
	return {
		name: "read_image",
		label: "看图",
		description:
			"Read a PNG/JPEG/WebP/GIF file and return the image itself. " +
			"Large images are downscaled automatically; do not install image libraries or create thumbnails to inspect an image.",
		parameters: {
			type: "object",
			properties: {
				file_path: { type: "string", description: "Path to the image file, resolved by the filesystem backend." },
			},
			required: ["file_path"],
		} as never,
		async execute(_id, params: { file_path: string }) {
			if (params.file_path.trim().length === 0) throw new Error("file_path must be a non-empty string");
			const route = modelAcceptsImages();
			if (!route.ok) {
				throw new Error(`cannot read "${params.file_path}" as an image: model "${route.model}" does not declare image input; switch to an image-capable model to read images`);
			}
			const extension = extname(params.file_path).toLowerCase();
			if (extension !== "" && !(extension in IMAGE_TYPES)) {
				throw new Error(
					`cannot read "${params.file_path}": the ${extension} extension does not declare a supported image format; read_image accepts PNG/JPEG/WebP/GIF files, including extension-less files in those formats`,
				);
			}
			const path = state.resolve(params.file_path);
			const info = await versionOf(path);
			if (!info) throw new FsError(`cannot read "${path}": not found`, "FS_NOT_FOUND");
			if (!info.isFile) throw new FsError(`cannot read "${path}": not a regular file`, "FS_NOT_REGULAR_FILE");
			const bytes = await readFile(path);
			const mediaType = sniffImage(bytes);
			if (!mediaType) throw new Error(`cannot read "${path}": the file content is not a supported image format; read_image accepts PNG/JPEG/WebP/GIF`);
			const size = imageSize(bytes, mediaType);
			const dims = size ? `${size.width}x${size.height} px, ` : "";
			return {
				content: [
					{ type: "text", text: `<path>${path}</path>\n<type>image</type>\n<content>\n${mediaType} image, ${dims}${bytes.length} bytes\n</content>` },
					{ type: "image", data: bytes.toString("base64"), mimeType: mediaType },
				],
				details: { path },
			};
		},
	};
}

export function workingDirectoryTool(state: HarnessState, changed: (cwd: string) => void): Tool {
	return {
		name: "working_directory",
		label: "工作目录",
		description:
			"Read the current working directory, or change it with cd. Relative paths use the current directory. Existing shells and running processes keep their own directories.",
		parameters: {
			type: "object",
			properties: {
				cd: { type: "string", description: "Existing directory to enter. Omit to read the current directory." },
			},
		} as never,
		async execute(_id, params: { cd?: string }) {
			if (params.cd !== undefined) {
				if (params.cd.length === 0) throw new Error("working-directory: cd must not be empty");
				const target = state.resolve(params.cd);
				const info = await versionOf(target);
				if (!info || info.isFile) throw new Error(`working-directory: directory does not exist: ${JSON.stringify(params.cd)}`);
				if (target !== state.cwd) {
					state.cwd = target;
					changed(target);
				}
			}
			return { content: [{ type: "text", text: state.cwd }], details: { cwd: state.cwd } };
		},
	};
}
