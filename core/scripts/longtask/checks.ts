import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { crc32 } from "node:zlib";
import { JSDOM } from "jsdom";
import { readZip } from "../../src/cards/zip.ts";
import type { Case } from "./cases.ts";
import { MIN_HEADINGS, sha256, wordNamespace, type Answers } from "./fixtures/generate.ts";

type Tool = { id: string; name: string; args: Record<string, unknown>; session: string; seq: number; ok: boolean; images?: string[] };
export interface Evidence {
	status: string;
	missing: string[];
	tools: Tool[];
	job?: { start: number; end: number; userAt: number; replyAt: number; continuationAt: number; sameGoal: boolean; automatic: boolean; status: string };
	restart?: { before: string; after: string; resumed: boolean; checkpointSha: string; checkpointMtime: number; rewrites: number };
}
export type Check = { id: string; title: string; passed: boolean; detail: string };

/** Model-controlled filenames never escape the isolated case directory. */
export function regularFile(root: string, path: string): string {
	const entry = join(root, path);
	const real = realpathSync(entry);
	const rel = relative(realpathSync(root), real);
	if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel) || !lstatSync(entry).isFile()) throw new Error("文件不在任务范围内");
	return real;
}

export function wordHeadings(data: Buffer): number {
	const parts = new Map(readZip(data, 32 * 1024 * 1024).map(entry => [entry.name, entry.data.toString("utf8")]));
	if (!parts.has("[Content_Types].xml") || !parts.get("_rels/.rels")?.includes("word/document.xml")) throw new Error("缺少 Word 包入口");
	const xml = parts.get("word/document.xml");
	if (!xml) throw new Error("缺少 Word 正文");
	const view = new JSDOM(xml, { contentType: "text/xml" });
	try {
		const doc = view.window.document;
		if (doc.documentElement.localName !== "document" || doc.documentElement.namespaceURI !== wordNamespace
			|| doc.getElementsByTagNameNS(wordNamespace, "body").length !== 1) throw new Error("Word 正文结构无效");
		return [...doc.getElementsByTagNameNS(wordNamespace, "p")].filter(p => {
			const style = p.getElementsByTagNameNS(wordNamespace, "pStyle")[0]?.getAttributeNS(wordNamespace, "val");
			const text = [...p.getElementsByTagNameNS(wordNamespace, "t")].map(t => t.textContent).join("").trim();
			return !!text && /^heading[1-9]$/i.test(style ?? "");
		}).length;
	} finally { view.window.close(); }
}

export function validPng(data: Buffer): boolean {
	if (data.length < 45 || !data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return false;
	let idat = false;
	for (let offset = 8; offset + 12 <= data.length;) {
		const size = data.readUInt32BE(offset);
		const end = offset + size + 12;
		if (end > data.length || crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) return false;
		const kind = data.toString("ascii", offset + 4, offset + 8);
		if (offset === 8 && (kind !== "IHDR" || size !== 13 || !data.readUInt32BE(offset + 8) || !data.readUInt32BE(offset + 12))) return false;
		if (kind === "IDAT" && size) idat = true;
		if (kind === "IEND") return size === 0 && idat && end === data.length;
		offset = end;
	}
	return false;
}

function parseHtml(text: string, condition: (doc: Document) => boolean): boolean {
	const view = new JSDOM(text);
	try { return condition(view.window.document); }
	finally { view.window.close(); }
}

const normalized = (path: unknown) => typeof path === "string" ? path.replaceAll("\\", "/") : "";
const named = (value: unknown, path: string) => {
	const name = normalized(value);
	return name === path || name.endsWith("/" + path);
};

export function readSessionEvidence(text: string, session: string): Tool[] {
	const tools = new Map<string, Tool>();
	for (const [seq, line] of text.split(/\r?\n/).entries()) {
		if (!line) continue;
		const entry = JSON.parse(line);
		if (entry.type !== "message" || !Array.isArray(entry.message?.content)) continue;
		const message = entry.message;
		if (message.role === "assistant") for (const block of message.content) {
			if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string")
				tools.set(block.id, { id: block.id, name: block.name, args: block.arguments ?? {}, session, seq, ok: false });
		}
		if (message.role === "toolResult") {
			const tool = tools.get(message.toolCallId);
			if (!tool || tool.name !== message.toolName || message.isError !== false) continue;
			tool.ok = true;
			if (tool.name === "render_html") tool.images = message.content.filter((part: { type: string; mimeType?: string; data?: string }) =>
				part.type === "image" && part.mimeType === "image/png" && typeof part.data === "string").map((part: { data: string }) => part.data);
		}
	}
	return [...tools.values()];
}

export function evaluate(item: Case, root: string, answers: Answers, evidence: Evidence): Check[] {
	const checks: Check[] = [];
	const file = (path: string) => regularFile(root, path);
	const bytes = (path: string) => readFileSync(file(path));
	const text = (path: string) => bytes(path).toString("utf8").replace(/^\uFEFF/, "");
	const json = (path: string) => JSON.parse(text(path));
	const check = (id: string, title: string, test: () => boolean, expected: string) => {
		try { checks.push({ id, title, passed: test(), detail: expected }); }
		catch (error) { checks.push({ id, title, passed: false, detail: (error as NodeJS.ErrnoException).code === "ENOENT" ? "缺少所需文件。" : String(error) }); }
	};
	const png = (path: string) => validPng(bytes(path));
	const shots = (path: string) => evidence.tools.filter(tool => tool.name === "render_html" && tool.ok
		&& named(tool.args.file_path, path) && tool.images?.some(data => validPng(Buffer.from(data, "base64"))));
	switch (item.id) {
		case "L1":
			check("outline", "要点版可打开并有足够标题", () => wordHeadings(bytes("output/outline.docx")) >= MIN_HEADINGS, "可解析的 DOCX，至少 4 个非空 Word 标题。");
			check("original", "原文件未变", () => sha256(file("original.docx")) === answers.originalDocx, "原始 DOCX 的 SHA-256 与生成时一致。");
			break;
		case "L2":
			check("monthly", "月汇总逐行对账", () => {
				const [header, ...lines] = text("output/monthly.csv").trim().split(/\r?\n/);
				if (header !== "month,units,revenue_cents") return false;
				const rows = lines.map(line => {
					const match = /^(\d{4}-\d{2}),(\d+),(\d+)$/.exec(line);
					return match ? { month: match[1], units: Number(match[2]), revenue_cents: Number(match[3]) } : null;
				});
				return rows.every(row => row !== null) && isDeepStrictEqual(rows.sort((a,b) => a!.month!.localeCompare(b!.month!)), answers.months);
			}, "12 个月的销量和收入分均与标准答案一致。");
			for (const path of ["units", "revenue"]) check(path, path + " 图为有效 PNG", () => png("output/" + path + ".png"), "PNG 签名、尺寸、数据块和校验和有效。");
			check("html", "HTML 嵌入两张图", () => parseHtml(text("output/report.html"), doc => ["units.png", "revenue.png"].every(name =>
				[...doc.images].some(img => ["./" + name, name].includes(img.getAttribute("src") ?? "")))), "两张图使用报告旁的相对路径。");
			check("screenshot", "报告已由截图工具渲染", () => shots("output/report.html").length > 0, "会话里有对应 HTML 的有效 PNG 工具结果。");
			break;
		case "L3":
			check("statistics", "50 万行统计与标准答案一致", () => isDeepStrictEqual(json("output/statistics.json"), answers.statistics), "总计、极值及 A/B/C 的分组计数和金额完全一致。");
			check("reuse", "同会话的第二次 Python 调用复用 df", () => {
				const calls = evidence.tools.filter(tool => tool.name === "python");
				const [first, second] = calls;
				if (calls.length !== 2 || !first?.ok || !second?.ok || first.session !== second.session) return false;
				const initial = String(first.args.code ?? ""), next = String(second.args.code ?? "");
				return /\bdf\s*=.*\bread_csv\s*\(/.test(initial) && /large\.csv/i.test(initial) && /\bdf\b/.test(next)
					&& !/\b(?:read_\w+|open|load\w*|restart)\s*\(|large\.csv/i.test(next) && second.args.restart !== true
					&& !evidence.tools.some(tool => tool.seq > first.seq && tool !== second && /large\.csv/i.test(JSON.stringify(tool.args)));
			}, "按工具顺序检查首次读取、同会话变量复用及之后的源文件读取。");
			break;
		case "L4":
			check("page", "最终 HTML 符合简要规范", () => parseHtml(text("output/page.html"), doc =>
				!!doc.querySelector("h1") && !!doc.getElementById("overview") && !!doc.getElementById("contact") && (doc.body.textContent ?? "").includes("合成样例")), "存在标题、概览、联系区及合成样例文案。");
			check("iterations", "两次截图之间确实改了页面", () => {
				const captures = shots("output/page.html");
				return captures.some(first => captures.some(second => first.id !== second.id && first.session === second.session && evidence.tools.some(tool =>
					tool.session === first.session && tool.seq > first.seq && tool.seq < second.seq && tool.ok &&
					["write", "edit"].includes(tool.name) && named(tool.args.file_path ?? tool.args.path, "output/page.html"))));
			}, "会话里至少两个不同截图调用，中间有成功写入或编辑同一 HTML 的回执。");
			break;
		case "L5":
			check("duration", "后台脚本运行超过五分钟并成功", () => {
				const out = json("output/job.json"), job = evidence.job;
				return out.status === "done" && out.endedAt - out.startedAt > 300_000 && !!job && job.end - job.start > 300_000 && job.status === "completed" && job.sameGoal;
			}, "脚本和目标作业各有超过五分钟的成功记录。");
			check("chat", "作业运行期间收到插话并回复", () => {
				const job = evidence.job;
				return !!job && job.start < job.userAt && job.userAt < job.replyAt && job.replyAt < job.end;
			}, "用户消息及助手回复均发生在作业起止时间内。");
			check("resume", "作业结束后自动续跑并交付", () => {
				const job = evidence.job;
				return !!job && job.sameGoal && job.automatic && job.continuationAt >= job.end && !!text("output/summary.txt").trim();
			}, "同一目标在结束事件之后自动续跑，存在非空的最终汇报。");
			break;
		case "L6":
			for (const side of ["north", "south"]) check(side, side + " 有可用交付", () => text("output/" + side + ".csv").trim() === text(side + ".csv").trim(), "交付与已提供的原始数据一致。");
			check("missing", "缺失 west 且目标不报完成", () => {
				let missing = false;
				try { file("output/west.csv"); } catch (error) { missing = (error as NodeJS.ErrnoException).code === "ENOENT"; }
				return missing && evidence.status !== "completed" && evidence.missing.includes("output/west.csv");
			}, "第三份文件不存在，目标 missing[] 包含其验收项。");
			break;
		case "L7":
			check("paused", "重启后仍保持暂停", () => evidence.restart?.before === "paused" && evidence.restart.after === "paused", "重启前、后均采样真实状态。");
			check("checkpoint", "恢复没有重做第一阶段", () => {
				const state = evidence.restart, checkpoint = file("output/checkpoint.txt");
				return !!state && state.resumed && !state.rewrites && lstatSync(checkpoint).mtimeMs === state.checkpointMtime && sha256(checkpoint) === state.checkpointSha;
			}, "检查点的 SHA-256、修改时间和工具回执都表明未重写。");
			check("final", "恢复后交付阶段二", () => !!evidence.restart?.resumed && text("output/final.txt").includes("DF-105-B"), "最终文件包含阶段二校对编号。");
			break;
	}
	return checks;
}
