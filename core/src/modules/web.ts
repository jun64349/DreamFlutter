import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/** fetch() that connects only to public addresses (see publicOnlyAgent). */
export function fetchPublic(url: URL, init: RequestInit): Promise<Response> {
	return undiciFetch(url, { ...(init as object), dispatcher: publicOnlyAgent() }) as unknown as Promise<Response>;
}

/** At most [limit] bytes of a response body; the rest is never downloaded. */
export async function readLimited(response: Response, limit: number): Promise<{ bytes: Buffer; truncated: boolean }> {
	const reader = response.body?.getReader();
	if (!reader) return { bytes: Buffer.alloc(0), truncated: false };
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (size <= limit) {
		const { done, value } = await reader.read();
		if (done) return { bytes: Buffer.concat(chunks), truncated: false };
		chunks.push(value);
		size += value.length;
	}
	await reader.cancel().catch(() => {});
	return { bytes: Buffer.concat(chunks).subarray(0, limit), truncated: true };
}
import type { CoreModule } from "../core.ts";

/** Loopback, private, link-local, carrier-grade NAT, multicast and unspecified addresses. */
export function isPrivateAddress(address: string): boolean {
	const v6 = address.toLowerCase().replace(/^\[|\]$/g, "");
	if (isIP(v6) === 4) {
		const [a, b] = v6.split(".").map(Number) as [number, number];
		return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
	}
	if (isIP(v6) !== 6) return true;
	const words = ipv6Words(v6);
	if (!words) return true;
	// IPv4-mapped (::ffff:a.b.c.d, also written ::ffff:7f00:1) and IPv4-compatible (::a.b.c.d): judge the IPv4 address.
	if (words.slice(0, 5).every((w) => w === 0) && (words[5] === 0xffff || words[5] === 0)) {
		if (words[5] === 0 && words[6] === 0 && words[7]! <= 1) return true; // :: and ::1
		return isPrivateAddress(`${words[6]! >> 8}.${words[6]! & 255}.${words[7]! >> 8}.${words[7]! & 255}`);
	}
	const first = words[0]!;
	// fc00::/7 unique local, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast, 64:ff9b::/96 NAT64.
	return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00 || (first === 0x64 && words[1] === 0xff9b);
}

/** The eight 16-bit words of an IPv6 address (with "::" and a dotted IPv4 tail expanded). */
function ipv6Words(address: string): number[] | undefined {
	let text = address.split("%")[0]!;
	const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
	if (tail) {
		const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
		text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const [head, rest] = text.split("::") as [string, string | undefined];
	const left = head ? head.split(":") : [];
	const right = rest ? rest.split(":") : [];
	const fill = rest === undefined ? 0 : 8 - left.length - right.length;
	const words = [...left, ...Array<string>(Math.max(0, fill)).fill("0"), ...right].map((w) => Number.parseInt(w, 16));
	return words.length === 8 && words.every((w) => w >= 0 && w <= 0xffff) ? words : undefined;
}

/** Throws unless [url]'s host resolves only to public addresses (蝶君's fetches: never this machine or the LAN). */
export async function requirePublicHost(url: URL): Promise<void> {
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
	if (!addresses.length) throw new Error(`找不到主机 ${host}`);
	if (addresses.some(isPrivateAddress)) throw new Error(`${host} 指向本机或内网地址，不允许访问`);
}

/**
 * A connection pool that checks every address it actually connects to (the
 * check above resolves the name once; a name can answer differently when
 * the connection resolves it again). IP literals never resolve: checked above.
 */
let publicAgent: Agent | undefined;
export function publicOnlyAgent(): Agent {
	publicAgent ??= new Agent({
		connect: {
			lookup: (hostname, options, callback) => {
				dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
					if (error) return callback(error, "", 4);
					const list = addresses as unknown as LookupAddress[];
					const bad = list.find((a) => isPrivateAddress(a.address));
					if (bad || !list.length) return callback(new Error(`${hostname} 指向本机或内网地址，不允许访问`), "", 4);
					if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
					callback(null, list[0]!.address, list[0]!.family);
				});
			},
		},
	});
	return publicAgent;
}

const MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_CHARS = 20_000;
const MAX_CHARS = 100_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", copy: "©", reg: "®", middot: "·", laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’" };

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
		if (code[0] === "#") {
			const n = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
		}
		return ENTITIES[code.toLowerCase()] ?? m;
	});
}

function absolute(href: string, base: string): string {
	try {
		return new URL(decodeEntities(href), base).href;
	} catch {
		return href;
	}
}

/** The largest <article>/<main> block, else <body>, else everything. */
function mainContent(html: string): string {
	const candidates = [...html.matchAll(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]!);
	if (candidates.length) return candidates.sort((a, b) => b.length - a.length)[0]!;
	const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
	return body ? body[1]! : html;
}

/** Readable Markdown-ish text from an HTML page (no dependencies). */
export function htmlToText(html: string, baseUrl: string): { title: string; text: string } {
	const title = decodeEntities(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
	let s = html.replace(/<!--[\s\S]*?-->/g, "");
	s = s.replace(/<(script|style|noscript|svg|template|iframe|canvas|head)\b[\s\S]*?<\/\1>/gi, "");
	s = mainContent(s);
	s = s.replace(/<(nav|footer|aside|form|button|select)\b[\s\S]*?<\/\1>/gi, "");
	// Keep preformatted blocks verbatim.
	const blocks: string[] = [];
	s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
		blocks.push(decodeEntities(inner.replace(/<[^>]+>/g, "")));
		return `\n\n\u0000${blocks.length - 1}\u0000\n\n`;
	});
	s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => `\n\n${"#".repeat(Number(level))} ${inner.replace(/<[^>]+>/g, "").trim()}\n\n`);
	s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
		const label = inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
		if (!label) return "";
		if (/^(javascript:|#)/i.test(href)) return label;
		return `[${label}](${absolute(href, baseUrl)})`;
	});
	s = s.replace(/<img\b[^>]*alt\s*=\s*["']([^"']+)["'][^>]*>/gi, (_m, alt: string) => (alt.trim() ? `[图片：${alt.trim()}]` : ""));
	s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
	s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
	s = s.replace(/<li\b[^>]*>/gi, "\n- ");
	s = s.replace(/<(td|th)\b[^>]*>/gi, " | ");
	s = s.replace(/<br\s*\/?>/gi, "\n");
	s = s.replace(/<\/?(p|div|section|ul|ol|table|tr|blockquote|dl|dt|dd|figure|figcaption|header)\b[^>]*>/gi, "\n\n");
	s = s.replace(/<[^>]+>/g, "");
	s = decodeEntities(s);
	s = s
		.split("\n")
		.map((line) => line.replace(/[ \t ]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => "```\n" + blocks[Number(i)]!.replace(/\n+$/, "") + "\n```");
	return { title, text: s };
}

function charsetOf(contentType: string, head: Uint8Array): string {
	const fromHeader = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
	if (fromHeader) return fromHeader;
	const sniff = new TextDecoder("latin1").decode(head.slice(0, 2048));
	return sniff.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? "utf-8";
}

/** Downloads [url] (http/https only, size-capped) and returns readable text. */
export async function fetchPage(
	url: string,
	options: {
		timeoutMs?: number;
		signal?: AbortSignal;
		allowHttpErrors?: boolean;
		/** Follows redirects one at a time, letting this refuse (throw) each next address. */
		checkRedirect?: (next: URL) => Promise<void>;
		/** Connect only to public addresses (checked at connection time, every redirect included). */
		publicOnly?: boolean;
	} = {},
): Promise<{ url: string; title: string; text: string; contentType: string; status: number }> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("网址格式不对");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("只支持 http 和 https 网址");
	const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 30_000), ...(options.signal ? [options.signal] : [])]);
	const headers = {
		"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 DreamFlutter",
		Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
		"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
	};
	const get = (target: URL, redirect: RequestRedirect): Promise<Response> =>
		options.publicOnly
			? fetchPublic(target, { signal, headers, redirect })
			: fetch(target, { signal, headers, redirect });
	let response = await get(parsed, options.checkRedirect ? "manual" : "follow");
	for (let hops = 0; options.checkRedirect && response.status >= 300 && response.status < 400 && response.headers.has("location"); hops++) {
		if (hops >= 5) throw new Error("网页跳转次数太多");
		await response.body?.cancel();
		parsed = new URL(response.headers.get("location")!, parsed);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("只支持 http 和 https 网址");
		await options.checkRedirect(parsed);
		response = await get(parsed, "manual");
	}
	if (!response.ok && !options.allowHttpErrors) throw new Error(`网站返回 ${response.status} ${response.statusText}`);
	const status = response.status;
	const contentType = response.headers.get("content-type") ?? "";
	if (/^(image|audio|video)\/|application\/(pdf|zip|octet-stream)/i.test(contentType)) throw new Error(`这是 ${contentType.split(";")[0]} 文件，不是网页，无法转成文字`);
	const reader = response.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (reader) {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > MAX_BYTES) {
				await reader.cancel();
				break;
			}
			chunks.push(value);
		}
	}
	const bytes = new Uint8Array(size > MAX_BYTES ? MAX_BYTES : size);
	let offset = 0;
	for (const c of chunks) {
		bytes.set(c.subarray(0, Math.min(c.length, bytes.length - offset)), offset);
		offset += c.length;
		if (offset >= bytes.length) break;
	}
	let decoder: InstanceType<typeof TextDecoder>;
	try {
		decoder = new TextDecoder(charsetOf(contentType, bytes));
	} catch {
		decoder = new TextDecoder("utf-8");
	}
	const body = decoder.decode(bytes);
	const finalUrl = response.url || parsed.href;
	if (/html|xml/i.test(contentType) || /^\s*</.test(body)) {
		const { title, text } = htmlToText(body, finalUrl);
		return { url: finalUrl, title, text, contentType, status };
	}
	if (/json/i.test(contentType)) {
		try {
			return { url: finalUrl, title: "", text: JSON.stringify(JSON.parse(body), null, 2), contentType, status };
		} catch {}
	}
	return { url: finalUrl, title: "", text: body, contentType, status };
}

/** The `web_fetch` tool: read a web page as text (read-only, no approval needed). */
export class WebModule implements CoreModule {
	extensions(): ExtensionFactory[] {
		return [
			(pi: ExtensionAPI) => {
				pi.registerTool({
					name: "web_fetch",
					label: "读取网页",
					description:
						"Fetch a web page (http/https) and return its main text as Markdown, with links made absolute. Long pages are paged: pass start_index from the previous result to continue. Not for binary files.",
					parameters: {
						type: "object",
						properties: {
							url: { type: "string" },
							max_chars: { type: "number", description: `Characters to return (default ${DEFAULT_CHARS}, max ${MAX_CHARS})` },
							start_index: { type: "number", description: "Offset into the page text, for continuing a long page" },
						},
						required: ["url"],
					} as never,
					async execute(_id, params: { url: string; max_chars?: number; start_index?: number }, signal) {
						const max = Math.min(Math.max(1000, Math.round(params.max_chars ?? DEFAULT_CHARS)), MAX_CHARS);
						const start = Math.max(0, Math.round(params.start_index ?? 0));
						const page = await fetchPage(params.url, { signal: signal ?? undefined });
						const slice = page.text.slice(start, start + max);
						const rest = page.text.length - (start + slice.length);
						const header = [`网址：${page.url}`, page.title ? `标题：${page.title}` : "", `正文共 ${page.text.length} 字${start ? `，从第 ${start} 字开始` : ""}`].filter(Boolean).join("\n");
						const footer = rest > 0 ? `\n\n…还有 ${rest} 字没显示，需要时用 start_index=${start + slice.length} 继续读取。` : "";
						return { content: [{ type: "text", text: `${header}\n\n${slice || "（这一页没有可读的文字）"}${footer}` }], details: { url: page.url, title: page.title, length: page.text.length } };
					},
				});
			},
		];
	}
}

/** Existing harness policy, shared by the configurable fetch adapter without changing fetchPage. */
export async function fetchToolPage(url: string, signal?: AbortSignal, sandbox?: { online(): boolean }) {
	let checkRedirect: ((next: URL) => Promise<void>) | undefined;
	if (sandbox) {
		if (!sandbox.online()) throw new Error("沙箱现在是离线的，不能读取网页（可以在设置 › 蝶君沙箱里允许联网）");
		let first: URL;
		try { first = new URL(url); } catch { throw new Error("网址格式不对"); }
		await requirePublicHost(first);
		checkRedirect = requirePublicHost;
	}
	return fetchPage(url, { signal, allowHttpErrors: true, timeoutMs: 60_000, checkRedirect, publicOnly: sandbox !== undefined });
}

/** Check before sending any target URL to a third party, including cancellable DNS resolution. */
export async function requireRemoteWebUrl(raw: string, userSignal?: AbortSignal): Promise<URL> {
	let url: URL;
	try { url = new URL(raw); } catch { throw new Error("网址格式不对"); }
	if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error("只允许 http 或 https 网页地址");
	if (url.username || url.password) throw new Error("不允许在网址中携带用户名或密码");
	if (raw.length > 8192 || url.href.length > 8192) throw new Error("网页地址不能超过 8192 个字符");
	const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(userSignal ? [userSignal] : [])]);
	signal.throwIfAborted();
	await new Promise<void>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		requirePublicHost(url).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
	return url;
}
