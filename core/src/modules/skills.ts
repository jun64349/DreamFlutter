import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager, parseFrontmatter, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Core, CoreModule } from "../core.ts";
import { RpcError, requireStr, samePath, str } from "../core.ts";
import type { Db } from "../db.ts";
import { json, now, parseJson } from "../db.ts";
import { dropSharedAgentSkills } from "../paths.ts";
import { storageLocations } from "../storage/locations.ts";
import { textOf } from "../runs.ts";
import { parseJsonAnswer, type Llm } from "./llm.ts";
import { fileFingerprint, locator, type EntryMetadata, type SourceKind } from "./library-registry.ts";
import { validateSkill } from "./skill-validation.ts";
import { skillNameErrors } from "./skill-name.ts";
import { builtinSkillKey, builtinSkills, isBuiltinSkillPath, mergeBuiltinSkills } from "./builtin-skills.ts";
import { skillBundle, trialSkill } from "./skill-trial.ts";
import { SkillRouting } from "./skill-routing.ts";
import { withSkillDownload } from "./skill-download.ts";

export interface SkillInfo extends Partial<EntryMetadata> {
	kind?: "skill" | "template";
	command?: string;
	params?: TemplateParam[];
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	/** user = the app's own Pi skills folder; project = the workspace's own (~/.agents/skills, shared by other agent tools, is not read). */
	scope: string;
	enabled: boolean;
	modelInvocable: boolean;
	readOnly?: boolean;
	nameDiagnostics?: string[];
}

export interface TemplateParam {
	name: string;
	default?: string;
}

export interface TemplateInfo extends Partial<EntryMetadata> {
	name: string;
	description: string;
	/** Body with {{param}} placeholders, for editing. */
	body: string;
	params: TemplateParam[];
	filePath: string;
}

export type ProposalKind = "skill" | "mcp";
export type ProposalStatus = "pending" | "accepted" | "rejected";

export interface Proposal {
	id: string;
	kind: ProposalKind;
	title: string;
	payload: SkillProposal;
	status: ProposalStatus;
	sourceSession: string | null;
	cwd: string | null;
	createdAt: number;
	resolvedAt: number | null;
}

export interface SkillProposal {
	name: string;
	description: string;
	/** Full SKILL.md text (frontmatter included). */
	content: string;
	scope: "user" | "project";
	reason?: string;
	/** Current SKILL.md when the proposal changes an existing skill (for a diff). */
	previous?: string | null;
	sourceKind?: SourceKind;
	sourceUrl?: string | null;
	files?: Record<string, string>;
	filesPreview?: Record<string, string>;
	bundleFingerprint?: string;
	mcpConfig?: Record<string, unknown>;
}

const SKILL_NAME = { test: (name: string) => skillNameErrors(name).length === 0 };
export const SKILL_TOOLS = ["skill_propose", "skill_register", "skill_test", "skill_script_trial", "skill_route"];

/** SKILL.md with the Agent Skills frontmatter. */
export function skillMarkdown(name: string, description: string, body: string): string {
	const desc = description.replace(/\s+/g, " ").trim().slice(0, 1024);
	const text = body.replace(/^---[\s\S]*?---\s*/, "").trim();
	return `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${text}\n`;
}

// ---- templates: Pi prompt templates with named parameters ---------------------------------

function frontmatter(text: string): { data: Record<string, string>; body: string } {
	try {
		const parsed = parseFrontmatter(text);
		return { data: Object.fromEntries(Object.entries(parsed.frontmatter).filter(([, value]) => typeof value === "string" || typeof value === "boolean").map(([key, value]) => [key, String(value)])), body: parsed.body };
	} catch { return { data: {}, body: text }; }
}

/** {{name}} placeholders → Pi positional arguments (${1:-default}), in order of first use. */
export function compileTemplate(body: string, params: TemplateParam[]): { piBody: string; params: TemplateParam[] } {
	const order: TemplateParam[] = [];
	const piBody = body.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, raw: string) => {
		const name = raw.trim();
		let index = order.findIndex((p) => p.name === name);
		if (index < 0) {
			order.push({ name, default: params.find((p) => p.name === name)?.default });
			index = order.length - 1;
		}
		// Always `${n:-default}`: Pi has no bare `${n}`, and `$n` would merge with a following digit.
		return `\${${index + 1}:-${(order[index]!.default ?? "").replace(/}/g, "")}}`;
	});
	return { piBody, params: order };
}

/** Pi positional arguments back to {{name}} placeholders for editing. */
export function decompileTemplate(piBody: string, params: TemplateParam[]): string {
	return piBody.replace(/\$\{(\d+)(?::-[^}]*)?\}|\$(\d+)/g, (m, a: string | undefined, b: string | undefined) => {
		const param = params[Number(a ?? b) - 1];
		return param ? `{{${param.name}}}` : m;
	});
}

/** The `/name "a" "b"` prompt that runs a template with these values. */
export function templateCommand(name: string, params: TemplateParam[], values: Record<string, string>): string {
	const args = params.map((p) => `"${(values[p.name] ?? p.default ?? "").replace(/"/g, "”").replace(/\r?\n/g, " ")}"`);
	return [`/${name}`, ...args].join(" ");
}

/**
 * Skills (Pi's progressively loaded SKILL.md files), task templates (Pi
 * prompt templates with named parameters) and proposals the user confirms:
 * skills the agent suggests via `skill_propose` or drafted from a session.
 */
export class SkillsModule implements CoreModule {
	readonly modelFacing = true;
	private readonly core: Core;
	private readonly db: Db;
	private readonly llm: Llm;
	private readonly routing: SkillRouting;

	constructor(core: Core, llm: Llm, routingOptions: { prefilterEnabled?: boolean } = {}) {
		this.core = core;
		this.db = core.db;
		this.llm = llm;
		this.routing = new SkillRouting(core, llm, (cwd) => this.listSkills(cwd), routingOptions);
		core.declareBackup({ id: "proposals", title: "待确认的技能和记忆建议", tables: ["proposals"], paths: { proposals: { source_session: "path", cwd: "path" } } });
		core.declareBackup({ id: "library", title: "技能、模板与 MCP 登记和使用记录", tables: ["library_entries", "library_usage"],
			paths: { library_entries: { locator: "key", source_url: "path" }, library_usage: { locator: "key" } } });
		core.exemptFromApproval(...SKILL_TOOLS);
		this.register();
	}

	private get userSkillsDir(): string {
		return storageLocations(this.core.paths.dataDir, this.core.agentDir).skills;
	}

	private get promptsDir(): string {
		return storageLocations(this.core.paths.dataDir, this.core.agentDir).templates;
	}

	private get settingsPath(): string {
		return join(this.core.agentDir, "settings.json");
	}

	private readSettings(): Record<string, unknown> {
		try {
			return JSON.parse(readFileSync(this.settingsPath, "utf8")) as Record<string, unknown>;
		} catch {
			return {};
		}
	}

	private writeSettings(settings: Record<string, unknown>): void {
		const temp = `${this.settingsPath}.${process.pid}.tmp`;
		mkdirSync(dirname(this.settingsPath), { recursive: true });
		writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
		renameSync(temp, this.settingsPath);
	}

	private disabledPaths(): string[] {
		const skills = this.readSettings().skills;
		return Array.isArray(skills) ? skills.filter((s): s is string => typeof s === "string" && s.startsWith("-")).map((s) => s.slice(1)) : [];
	}

	// ---- skills ------------------------------------------------------------------------

	async selfworkNameTaken(name: string, cwd: string): Promise<boolean> {
		return existsSync(join(this.userSkillsDir, name)) || (await this.listSkills(cwd)).some(skill =>
			skill.kind !== "template" && skill.name.toLowerCase() === name.toLowerCase());
	}

	async listSkills(cwd: string): Promise<SkillInfo[]> {
		const disabled = this.disabledPaths();
		// Untrusted projects stay unloaded here too (resolving project packages can run their code).
		const settingsManager = SettingsManager.create(cwd, this.core.agentDir, { projectTrusted: this.core.isProjectTrusted(cwd) });
		const loader = new DefaultResourceLoader({ cwd, agentDir: this.core.agentDir, settingsManager, noExtensions: true, noPromptTemplates: true, noThemes: true, skillsOverride: (base: { skills: import("@earendil-works/pi-coding-agent").Skill[] }) => mergeBuiltinSkills(dropSharedAgentSkills(base), this.core.library) } as never);
		await loader.reload();
		const loaded = loader.getSkills().skills;
		const found = new Map<string, SkillInfo>();
		for (const s of loaded) {
			found.set(s.filePath.toLowerCase(), {
				name: s.name,
				description: s.description,
				filePath: s.filePath,
				baseDir: s.baseDir,
				scope: s.sourceInfo.scope,
				enabled: true,
				modelInvocable: !s.disableModelInvocation,
			});
		}
		// Disabled skills are excluded by Pi; list them from their files.
		for (const path of disabled) {
			if (found.has(path.toLowerCase()) || !existsSync(path)) continue;
			const { data } = frontmatter(readFileSync(path, "utf8"));
			found.set(path.toLowerCase(), {
				name: data.name ?? dirname(path).split(/[\\/]/).pop() ?? path,
				description: data.description ?? "",
				filePath: path,
				baseDir: dirname(path),
				scope: samePath(dirname(dirname(path)), this.userSkillsDir) ? "user" : "project",
				enabled: false,
				modelInvocable: data["disable-model-invocation"] !== "true",
			});
		}
		const skills: SkillInfo[] = [...found.values()].map((skill) => {
			this.core.library.ensure("skill", locator(skill.filePath));
			const allowed = this.core.library.fileAllowed("skill", skill.filePath);
			const builtin = !!builtinSkillKey(skill.filePath);
			return { ...skill, scope: builtin ? "builtin" : skill.scope, ...this.core.library.get("skill", locator(skill.filePath)), readOnly: builtin, nameDiagnostics: skillNameErrors(skill.name, basename(skill.filePath).toLowerCase() === "skill.md" ? basename(skill.baseDir) : undefined), enabled: skill.enabled && allowed };
		});
		return [...skills.map((s) => ({ ...s, kind: "skill" as const, command: `/skill:${s.name}` })), ...this.listTemplates().map((t) => ({ ...t, kind: "template" as const, baseDir: dirname(t.filePath), scope: "user", modelInvocable: false, enabled: this.core.library.fileAllowed("template", t.filePath), command: `/${t.name}` }))]
			.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
	}

	setSkillEnabled(filePath: string, enabled: boolean): void {
		const template = this.listTemplates().find((t) => samePath(t.filePath, filePath));
		if (template) {
			if (enabled && !this.core.library.fileTrusted("template", filePath)) throw new RpcError("untrusted", "模板已变化，请重新确认");
			this.core.library.write("template", locator(filePath), { enabled });
			this.core.broadcast({ event: "skills.changed" }); this.core.broadcast({ event: "templates.changed" }); return;
		}
		assertSkillFile(filePath);
		const meta = this.core.library.ensure("skill", locator(filePath));
		if (enabled && meta.trust !== "trusted") throw new RpcError("untrusted", "请先在待确认里审阅并确认此技能");
		if (enabled && !this.core.library.fileTrusted("skill", filePath)) throw new RpcError("untrusted", "技能文件已变化，请重新登记并确认");
		this.core.library.write("skill", locator(filePath), { enabled });
		if (builtinSkillKey(filePath)) { this.core.broadcast({ event: "skills.changed" }); return; }
		const settings = this.readSettings();
		const list = (Array.isArray(settings.skills) ? settings.skills : []).filter((s): s is string => typeof s === "string" && !samePath(s.replace(/^-/, ""), filePath));
		if (!enabled) list.push(`-${filePath}`);
		settings.skills = list;
		this.writeSettings(settings);
		this.core.broadcast({ event: "skills.changed" });
	}

	/** Moves a skill folder into the core's trash (recoverable). */
	removeSkill(filePath: string): void {
		const template = this.listTemplates().find((t) => samePath(t.filePath, filePath));
		if (template) { this.removeTemplate(template.name); return; }
		if (isBuiltinSkillPath(filePath)) throw new RpcError("read_only", "内置技能随应用更新，不能删除；可以停用或复制为用户技能");
		assertSkillFile(filePath);
		if (!existsSync(filePath)) throw new RpcError("not_found", "这个技能文件不存在");
		// A skill folder (…/name/SKILL.md) moves as a whole; a standalone skill is one file.
		const target = filePath.split(/[\\/]/).pop() === "SKILL.md" ? dirname(filePath) : filePath;
		const trash = join(this.core.paths.dataDir, "trash", `${Date.now()}-${target.split(/[\\/]/).pop()}`);
		mkdirSync(dirname(trash), { recursive: true });
		renameSync(target, trash);
		const settings = this.readSettings();
		settings.skills = (Array.isArray(settings.skills) ? settings.skills : []).filter((s) => typeof s !== "string" || !samePath(s.replace(/^-/, ""), filePath));
		this.writeSettings(settings);
		this.core.library.write("skill", locator(filePath), { enabled: false, trust: "untrusted", butterflyAllowed: false });
		this.core.broadcast({ event: "skills.changed" });
	}

	readSkill(filePath: string): string {
		if (this.listTemplates().some((t) => samePath(t.filePath, filePath))) return readFileSync(filePath, "utf8");
		assertSkillFile(filePath);
		return readFileSync(filePath, "utf8");
	}


	/** Copies a folder containing SKILL.md into the user's skills. */
	importSkill(folder: string, sourceUrl?: string): SkillInfo {
		const source = join(folder, "SKILL.md");
		if (!existsSync(source)) throw new RpcError("bad_request", "这个文件夹里没有 SKILL.md");
		const { data } = frontmatter(readFileSync(source, "utf8"));
		const name = data.name ?? folder.split(/[\\/]/).pop() ?? "skill";
		if (!SKILL_NAME.test(name)) throw new RpcError("bad_request", skillNameErrors(name).join("；"));
		if (builtinSkills().some((skill) => skill.name === name)) throw new RpcError("read_only", "此名称属于内置技能，请使用不同的用户技能名");
		const target = join(this.userSkillsDir, name);
		if (isBuiltinSkillPath(target)) throw new RpcError("read_only", "用户技能目录不能位于应用内置技能目录内");
		if (existsSync(target)) throw new RpcError("conflict", `已经有名为 ${name} 的技能`);
		const checked = validateSkill(readFileSync(source, "utf8"), { filePath: source, name });
		if (!checked.ok) throw new RpcError("bad_request", checked.errors.join("；"));
		this.core.library.write("skill", locator(join(target, "SKILL.md")), { sourceKind: "community", sourceUrl: sourceUrl ?? folder, trust: "untrusted", enabled: false });
		copyDir(folder, target);
		this.setSkillEnabled(join(target, "SKILL.md"), false);
		this.propose({ name, description: data.description ?? "", content: readFileSync(source, "utf8"), scope: "user", sourceKind: "community", sourceUrl: sourceUrl ?? folder,
			bundleFingerprint: fileFingerprint("skill", join(target, "SKILL.md")), filesPreview: previewSkillFiles(target) });
		this.core.broadcast({ event: "skills.changed" });
		return { name, description: data.description ?? "", filePath: join(target, "SKILL.md"), baseDir: target, scope: "user", ...this.core.library.get("skill", locator(join(target, "SKILL.md"))), enabled: false, modelInvocable: true };
	}

	// ---- proposals ---------------------------------------------------------------------

	propose(payload: SkillProposal, origin: { sourceSession?: string | null; cwd?: string | null } = {}): Proposal {
		if (!SKILL_NAME.test(payload.name)) throw new RpcError("bad_request", skillNameErrors(payload.name).join("；"));
		if (builtinSkills().some((skill) => skill.name === payload.name)) throw new RpcError("read_only", "内置技能不能直接修改，请先复制为用户技能并使用不同名称");
		const target = this.skillPath(payload.name, payload.scope, origin.cwd ?? undefined);
		if (isBuiltinSkillPath(target)) throw new RpcError("read_only", "内置技能目录只读，请选择用户技能目录");
		if (payload.scope === "project" && (!origin.cwd || !this.core.isProjectTrusted(origin.cwd))) throw new RpcError("untrusted", "工作区未获信任，不能写入项目技能");
		const checked = validateSkill(payload.content, { name: payload.name, files: payload.files, filePath: existsSync(target) ? target : undefined });
		if (!checked.ok) throw new RpcError("bad_request", checked.errors.join("；"));
		validateFiles(payload.files);
		const proposal: Proposal = {
			id: `p_${randomUUID().slice(0, 8)}`,
			kind: "skill",
			title: payload.name,
			payload: { ...payload, sourceKind: payload.sourceKind ?? "agent", sourceUrl: payload.sourceUrl ?? origin.sourceSession ?? null, previous: existsSync(target) ? readFileSync(target, "utf8") : null },
			status: "pending",
			sourceSession: origin.sourceSession ?? null,
			cwd: origin.cwd ?? null,
			createdAt: now(),
			resolvedAt: null,
		};
		this.db.run(
			"INSERT INTO proposals(id, kind, title, payload, status, source_session, cwd, created_at) VALUES(?, ?, ?, ?, 'pending', ?, ?, ?)",
			proposal.id,
			proposal.kind,
			proposal.title,
			json(proposal.payload),
			proposal.sourceSession,
			proposal.cwd,
			proposal.createdAt,
		);
		this.core.broadcast({ event: "proposals.changed" });
		if (!this.core.clients.size) this.core.notifications.post({ key: `skill:proposal:${proposal.id}`, category: "decision", objectRef: proposal.id,
			object: payload.name, situation: "Agent 建议保存一个技能", impact: "等待你决定是否保存", action: "查看技能提议",
			target: { page: "library", sessionFile: proposal.sourceSession, itemId: proposal.id },
		}, { legacy: { title: "Agent 建议保存一个技能", body: payload.name } });
		return proposal;
	}

	listProposals(status: ProposalStatus | undefined = "pending"): Proposal[] {
		const rows = status
			? this.db.all<ProposalRow>("SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC", status)
			: this.db.all<ProposalRow>("SELECT * FROM proposals ORDER BY created_at DESC LIMIT 200");
		return rows.map(toProposal);
	}

	private skillPath(name: string, scope: "user" | "project", cwd?: string): string {
		if (scope === "project" && cwd) return join(cwd, ".pi", "skills", name, "SKILL.md");
		return join(this.userSkillsDir, name, "SKILL.md");
	}

	async acceptProposal(id: string, edited?: Partial<SkillProposal>): Promise<unknown> {
		const row = this.db.get<ProposalRow>("SELECT * FROM proposals WHERE id = ?", id);
		if (!row || row.status !== "pending") throw new RpcError("gone", "这个建议已经处理过了");
		const proposal = toProposal(row);
		if (proposal.kind === "mcp") return this.core.call("mcp.acceptProposal", { id });
		const payload = { ...proposal.payload, ...(edited?.name ? { name: edited.name } : {}), ...(edited?.content ? { content: edited.content } : {}) };
		if (!SKILL_NAME.test(payload.name)) throw new RpcError("bad_request", "技能名只能用小写字母、数字和横线");
		if (builtinSkills().some((skill) => skill.name === payload.name)) throw new RpcError("read_only", "内置技能不能直接修改，请先复制为用户技能");
		if (payload.scope !== "project") payload.scope = "user";
		const path = this.skillPath(payload.name, payload.scope, proposal.cwd ?? undefined);
		if (isBuiltinSkillPath(path)) throw new RpcError("read_only", "内置技能目录只读，请选择用户技能目录");
		if (payload.scope === "project" && (!proposal.cwd || !this.core.isProjectTrusted(proposal.cwd))) throw new RpcError("untrusted", "工作区未获信任");
		if (payload.bundleFingerprint && (payload.name !== proposal.payload.name || fileFingerprint("skill", path) !== payload.bundleFingerprint)) throw new RpcError("conflict", "导入的技能文件已变化，请重新导入或登记");
		if (!payload.bundleFingerprint && (existsSync(path) ? readFileSync(path, "utf8") : null) !== proposal.payload.previous) throw new RpcError("conflict", "技能已被修改，请重新登记建议");
		const content = payload.content.startsWith("---") ? payload.content : skillMarkdown(payload.name, payload.description, payload.content);
		const checked = validateSkill(content, { name: payload.name, files: payload.files, filePath: existsSync(path) ? path : undefined });
		if (!checked.ok) throw new RpcError("bad_request", checked.errors.join("；"));
		validateFiles(payload.files);
		assertSafeSkillTarget(path, payload.files);
		mkdirSync(dirname(path), { recursive: true });
		for (const [file, text] of Object.entries(payload.files ?? {})) { const destination = join(dirname(path), file); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, text, "utf8"); }
		writeFileSync(path, content, "utf8");
		this.core.library.write("skill", locator(path), { sourceKind: payload.sourceKind ?? "agent", sourceUrl: payload.sourceUrl ?? null, trust: "trusted", enabled: true }, fileFingerprint("skill", path));
		this.setSkillEnabled(path, true);
		this.db.run("UPDATE proposals SET status = 'accepted', payload = ?, resolved_at = ? WHERE id = ?", json(payload), now(), id);
		this.core.broadcast({ event: "proposals.changed" });
		this.core.broadcast({ event: "skills.changed" });
		return { path };
	}

	rejectProposal(id: string): void {
		this.db.run("UPDATE proposals SET status = 'rejected', resolved_at = ? WHERE id = ? AND status = 'pending'", now(), id);
		this.core.broadcast({ event: "proposals.changed" });
	}

	/** Drafts a skill from what worked in a session (the "存成技能" button). */
	async draftSkillFromSession(slotId: string): Promise<Proposal> {
		const slot = this.core.slot(slotId);
		const conversation = (slot.session.messages as unknown as { role: string; content: unknown }[])
			.filter((m) => m.role === "user" || m.role === "assistant")
			.map((m) => `${m.role === "user" ? "用户" : "助手"}：${textOf(m.content).slice(0, 2000)}`)
			.join("\n\n")
			.slice(-12000);
		if (!conversation.trim()) throw new RpcError("bad_request", "这个会话还没有内容");
		const answer = await this.llm.complete(conversation, {
			system:
				"把这段对话里完成任务的方法整理成一个可复用的 Agent 技能（SKILL.md）。只输出 JSON：" +
				'{"name":"小写字母和横线组成的英文名","description":"一句话说明这个技能做什么、什么时候用（用用户的语言）","body":"Markdown 正文：适用场景、步骤、需要的工具、结果检查方法"}。' +
				"写通用的方法，不要写这次任务特有的细节。",
			maxTokens: 2500,
			timeoutMs: 90_000,
			sessionModel: slot.info().model,
		});
		const draft = parseJsonAnswer<{ name?: string; description?: string; body?: string }>(answer);
		if (!draft?.body) throw new RpcError("model", "没能整理出技能，可以换个模型再试");
		const name = (draft.name ?? "my-skill").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "my-skill";
		return this.propose(
			{ name, description: draft.description ?? "", content: skillMarkdown(name, draft.description ?? "", draft.body), scope: "user", reason: "从会话整理" },
			{ sourceSession: slot.info().sessionFile, cwd: slot.cwd },
		);
	}

	// ---- templates ---------------------------------------------------------------------

	listTemplates(): TemplateInfo[] {
		if (!existsSync(this.promptsDir)) return [];
		const out: TemplateInfo[] = [];
		for (const file of readdirSync(this.promptsDir)) {
			if (!file.endsWith(".md")) continue;
			const filePath = join(this.promptsDir, file);
			const { data, body } = frontmatter(readFileSync(filePath, "utf8"));
			const params = parseJson<TemplateParam[]>(data["df-params"], []);
			out.push({ name: file.slice(0, -3), description: data.description ?? "", body: decompileTemplate(body.trim(), params), params, filePath, ...this.core.library.ensure("template", locator(filePath)) });
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	saveTemplate(input: { name: string; description?: string; body: string; params?: TemplateParam[]; previousName?: string }): TemplateInfo {
		const name = input.name.trim();
		assertTemplateName(name);
		if (input.previousName) assertTemplateName(input.previousName);
		if (!input.body.trim()) throw new RpcError("bad_request", "模板内容不能为空");
		const { piBody, params } = compileTemplate(input.body.trim(), input.params ?? []);
		const hint = params.map((p) => (p.default ? `[${p.name}]` : `<${p.name}>`)).join(" ");
		const text = [
			"---",
			`description: ${JSON.stringify((input.description ?? "").trim() || name)}`,
			...(hint ? [`argument-hint: ${JSON.stringify(hint)}`] : []),
			`df-params: ${JSON.stringify(JSON.stringify(params))}`,
			"---",
			piBody,
			"",
		].join("\n");
		mkdirSync(this.promptsDir, { recursive: true });
		if (input.previousName && input.previousName !== name) rmSync(join(this.promptsDir, `${input.previousName}.md`), { force: true });
		const filePath = join(this.promptsDir, `${name}.md`);
		writeFileSync(filePath, text, "utf8");
		this.core.library.write("template", locator(filePath), { sourceKind: "user", trust: "trusted", enabled: true }, fileFingerprint("template", filePath));
		this.core.broadcast({ event: "templates.changed" });
		return { name, description: input.description ?? "", body: input.body.trim(), params, filePath, ...this.core.library.get("template", locator(filePath)) };
	}

	removeTemplate(name: string): void {
		assertTemplateName(name);
		rmSync(join(this.promptsDir, `${name}.md`), { force: true });
		this.core.broadcast({ event: "templates.changed" });
	}

	/** Drafts a template from a message the user sent (variable parts become {{params}}). */
	async draftTemplate(text: string): Promise<{ name: string; description: string; body: string }> {
		const answer = await this.llm.complete(text.slice(0, 4000), {
			system:
				"把用户的这条请求改写成可复用的任务模板：会变的部分（主题、日期、文件、人名、数量等）换成 {{参数名}}，参数名用简短中文。只输出 JSON：" +
				'{"name":"简短模板名（中文或英文，不含空格）","description":"一句话说明","body":"模板正文"}',
			maxTokens: 1500,
			timeoutMs: 60_000,
		});
		const draft = parseJsonAnswer<{ name?: string; description?: string; body?: string }>(answer);
		return {
			name: (draft?.name ?? "我的模板").replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 64) || "我的模板",
			description: draft?.description ?? "",
			body: draft?.body ?? text,
		};
	}

	// ---- extension ---------------------------------------------------------------------

	extensions(slot: { slotId: string }): ExtensionFactory[] {
		const module = this;
		return [
			(pi: ExtensionAPI) => {
				module.routing.install(pi, slot.slotId);
				pi.registerTool({
					name: "skill_register", label: "登记技能", description: "Register or update a skill bundle for user review. Never enables or trusts it. content is the complete SKILL.md text. files maps each relative filename to its literal full text/source code, NOT a host file path. Do not include SKILL.md in files.",
					parameters: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, content: { type: "string", description: "Complete SKILL.md text, including frontmatter" }, scope: { type: "string", enum: ["user", "project"] }, files: { type: "object", description: "Relative filename -> literal full file contents, e.g. {\"scripts/check.py\":\"print('ok')\\n\"}; never file paths; SKILL.md goes only in content", additionalProperties: { type: "string" } }, sourceKind: { type: "string", enum: ["agent", "community"] }, sourceUrl: { type: "string" } }, required: ["name", "description", "content"] } as never,
					async execute(_id, input: SkillProposal) {
						const live = module.core.slots.get(slot.slotId);
						const proposal = module.propose({ name: input.name, description: input.description, content: input.content, scope: input.scope === "project" ? "project" : "user", files: input.files, sourceKind: input.sourceKind === "agent" ? "agent" : input.sourceKind === "community" || input.sourceUrl ? "community" : "agent", sourceUrl: input.sourceUrl }, { cwd: live?.cwd, sourceSession: live?.info().sessionFile });
						return { content: [{ type: "text", text: JSON.stringify({ id: proposal.id, status: "pending", trust: "untrusted", enabled: false }) }], details: {} };
					},
				});
				pi.registerTool({
					name: "skill_test", label: "检查技能", description: "Statically validate a registered or proposed SKILL.md; never executes scripts on the host. Use skill_script_trial for separate butterfly sandbox execution.",
					parameters: { type: "object", properties: { filePath: { type: "string" }, proposalId: { type: "string" } } } as never,
					async execute(_id, input: Record<string, unknown>) { return { content: [{ type: "text", text: JSON.stringify(await module.core.call("skills.test", input)) }], details: {} }; },
				});
				pi.registerTool({ name: "skill_script_trial", label: "沙箱试运行技能", description: "Copy a skill or pending proposal into an isolated butterfly sandbox temporary directory, run one script as agent with time/output limits, and report exit code, output and artifacts. Never runs the script on the host or grants trust.",
					parameters: { type: "object", properties: { filePath: { type: "string" }, proposalId: { type: "string" }, script: { type: "string" }, args: { type: "array", items: { type: "string" } }, timeoutMs: { type: "number" }, maxOutputBytes: { type: "number" } } } as never,
					async execute(_id, input: Record<string, unknown>) { return { content: [{ type: "text", text: JSON.stringify(await module.core.call("skills.scriptTrial", input)) }], details: {} }; },
				});
				pi.registerTool({
					name: "skill_propose",
					label: "建议保存技能",
					description:
						"Propose saving a reusable method as an Agent Skill (SKILL.md) after you completed a task in a way worth repeating, or when the user asks. The user reviews it before it is saved. Write general steps, applicable situations, needed tools and how to check results; not task-specific details.",
					parameters: {
						type: "object",
						properties: {
							name: { type: "string", description: "lowercase-with-dashes" },
							description: { type: "string", description: "What it does and when to use it" },
							body: { type: "string", description: "Markdown instructions" },
							scope: { type: "string", enum: ["user", "project"], description: "project = only for this workspace" },
							reason: { type: "string" },
						},
						required: ["name", "description", "body"],
					} as never,
					async execute(_id, params: { name: string; description: string; body: string; scope?: "user" | "project"; reason?: string }) {
						const live = module.core.slots.get(slot.slotId);
						const name = params.name;
						const proposal = module.propose(
							{ name, description: params.description, content: skillMarkdown(name, params.description, params.body), scope: params.scope ?? "user", reason: params.reason },
							{ sourceSession: live?.info().sessionFile ?? null, cwd: live?.cwd ?? null },
						);
						return { content: [{ type: "text", text: `已提交给用户确认（${proposal.id}）。用户同意后技能才会保存。` }], details: {} };
					},
				});
			},
		];
	}

	private register(): void {
		const core = this.core;
		core.register("skills.routingStatus", (p) => this.routing.status(core.slot(requireStr(p.slotId, "slotId")).session.sessionId) ?? null);
		core.register("skills.copyBuiltin", (p) => {
			const source = requireStr(p.filePath, "filePath"), name = requireStr(p.name, "name");
			if (!builtinSkillKey(source)) throw new RpcError("bad_request", "请选择一个内置技能");
			if (!SKILL_NAME.test(name)) throw new RpcError("bad_request", skillNameErrors(name).join("；"));
			if (builtinSkills().some((skill) => skill.name === name)) throw new RpcError("conflict", "复制后的技能须使用不同名称");
			const target = this.skillPath(name, "user");
			if (isBuiltinSkillPath(target)) throw new RpcError("read_only", "用户技能目录不能位于应用内置技能目录内");
			if (existsSync(dirname(target))) throw new RpcError("conflict", "此用户技能已存在");
			assertSafeSkillTarget(target); copyDir(dirname(source), dirname(target));
			writeFileSync(target, readFileSync(target, "utf8").replace(/^name:[^\r\n]*$/m, `name: ${name}`), "utf8");
			core.library.write("skill", locator(target), { sourceKind: "user", sourceUrl: `app:${builtinSkillKey(source)}`, trust: "trusted", enabled: true }, fileFingerprint("skill", target));
			core.broadcast({ event: "skills.changed" }); return { path: target, name };
		});
		core.register("skills.list", (p) => this.listSkills(requireStr(p.cwd, "cwd")));
		core.register("skills.read", (p) => this.readSkill(requireStr(p.filePath, "filePath")));
		core.register("skills.setEnabled", (p) => {
			this.setSkillEnabled(requireStr(p.filePath, "filePath"), p.enabled === true);
			return { ok: true };
		});
		core.register("skills.remove", (p) => {
			this.removeSkill(requireStr(p.filePath, "filePath"));
			return { ok: true };
		});
		core.register("skills.import", (p) => this.importSkill(requireStr(p.folder, "folder"), str(p.sourceUrl)));
		core.register("skills.importUrl", async (p) => {
			if (core.maintenance) throw new RpcError("busy", "正在维护数据，请稍后导入");
			const url = requireStr(p.url, "url");
			return withSkillDownload(url, (folder) => { if (core.maintenance) throw new RpcError("busy", "正在维护数据，请稍后导入"); return this.importSkill(folder, url); });
		});
		core.register("skills.register", (p) => this.propose({ name: requireStr(p.name, "name"), description: requireStr(p.description, "description"), content: requireStr(p.content, "content"), scope: p.scope === "project" ? "project" : "user", files: p.files as Record<string, string> | undefined,
			sourceKind: p.sourceKind === "community" ? "community" : p.sourceKind === "user" ? "user" : "agent", sourceUrl: str(p.sourceUrl) }, { cwd: str(p.cwd) }));
		core.register("skills.test", (p) => {
			if (typeof p.proposalId === "string") {
				const proposal = this.listProposals(undefined).find((row) => row.id === p.proposalId && row.kind === "skill");
				if (!proposal) throw new RpcError("not_found", "没有这个技能建议");
				const path = this.skillPath(proposal.payload.name, proposal.payload.scope, proposal.cwd ?? undefined);
				return validateSkill(proposal.payload.content, { name: proposal.payload.name, files: proposal.payload.files, filePath: existsSync(path) ? path : undefined });
			}
			const filePath = requireStr(p.filePath, "filePath"); assertSkillFile(filePath);
			return validateSkill(readFileSync(filePath, "utf8"), { filePath });
		});
		core.register("skills.scriptTrial", (p) => {
			let files: Record<string, string>;
			if (typeof p.proposalId === "string") {
				const proposal = this.listProposals(undefined).find((row) => row.id === p.proposalId && row.kind === "skill");
				if (!proposal) throw new RpcError("not_found", "没有这个技能建议");
				const path = this.skillPath(proposal.payload.name, proposal.payload.scope, proposal.cwd ?? undefined);
				files = existsSync(path) ? skillBundle(dirname(path)) : {};
				files["SKILL.md"] = Buffer.from(proposal.payload.content).toString("base64");
				for (const [name, text] of Object.entries(proposal.payload.files ?? {})) files[name.replaceAll("\\", "/")] = Buffer.from(text).toString("base64");
			} else { const filePath = requireStr(p.filePath, "filePath"); assertSkillFile(filePath); files = skillBundle(dirname(filePath)); }
			const scripts = Object.keys(files).filter((file) => file.startsWith("scripts/") && /\.(?:py|[cm]?js|sh)$/.test(file));
			const script = str(p.script) ?? (scripts.length === 1 ? scripts[0]! : "");
			return trialSkill(core, { files, script, args: p.args as string[] | undefined, timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : undefined, maxOutputBytes: typeof p.maxOutputBytes === "number" ? p.maxOutputBytes : undefined });
		});
		core.register("skills.draftFromSession", (p) => this.draftSkillFromSession(requireStr(p.slotId, "slotId")));
		core.register("proposals.list", (p) => this.listProposals(p.status === "all" ? undefined : ((str(p.status) as ProposalStatus | undefined) ?? "pending")));
		core.register("proposals.accept", (p) => this.acceptProposal(requireStr(p.id, "id"), (p.edited as Partial<SkillProposal> | undefined) ?? undefined));
		core.register("proposals.reject", (p) => {
			this.rejectProposal(requireStr(p.id, "id"));
			return { ok: true };
		});
		core.register("templates.list", () => this.listTemplates());
		core.register("templates.setEnabled", (p) => {
			const template = this.listTemplates().find((t) => t.name === p.name);
			if (!template) throw new RpcError("not_found", "没有这个模板");
			this.core.library.write("template", locator(template.filePath), { enabled: p.enabled === true });
			core.broadcast({ event: "templates.changed" }); return { ok: true };
		});
		core.register("templates.save", (p) =>
			this.saveTemplate({
				name: requireStr(p.name, "name"),
				description: str(p.description),
				body: requireStr(p.body, "body"),
				params: Array.isArray(p.params) ? (p.params as TemplateParam[]) : [],
				previousName: str(p.previousName),
			}),
		);
		core.register("templates.remove", (p) => {
			this.removeTemplate(requireStr(p.name, "name"));
			return { ok: true };
		});
		core.register("templates.command", (p) => {
			const template = this.listTemplates().find((t) => t.name === p.name);
			if (!template) throw new RpcError("not_found", "没有这个模板");
			if (!this.core.library.fileAllowed("template", template.filePath)) throw new RpcError("untrusted", "模板已停用或未获信任");
			return { command: templateCommand(template.name, template.params, (p.values as Record<string, string>) ?? {}) };
		});
		core.register("templates.draft", (p) => this.draftTemplate(requireStr(p.text, "text")));
	}
}

interface ProposalRow {
	id: string;
	kind: string;
	title: string;
	payload: string;
	status: string;
	source_session: string | null;
	cwd: string | null;
	created_at: number;
	resolved_at: number | null;
}

function toProposal(row: ProposalRow): Proposal {
	return {
		id: row.id,
		kind: row.kind as ProposalKind,
		title: row.title,
		payload: parseJson<SkillProposal>(row.payload, { name: row.title, description: "", content: "", scope: "user" }),
		status: row.status as ProposalStatus,
		sourceSession: row.source_session,
		cwd: row.cwd,
		createdAt: row.created_at,
		resolvedAt: row.resolved_at,
	};
}

/** Only Markdown files below a `skills` folder may be read or removed through the skill methods. */
function assertSkillFile(filePath: string): void {
	// Judge the real location: "..", symlinks and junctions must not lead out of a skills folder.
	let real: string;
	try {
		real = realpathSync(resolve(filePath));
	} catch {
		throw new RpcError("not_found", "这个技能文件不存在");
	}
	const parts = real.split(/[\\/]/);
	if (!real.toLowerCase().endsWith(".md") || !parts.slice(0, -1).some((p) => p.toLowerCase() === "skills")) {
		throw new RpcError("bad_request", "不是技能文件");
	}
}

/** Template names become file names and /commands: no separators or dots. */
function assertTemplateName(name: string): void {
	if (!/^[\p{L}\p{N}_-]{1,64}$/u.test(name)) throw new RpcError("bad_request", "模板名只能用文字、数字、横线和下划线（会成为 /命令名）");
}

function copyDir(from: string, to: string): void {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) throw new RpcError("bad_request", "技能不能包含符号链接或目录联接");
		const source = join(from, entry.name);
		const target = join(to, entry.name);
		if (entry.isDirectory()) copyDir(source, target);
		else writeFileSync(target, readFileSync(source));
	}
}

function validateFiles(files?: Record<string, string>): void {
	if (files === undefined) return;
	if (!files || typeof files !== "object" || Array.isArray(files)) throw new RpcError("bad_request", "files 必须是相对路径到文本的映射");
	let size = 0;
	for (const [file, content] of Object.entries(files)) {
		if (!file || isAbsolute(file) || file.includes(":") || file.split(/[\\/]/).some((part) => !part || part === "." || part === "..") || file.toLowerCase() === "skill.md" || typeof content !== "string") throw new RpcError("bad_request", "技能附属文件必须是安全的相对路径，不能覆盖 SKILL.md");
		size += Buffer.byteLength(content);
	}
	if (Object.keys(files).length > 2000 || size > 32 * 1024 * 1024) throw new RpcError("bad_request", "技能文件过多或超过 32 MB 上限");
}

function assertSafeSkillTarget(path: string, files?: Record<string, string>): void {
	for (const target of [path, ...Object.keys(files ?? {}).map((file) => join(dirname(path), file))]) {
		let current = target;
		while (current !== dirname(current)) {
			if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new RpcError("bad_request", "技能写入路径不能经过符号链接或目录联接");
			current = dirname(current);
		}
		if (relative(dirname(path), target).startsWith("..")) throw new RpcError("bad_request", "技能文件超出目录");
	}
}

function previewSkillFiles(root: string): Record<string, string> {
	const files: Record<string, string> = {};
	let remaining = 200_000;
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const file = join(dir, entry.name);
			if (entry.isDirectory()) { visit(file); continue; }
			if (!entry.isFile() || file === join(root, "SKILL.md")) continue;
			const bytes = readFileSync(file), name = relative(root, file).replaceAll("\\", "/");
			const text = bytes.includes(0) ? `[二进制文件：${bytes.length} bytes，请打开技能目录查看]` : bytes.toString("utf8");
			files[name] = remaining > 0 ? text.slice(0, Math.min(64_000, remaining)) : "";
			remaining -= files[name]!.length;
			if (files[name]!.length < text.length) files[name] += "\n[预览已截断，请打开技能目录查看全文]";
		}
	};
	visit(root); return files;
}
