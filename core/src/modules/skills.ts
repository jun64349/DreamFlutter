import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Core, CoreModule } from "../core.ts";
import { RpcError, requireStr, samePath, str } from "../core.ts";
import type { Db } from "../db.ts";
import { json, now, parseJson } from "../db.ts";
import { textOf } from "../runs.ts";
import { parseJsonAnswer, type Llm } from "./llm.ts";

export interface SkillInfo {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	/** user = ~/.pi/agent/skills or ~/.agents/skills; project = the workspace's own. */
	scope: string;
	enabled: boolean;
	modelInvocable: boolean;
}

export interface TemplateParam {
	name: string;
	default?: string;
}

export interface TemplateInfo {
	name: string;
	description: string;
	/** Body with {{param}} placeholders, for editing. */
	body: string;
	params: TemplateParam[];
	filePath: string;
}

export type ProposalKind = "skill";
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
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SKILL_TOOLS = ["skill_propose"];

/** SKILL.md with the Agent Skills frontmatter. */
export function skillMarkdown(name: string, description: string, body: string): string {
	const desc = description.replace(/\s+/g, " ").trim().slice(0, 1024);
	const text = body.replace(/^---[\s\S]*?---\s*/, "").trim();
	return `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${text}\n`;
}

// ---- templates: Pi prompt templates with named parameters ---------------------------------

function frontmatter(text: string): { data: Record<string, string>; body: string } {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return { data: {}, body: text };
	const data: Record<string, string> = {};
	for (const line of match[1]!.split(/\r?\n/)) {
		const kv = line.match(/^([\w-]+):\s*(.*)$/);
		if (!kv) continue;
		let value = kv[2]!.trim();
		if (value.startsWith('"') && value.endsWith('"')) {
			try {
				value = JSON.parse(value);
			} catch {
				value = value.slice(1, -1);
			}
		}
		data[kv[1]!] = value;
	}
	return { data, body: text.slice(match[0].length) };
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

	constructor(core: Core, llm: Llm) {
		this.core = core;
		this.db = core.db;
		this.llm = llm;
		core.declareBackup({ id: "proposals", title: "待确认的技能和记忆建议", tables: ["proposals"], paths: { proposals: { source_session: "path", cwd: "path" } } });
		core.exemptFromApproval(...SKILL_TOOLS);
		this.register();
	}

	private get userSkillsDir(): string {
		return join(this.core.agentDir, "skills");
	}

	private get promptsDir(): string {
		return join(this.core.agentDir, "prompts");
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

	async listSkills(cwd: string): Promise<SkillInfo[]> {
		const disabled = this.disabledPaths();
		// Untrusted projects stay unloaded here too (resolving project packages can run their code).
		const settingsManager = SettingsManager.create(cwd, this.core.agentDir, { projectTrusted: this.core.isProjectTrusted(cwd) });
		const loader = new DefaultResourceLoader({ cwd, agentDir: this.core.agentDir, settingsManager, noExtensions: true, noPromptTemplates: true, noThemes: true } as never);
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
		return [...found.values()].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
	}

	setSkillEnabled(filePath: string, enabled: boolean): void {
		const settings = this.readSettings();
		const list = (Array.isArray(settings.skills) ? settings.skills : []).filter((s): s is string => typeof s === "string" && !samePath(s.replace(/^-/, ""), filePath));
		if (!enabled) list.push(`-${filePath}`);
		settings.skills = list;
		this.writeSettings(settings);
		this.core.broadcast({ event: "skills.changed" });
	}

	/** Moves a skill folder into the core's trash (recoverable). */
	removeSkill(filePath: string): void {
		assertSkillFile(filePath);
		if (!existsSync(filePath)) throw new RpcError("not_found", "这个技能文件不存在");
		// A skill folder (…/name/SKILL.md) moves as a whole; a standalone skill is one file.
		const target = filePath.split(/[\\/]/).pop() === "SKILL.md" ? dirname(filePath) : filePath;
		const trash = join(this.core.paths.dataDir, "trash", `${Date.now()}-${target.split(/[\\/]/).pop()}`);
		mkdirSync(dirname(trash), { recursive: true });
		renameSync(target, trash);
		this.setSkillEnabled(filePath, true); // drop any exclusion entry
		this.core.broadcast({ event: "skills.changed" });
	}

	readSkill(filePath: string): string {
		assertSkillFile(filePath);
		return readFileSync(filePath, "utf8");
	}

	/** Copies a folder containing SKILL.md into the user's skills. */
	importSkill(folder: string): SkillInfo {
		const source = join(folder, "SKILL.md");
		if (!existsSync(source)) throw new RpcError("bad_request", "这个文件夹里没有 SKILL.md");
		const { data } = frontmatter(readFileSync(source, "utf8"));
		const name = (data.name ?? folder.split(/[\\/]/).pop() ?? "skill").toLowerCase().replace(/[^a-z0-9-]/g, "-");
		const target = join(this.userSkillsDir, name);
		if (existsSync(target)) throw new RpcError("conflict", `已经有名为 ${name} 的技能`);
		copyDir(folder, target);
		this.core.broadcast({ event: "skills.changed" });
		return { name, description: data.description ?? "", filePath: join(target, "SKILL.md"), baseDir: target, scope: "user", enabled: true, modelInvocable: true };
	}

	// ---- proposals ---------------------------------------------------------------------

	propose(payload: SkillProposal, origin: { sourceSession?: string | null; cwd?: string | null } = {}): Proposal {
		if (!SKILL_NAME.test(payload.name)) throw new RpcError("bad_request", "技能名只能用小写字母、数字和横线");
		const target = this.skillPath(payload.name, payload.scope, origin.cwd ?? undefined);
		const proposal: Proposal = {
			id: `p_${randomUUID().slice(0, 8)}`,
			kind: "skill",
			title: payload.name,
			payload: { ...payload, previous: existsSync(target) ? readFileSync(target, "utf8") : null },
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
		if (!this.core.clients.size && this.core.settings.get().notifications) this.core.notifier.notify("Agent 建议保存一个技能", payload.name);
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

	acceptProposal(id: string, edited?: Partial<SkillProposal>): { path: string } {
		const row = this.db.get<ProposalRow>("SELECT * FROM proposals WHERE id = ?", id);
		if (!row || row.status !== "pending") throw new RpcError("gone", "这个建议已经处理过了");
		const proposal = toProposal(row);
		const payload = { ...proposal.payload, ...edited };
		if (!SKILL_NAME.test(payload.name)) throw new RpcError("bad_request", "技能名只能用小写字母、数字和横线");
		if (payload.scope !== "project") payload.scope = "user";
		const path = this.skillPath(payload.name, payload.scope, proposal.cwd ?? undefined);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, payload.content.startsWith("---") ? payload.content : skillMarkdown(payload.name, payload.description, payload.content), "utf8");
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
			out.push({ name: file.slice(0, -3), description: data.description ?? "", body: decompileTemplate(body.trim(), params), params, filePath });
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
		this.core.broadcast({ event: "templates.changed" });
		return { name, description: input.description ?? "", body: input.body.trim(), params, filePath };
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
						const name = params.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
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
		core.register("skills.import", (p) => this.importSkill(requireStr(p.folder, "folder")));
		core.register("skills.draftFromSession", (p) => this.draftSkillFromSession(requireStr(p.slotId, "slotId")));
		core.register("proposals.list", (p) => this.listProposals(p.status === "all" ? undefined : ((str(p.status) as ProposalStatus | undefined) ?? "pending")));
		core.register("proposals.accept", (p) => this.acceptProposal(requireStr(p.id, "id"), (p.edited as Partial<SkillProposal> | undefined) ?? undefined));
		core.register("proposals.reject", (p) => {
			this.rejectProposal(requireStr(p.id, "id"));
			return { ok: true };
		});
		core.register("templates.list", () => this.listTemplates());
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
		const source = join(from, entry.name);
		const target = join(to, entry.name);
		if (entry.isDirectory()) copyDir(source, target);
		else writeFileSync(target, readFileSync(source));
	}
}
