import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { crc32 } from "node:zlib";
import { JSDOM } from "jsdom";
import { readZip } from "../../src/cards/zip.ts";
import type { Case } from "./cases.ts";
import { MIN_HEADINGS, sha256, wordNamespace, type Answers } from "./fixtures/generate.ts";
import { loadsSourceIntoDf, namesSource, readsPythonData, referencesDf } from "./python-evidence.ts";

type Tool = { id: string; name: string; args: Record<string, unknown>; session: string; seq: number; at?: number; ok: boolean; images?: string[] };
export interface Evidence {
	status: string;
	missing: string[];
	tools: Tool[];
	job?: { start: number; end: number; userAt: number; replyAt: number; continuationAt: number; sameGoal: boolean; automatic: boolean; status: string };
	restart?: { before: string; after: string; resumed: boolean; checkpointSha: string; checkpointMtime: number; rewrites: number };
}
export type Condition = { title: string; passed: boolean | null; detail?: string; conditions?: Condition[] };
export type Check = { id: string; title: string; passed: boolean; detail: string; conditions: Condition[] };
const condition = (title: string, passed: boolean | null, detail?: string): Condition => ({ title, passed, detail });
const group = (title: string, conditions: Condition[]) => ({ title, passed: conditions.every(item => item.passed === true), conditions });

function inspect<T>(title: string, read: () => T, verify: (value: T | undefined) => Condition[]): Condition[] {
	let value: T;
	try { value = read(); }
	catch (error) {
		const detail = (error as NodeJS.ErrnoException).code === "ENOENT" ? "缺少所需文件。" : "无法读取或解析证据。";
		return [condition(title, false, detail), ...verify(undefined)];
	}
	return [condition(title, true), ...verify(value)];
}

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
	return pngConditions(data).every(part => part.passed === true);
}

function pngConditions(data: Buffer | undefined): Condition[] {
	const signature = data ? data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) : null;
	const dimensions = data && signature ? data.length >= 45 && data.toString("ascii", 12, 16) === "IHDR"
		&& data.readUInt32BE(8) === 13 && !!data.readUInt32BE(16) && !!data.readUInt32BE(20) : null;
	const chunks = data && dimensions ? validPngChunks(data) : null;
	return [
		condition("PNG 签名正确", signature),
		condition("首个数据块为 IHDR 且尺寸非零", dimensions),
		condition("数据块及校验和完整", chunks),
	];
}

function validPngChunks(data: Buffer): boolean {
	let idat = false;
	for (let offset = 8; offset + 12 <= data.length;) {
		const size = data.readUInt32BE(offset);
		const end = offset + size + 12;
		if (end > data.length || crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) return false;
		const kind = data.toString("ascii", offset + 4, offset + 8);
		if (kind === "IDAT" && size) idat = true;
		if (kind === "IEND") return size === 0 && idat && end === data.length;
		offset = end;
	}
	return false;
}

function parseHtml<T>(text: string, inspect: (doc: Document) => T): T {
	const view = new JSDOM(text);
	try { return inspect(view.window.document); }
	finally { view.window.close(); }
}

const normalized = (path: unknown) => typeof path === "string" ? path.replaceAll("\\", "/") : "";
const named = (value: unknown, path: string) => {
	const name = normalized(value);
	return name === path || name.endsWith("/" + path);
};

function reuseConditions(tools: Tool[]): Condition[] {
	const calls = tools.flatMap((tool, index) => tool.name === "python"
		? [{ tool, index, code: String(tool.args.code ?? "") }] : []);
	const load = calls.find(call => loadsSourceIntoDf(call.code));
	const subsequent = load ? calls.filter(call => call.index > load.index) : [];
	const restarted = new Set<string>();
	const rereads: number[] = [];
	const candidates = subsequent.map(({ tool, index, code }) => {
		const reads = readsPythonData(code);
		if (reads) rereads.push(index + 1);
		if (tool.args.restart === true) restarted.add(tool.session);
		return group("工具调用 " + (index + 1), [
			condition("调用成功", tool.ok),
			condition("与首次读取在同一会话", load?.tool.session === tool.session),
			condition("自首次读取以来内核未重启", !restarted.has(tool.session)),
			condition("引用了 df", referencesDf(code)),
			condition("本次调用未重新读取源数据", !reads),
		]);
	});
	if (load) for (const [index, tool] of tools.entries()) {
		if (index <= load.index || !tool.ok) continue;
		const fileRead = ["read", "read_document", "read_image", "grep"].includes(tool.name)
			&& namesSource(tool.args.file_path ?? tool.args.path);
		if (fileRead || (tool.name === "grep" && namesSource(tool.args.include))) rereads.push(index + 1);
	}
	rereads.sort((a, b) => a - b);
	return [
		condition("至少两次 Python 调用", calls.length >= 2, "共 " + calls.length + " 次。"),
		condition("找到首次读取 large.csv 并给 df 赋值的调用", !!load, load && "工具调用 " + (load.index + 1) + "。"),
		condition("首次读取调用成功", load?.tool.ok ?? null),
		{ ...condition("之后有符合条件的 Python 调用", load ? candidates.some(candidate => candidate.passed) : null), conditions: candidates },
		condition("首次读取之后没有再次读取源文件", load ? rereads.length === 0 : null,
			rereads.length ? "发现读取的工具调用 " + rereads.join("、") + "。" : undefined),
	];
}

export function readSessionEvidence(text: string, session: string): Tool[] {
	const tools = new Map<string, Tool>();
	for (const [seq, line] of text.split(/\r?\n/).entries()) {
		if (!line) continue;
		const entry = JSON.parse(line);
		if (entry.type !== "message" || !Array.isArray(entry.message?.content)) continue;
		const message = entry.message;
		if (message.role === "assistant") for (const block of message.content) {
			if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
				const at = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp);
				tools.set(block.id, { id: block.id, name: block.name, args: block.arguments ?? {}, session, seq, at: Number.isFinite(at) ? at : undefined, ok: false });
			}
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
	const json = <T>(path: string): T | null => JSON.parse(text(path));
	const check = (id: string, title: string, detail: string, conditions: Condition[]) => {
		checks.push({ id, detail, ...group(title, conditions), conditions });
	};
	const screenshotCalls = (path: string) => evidence.tools.filter(tool => tool.name === "render_html" && named(tool.args.file_path, path));
	const hasImage = (tool: Tool) => tool.images?.some(data => validPng(Buffer.from(data, "base64")));
	const before = (label: string, a: number | undefined, b: number | undefined, equal = false) =>
		condition(label, a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b) ? null : a < b || (equal && a === b));
	switch (item.id) {
		case "L1":
			check("outline", "要点版可打开并有足够标题", "可解析的 DOCX，至少 4 个非空 Word 标题。",
				inspect("可读取并解析 DOCX", () => wordHeadings(bytes("output/outline.docx")), count => [
					condition("非空 Word 标题达到 4 个", count === undefined ? null : count >= MIN_HEADINGS, count === undefined ? undefined : "共 " + count + " 个。"),
				]));
			check("original", "原文件未变", "原始 DOCX 的 SHA-256 与生成时一致。",
				inspect("可读取原始 DOCX", () => sha256(file("original.docx")), hash => [
					condition("SHA-256 与生成时一致", hash === undefined ? null : hash === answers.originalDocx),
				]));
			break;
		case "L2": {
			check("monthly", "月汇总逐行对账", "12 个月的销量和收入分均与标准答案一致。",
				inspect("可读取月汇总 CSV", () => text("output/monthly.csv").trim().split(/\r?\n/), data => {
				const [header, ...lines] = data ?? [];
				const rows = lines.flatMap(line => {
					const match = /^(\d{4}-\d{2}),(\d+),(\d+)$/.exec(line);
					return match ? [{ month: match[1], units: Number(match[2]), revenue_cents: Number(match[3]) }] : [];
				});
				const valid = rows.length === lines.length;
				return [
					condition("CSV 表头正确", data ? header === "month,units,revenue_cents" : null),
					condition("每行均为月份和两个整数", data ? valid : null),
					condition("月份、销量及收入分逐行与标准答案一致", data && valid
						? isDeepStrictEqual(rows.sort((a, b) => a.month!.localeCompare(b.month!)), answers.months) : null),
				];
			}));
			for (const path of ["units", "revenue"]) check(path, path + " 图为有效 PNG", "PNG 签名、尺寸、数据块和校验和有效。",
				inspect("可读取 PNG 文件", () => bytes("output/" + path + ".png"), data => pngConditions(data)));
			const names = ["units.png", "revenue.png"];
			check("html", "HTML 嵌入两张图", "两张图使用报告旁的相对路径。",
				inspect("可解析报告 HTML", () => parseHtml(text("output/report.html"), doc => [...doc.images].map(img => img.getAttribute("src"))),
					sources => names.map(name => condition("以相对路径嵌入 " + name, sources ? sources.includes(name) || sources.includes("./" + name) : null))));
			const shots = screenshotCalls("output/report.html").filter(tool => tool.ok);
			check("screenshot", "报告已由截图工具渲染", "会话里有对应 HTML 的有效 PNG 工具结果。", [
				condition("存在成功的报告 HTML 截图调用", shots.length > 0),
				condition("该调用返回有效 PNG", shots.length ? shots.some(hasImage) : null),
			]);
			break;
		}
		case "L3":
			check("statistics", "50 万行统计与标准答案一致", "总计、极值及 A/B/C 的分组计数和金额完全一致。",
				inspect("可解析统计 JSON", () => json<NonNullable<Answers["statistics"]>>("output/statistics.json"), value => [
					...(["count", "sum_cents", "min_cents", "max_cents"] as const).map(key =>
						condition(key + " 与标准答案一致", value === undefined ? null : !!value && value[key] === answers.statistics?.[key])),
					...["A", "B", "C"].map(key => condition(key + " 组计数与金额一致", value === undefined ? null
						: !!value?.groups?.[key] && isDeepStrictEqual(value.groups[key], answers.statistics?.groups[key]))),
					condition("完整 JSON 与标准答案一致", value === undefined ? null : isDeepStrictEqual(value, answers.statistics)),
				]));
			check("reuse", "后续 Python 调用在同一会话复用 df", "按工具顺序检查首次读取、同会话变量复用及之后的源文件读取。", reuseConditions(evidence.tools));
			break;
		case "L4": {
			const page = "output/page.html";
			check("page", "最终 HTML 符合简要规范", "存在标题、概览、联系区及合成样例文案。",
				inspect("可解析最终 HTML", () => parseHtml(text(page), doc => [
					!!doc.querySelector("h1"), !!doc.getElementById("overview"), !!doc.getElementById("contact"),
					(doc.body.textContent ?? "").includes("合成样例"),
				]), results => ["存在标题", "存在概览", "存在联系区", "存在合成样例文案"]
					.map((label, i) => condition(label, results?.[i] ?? null))));
			const captures = screenshotCalls(page).filter(tool => tool.ok && hasImage(tool));
			const pairs = captures.flatMap(first => captures.filter(second => first.id !== second.id
				&& first.session === second.session && first.seq < second.seq).map(second => ({ first, second })));
			check("iterations", "两次截图之间确实改了页面", "会话里至少两个不同截图调用，中间有成功写入或编辑同一 HTML 的回执。", [
				condition("同一会话有两次有效截图", pairs.length > 0),
				condition("其中一对截图间成功写入或编辑了页面", pairs.length ? pairs.some(({ first, second }) => evidence.tools.some(tool =>
					tool.session === first.session && tool.seq > first.seq && tool.seq < second.seq && tool.ok
					&& ["write", "edit"].includes(tool.name) && named(tool.args.file_path ?? tool.args.path, page))) : null),
			]);
			break;
		}
		case "L5": {
			const job = evidence.job;
			check("duration", "后台脚本运行超过五分钟并成功", "脚本和目标作业各有超过五分钟的成功记录。", [
				...inspect("可解析脚本结果 JSON", () => json<{ status: string; startedAt: number; endedAt: number }>("output/job.json"), out => [
					condition("脚本正常结束", out === undefined ? null : out?.status === "done"),
					condition("脚本耗时超过五分钟", out ? out.endedAt - out.startedAt > 300_000 : null),
				]),
				condition("存在作业回执", !!job),
				condition("作业成功完成", job ? job.status === "completed" : null),
				condition("作业耗时超过五分钟", job ? job.end - job.start > 300_000 : null),
				condition("作业属于同一目标", job?.sameGoal ?? null),
			]);
			check("chat", "作业运行期间收到插话并回复", "用户消息及助手回复均发生在作业起止时间内。", [
				before("作业启动早于用户插话", job?.start, job?.userAt),
				before("用户插话早于助手回复", job?.userAt, job?.replyAt),
				before("助手回复早于作业结束", job?.replyAt, job?.end),
			]);
			check("resume", "作业结束后自动续跑并交付", "同一目标在结束事件之后自动续跑，存在非空的最终汇报。", [
				condition("作业属于同一目标", job?.sameGoal ?? null),
				condition("观察到自动续跑", job?.automatic ?? null),
				before("续跑发生在作业结束时或之后", job?.end, job?.continuationAt, true),
				...inspect("可读取最终汇报", () => text("output/summary.txt").trim(), summary => [
					condition("最终汇报非空", summary === undefined ? null : summary.length > 0),
				]),
			]);
			break;
		}
		case "L6": {
			for (const side of ["north", "south"]) check(side, side + " 有可用交付", "交付与已提供的原始数据一致。",
				inspect("可读取交付和原始 CSV", () => [text("output/" + side + ".csv").trim(), text(side + ".csv").trim()], pair => [
					condition("交付与原始数据一致", pair ? pair[0] === pair[1] : null),
				]));
			let missing = false;
			try { file("output/west.csv"); } catch (error) { missing = (error as NodeJS.ErrnoException).code === "ENOENT"; }
			check("missing", "缺失 west 且目标不报完成", "第三份文件不存在，目标 missing[] 包含其验收项。", [
				condition("west 交付文件不存在", missing),
				condition("目标未标记完成", evidence.status !== "completed"),
				condition("missing[] 包含 west 验收项", evidence.missing.includes("output/west.csv")),
			]);
			break;
		}
		case "L7": {
			const state = evidence.restart;
			check("paused", "重启后仍保持暂停", "重启前、后均采样真实状态。", [
				condition("重启前处于暂停", state ? state.before === "paused" : null),
				condition("重启后处于暂停", state ? state.after === "paused" : null),
			]);
			check("checkpoint", "恢复没有重做第一阶段", "检查点的 SHA-256、修改时间和工具回执都表明未重写。", [
				condition("目标已恢复", state?.resumed ?? null),
				condition("无重写工具回执", state ? !state.rewrites : null),
				...inspect("可读取检查点", () => {
					const checkpoint = file("output/checkpoint.txt");
					return { mtime: lstatSync(checkpoint).mtimeMs, hash: sha256(checkpoint) };
				}, observed => [
					condition("修改时间与恢复前一致", observed && state ? observed.mtime === state.checkpointMtime : null),
					condition("SHA-256 与恢复前一致", observed && state ? observed.hash === state.checkpointSha : null),
				]),
			]);
			check("final", "恢复后交付阶段二", "最终文件包含阶段二校对编号。", [
				condition("目标已恢复", state?.resumed ?? null),
				...inspect("可读取最终文件", () => text("output/final.txt"), output => [
					condition("最终文件包含 DF-105-B", output === undefined ? null : output.includes("DF-105-B")),
				]),
			]);
			break;
		}
	}
	return checks;
}
