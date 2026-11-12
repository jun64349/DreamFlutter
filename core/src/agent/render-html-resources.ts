import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { open, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { HarnessState } from "./state.ts";

const types: Record<string, string> = {
	".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
	".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif", ".ico": "image/x-icon",
	".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
};
const HTML = "text/html";
const MAX_FILE = 12 * 1024 * 1024;
const MAX_TOTAL = 48 * 1024 * 1024;
const MAX_REQUESTS = 256;
export const LOCAL_DISK_REQUIRED = "截图只支持本机磁盘上的文件";
const CSP = [
	"default-src 'none'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self'", "base-uri 'none'",
	"form-action 'none'", "frame-src 'none'", "worker-src 'none'", "sandbox allow-scripts allow-same-origin",
].join("; ");

type Header = { name: string; value: string };
export type Resource = { body: string; headers: Header[] };
export type RenderGoalScope = (requested: string, actual: string) => Promise<boolean>;
type RenderLog = (url: string, reason: string, error?: unknown) => void;
class ResourceError extends Error {}
export class RenderInputError extends Error {}

export function renderAccessError(state: HarnessState, workspace: string, path: string): RenderInputError {
	const rel = relativeTo(state.local(workspace), path);
	const location = rel && rel.split(sep).every(validSegment)
		? state.env.kind === "sandbox" ? posix.join(workspace, ...rel.split(sep)) : rel
		: "工作区以外的文件";
	return new RenderInputError(`安全路径策略拒绝访问（${location}）。`);
}

export function publicEntryError(state: HarnessState, workspace: string, file: string, error: unknown): RenderInputError {
	if (error instanceof RenderInputError) return error;
	const sandbox = state.env.kind === "sandbox";
	const requested = state.resolve(file);
	const rel = sandbox ? posix.relative(workspace, requested) : relativeTo(workspace, requested);
	const location = localPathArgument(file) && rel && rel.split(sandbox ? "/" : sep).every(validSegment)
		? (sandbox ? requested : rel) : "工作区以外的文件";
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	const reason = error instanceof ResourceError ? error.message : code === "ENOENT" ? "找不到截图入口" : "无法读取截图入口";
	return new RenderInputError(`${reason}（${location}）。`);
}

function relativeTo(root: string, path: string): string | undefined {
	const value = relative(root, path);
	return value && value !== ".." && !value.startsWith(".." + sep) && !isAbsolute(value) ? value : undefined;
}

function localPathArgument(path: string): boolean {
	return !!path.trim() && !/[\x00-\x1f]/.test(path) && !/^[/\\]{2}/.test(path)
		&& (!/^[a-z][a-z0-9+.-]*:/i.test(path) || /^[a-z]:[\\/]/i.test(path));
}

function validSegment(segment: string): boolean { return !!segment && segment !== "." && segment !== ".." && !/[/\\:\x00-\x1f]/.test(segment); }
const utf8 = (type: string) => type.startsWith("text/") || type === "application/json" || type === "image/svg+xml";

export class RenderLocalVolumes {
	private readonly drives = new Map<string, Promise<number>>();

	async check(path: string, signal: AbortSignal): Promise<void> {
		const normal = path.replace(/^\\\\\?\\(?=[a-z]:)/i, "");
		if (/^[/\\]{2}/.test(normal)) throw new ResourceError(LOCAL_DISK_REQUIRED);
		if (process.platform !== "win32") return;
		const letter = /^([a-z]):[/\\]/i.exec(normal)?.[1]?.toUpperCase();
		if (!letter) throw new ResourceError(LOCAL_DISK_REQUIRED);
		let type = this.drives.get(letter);
		if (!type) {
			type = this.driveType(letter, signal);
			this.drives.set(letter, type);
		}
		if (![2, 3, 5, 6].includes(await type)) throw new ResourceError(LOCAL_DISK_REQUIRED);
	}

	driveType(letter: string, signal: AbortSignal): Promise<number> {
		return new Promise((resolve, reject) => {
			const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
			const command = "[int]([IO.DriveInfo]::new($env:DF_RENDER_DRIVE + ':\\').DriveType)";
			execFile(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
				windowsHide: true, signal, timeout: 5000, env: { ...process.env, DF_RENDER_DRIVE: letter },
			}, (error, stdout) => error ? reject(new ResourceError(LOCAL_DISK_REQUIRED, { cause: error })) : resolve(Number(stdout.trim())));
		});
	}
}

const requestedTypes: Record<string, (type: string) => boolean> = {
	Script: type => type === "text/javascript",
	Stylesheet: type => type === "text/css",
	Image: type => type.startsWith("image/"),
	Font: type => type.startsWith("font/"),
};
const wrongType = () => new ResourceError("本地资源内容与类型不符");

function checkedText(bytes: Buffer, type: string): string | undefined {
	if (!utf8(type)) {
		const signature = (offset: number, expected: string) => bytes.toString("latin1", offset, offset + expected.length) === expected;
		const valid = {
			"image/png": () => signature(0, "\x89PNG\r\n\x1a\n") && signature(12, "IHDR"),
			"image/jpeg": () => signature(0, "\xff\xd8\xff"),
			"image/webp": () => signature(0, "RIFF") && signature(8, "WEBP"),
			"image/gif": () => signature(0, "GIF87a") || signature(0, "GIF89a"),
			"image/avif": () => signature(4, "ftyp") && /avif|avis/.test(bytes.toString("ascii", 8, 32)),
			"image/x-icon": () => signature(0, "\0\0\x01\0"),
			"font/woff": () => signature(0, "wOFF"), "font/woff2": () => signature(0, "wOF2"),
			"font/ttf": () => signature(0, "\0\x01\0\0") || signature(0, "true"),
			"font/otf": () => signature(0, "OTTO"),
		}[type];
		if (!valid?.()) throw wrongType();
		return;
	}
	let text: string;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	catch { throw wrongType(); }
	if (/[\x00-\x08\x0b\x0e-\x1f]/.test(text)) throw wrongType();
	const head = text.replace(/^(?:\s+|<!--[\s\S]*?-->|<\?xml[^>]*\?>)*/i, "");
	if (type === "image/svg+xml" && !/^(?:<!doctype\s+svg\b[^>]*>\s*)?<svg[\s>/:]/i.test(head)) throw wrongType();
	if ((type === "text/javascript" || type === "text/css") && /^<(?:!doctype\b|[a-z][\w:-]*[\s>/:]|\?xml)/i.test(head)) throw wrongType();
	if (type === HTML && /^(?:<svg[\s>/:]|%PDF-)/i.test(head)) throw wrongType();
	if (type === "application/json") {
		try { JSON.parse(text); } catch { throw wrongType(); }
	}
	return text;
}

function modelAddress(raw: string): string {
	const url = URL.parse(raw);
	if (!url) return "无法识别的地址";
	return url.host ? url.protocol + "//" + url.host : url.protocol;
}

/** A virtual origin. The browser never opens the real workspace paths or a listening server. */
export class RenderHtmlResources {
	readonly origin: string;
	readonly url: string;
	readonly blocked = new Map<string, string>();
	private readonly prefix: string;
	private readonly root: string;
	private readonly workspace: string;
	private readonly state: HarnessState;
	private readonly volumes?: RenderLocalVolumes;
	private readonly logBlocked?: RenderLog;
	private readonly goal?: RenderGoalScope;
	private readonly goalBlocked = new Set<string>();
	private readonly entry: Resource;
	private bytes: number;
	private requests = 0;

	private constructor(root: string, workspace: string, path: string, entry: Resource, bytes: number, state: HarnessState,
		volumes: RenderLocalVolumes | undefined, logBlocked: RenderLog | undefined, goal: RenderGoalScope | undefined) {
		const id = randomUUID().replaceAll("-", "");
		this.origin = "https://df-" + id + ".invalid";
		this.prefix = "/" + id + "/";
		this.url = this.origin + this.prefix + path.split(sep).map(encodeURIComponent).join("/");
		this.root = root;
		this.workspace = workspace;
		this.entry = entry;
		this.bytes = bytes;
		this.state = state;
		this.volumes = volumes;
		this.logBlocked = logBlocked;
		this.goal = goal;
	}

	static async create(state: HarnessState, workspace: string, filePath: string, signal: AbortSignal,
		logBlocked?: RenderLog, goal?: RenderGoalScope): Promise<RenderHtmlResources> {
		const sandbox = state.env.kind === "sandbox";
		if (!sandbox && /^[/\\]{2}/.test(filePath)) throw new ResourceError(LOCAL_DISK_REQUIRED);
		if (!localPathArgument(filePath)) throw new ResourceError("请选择工作区里的本地 HTML 文件");
		if (sandbox && /^[a-z]:/i.test(filePath)) throw new ResourceError("请选择蝶君沙箱里的本地 HTML 文件");
		const volumes = sandbox ? undefined : new RenderLocalVolumes();
		const rootPath = state.local(workspace);
		await volumes?.check(rootPath, signal);
		const logical = state.resolve(filePath);
		const requested = state.local(logical);
		await volumes?.check(requested, signal);
		signal.throwIfAborted();
		const root = await realpath(rootPath);
		await volumes?.check(root, signal);
		const path = await realpath(requested);
		await volumes?.check(path, signal);
		const rel = relativeTo(root, path);
		if (!rel) throw new RenderInputError("截图入口必须在授权工作区里（工作区以外的文件）。");
		if (!rel.split(sep).every(validSegment) || types[extname(path).toLowerCase()] !== HTML) throw new ResourceError("截图入口必须是 .html 或 .htm 文件");
		if (goal && !await goal(logical, path)) throw new ResourceError("截图入口超出目标允许的范围");
		const file = await readResource(state, path, HTML, signal);
		return new RenderHtmlResources(root, workspace, rel, file.resource, file.bytes, state, volumes, logBlocked, goal);
	}

	get goalBlockedCount(): number { return this.goalBlocked.size; }

	report(url: string, reason: string, error?: unknown): void {
		if (!url || this.blocked.size >= 30 || this.blocked.has(url) || this.goalBlocked.has(this.requestPath(url))) return;
		this.blocked.set(url, reason);
		this.logBlocked?.(url, reason, error);
	}

	private requestPath(raw: string): string {
		const url = URL.parse(raw);
		return url ? url.origin + url.pathname : raw;
	}

	publicBlocked(): [string, string][] {
		const reported = new Set<string>();
		return [...this.blocked].flatMap(([url, reason]) => {
			if (this.goalBlocked.has(this.requestPath(url))) return [];
			const address = modelAddress(url), key = address + "\0" + reason;
			if (reported.has(key)) return [];
			reported.add(key);
			return [[address, reason]];
		});
	}

	async get(raw: string, method: string, resourceType: string, signal: AbortSignal): Promise<Resource | undefined> {
		signal.throwIfAborted();
		const url = URL.parse(raw);
		if (!url || url.origin !== this.origin || url.username || url.password) { this.report(raw, "仅允许本地资源"); return; }
		// Chromium probes its implicit root favicon even on a self-contained page.
		if (url.pathname === "/favicon.ico" && method === "GET" && resourceType !== "Document") return { body: "", headers: [] };
		if (!url.pathname.startsWith(this.prefix) || (method !== "GET" && method !== "HEAD")) {
			this.report(raw, "超出授权范围"); return;
		}
		if (resourceType === "Document") {
			if (url.origin + url.pathname === this.url && method === "GET") return this.entry;
			this.report(raw, "只允许打开截图入口"); return;
		}
		try {
			if (++this.requests > MAX_REQUESTS) throw new ResourceError("本地资源数量已达上限");
			const segments = url.pathname.slice(this.prefix.length).split("/").map(decodeURIComponent);
			if (!segments.every(validSegment)) throw new ResourceError("超出授权范围");
			const type = types[extname(segments.at(-1)!).toLowerCase()];
			if (!type || type === HTML) throw new ResourceError("本地资源类型不支持");
			if (requestedTypes[resourceType] && !requestedTypes[resourceType](type)) throw wrongType();
			const path = await realpath(resolve(this.root, ...segments));
			const logical = this.state.env.resolve(this.workspace, segments.join("/"));
			if (this.goal && !await this.goal(logical, path)) {
				const key = this.requestPath(raw);
				if (!this.goalBlocked.has(key)) this.logBlocked?.(raw, "超出目标允许的范围");
				this.goalBlocked.add(key);
				return;
			}
			await this.volumes?.check(path, signal);
			if (!relativeTo(this.root, path)) throw new ResourceError("超出授权范围");
			const file = await readResource(this.state, path, type, signal, true, bytes => {
				if (this.bytes + bytes > MAX_TOTAL) throw new ResourceError("本地资源体积已达上限");
				this.bytes += bytes;
			});
			return method === "HEAD" ? { ...file.resource, body: "" } : file.resource;
		} catch (error) {
			signal.throwIfAborted();
			const reason = error instanceof ResourceError ? error.message : "本地资源无法读取";
			this.report(raw, reason, error);
		}
	}
}

async function readResource(state: HarnessState, path: string, type: string, signal: AbortSignal, quiet = false, reserve?: (bytes: number) => void) {
	if (state.security) {
		const denied = (cause?: unknown) => new ResourceError("安全路径策略拒绝访问", { cause });
		if (!await state.security.authorize(path, "render_html", quiet).catch(error => {
			throw error instanceof RenderInputError ? error : denied(error);
		})) throw denied();
	}
	signal.throwIfAborted();
	const handle = await open(path, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > MAX_FILE || await realpath(path) !== path) throw new ResourceError("本地资源不是可读取的常规文件或文件过大");
		reserve?.(info.size);
		const buffer = Buffer.alloc(info.size + 1);
		let length = 0;
		while (length < buffer.length) {
			signal.throwIfAborted();
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length !== info.size) throw new ResourceError("本地资源在读取时发生变化");
		const bytes = buffer.subarray(0, length);
		const text = checkedText(bytes, type);
		const body = text !== undefined && state.security ? Buffer.from(await state.security.read(path, text)) : bytes;
		const headers: Header[] = [
			{ name: "Content-Type", value: type + (utf8(type) ? "; charset=utf-8" : "") },
			{ name: "Cache-Control", value: "no-store" }, { name: "X-Content-Type-Options", value: "nosniff" },
		];
		if (type === HTML) headers.push({ name: "Content-Security-Policy", value: CSP }, { name: "Referrer-Policy", value: "no-referrer" },
			{ name: "X-DNS-Prefetch-Control", value: "off" });
		return { resource: { body: body.toString("base64"), headers }, bytes: length };
	} finally { await handle.close(); }
}
