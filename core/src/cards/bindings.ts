import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fetchPage, fetchPublic, isPrivateAddress, readLimited } from "../modules/web.ts";
import { CODES, isPlainObject, type CardBinding } from "./document.ts";

/**
 * The tools this host offers to card bindings (§4.2: the host defines and
 * publishes the tool space) and the authorization unit each call needs
 * (§4.6: kind + subject - host name, program, tool name or declared folder).
 *
 * Shapes are pinned at mint time (§4.1, §4.2): the manifest declares the
 * boundary (hosts, folders, the program and its arguments, the method) and a
 * runtime input can only fill the declared slots.
 */

export type GrantKind = "net" | "exec" | "tool" | "dir";

export interface Unit {
	kind: GrantKind;
	subject: string;
}

export class BindingError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export interface BindingContext {
	cwd: string;
	sendNotice(title: string, body: string): Promise<boolean>;
	/** Tests only: allow http and loopback targets. */
	allowLocalNetwork?: boolean;
}

/** One call, fully resolved: what is asked for and exactly what will run (§4.6: shown as is). */
export interface PreparedCall {
	unit: Unit | null;
	/** Human-readable description of the complete call. */
	summary: string;
	run(): Promise<Record<string, unknown>>;
}

interface ToolSpec {
	label: string;
	/** Statically readable units of a declaration (for listing; §4.6). */
	units(binding: CardBinding, cwd: string): Unit[];
	prepare(binding: CardBinding, input: Record<string, unknown>, ctx: BindingContext, raw: unknown): Promise<PreparedCall> | PreparedCall;
}

const BODY_LIMIT = 1024 * 1024;
const unavailable = (message: string) => new BindingError(CODES.TOOL_UNAVAILABLE, message);
const invalid = (message: string) => new BindingError(CODES.INVALID_INPUT, message);

function list(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

function declaredHosts(binding: CardBinding): string[] {
	return list(binding.input?.hosts).map((h) => h.toLowerCase());
}

function hostAllowed(hosts: string[], host: string): boolean {
	return hosts.some((h) => h === host || (h.startsWith("*.") && host.endsWith(h.slice(1))));
}

/**
 * Read bindings' transport baseline (§4.3): declared hosts only, https only,
 * no internal or loopback addresses.
 */
async function checkTarget(binding: CardBinding, url: unknown, ctx: BindingContext): Promise<URL> {
	if (typeof url !== "string" || !url) throw invalid("缺少 url");
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw invalid("网址格式不对");
	}
	const hosts = declaredHosts(binding);
	if (!hosts.length) throw unavailable("这个绑定没有声明可访问的主机（manifest 的 input.hosts）");
	const host = parsed.hostname.toLowerCase();
	if (!hostAllowed(hosts, host)) throw unavailable(`${host} 不在这张卡声明的主机里`);
	if (ctx.allowLocalNetwork) return parsed;
	if (parsed.protocol !== "https:") throw invalid("只能访问 https 网址");
	const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
	if (!addresses.length) throw new BindingError(CODES.TOOL_FAILED, `找不到主机 ${host}`);
	if (addresses.some(isPrivateAddress)) throw unavailable(`${host} 指向内网或本机地址，不允许访问`);
	return parsed;
}

const SENSITIVE_HEADERS = /^(authorization|cookie|proxy-authorization|x-api-key|api-key|x-auth-token)$/i;

function within(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Declared folders (relative ones resolve against the card's workspace). */
function declaredDirs(binding: CardBinding, cwd: string): string[] {
	return list(binding.input?.dirs).map((d) => resolve(cwd, d));
}

/** [path] with links (junctions, symlinks) resolved: the nearest existing ancestor's real path plus the rest. */
function realTarget(path: string): string {
	const rest: string[] = [];
	let existing = path;
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) return path;
		rest.unshift(basename(existing));
		existing = parent;
	}
	try {
		return join(realpathSync.native(existing), ...rest);
	} catch {
		return path;
	}
}

function fileTarget(binding: CardBinding, input: Record<string, unknown>, ctx: BindingContext): { path: string; dir: string } {
	const dirs = declaredDirs(binding, ctx.cwd);
	if (!dirs.length) throw unavailable("这个绑定没有声明可访问的文件夹（manifest 的 input.dirs）");
	if (typeof input.path !== "string" || !input.path) throw invalid("缺少 path");
	const path = resolve(dirs[0]!, input.path);
	const dir = dirs.find((d) => within(path, d));
	if (!dir) throw unavailable(`${path} 不在这张卡声明的文件夹里`);
	// A link inside the folder must not lead outside it.
	if (!within(realTarget(path), realTarget(dir))) throw unavailable(`${path} 经由链接指向了声明的文件夹之外`);
	return { path, dir };
}

function programName(program: string): string {
	return basename(program).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
}

const TOOLS: Record<string, ToolSpec> = {
	"time.now": {
		label: "读取当前时间",
		units: () => [],
		prepare: () => ({
			unit: null,
			summary: "读取当前时间",
			async run() {
				const now = new Date();
				return { iso: now.toISOString(), epochMs: now.getTime(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, local: now.toLocaleString("zh-CN") };
			},
		}),
	},
	"fetch.request": {
		label: "经宿主访问网络",
		units: (binding) => declaredHosts(binding).map((h) => ({ kind: "net" as const, subject: h })),
		async prepare(binding, input, ctx) {
			const url = await checkTarget(binding, input.url, ctx);
			const method = (typeof binding.input?.method === "string" ? binding.input.method : "GET").toUpperCase();
			if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) throw invalid(`不支持的方法 ${method}`);
			const headers: Record<string, string> = {};
			const declared = isPlainObject(binding.input?.headers) ? binding.input.headers : {};
			for (const [k, v] of Object.entries(declared)) if (typeof v === "string" && !SENSITIVE_HEADERS.test(k)) headers[k] = v;
			const body = method === "GET" || method === "HEAD" ? undefined : typeof input.body === "string" ? input.body : input.body != null ? JSON.stringify(input.body) : undefined;
			if (body !== undefined && !headers["content-type"] && typeof input.body !== "string") headers["content-type"] = "application/json";
			return {
				unit: { kind: "net", subject: url.hostname.toLowerCase() },
				summary: `${method} ${url.href}${body ? `\n请求体：${body.slice(0, 500)}` : ""}`,
				async run() {
					const init: RequestInit = { method, headers, body, signal: AbortSignal.timeout(30_000), redirect: "manual" };
					const response = ctx.allowLocalNetwork ? await fetch(url, init) : await fetchPublic(url, init);
					const { bytes, truncated } = await readLimited(response, BODY_LIMIT);
					const text = bytes.toString("utf8");
					const result: Record<string, unknown> = { status: response.status, ok: response.ok, contentType: response.headers.get("content-type"), body: text, truncated };
					if (/json/i.test(response.headers.get("content-type") ?? "")) {
						try {
							result.json = JSON.parse(text);
						} catch {}
					}
					return result;
				},
			};
		},
	},
	"web.read": {
		label: "读取网页正文",
		units: (binding) => declaredHosts(binding).map((h) => ({ kind: "net" as const, subject: h })),
		async prepare(binding, input, ctx) {
			const url = await checkTarget(binding, input.url, ctx);
			return {
				unit: { kind: "net", subject: url.hostname.toLowerCase() },
				summary: `读取网页 ${url.href}`,
				async run() {
					// Each redirect passes the same checks as the first address (declared host, https, no internal address).
					const page = await fetchPage(url.href, { checkRedirect: async (next) => void (await checkTarget(binding, next.href, ctx)), publicOnly: !ctx.allowLocalNetwork });
					return { url: page.url, title: page.title, text: page.text.slice(0, 100_000) };
				},
			};
		},
	},
	"fs.read": {
		label: "读取文件",
		units: (binding, cwd) => declaredDirs(binding, cwd).map((d) => ({ kind: "dir" as const, subject: d })),
		prepare(binding, input, ctx) {
			const { path, dir } = fileTarget(binding, input, ctx);
			return {
				unit: { kind: "dir", subject: dir },
				summary: `读取文件 ${path}`,
				async run() {
					if (statSync(path).size > BODY_LIMIT * 5) throw invalid("文件超过 5 MB");
					return { path, text: readFileSync(path, "utf8") };
				},
			};
		},
	},
	"fs.list": {
		label: "列出文件夹",
		units: (binding, cwd) => declaredDirs(binding, cwd).map((d) => ({ kind: "dir" as const, subject: d })),
		prepare(binding, input, ctx) {
			const { path, dir } = fileTarget(binding, { path: ".", ...input }, ctx);
			return {
				unit: { kind: "dir", subject: dir },
				summary: `列出文件夹 ${path}`,
				async run() {
					return { path, entries: readdirSync(path, { withFileTypes: true }).slice(0, 2000).map((e) => ({ name: e.name, dir: e.isDirectory() })) };
				},
			};
		},
	},
	"fs.write": {
		label: "写入文件",
		units: (binding, cwd) => declaredDirs(binding, cwd).map((d) => ({ kind: "dir" as const, subject: d })),
		prepare(binding, input, ctx) {
			const { path, dir } = fileTarget(binding, input, ctx);
			if (typeof input.text !== "string") throw invalid("缺少 text");
			const text = input.text;
			return {
				unit: { kind: "dir", subject: dir },
				summary: `写入文件 ${path}（${Buffer.byteLength(text)} 字节）`,
				async run() {
					mkdirSync(dirname(path), { recursive: true });
					writeFileSync(path, text, "utf8");
					return { path, bytes: Buffer.byteLength(text) };
				},
			};
		},
	},
	"exec.run": {
		label: "运行程序",
		units: (binding) => (typeof binding.input?.program === "string" ? [{ kind: "exec" as const, subject: programName(binding.input.program) }] : []),
		prepare(binding, input, ctx) {
			// The command is pinned by the declaration; the only runtime slot is stdin.
			const program = binding.input?.program;
			if (typeof program !== "string" || !program) throw unavailable("这个绑定没有声明要运行的程序（manifest 的 input.program）");
			const args = list(binding.input?.args);
			const stdin = typeof input.stdin === "string" ? input.stdin : undefined;
			return {
				unit: { kind: "exec", subject: programName(program) },
				summary: `运行 ${[program, ...args].join(" ")}（工作文件夹 ${ctx.cwd}）${stdin ? `，输入 ${stdin.length} 字` : ""}`,
				run: () =>
					new Promise((done) => {
						const child = execFile(program, args, { cwd: ctx.cwd, timeout: 60_000, maxBuffer: BODY_LIMIT, windowsHide: true }, (error, stdout, stderr) => {
							const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? -1 : 0;
							done({ exitCode: code, stdout: String(stdout), stderr: String(stderr || (code === -1 && error ? error.message : "")) });
						});
						if (stdin !== undefined) child.stdin?.end(stdin);
					}),
			};
		},
	},
	"notify.send": {
		label: "发送系统通知",
		units: () => [{ kind: "tool", subject: "notify.send" }],
		prepare(_binding, input, ctx) {
			const title = String(input.title ?? "卡片提醒").slice(0, 80);
			const body = String(input.body ?? "").slice(0, 300);
			return {
				unit: { kind: "tool", subject: "notify.send" },
				summary: `发送系统通知「${title}」${body ? `：${body}` : ""}`,
				async run() {
					return { sent: await ctx.sendNotice(title, body) };
				},
			};
		},
	},
};

/** The tool space this host publishes to bindings. */
export const AVAILABLE_TOOLS = Object.keys(TOOLS);

export function knownTool(tool: string): boolean {
	return Object.hasOwn(TOOLS, tool);
}

export function toolLabel(tool: string): string {
	return TOOLS[tool]?.label ?? tool;
}

/** Units a declaration names, for showing what a card may ask for. */
export function declaredUnits(binding: CardBinding, cwd: string): Unit[] {
	return TOOLS[binding.tool]?.units(binding, cwd) ?? [];
}

/** [raw]: the call input as the card sent it (null when none). */
export async function prepareCall(binding: CardBinding, raw: unknown, ctx: BindingContext): Promise<PreparedCall> {
	const spec = TOOLS[binding.tool];
	if (!spec) throw unavailable(`这个宿主不提供工具 ${binding.tool}`);
	return spec.prepare(binding, isPlainObject(raw) ? raw : {}, ctx, raw);
}

/** Tests only: a harmless tool (the conformance suite binds `conformance.echo`). */
export function defineTestTool(name: string, run: (input: unknown) => Record<string, unknown>): void {
	TOOLS[name] = { label: name, units: () => [], prepare: (_binding, _input, _ctx, raw) => ({ unit: null, summary: name, run: async () => run(raw) }) };
}

/** Units that read local data, and units that send data out (§4.6: judged by subject). */
export function readsLocal(unit: Unit): boolean {
	return unit.kind === "dir" || unit.kind === "exec";
}

export function sendsOut(unit: Unit): boolean {
	return unit.kind === "net" || unit.kind === "exec";
}
