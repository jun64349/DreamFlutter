import { isAbsolute, posix, resolve } from "node:path";
import { SANDBOX_TOOLS as harnessSandboxTools } from "../../agent/harness.ts";
import { RpcError } from "../../core.ts";
import { pathKey } from "../../security/paths.ts";

export const SOURCES = ["conversation", "schedule", "folder"] as const;
export type Source = typeof SOURCES[number];
export const MODES = ["off", "observe", "auto"] as const;
export type RuleMode = typeof MODES[number];

export const SANDBOX_TOOLS = ["read", "read_image", "glob", "grep", "write", "edit", "todo", "exit_plan_mode", "render_html"] as const;
/** Runtime tools backed by the sandbox, including the sandbox-aware web and child-session adapters. */
export function sandboxGoalTools(): string[] {
	return [...harnessSandboxTools(), "web_search", "agent"];
}
const HOST_TOOLS = ["read", "write", "edit"] as const;
const ACTIONS = [...SANDBOX_TOOLS, "notify", "read_source"] as const;
export type Action = typeof ACTIONS[number];
export type Scope = { kind: "sandbox" } | { kind: "folder"; path: string } | { kind: "external"; path: string };

export interface RuleDefinition {
	name: string;
	source: Source;
	filter: { scheduleId?: string; folder?: string; extension?: string };
	task: string;
	scope: Scope;
	actions: Action[];
	delivery: string;
	assess: boolean;
}
export interface Rule extends RuleDefinition { id: string; revision: number; mode: RuleMode; updatedAt: number }

export function record(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	throw new RpcError("bad_request", "需要结构化规则");
}

function text(value: unknown, label: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
		throw new RpcError("bad_request", `无效的${label}`);
	return value.trim();
}

export function modeOf(value: unknown): RuleMode {
	const mode = MODES.find(item => item === value);
	if (!mode) throw new RpcError("bad_request", "规则档位无效");
	return mode;
}

export function sandboxPath(raw: string, cwd = "/workspace"): string {
	if (raw.includes("\\") || raw.includes("\0") || /^[A-Za-z]:/.test(raw)) return "";
	return posix.resolve(cwd, raw);
}

export function inside(path: string, root: string): boolean {
	return path === root || path.startsWith(root + "/");
}

export function hostKey(path: string): string { return pathKey(resolve(path)); }

export function readRule(value: unknown): RuleDefinition {
	const p = record(value), rawScope = record(p.scope ?? { kind: "sandbox" }), f = record(p.filter ?? {});
	const source = SOURCES.find(item => item === p.source);
	if (!source) throw new RpcError("bad_request", "规则来源无效");
	const kind = rawScope.kind;
	if (kind !== "sandbox" && kind !== "folder" && kind !== "external") throw new RpcError("bad_request", "规则范围无效");
	const path = kind === "sandbox" ? "" : text(rawScope.path, "授权路径", 2048);
	if (path && (!isAbsolute(path) || /^[\\/]{2}/.test(path) || path.slice(2).includes(":")))
		throw new RpcError("bad_request", "授权范围需要本机绝对路径");
	if (kind === "folder" && source !== "folder" || source === "folder" && kind !== "folder")
		throw new RpcError("bad_request", "资料文件夹事件须使用该文件夹的只读授权");
	const scope: Scope = kind === "sandbox" ? { kind } : { kind, path: resolve(path) };
	const rawActions = p.actions ?? (kind === "folder" ? [...SANDBOX_TOOLS, "read_source"] : kind === "external" ? ["read"] : SANDBOX_TOOLS);
	const actions: Action[] = [];
	if (!Array.isArray(rawActions)) throw new RpcError("bad_request", "允许动作需要列表");
	for (const value of rawActions) {
		const action = ACTIONS.find(item => item === value);
		if (!action || action === "read_source" && kind !== "folder" ||
			kind === "external" && action !== "notify" && !(HOST_TOOLS as readonly string[]).includes(action))
			throw new RpcError("bad_request", "动作超出规则范围");
		if (!actions.includes(action)) actions.push(action);
	}
	if (kind === "folder" && !actions.includes("read_source")) throw new RpcError("bad_request", "资料规则需要允许读取指定来源");
	const delivery = sandboxPath(text(p.delivery ?? "outbox", "交付位置", 2048));
	if (!inside(delivery, "/workspace/outbox")) throw new RpcError("bad_request", "交付位置须在沙箱 outbox 内");
	if (Object.keys(f).some(key => !["scheduleId", "folder", "extension"].includes(key)) ||
		f.scheduleId !== undefined && source !== "schedule" ||
		(f.folder !== undefined || f.extension !== undefined) && source !== "folder")
		throw new RpcError("bad_request", "过滤条件与来源不符");
	if (p.assess !== undefined && typeof p.assess !== "boolean") throw new RpcError("bad_request", "评估选项无效");
	return {
		name: text(p.name, "规则名称", 160), source, task: text(p.task, "任务说明", 8000), scope, actions, delivery, assess: p.assess === true,
		filter: {
			...(f.scheduleId === undefined ? {} : { scheduleId: text(f.scheduleId, "日程编号", 256) }),
			...(f.folder === undefined ? {} : { folder: text(f.folder, "文件夹过滤", 2048) }),
			...(f.extension === undefined ? {} : { extension: text(f.extension, "文件扩展名", 48).toLowerCase() }),
		},
	};
}
