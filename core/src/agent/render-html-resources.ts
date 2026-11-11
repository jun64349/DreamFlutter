import { randomUUID } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { HarnessState } from "./state.ts";
import { redact } from "../security/redaction.ts";

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
const CSP = [
	"default-src 'none'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self'", "base-uri 'none'",
	"form-action 'none'", "frame-src 'none'", "worker-src 'none'", "sandbox allow-scripts allow-same-origin",
].join("; ");

type Header = { name: string; value: string };
export type Resource = { body: string; headers: Header[] };

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

/** A virtual origin. The browser never opens the real workspace paths or a listening server. */
export class RenderHtmlResources {
	readonly origin: string;
	readonly url: string;
	readonly blocked = new Map<string, string>();
	private readonly prefix: string;
	private readonly root: string;
	private readonly state: HarnessState;
	private readonly entry: Resource;
	private bytes: number;
	private requests = 0;

	private constructor(root: string, path: string, entry: Resource, bytes: number, state: HarnessState) {
		const id = randomUUID().replaceAll("-", "");
		this.origin = "https://df-" + id + ".invalid";
		this.prefix = "/" + id + "/";
		this.url = this.origin + this.prefix + path.split(sep).map(encodeURIComponent).join("/");
		this.root = root;
		this.entry = entry;
		this.bytes = bytes;
		this.state = state;
	}

	static async create(state: HarnessState, workspace: string, filePath: string, signal: AbortSignal): Promise<RenderHtmlResources> {
		if (!localPathArgument(filePath)) throw new Error("请选择工作区里的本地 HTML 文件。");
		const sandbox = state.env.kind === "sandbox";
		if (sandbox && /^[a-z]:/i.test(filePath)) throw new Error("请选择蝶君沙箱里的本地 HTML 文件。");
		const root = await realpath(state.local(workspace));
		if (!sandbox && /^(?:\\\\|\/\/)(?:wsl\.localhost|wsl\$)[\\/]/i.test(root)) throw new Error("工作台截图只读取 Windows 工作区。");
		const requested = state.local(state.resolve(filePath));
		const path = await realpath(requested);
		const rel = relativeTo(root, path);
		if (!rel || !rel.split(sep).every(validSegment) || types[extname(path).toLowerCase()] !== HTML) {
			throw new Error("截图入口必须是授权工作区里的 .html 或 .htm 文件。");
		}
		const file = await readResource(state, path, HTML, signal);
		return new RenderHtmlResources(root, rel, file.resource, file.bytes, state);
	}

	report(url: string, reason: string): void {
		if (!url || this.blocked.size >= 30) return;
		const title = url.startsWith(this.origin) ? this.displayLocal(url.slice(this.origin.length)) : url;
		const name = redact(title, true).slice(0, 320);
		if (name && !this.blocked.has(name)) this.blocked.set(name, reason);
	}

	private displayLocal(value: string): string {
		const path = value.startsWith(this.prefix) ? value.slice(this.prefix.length) : value;
		try { return decodeURI(path); } catch { return path; }
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
			if (++this.requests > MAX_REQUESTS) throw new Error("本地资源数量已达上限");
			const segments = url.pathname.slice(this.prefix.length).split("/").map(decodeURIComponent);
			if (!segments.every(validSegment)) throw new Error("超出授权范围");
			const type = types[extname(segments.at(-1)!).toLowerCase()];
			if (!type || type === HTML) throw new Error("本地资源类型不支持");
			const path = await realpath(resolve(this.root, ...segments));
			if (!relativeTo(this.root, path)) throw new Error("超出授权范围");
			const file = await readResource(this.state, path, type, signal, true, bytes => {
				if (this.bytes + bytes > MAX_TOTAL) throw new Error("本地资源体积已达上限");
				this.bytes += bytes;
			});
			return method === "HEAD" ? { ...file.resource, body: "" } : file.resource;
		} catch (error) {
			signal.throwIfAborted();
			const reason = error instanceof Error && !("code" in error) ? error.message : "本地资源无法读取";
			this.report(raw, reason);
		}
	}
}

async function readResource(state: HarnessState, path: string, type: string, signal: AbortSignal, quiet = false, reserve?: (bytes: number) => void) {
	if (state.security && !await state.security.authorize(path, "render_html", quiet)) throw new Error("安全路径策略拒绝访问");
	signal.throwIfAborted();
	const handle = await open(path, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > MAX_FILE || await realpath(path) !== path) throw new Error("本地资源不是可读取的常规文件或文件过大");
		reserve?.(info.size);
		const buffer = Buffer.alloc(info.size + 1);
		let length = 0;
		while (length < buffer.length) {
			signal.throwIfAborted();
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length !== info.size) throw new Error("本地资源在读取时发生变化");
		const bytes = buffer.subarray(0, length);
		const body = utf8(type) && state.security
			? Buffer.from(await state.security.read(path, bytes.toString("utf8"))) : bytes;
		const headers: Header[] = [
			{ name: "Content-Type", value: type + (utf8(type) ? "; charset=utf-8" : "") },
			{ name: "Cache-Control", value: "no-store" }, { name: "X-Content-Type-Options", value: "nosniff" },
		];
		if (type === HTML) headers.push({ name: "Content-Security-Policy", value: CSP }, { name: "Referrer-Policy", value: "no-referrer" });
		return { resource: { body: body.toString("base64"), headers }, bytes: length };
	} finally { await handle.close(); }
}
