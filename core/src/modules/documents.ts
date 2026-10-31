import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Core, CoreModule } from "../core.ts";
import { requireStr } from "../core.ts";
import { readZip } from "../cards/zip.ts";

/**
 * Documents dropped into a chat (plan §C3): PDF, Word, Excel, PowerPoint and
 * text files become text. Small ones go into the message; large ones are
 * passed by path and the agent reads them page by page with `read_document`.
 */

export type DocumentKind = "pdf" | "docx" | "xlsx" | "pptx" | "text";

export interface ConvertedDocument {
	path: string;
	name: string;
	kind: DocumentKind;
	text: string;
	chars: number;
	/** Pages (PDF), sheets (Excel) or slides (PowerPoint). */
	parts: number | null;
	size: number;
	/** Too long to inline: send the path and let the agent read it. */
	large: boolean;
}

/** Inline the text when it is at most this many characters. */
export const INLINE_LIMIT = 30_000;
const MAX_FILE = 200 * 1024 * 1024;

const TEXT_EXT = new Set([
	".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".xml", ".html", ".htm", ".log",
	".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".dart", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs", ".go", ".rs", ".rb", ".php",
	".swift", ".sql", ".sh", ".ps1", ".bat", ".css", ".scss", ".vue", ".svelte", ".tex", ".bib", ".r", ".m", ".lua", ".pl", ".srt", ".vtt",
]);

export function documentKind(path: string): DocumentKind | null {
	const ext = extname(path).toLowerCase();
	if (ext === ".pdf") return "pdf";
	if (ext === ".docx") return "docx";
	if (ext === ".xlsx" || ext === ".xlsm") return "xlsx";
	if (ext === ".pptx") return "pptx";
	if (TEXT_EXT.has(ext)) return "text";
	return null;
}

function decodeXml(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
		.replace(/&amp;/g, "&");
}

/** UTF-8 (with or without BOM), UTF-16 with BOM, else GB18030 (common for Chinese Windows files). */
export function decodeText(bytes: Buffer): string {
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
	} catch {
		try {
			return new TextDecoder("gb18030").decode(bytes);
		} catch {
			return bytes.toString("latin1");
		}
	}
}

const NL = "\n";

function entry(entries: { name: string; data: Buffer }[], name: string): string | undefined {
	return entries.find((e) => e.name === name)?.data.toString("utf8");
}

/** Word: paragraphs, tabs, line breaks and tables (as Markdown rows). */
export function docxText(buffer: Buffer): string {
	const entries = readZip(buffer);
	const xml = entry(entries, "word/document.xml");
	if (!xml) throw new Error("不是有效的 Word 文档");
	const body = xml.replace(/<w:tbl>([\s\S]*?)<\/w:tbl>/g, (_m, table: string) => {
		const rows = [...table.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((r) =>
			[...r[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((c) => paragraphs(c[0]).join(" ").replace(/\|/g, "\\|").trim()),
		);
		if (!rows.length) return "";
		const width = Math.max(...rows.map((r) => r.length));
		const line = (cells: string[]) => `| ${[...cells, ...Array(width - cells.length).fill("")].join(" | ")} |`;
		const markdown = [line(rows[0]!), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join(NL);
		return `<w:p><w:t>${markdown.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</w:t></w:p>`;
	});
	return paragraphs(body)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function paragraphs(xml: string): string[] {
	return [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g)].map((p) => {
		const style = p[0].match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? "";
		const inner = p[0].replace(/<w:tab\/>/g, "<w:t>\t</w:t>").replace(/<w:(?:br|cr)\b[^>]*\/>/g, "<w:t>\n</w:t>");
		const text = decodeXml([...inner.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join(""));
		const heading = style.match(/^(?:Heading|标题)\s*(\d)$/i);
		return heading && text.trim() ? `${"#".repeat(Number(heading[1]))} ${text.trim()}` : text;
	});
}

function columnIndex(ref: string): number {
	let n = 0;
	for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

/** Excel: every sheet as a Markdown table (values, not formulas). */
export function xlsxText(buffer: Buffer): { text: string; sheets: number } {
	const entries = readZip(buffer);
	const shared = [...(entry(entries, "xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
		decodeXml([...m[1]!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")),
	);
	const workbook = entry(entries, "xl/workbook.xml") ?? "";
	const rels = entry(entries, "xl/_rels/workbook.xml.rels") ?? "";
	const sheets = [...workbook.matchAll(/<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g)].map((m) => {
		const target = rels.match(new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${m[2]}"`));
		const path = (target?.[1] ?? target?.[2] ?? "").replace(/^\/?xl\//, "");
		return { name: decodeXml(m[1]!), file: `xl/${path}` };
	});
	const out: string[] = [];
	for (const sheet of sheets) {
		const xml = entry(entries, sheet.file);
		if (!xml) continue;
		const rows: string[][] = [];
		for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
			const cells: string[] = [];
			for (const c of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
				const attrs = c[1]!;
				const ref = attrs.match(/r="([A-Z]+\d+)"/)?.[1];
				const type = attrs.match(/t="(\w+)"/)?.[1];
				const inner = c[2] ?? "";
				let value = decodeXml(inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "");
				if (type === "s") value = shared[Number(value)] ?? "";
				else if (type === "inlineStr") value = decodeXml([...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
				else if (type === "b") value = value === "1" ? "TRUE" : "FALSE";
				const index = ref ? columnIndex(ref) : cells.length;
				while (cells.length < index) cells.push("");
				cells[index] = value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
			}
			rows.push(cells);
		}
		while (rows.length && rows[rows.length - 1]!.every((c) => !c)) rows.pop();
		out.push(`## ${sheet.name}`);
		if (!rows.length) {
			out.push("（空表）");
			continue;
		}
		const width = Math.max(...rows.map((r) => r.length));
		const line = (cells: string[]) => `| ${[...cells, ...Array(width - cells.length).fill("")].join(" | ")} |`;
		out.push(line(rows[0]!), line(Array(width).fill("---")), ...rows.slice(1).map(line), "");
	}
	return { text: out.join("\n").trim(), sheets: sheets.length };
}

/** PowerPoint: text of each slide. */
export function pptxText(buffer: Buffer): { text: string; slides: number } {
	const entries = readZip(buffer);
	const slides = entries
		.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
		.sort((a, b) => Number(a.name.match(/\d+/)![0]) - Number(b.name.match(/\d+/)![0]));
	const text = slides
		.map((s, i) => {
			const xml = s.data.toString("utf8");
			const paras = [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)]
				.map((p) => decodeXml([...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join("")))
				.filter((t) => t.trim());
			return `## 第 ${i + 1} 页\n${paras.join("\n")}`;
		})
		.join("\n\n");
	return { text, slides: slides.length };
}

/** PDF text per page (pdf.js); scanned pages without a text layer come back empty. */
export async function pdfText(buffer: Buffer): Promise<{ text: string; pages: number }> {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: false, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
	const pages: string[] = [];
	try {
		for (let i = 1; i <= doc.numPages; i++) {
			const page = await doc.getPage(i);
			const content = await page.getTextContent();
			let line = "";
			const lines: string[] = [];
			for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
				if (typeof item.str !== "string") continue;
				line += item.str;
				if (item.hasEOL) {
					lines.push(line);
					line = "";
				}
			}
			if (line) lines.push(line);
			pages.push(`--- 第 ${i} 页 ---\n${lines.join("\n").replace(/[ \t]+\n/g, "\n").trim()}`);
			page.cleanup();
		}
	} finally {
		await doc.destroy();
	}
	return { text: pages.join("\n\n"), pages: doc.numPages };
}

export async function convertDocument(path: string): Promise<ConvertedDocument> {
	const kind = documentKind(path);
	if (!kind) throw new Error(`不支持的文件类型：${extname(path) || basename(path)}`);
	const size = statSync(path).size;
	if (size > MAX_FILE) throw new Error("文件太大（超过 200 MB）");
	const buffer = readFileSync(path);
	let text: string;
	let parts: number | null = null;
	switch (kind) {
		case "pdf": {
			const r = await pdfText(buffer);
			text = r.text;
			parts = r.pages;
			if (!text.replace(/--- 第 \d+ 页 ---/g, "").trim()) text = "（这个 PDF 没有文字层，可能是扫描件；需要的话请把页面截图发给我。）";
			break;
		}
		case "docx":
			text = docxText(buffer);
			break;
		case "xlsx": {
			const r = xlsxText(buffer);
			text = r.text;
			parts = r.sheets;
			break;
		}
		case "pptx": {
			const r = pptxText(buffer);
			text = r.text;
			parts = r.slides;
			break;
		}
		default:
			text = decodeText(buffer);
	}
	return { path, name: basename(path), kind, text, chars: text.length, parts, size, large: text.length > INLINE_LIMIT };
}

const KIND_LABEL: Record<DocumentKind, string> = { pdf: "PDF", docx: "Word", xlsx: "Excel", pptx: "PowerPoint", text: "文本" };

/**
 * `files.convert` for the window, and the `read_document` tool (standard
 * mode) that reads a converted document in pages.
 */
export class DocumentsModule implements CoreModule {
	readonly modelFacing = true;
	private readonly cache = new Map<string, { mtime: number; doc: ConvertedDocument }>();

	constructor(core: Core) {
		core.register("files.convert", async (params) => {
			const doc = await this.convert(requireStr(params.path, "path"));
			const preview = doc.large ? doc.text.slice(0, 2000) : doc.text;
			return { ...doc, text: preview, kindLabel: KIND_LABEL[doc.kind] };
		});
		core.exemptFromApproval("read_document");
	}

	async convert(path: string): Promise<ConvertedDocument> {
		const mtime = statSync(path).mtimeMs;
		const hit = this.cache.get(path);
		if (hit && hit.mtime === mtime) return hit.doc;
		const doc = await convertDocument(path);
		this.cache.set(path, { mtime, doc });
		if (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value!);
		return doc;
	}

	extensions(): ExtensionFactory[] {
		const module = this;
		return [
			(pi: ExtensionAPI) => {
				pi.registerTool({
					name: "read_document",
					label: "读取文档",
					description:
						"Read a PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx) or text file as plain text, in chunks. Long documents: continue with start_index from the previous result.",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string", description: "Absolute path, or relative to the working directory" },
							start_index: { type: "number", description: "Character offset to continue from" },
							max_chars: { type: "number", description: "Characters to return (default 20000, max 60000)" },
						},
						required: ["path"],
					} as never,
					async execute(_id, params: { path: string; start_index?: number; max_chars?: number }, _signal, _onUpdate, ctx) {
						const { resolve } = await import("node:path");
						const path = resolve(ctx?.cwd ?? process.cwd(), params.path);
						const doc = await module.convert(path);
						const start = Math.max(0, Math.round(params.start_index ?? 0));
						const max = Math.min(60_000, Math.max(1000, Math.round(params.max_chars ?? 20_000)));
						const slice = doc.text.slice(start, start + max);
						const rest = doc.text.length - start - slice.length;
						const header = `${doc.name}（${KIND_LABEL[doc.kind]}${doc.parts ? `，${doc.parts} ${doc.kind === "pdf" ? "页" : doc.kind === "xlsx" ? "个工作表" : "页幻灯片"}` : ""}，共 ${doc.chars} 字${start ? `，从第 ${start} 字开始` : ""}）`;
						const footer = rest > 0 ? `\n\n…还有 ${rest} 字，继续读取用 start_index=${start + slice.length}。` : "";
						return { content: [{ type: "text", text: `${header}\n\n${slice}${footer}` }], details: { path, chars: doc.chars, start } };
					},
				});
			},
		];
	}
}
