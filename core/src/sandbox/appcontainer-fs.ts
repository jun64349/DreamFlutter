import { appContainerSandboxEnv, appContainerWorkspacePath, startAppContainerFileProcess, type AppContainerConfig } from "./appcontainer.ts";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 12 * 1024 * 1024;

export interface AppContainerFileInfo {
	version: string;
	isFile: boolean;
	isDirectory: boolean;
	size: number;
	modifiedAt: number;
	nlink: number;
}

export interface AppContainerListedFile {
	name: string;
	version: string;
	size: number;
	modifiedAt: number;
}

export interface AppContainerFileAccess {
	stat(path: string, signal?: AbortSignal): Promise<AppContainerFileInfo | null>;
	read(path: string, signal?: AbortSignal): Promise<{ data: Buffer; version: string }>;
	write(path: string, data: Uint8Array | string, expectedVersion: string | null, signal?: AbortSignal): Promise<string>;
	makeDirectory(path: string, signal?: AbortSignal): Promise<void>;
	listFiles(path: string, limit: number, signal?: AbortSignal): Promise<AppContainerListedFile[]>;
	directoryNames(path: string, signal?: AbortSignal): Promise<string[]>;
	inputDigest(path: string, signal?: AbortSignal): Promise<string>;
	copyInput(source: string, target: string, signal?: AbortSignal): Promise<void>;
	renameInput(source: string, target: string, signal?: AbortSignal): Promise<void>;
	removeInput(path: string, signal?: AbortSignal): Promise<void>;
}

export class AppContainerFileError extends Error {
	readonly code: string;
	constructor(code: string, message: string) { super(message); this.code = code; }
}

// All filesystem operations here execute with the AppContainer token in the native bridge's Job.
// The user paths and payload are length-delimited JSON, never part of executable source or argv.
const worker = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const root = process.cwd();
const max = 8 * 1024 * 1024;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function input(size) {
  const bytes = Buffer.allocUnsafe(size);
  for (let pos = 0; pos < size;) {
    const count = fs.readSync(0, bytes, pos, size - pos, null);
    if (!count) fail('FS_PROTOCOL', 'AppContainer file input ended early');
    pos += count;
  }
  return bytes;
}
function stat(file) {
  let info;
  try { info = fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
  if (info.isSymbolicLink()) fail('FS_PATH', 'Symbolic links are outside this file protocol');
  return info;
}
function version(info) { return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'); }
function resolveTarget(file, createParents) {
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || /[:\0]/.test(relative)) {
    fail('FS_PATH', 'File path is outside the AppContainer workspace');
  }
  const segments = relative ? relative.split(path.sep) : [];
  let directory = root;
  for (const segment of segments.slice(0, -1)) {
    directory = path.join(directory, segment);
    let info = stat(directory);
    if (!info && createParents) {
      try { fs.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      info = stat(directory);
    }
    if (!info) return null;
    if (!info.isDirectory()) fail('FS_PATH', 'A path component is not a directory');
  }
  return path.join(root, relative);
}
function read(file) {
  const info = stat(file);
  if (!info) fail('FS_NOT_FOUND', 'File is missing');
  if (!info.isFile()) fail('FS_NOT_REGULAR_FILE', 'Expected a regular file');
  const handle = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(handle, { bigint: true });
    if (!before.isFile() || version(before) !== version(info)) fail('FS_STALE_VERSION', 'File changed before reading');
    if (before.size > BigInt(max)) fail('FS_SIZE_LIMIT', 'File size exceeds 8 MiB');
    const bytes = Buffer.allocUnsafe(Number(before.size));
    let pos = 0;
    while (pos < bytes.length) {
      const count = fs.readSync(handle, bytes, pos, bytes.length - pos, null);
      if (!count) break;
      pos += count;
    }
    if (pos !== bytes.length || version(fs.fstatSync(handle, { bigint: true })) !== version(before)) {
      fail('FS_STALE_VERSION', 'File changed during reading');
    }
    return { data: bytes.toString('base64'), version: version(before) };
  } finally { fs.closeSync(handle); }
}
function assertVersion(file, expected) {
  const current = stat(file);
  if (current && !current.isFile()) fail('FS_NOT_REGULAR_FILE', 'Expected a regular file');
  if (expected === null && current) fail('FS_NOT_OBSERVED', 'Read the file before replacing it');
  if (expected !== null && (!current || version(current) !== expected)) fail('FS_STALE_VERSION', 'File changed since reading');
}
function write(file, data, expected) {
  if (data.length > max) fail('FS_SIZE_LIMIT', 'File size exceeds 8 MiB');
  assertVersion(file, expected);
  const stage = path.join(path.dirname(file), '.dreamflutter-write-' + randomUUID());
  const fd = fs.openSync(stage, 'wx');
  try {
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    assertVersion(file, expected);
    if (expected === null) {
      try { fs.linkSync(stage, file); }
      catch (error) { if (error.code === 'EEXIST') fail('FS_NOT_OBSERVED', 'File was created by another task'); throw error; }
    } else {
      fs.renameSync(stage, file);
    }
  } finally {
    try { fs.unlinkSync(stage); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { version: version(fs.lstatSync(file, { bigint: true })) };
}
function list(directory, limit) {
  const files = [];
  if (!directory || !stat(directory)) return files;
  const pending = [directory];
  let visited = 0;
  while (pending.length && files.length < limit && visited < 4096) {
    const current = fs.opendirSync(pending.pop());
    try {
      for (let entry; files.length < limit && visited < 4096 && (entry = current.readSync());) {
        visited++;
        if (entry.isSymbolicLink()) continue;
        const pathName = path.join(current.path, entry.name);
        if (entry.isDirectory()) { pending.push(pathName); continue; }
        if (!entry.isFile()) continue;
        const info = stat(pathName);
        if (info?.isFile()) files.push({ name: path.relative(directory, pathName).split(path.sep).join('/'),
          size: Number(info.size), version: version(info), modifiedAt: Number(info.mtimeMs) });
      }
    } finally { current.closeSync(); }
  }
  return files;
}
function names(directory) {
  const entries = fs.readdirSync(directory);
  if (entries.length > 4096) fail('FS_SIZE_LIMIT', 'Too many workspace entries');
  return entries.sort();
}
function regularInput(file) {
  const info = stat(file);
  if (!info) fail('FS_NOT_FOUND', 'Workspace input is missing');
  if (!info.isDirectory() && !(info.isFile() && info.nlink === 1n)) fail('FS_PATH', 'Expected a directory or single-link regular file');
  return info;
}
function inputTree(file, destination, budget) {
  if (++budget.count > 4096) fail('FS_SIZE_LIMIT', 'Too many workspace input entries');
  const info = regularInput(file);
  if (!info.isDirectory()) {
    if (info.size > BigInt(max)) fail('FS_SIZE_LIMIT', 'Input file size exceeds 8 MiB');
    if (destination) { fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL); return; }
    return 'file:' + createHash('sha256').update(Buffer.from(read(file).data, 'base64')).digest('hex');
  }
  if (destination) fs.mkdirSync(destination);
  const children = names(file).map((name) => [name, inputTree(path.join(file, name), destination && path.join(destination, name), budget)]);
  if (!destination) return 'folder:' + createHash('sha256').update(JSON.stringify(children)).digest('hex');
}
function targetInsideWorkspace(file) {
  const first = path.relative(root, file).split(path.sep)[0].toLowerCase();
  if (!first || first === 'home' || first === 'temp') fail('FS_PATH', 'Expected a workspace input subdirectory');
  return file;
}
try {
  const length = input(4).readUInt32LE();
  if (!length || length > 12 * 1024 * 1024) fail('FS_PROTOCOL', 'Invalid file request size');
  const request = JSON.parse(input(length).toString('utf8'));
  const file = resolveTarget(request.path, request.op === 'mkdir' || (request.op === 'write' && request.expected === null));
  let value;
  if (request.op === 'stat') {
    const info = file && stat(file);
    value = info ? { version: version(info), isFile: info.isFile(), isDirectory: info.isDirectory(),
      size: Number(info.size), modifiedAt: Number(info.mtimeMs), nlink: Number(info.nlink) } : null;
  } else if (request.op === 'list') {
    value = list(file, request.limit);
  } else if (request.op === 'remove-input') {
    if (file) fs.rmSync(targetInsideWorkspace(file), { recursive: true, force: true });
    value = null;
  } else if (!file) {
    fail(request.op === 'write' ? 'FS_STALE_VERSION' : 'FS_NOT_FOUND', 'File is missing');
  } else if (request.op === 'read') {
    value = read(file);
  } else if (request.op === 'write') {
    value = write(file, Buffer.from(request.data, 'base64'), request.expected);
  } else if (request.op === 'mkdir') {
    try { fs.mkdirSync(file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!stat(file)?.isDirectory()) fail('FS_PATH', 'Directory expected');
    value = null;
  } else if (request.op === 'names') {
    value = names(file);
  } else if (request.op === 'hash-input') {
    value = inputTree(file, null, { count: 0 });
  } else if (request.op === 'copy-input' || request.op === 'rename-input') {
    const target = resolveTarget(request.target, false);
    if (!target || stat(target)) fail('FS_PATH', 'Input destination must be new');
    targetInsideWorkspace(target);
    if (request.op === 'copy-input') inputTree(file, target, { count: 0 });
    else fs.renameSync(targetInsideWorkspace(file), target);
    value = null;
  } else {
    fail('FS_PROTOCOL', 'Unsupported file operation');
  }
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code || 'FS_ERROR', message: error.message }));
}
`;

type FileRequest = { op: "stat" | "read" | "mkdir" | "names" | "hash-input" | "remove-input"; path: string } |
	{ op: "write"; path: string; data: string; expected: string | null } |
	{ op: "list"; path: string; limit: number } |
	{ op: "copy-input" | "rename-input"; path: string; target: string };
type Reply<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

function request<T>(config: AppContainerConfig, input: FileRequest, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) return Promise.reject(new AppContainerFileError("FS_CANCELLED", "AppContainer 文件操作已取消。"));
	const body = Buffer.from(JSON.stringify(input));
	if (body.length > MAX_MESSAGE_BYTES) return Promise.reject(new AppContainerFileError("FS_SIZE_LIMIT", "AppContainer 文件请求过大。"));
	const frame = Buffer.allocUnsafe(4);
	frame.writeUInt32LE(body.length);
	const child = startAppContainerFileProcess(config, worker);
	return new Promise((resolve, reject) => {
		let failure: Error | undefined;
		let stdoutBytes = 0;
		let stderr = "";
		const chunks: Buffer[] = [];
		const stop = (error: Error) => {
			failure ??= error;
			child.kill();
		};
		const abort = () => stop(new AppContainerFileError("FS_CANCELLED", "AppContainer 文件操作已取消。"));
		const timer = setTimeout(() => stop(new AppContainerFileError("FS_TIMEOUT", "AppContainer 文件操作超时。")), 30_000);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		child.stdin!.on("error", (error) => { failure ??= error; });
		child.stdout!.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > MAX_MESSAGE_BYTES) stop(new AppContainerFileError("FS_SIZE_LIMIT", "AppContainer 文件响应过大。"));
			else chunks.push(chunk);
		});
		child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, 4096); });
		child.on("error", (error) => { failure ??= error; });
		child.once("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			child.stdin!.destroy();
			if (failure) { reject(failure); return; }
			if (code !== 0) { reject(new AppContainerFileError("FS_PROCESS", stderr.trim() || `AppContainer file worker exited with ${code}`)); return; }
			try {
				const reply = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Reply<T>;
				if (!reply.ok) reject(new AppContainerFileError(reply.code, reply.message));
				else resolve(reply.value);
			} catch (error) { reject(error); }
		});
		child.stdin!.write(frame);
		child.stdin!.write(body);
	});
}

export function appContainerFileAccess(config: AppContainerConfig): AppContainerFileAccess {
	const env = appContainerSandboxEnv(config);
	const workspace = appContainerWorkspacePath(config);
	const locate = (path: string) => env.resolve(workspace, path);
	return {
		stat: async (path, signal) => request<AppContainerFileInfo | null>(config, { op: "stat", path: locate(path) }, signal),
		makeDirectory: async (path, signal) => { await request<null>(config, { op: "mkdir", path: locate(path) }, signal); },
		listFiles: async (path, limit, signal) => {
			if (!Number.isInteger(limit) || limit < 1 || limit > 4096) throw new AppContainerFileError("FS_PROTOCOL", "AppContainer 目录清单数量无效。");
			return request<AppContainerListedFile[]>(config, { op: "list", path: locate(path), limit }, signal);
		},
		directoryNames: async (path, signal) => request<string[]>(config, { op: "names", path: locate(path) }, signal),
		inputDigest: async (path, signal) => request<string>(config, { op: "hash-input", path: locate(path) }, signal),
		copyInput: async (source, target, signal) => {
			await request<null>(config, { op: "copy-input", path: locate(source), target: locate(target) }, signal);
		},
		renameInput: async (source, target, signal) => {
			await request<null>(config, { op: "rename-input", path: locate(source), target: locate(target) }, signal);
		},
		removeInput: async (path, signal) => { await request<null>(config, { op: "remove-input", path: locate(path) }, signal); },
		async read(path, signal) {
			const value = await request<{ data: string; version: string }>(config, { op: "read", path: locate(path) }, signal);
			return { data: Buffer.from(value.data, "base64"), version: value.version };
		},
		async write(path, data, expectedVersion, signal) {
			const bytes = Buffer.from(data);
			if (bytes.length > MAX_FILE_BYTES) throw new AppContainerFileError("FS_SIZE_LIMIT", "AppContainer 文件大小超过 8 MiB。");
			const value = await request<{ version: string }>(config, {
				op: "write", path: locate(path), data: bytes.toString("base64"), expected: expectedVersion,
			}, signal);
			return value.version;
		},
	};
}
