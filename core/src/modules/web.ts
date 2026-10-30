import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { CoreModule } from "../core.ts";

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
	options: { timeoutMs?: number; signal?: AbortSignal; allowHttpErrors?: boolean } = {},
): Promise<{ url: string; title: string; text: string; contentType: string; status: number }> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("网址格式不对");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("只支持 http 和 https 网址");
	const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 30_000), ...(options.signal ? [options.signal] : [])]);
	const response = await fetch(parsed, {
		signal,
		redirect: "follow",
		headers: {
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 DreamFlutter",
			Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
			"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
		},
	});
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
