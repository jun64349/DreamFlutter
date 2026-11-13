import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { extname, posix, resolve } from "node:path";
import type { Core } from "../../core.ts";
import { sandboxEnv } from "../../agent/state.ts";
import { canonicalPath, pathKey } from "../../security/paths.ts";
import { redact } from "../../security/redaction.ts";
import { SANDBOX_WORKSPACE } from "../../sandbox/sandbox.ts";
import { sandboxGoalTools } from "../autonomy/rules.ts";
import { docxText, pdfText, pptxText, xlsxText } from "../documents.ts";
import { parseJsonAnswer } from "../llm.ts";
import type { Goal, GoalScope } from "./types.ts";
import { parseWait, type WaitRequest } from "./waits.ts";

const FILE_PATH_TOOLS = ["read", "write", "edit", "read_image"];
const FILE_TOOLS = [...FILE_PATH_TOOLS, "read_document", "grep", "glob"];
const STATE_TOOLS = ["todo", "exit_plan_mode"];
const MAX_CHECK_BYTES = 8 * 1024 * 1024;
const TEXT_DELIVERIES = new Set([".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".jsonl", ".html", ".htm", ".xml",
	".yaml", ".yml", ".log", ".css", ".js", ".ts", ".py", ".dart", ".sql", ".sh", ".ps1", ".ini", ".toml", ".svg"]);

function signature(bytes: Buffer, prefix: string, offset = 0): boolean {
	return bytes.subarray(offset, offset + prefix.length).equals(Buffer.from(prefix, "latin1"));
}

const zipHeader = (bytes: Buffer) => signature(bytes, "PK\x03\x04");
const oleHeader = (bytes: Buffer) => signature(bytes, "\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1");
const BINARY_DELIVERIES = new Map<string, (bytes: Buffer) => boolean>([
	[".png", bytes => signature(bytes, "\x89PNG\r\n\x1a\n")],
	[".jpg", bytes => signature(bytes, "\xff\xd8\xff")], [".jpeg", bytes => signature(bytes, "\xff\xd8\xff")],
	[".gif", bytes => signature(bytes, "GIF87a") || signature(bytes, "GIF89a")],
	[".webp", bytes => signature(bytes, "RIFF") && signature(bytes, "WEBP", 8)],
	[".bmp", bytes => signature(bytes, "BM")], [".ico", bytes => signature(bytes, "\x00\x00\x01\x00")],
	[".tif", bytes => signature(bytes, "II\x2a\x00") || signature(bytes, "MM\x00\x2a")],
	[".tiff", bytes => signature(bytes, "II\x2a\x00") || signature(bytes, "MM\x00\x2a")],
	[".pdf", bytes => signature(bytes, "%PDF-")],
	[".zip", zipHeader], [".docx", zipHeader], [".xlsx", zipHeader], [".xlsm", zipHeader], [".pptx", zipHeader],
	[".odt", zipHeader], [".ods", zipHeader], [".odp", zipHeader],
	[".doc", oleHeader], [".xls", oleHeader], [".ppt", oleHeader],
]);

function within(path: string, root: string) { return path === root || path.startsWith(root + "/"); }
export function scopeTools(scope: GoalScope): string[] {
	return scope.allowedTools ?? [...FILE_TOOLS, ...STATE_TOOLS, ...scope.externalActions?.map(action => action.tool) ?? []];
}

function roots(scope: GoalScope): string[] {
	const cwd = scope.sandbox ? SANDBOX_WORKSPACE : scope.cwd;
	if (!cwd) return [];
	return (scope.allowedPaths ?? [cwd]).map(path => scope.sandbox ? posix.resolve(cwd, path) : pathKey(resolve(cwd, path)));
}

export function widensScope(previous: GoalScope, proposed: GoalScope): boolean {
	if (proposed.partition !== previous.partition || proposed.sandbox !== previous.sandbox) return true;
	if (previous.cwd && (!proposed.cwd || !within(pathKey(resolve(proposed.cwd)), pathKey(resolve(previous.cwd))))) return true;
	if (!previous.cwd && proposed.cwd && previous.allowedPaths === undefined) {
		return scopeTools(proposed).some(tool => !scopeTools(previous).includes(tool))
			|| (proposed.externalActions ?? []).some(action => !(previous.externalActions ?? []).some(old => old.tool === action.tool && old.command === action.command));
	}
	return roots(proposed).some(path => !roots(previous).some(root => within(path, root)))
		|| scopeTools(proposed).some(tool => !scopeTools(previous).includes(tool))
		|| (proposed.externalActions ?? []).some(action => !(previous.externalActions ?? []).some(old => old.tool === action.tool && old.command === action.command));
}

export async function goalPath(core: Core, scope: GoalScope, raw: string): Promise<string | null> {
	if (!scope.cwd || !raw || raw.includes("\0")) return null;
	if (scope.sandbox) {
		const cwd = scope.cwd;
		if (/\\|^[A-Za-z]:/.test(raw)) return null;
		const distro = core.sandboxProvider?.()?.distro;
		if (!distro) return null;
		const env = sandboxEnv(distro), path = posix.resolve(SANDBOX_WORKSPACE, raw);
		if (!within(path, SANDBOX_WORKSPACE) || !roots(scope).some(root => within(path, root))) return null;
		const local = await canonicalPath(env.local(path), cwd);
		const safeRoots = await Promise.all(roots(scope).filter(root => within(root, SANDBOX_WORKSPACE)).map(root => canonicalPath(env.local(root), cwd)));
		const workspace = await canonicalPath(env.local(SANDBOX_WORKSPACE), cwd);
		return within(pathKey(local), pathKey(workspace)) && safeRoots.some(root => within(pathKey(local), pathKey(root))) ? local : null;
	}
	const candidate = await canonicalPath(raw, scope.cwd);
	const safeRoots = await Promise.all((scope.allowedPaths ?? [scope.cwd]).map(root => canonicalPath(root, scope.cwd!)));
	if (!safeRoots.some(root => within(pathKey(candidate), pathKey(root)))) return null;
	return (await core.security.inspect(candidate, scope.cwd)).decision === "allow" ? candidate : null;
}

export async function allowedTool(core: Core, goal: Goal, tool: string, input: Record<string, unknown>): Promise<boolean> {
	if (core.autonomy.hasSandboxTools(goal)) {
		// job_output is authorized by the executor against the current goal and revision.
		if (!sandboxGoalTools().includes(tool) || tool === "job_output") return false;
		if (tool === "web_search" || tool === "web_fetch") return core.sandboxProvider?.()?.online() === true;
		if (tool === "agent") return !input.cwd && !input.worktree;
		const location = sandboxToolPath(tool, input);
		if (location) return !!await goalPath(core, goal.scope, location.raw);
		return !FILE_PATH_TOOLS.includes(tool) && tool !== "render_html";
	}
	if (!scopeTools(goal.scope).includes(tool)) return false;
	if (STATE_TOOLS.includes(tool)) return true;
	if (tool === "agent") return !input.cwd && !input.worktree;
	if (tool === "python") return goal.scope.sandbox && goal.scope.partition === "butterfly";
	if (FILE_TOOLS.includes(tool) || tool === "render_html") {
		// The general document reader uses the host cwd. Sandbox reads use the sandbox filesystem tools.
		if (tool === "read_document" && goal.scope.sandbox) return false;
		const raw = toolPath(tool, input) ?? (tool === "glob" || tool === "grep" ? "." : undefined);
		return raw !== undefined && !!await goalPath(core, goal.scope, raw);
	}
	if (["bash", "pwsh", "powershell"].includes(tool)) {
		return input.workdir === undefined
			&& !!goal.scope.externalActions?.some(action => action.tool === tool && action.command === input.command);
	}
	return false;
}

export function sandboxToolPath(tool: string, input: Record<string, unknown>): { key: string; raw: string } | undefined {
	const key = FILE_PATH_TOOLS.includes(tool) || tool === "render_html" ? "file_path"
		: tool === "glob" || tool === "grep" ? "path" : tool === "working_directory" ? "cd" : undefined;
	if (!key) return undefined;
	const raw = input[key] ?? (key === "path" ? "." : undefined);
	return typeof raw === "string" ? { key, raw } : undefined;
}

export function toolPath(tool: string, input: Record<string, unknown>): string | undefined {
	const value = FILE_PATH_TOOLS.includes(tool) || tool === "render_html" ? input.file_path : input.path;
	return typeof value === "string" ? value : undefined;
}

export interface ToolReceipt {
	id: string;
	tool: string;
	command?: string;
	path?: string;
	exitCode?: number;
	ok: boolean;
}
export interface FileFact { path: string; sha256: string | null; size: number; modifiedAt: number; artifact: boolean; excerpt?: string }
export interface CheckResult { id: string; text: string; status: "passed" | "missing" | "unverified"; detail: string }
export interface ProgramReport { checks: CheckResult[]; files: FileFact[] }
export interface ReviewVerdict {
	verdict: "done" | "continue" | "wait" | "blocked" | "needs_user";
	missing: string[];
	next: string;
	questions: string[];
	revision: number;
	evidence_version: number;
	wait?: WaitRequest;
}

async function parses(path: string, bytes: Buffer): Promise<boolean | undefined> {
	try {
		switch (extname(path).toLowerCase()) {
			case ".json": JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")); return true;
			case ".csv": return csvParses(bytes.toString("utf8"));
			case ".docx": docxText(bytes); return true;
			case ".xlsx": case ".xlsm": xlsxText(bytes); return true;
			case ".pptx": pptxText(bytes); return true;
			case ".pdf": await pdfText(bytes); return true;
			default: return undefined;
		}
	} catch { return false; }
}

function csvParses(text: string): boolean {
	let quoted = false, atFieldStart = true, afterQuote = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (quoted) {
			if (char === '"' && text[i + 1] === '"') i++;
			else if (char === '"') { quoted = false; afterQuote = true; }
		} else if (char === "," || char === "\n" || char === "\r") {
			atFieldStart = true; afterQuote = false;
		} else if (afterQuote || (char === '"' && !atFieldStart)) return false;
		else if (char === '"') { quoted = true; atFieldStart = false; }
		else atFieldStart = false;
	}
	return !quoted;
}

function deliveryDecoder(first: Buffer): TextDecoder {
	const encoding = signature(first, "\xff\xfe") ? "utf-16le" : signature(first, "\xfe\xff") ? "utf-16be" : "utf-8";
	return new TextDecoder(encoding, { fatal: true });
}

async function nonblankDelivery(path: string, size: number, bytes?: Buffer): Promise<boolean> {
	if (bytes) return !!deliveryDecoder(bytes).decode(bytes).trim();
	let decoder: TextDecoder | undefined;
	let nonblank = false;
	for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024, end: size - 1 })) {
		const block = chunk as Buffer;
		decoder ??= deliveryDecoder(block);
		if (decoder.decode(block, { stream: true }).trim()) nonblank = true;
	}
	return !!decoder && (!!decoder.decode().trim() || nonblank);
}

async function deliveryHeader(path: string): Promise<Buffer> {
	const file = await open(path, "r");
	try {
		const head = Buffer.alloc(64);
		const { bytesRead } = await file.read(head, 0, head.length, 0);
		return head.subarray(0, bytesRead);
	} finally { await file.close(); }
}

async function deliveryContent(path: string, raw: string, size: number, bytes?: Buffer): Promise<Pick<CheckResult, "status" | "detail">> {
	if (!size) return { status: "missing", detail: "交付文件为空" };
	const extension = extname(raw).toLowerCase();
	const matchHeader = BINARY_DELIVERIES.get(extension);
	try {
		if (TEXT_DELIVERIES.has(extension)) return await nonblankDelivery(path, size, bytes)
			? { status: "passed", detail: "文本含有非空白内容" } : { status: "missing", detail: "交付文本只有空白" };
		if (matchHeader) return matchHeader(bytes ?? await deliveryHeader(path))
			? { status: "passed", detail: "已核对交付文件头" } : { status: "missing", detail: `文件头与 ${extension} 不符` };
	} catch { return { status: "unverified", detail: "交付内容无法读取或解码，待核验" }; }
	return { status: "unverified", detail: `交付类型 ${extension || "（无扩展名）"} 暂不支持自动核验` };
}

export async function checkProgram(core: Core, goal: Goal, receipts: ToolReceipt[], artifacts: string[],
	options?: { resolveDelivery?: (raw: string) => Promise<string | null>; metadataOnly?: boolean; verifyDeliveries?: boolean }): Promise<ProgramReport> {
	const candidates = new Set([...artifacts, ...goal.spec.deliverables].slice(0, 30));
	const files = new Map<string, { fact: FileFact; bytes?: Buffer; path: string } | "missing" | "unverified">();
	const examine = async (raw: string) => {
		const previous = files.get(raw);
		if (previous) return previous;
		try {
			const path = await (options?.resolveDelivery ? options.resolveDelivery(raw) : goalPath(core, goal.scope, raw));
			if (!path) { files.set(raw, "unverified"); return "unverified" as const; }
			const info = await stat(path);
			if (!info.isFile()) { files.set(raw, "missing"); return "missing" as const; }
			const bytes = !options?.metadataOnly && info.size <= MAX_CHECK_BYTES ? await readFile(path) : undefined;
			const sha256 = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
			const excerpt = bytes && /\.(md|txt|json|csv|log|ts|dart|py|yaml|yml)$/i.test(raw)
				? redact(bytes.subarray(0, 8000).toString("utf8"), true) : undefined;
			const item = { path, bytes, fact: { path: raw, sha256, size: info.size, modifiedAt: info.mtimeMs, artifact: candidates.has(raw), excerpt } };
			files.set(raw, item);
			return item;
		} catch (error) {
			const result = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unverified";
			files.set(raw, result);
			return result;
		}
	};
	for (const path of candidates) await examine(path);
	const checks: CheckResult[] = [];
	if (options?.verifyDeliveries && !options.metadataOnly) {
		const prefix = options.resolveDelivery ? "chat-file" : "delivery-file";
		for (const [index, raw] of goal.spec.deliverables.entries()) {
			const file = await examine(raw);
			const result = typeof file === "string" ? { status: file, detail: "交付文件缺失、不可读或超出交付范围" }
				: await deliveryContent(file.path, raw, file.fact.size, file.bytes);
			checks.push({ id: `${prefix}:${index}`, text: raw, ...result });
		}
	}
	const program = [
		...goal.spec.acceptance.filter(item => item.layer === "program"),
		...goal.spec.constraints.flatMap((rule, index) => rule.check ? [{ id: `constraint:${index + 1}`, text: rule.text, check: rule.check }] : []),
	];
	for (const { id, text, check } of program) {
		const args = check?.args ?? {};
		let status: CheckResult["status"] = "unverified", detail = "缺少后台核验记录";
		if (check?.kind === "command_ok" || check?.kind === "tests_pass") {
			const result = receipts.findLast(row => typeof args.command === "string" && row.command === args.command);
			if (result?.exitCode !== undefined) {
				status = result.ok && result.exitCode === 0 ? "passed" : "missing";
				detail = `退出码 ${result.exitCode}`;
			}
		} else if (check?.kind === "sources_read") {
			const sources = Array.isArray(args.paths) ? args.paths : typeof args.path === "string" ? [args.path] : [];
			if (sources.length && sources.every(path => typeof path === "string"
				&& receipts.some(row => row.ok && ["read", "read_document", "read_image"].includes(row.tool) && row.path === path))) {
				status = "passed"; detail = "已核对读取回执";
			}
		} else if (typeof args.path === "string") {
			const file = await examine(args.path);
			if (typeof file === "string") { status = file; detail = file === "missing" ? `找不到文件：${args.path}` : "文件不在可核验范围内"; }
			else if (check?.kind === "file_exists") { status = "passed"; detail = "文件存在"; }
			else if (check?.kind === "file_parses" && file.bytes) {
				const result = await parses(file.path, file.bytes);
				if (result !== undefined) { status = result ? "passed" : "missing"; detail = result ? "格式已验证" : "文件无法解析"; }
			} else if (check?.kind === "file_unchanged" && file.fact.sha256 && typeof (args.sha256 ?? args.digest) === "string") {
				status = (args.sha256 ?? args.digest) === file.fact.sha256 ? "passed" : "missing";
				detail = status === "passed" ? "文件摘要一致" : "文件摘要已变化";
			} else if (check?.kind === "contains" && file.bytes && typeof args.text === "string") {
				status = file.bytes.toString("utf8").includes(args.text) ? "passed" : "missing";
				detail = status === "passed" ? "已找到要求的内容" : "缺少要求的内容";
			}
		}
		checks.push({ id, text, status, detail });
	}
	return { checks, files: [...files.values()].flatMap(value => typeof value === "string" ? [] : [value.fact]) };
}

export function readVerdict(text: string, knownItems: ReadonlySet<string>): ReviewVerdict | null {
	const answer = parseJsonAnswer<ReviewVerdict>(text);
	if (!answer || !["done", "continue", "wait", "blocked", "needs_user"].includes(answer.verdict)
		|| !Array.isArray(answer.missing) || answer.missing.some(item => typeof item !== "string" || !knownItems.has(item))
		|| typeof answer.next !== "string" || !Array.isArray(answer.questions) || answer.questions.some(q => typeof q !== "string")
		|| !Number.isSafeInteger(answer.revision) || !Number.isSafeInteger(answer.evidence_version)) return null;
	let wait: WaitRequest | undefined;
	if (answer.verdict === "wait") {
		try { wait = parseWait(answer.wait); } catch { return null; }
	}
	return { ...answer, wait, next: redact(answer.next.slice(0, 2000), true), questions: answer.questions.slice(0, 8).map(q => redact(q.slice(0, 500), true)) };
}

