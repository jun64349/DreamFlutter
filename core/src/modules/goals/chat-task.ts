import { posix } from "node:path";
import { parseJson, type Db } from "../../db.ts";
import { qualifyingRequest } from "./proposals.ts";

export interface ChatTaskRow {
	mandate_id: string;
	goal_id: string;
	session_id: string;
	session_file: string;
	event_id: string;
	inputs: string;
	deliverables: string;
	created_at: number;
	stopped_at: number | null;
	required_action: "read" | "write" | "edit" | null;
}

export const chatTask = (db: Db, goalId: string) =>
	db.get<ChatTaskRow>("SELECT * FROM butterfly_chat_tasks WHERE goal_id=?", goalId);
export const goalIdForChat = (mandateId: string) => "g_" + mandateId.slice(0, 16);
export const deliveryDirectory = (goalId: string) => "/workspace/outbox/" + goalId;
export const promisedFiles = (row: ChatTaskRow) => parseJson<string[]>(row.deliverables, []);

export type ChatAttachment = { path: string; kind: "file" | "folder" | "document" };
export type ChatInput = { text: string; attachments: ChatAttachment[]; materials: string[] };

const READ_HINT = "需要时用工具读取上面列出的文件或文件夹。";
const BOUNDARY = /<\s*\/?\s*(?:写笺|资料|文本|文档)(?=[\s/>]|$)/gu;
const TAG = /^<(?:\/(写笺|资料|文本|文档)|(资料)|(写笺|文本) 标题="[^"<>\r\n]*"|(文档) 标题="[^"<>\r\n]*" 路径="([^"<>\r\n]*)")>/u;

function attachmentPath(path: unknown): path is string {
	return typeof path === "string" && path.startsWith("/workspace/inbox/") && !path.endsWith("/") &&
		path === posix.normalize(path) && !/[\\:\u0000-\u001f]/.test(path) &&
		path !== "/workspace/inbox/tasks" && !path.startsWith("/workspace/inbox/tasks/.prepare-");
}

function dedupe(input: ChatInput): ChatInput {
	const byPath = new Map(input.attachments.map(item => [item.path, item]));
	return { ...input, attachments: [...byPath.values()] };
}

/** The client supplies original text separately from untrusted materials. */
export function structuredChatInput(raw: unknown): ChatInput | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const { text, attachments = [], materials = [] } = raw as Partial<ChatInput>;
	if (typeof text !== "string" || !Array.isArray(attachments) || !Array.isArray(materials) ||
		attachments.some(item => !item || !attachmentPath(item.path) || !["file", "folder", "document"].includes(item.kind)) ||
		materials.some(body => typeof body !== "string")) return null;
	return dedupe({ text, attachments: attachments.map(({ path, kind }) => ({ path, kind })), materials });
}

export function chatPrompt(input: ChatInput): string {
	const content = [
		...input.attachments.map(({ kind, path }) => "- " + (kind === "folder" ? "文件夹" : "文件") + "：" + path),
		...input.materials.map((body, index) => "资料 " + (index + 1) + "：\n" + body),
	];
	return content.length ? input.text + "\n\n<资料>\n" + content.join("\n") + "\n</资料>\n" + READ_HINT : input.text;
}

/** Legacy windows send one string. Accept only a structurally complete envelope. */
export function legacyChatInput(raw: string): ChatInput | null {
	const input: ChatInput = { text: "", attachments: [], materials: [] };
	let outer: "写笺" | "资料" | undefined;
	let inner: "文本" | "文档" | undefined;
	let seenMaterials = false, seenEnvelope = false, position = 0;
	const add = (text: string) => { if (text.trim()) input.materials.push(text.trim()); };
	const plain = (text: string): boolean => {
		for (const line of text.trim().split(/\r?\n/)) {
			const meta = /^- (文件夹|文件)：(.*)$/.exec(line.trim());
			if (!meta) { add(line); continue; }
			const path = meta[2]!.trim();
			if (!attachmentPath(path)) return false;
			input.attachments.push({ path, kind: meta[1] === "文件夹" ? "folder" : "file" });
		}
		return true;
	};
	for (const marker of raw.matchAll(BOUNDARY)) {
		const tag = TAG.exec(raw.slice(marker.index));
		if (!tag || marker.index < position) return null;
		const before = raw.slice(position, marker.index);
		position = marker.index + tag[0].length;
		const [, close, block, note, doc, path] = tag;
		if (inner) {
			if (close !== inner) return null;
			add(before);
			inner = undefined;
		} else if (outer === "写笺") {
			if (close !== outer) return null;
			add(before);
			outer = undefined;
		} else if (outer === "资料") {
			if (!plain(before)) return null;
			if (close === outer) outer = undefined;
			else if (note === "文本" || doc === "文档") {
				inner = note === "文本" ? note : doc as "文档";
				if (attachmentPath(path)) input.attachments.push({ kind: "document", path });
			} else return null;
		} else {
			if (close || (!block && note !== "写笺") || seenMaterials || (seenEnvelope && before.trim())) return null;
			if (!seenEnvelope) input.text = before;
			seenEnvelope = true;
			seenMaterials = !!block;
			outer = block ? "资料" : "写笺";
		}
	}
	if (outer || inner) return null;
	const tail = raw.slice(position).trim();
	const rest = seenMaterials && tail.startsWith(READ_HINT) ? tail.slice(READ_HINT.length).trim() : tail;
	if (input.text.trim() && rest) return null;
	input.text = input.text.trim() || rest;
	return dedupe(input);
}

const QUESTION = /^(?:请问|我想问|你好|嗨|你觉得|(?:你)?(?:知道|能解释|能告诉我)|帮我解释(?:一下)?[，,：:\s]|给我说说|什么是|为什么|怎么|如何)|(?:是什么意思|怎么做|如何做)[？?]?$/;
const DEFER = /(?:^|[，,。；;\n]|但是|不过|但)\s*(?:请)?(?:先|暂时|目前|现在)?(?:别|不要|不用|暂不)(?:现在|先)?(?:开始|动手|执行|开工|做|处理|[，,。！!\s]|$)/;
const REPLY_HERE = /(?:在(?:这(?:段|个|里)?|当前)?(?:对话|聊天)(?:里|中)?|(?:直接)?在这里|就在这儿)(?:直接)?(?:回复|回答|告诉)|(?:直接)?(?:回复|回答)我(?:就行|即可|就好)/;
const DELEGATE = /(?:请(?!问)|帮我|替我|麻烦你|交给你|给我|^先|^在沙箱(?:里|内)?先|^把[^。！？\n]{1,80}先)/;
const PHASES = /(?:先[\s\S]*(?:再|然后|最后)|分[阶步]|多轮|反复|直到|测试[\s\S]*(?:修|迭代))/;
const COMPLETION = /(?:完成|做完|读完|核对完|核对无误|检查完|确认无误|汇总完)(?:之后|后)[\s，,、]*(?:再|请)?(?:输出|保存为|写成|生成|产出|交付)/;
const SEQUENCE = /(?:读取|核对|检查|复核|比对)[^。！？\n]{1,160}(?:并|然后|再)(?:核对|汇总|统计|整理|归纳)/;
const PRODUCT = /(?:交(?:付|给我|一份)|输出|产出|生成|写成|写一份|保存为|做成)([^\n。！？!?]*)/g;
const FILE = /(?:^|[^\p{L}\p{N}_./\\-])([\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.[a-z][a-z0-9]{0,9})(?=$|[^\p{L}\p{N}_./\\-])/giu;
const HOST = /(?:[A-Za-z]:[\\/]|\\\\[^\s]+|\/mnt\/[a-z]\/|沙箱外|本机|桌面|真实文件|主机)/i;
const REAL_ACTION = /(?:发送给|发给|发邮件|发消息|发送邮件|发布|上传|下单|付款|转账|购买|提交到|删除|移动|联网)/;
const HOST_PATH = /"([A-Za-z]:[\\/][^"\r\n]+)"|“([A-Za-z]:[\\/][^”\r\n]+)”|([A-Za-z]:[\\/][^\s"“”。，、；！？,;]+)/g;

type Request = { text: string; files: string[] } & (
	{ kind: "sandbox" } | { kind: "external"; path: string; action: "read" | "write" | "edit" } | { kind: "needs_scope" }
);

export function classifyChatText(raw: string): Request | null {
	const text = raw.trim();
	if (!text || QUESTION.test(text) || DEFER.test(text) || REPLY_HERE.test(text) || !DELEGATE.test(text)) return null;
	const products = [...text.matchAll(PRODUCT)].map(match => match[1]!);
	const names = [...new Set(products.flatMap(value => [...value.matchAll(FILE)].map(match => match[1]!)))];
	if (!qualifyingRequest(text) && !(names.length && (COMPLETION.test(text) || SEQUENCE.test(text))) &&
		!(PHASES.test(text) && (products.length || HOST.test(text) || REAL_ACTION.test(text)))) return null;
	const files = names.length ? names.slice(0, 30) : ["交付说明.md"];
	if (REAL_ACTION.test(text) && (HOST.test(text) || /发送|发给|发邮件|发消息|发布|上传|下单|付款|转账|购买|提交到|联网/.test(text)))
		return { kind: "needs_scope", text, files };
	if (!HOST.test(text)) return { kind: "sandbox", text, files };
	const paths = [...new Set([...text.matchAll(HOST_PATH)].map(match => match[1] ?? match[2] ?? match[3]!))];
	const action = /修改|编辑|更新/.test(text) ? "edit" : /写入|覆盖|创建/.test(text) ? "write" : /读取|查看|检查|核对/.test(text) ? "read" : null;
	if (paths.length !== 1 || !action || /[\\/]$/.test(paths[0]!))
		return { kind: "needs_scope", text, files };
	return { kind: "external", text, files: [paths[0]!], path: paths[0]!, action };
}

export function readChatRequest(raw: string): Request | null {
	const input = legacyChatInput(raw);
	return input && classifyChatText(input.text);
}
