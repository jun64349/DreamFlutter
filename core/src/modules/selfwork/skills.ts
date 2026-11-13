import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RpcError, requireStr, type Core } from "../../core.ts";
import { locator } from "../library-registry.ts";
import { skillMarkdown, SkillsModule } from "../skills.ts";
import { validateSkill } from "../skill-validation.ts";
import { trialSkill, type TrialRunner } from "../skill-trial.ts";
import { requireUser } from "./access.ts";

export interface SkillDraft { name: string; description: string; body: string }
interface SkillRow { id: string; name: string; active_version: number; adopted_version: number | null }
interface Version { version: number; description: string; content: string; source_ref: string; tested_at: number }

// The test is supplied by the program. The draft is a Markdown document, not an executable.
const trial = `import hashlib, pathlib, sys
data = pathlib.Path("SKILL.md").read_bytes()
text = data.decode("utf-8", errors="strict")
header, separator, body = text[4:].partition("\\n---\\n")
assert hashlib.sha256(data).hexdigest() == sys.argv[1]
assert text.startswith("---\\n") and separator and body.strip()
assert "name:" in header and "description:" in header
print("skill-document-ok")
`;

export class SelfworkSkills {
	private readonly core: Core;
	private readonly clock: () => number;
	private readonly runner?: TrialRunner;

	constructor(core: Core, clock: () => number, runner?: TrialRunner) {
		this.core = core;
		this.clock = clock;
		this.runner = runner;
		core.register("selfwork.skills.list", () => this.rows().map(row => ({
			...row, source: "butterfly_self",
			versions: core.db.all<Omit<Version, "content">>("SELECT version,description,source_ref,tested_at FROM selfwork_skill_versions WHERE skill_id=? ORDER BY version DESC", row.id),
		})));
		core.register("selfwork.skills.adopt", async (p, client) => {
			requireUser(core, client);
			const row = this.get(requireStr(p.id, "id"));
			if (row.adopted_version !== null) return row;
			if (await this.nameTaken(row.name, strCwd(p.cwd))) throw new RpcError("conflict", "此名称已经被其他技能使用");
			requireUser(core, client);
			const current = this.get(row.id);
			if (current.active_version !== row.active_version) throw new RpcError("conflict", "技能版本已变化，请重新查看");
			this.core.db.run("UPDATE selfwork_skills SET adopted_version=active_version WHERE id=? AND adopted_version IS NULL", row.id);
			this.materialize(row, row.active_version, false);
			this.changed();
			return this.get(row.id);
		});
		core.register("selfwork.skills.rollback", (p, client) => {
			requireUser(core, client);
			const row = this.get(requireStr(p.id, "id"));
			if (typeof p.version !== "number" || !Number.isSafeInteger(p.version) || !this.version(row.id, p.version)) throw new RpcError("bad_request", "找不到已验证的技能版本");
			this.core.db.run("UPDATE selfwork_skills SET active_version=? WHERE id=?", p.version, row.id);
			this.materialize(row, p.version, true);
			this.changed();
			return this.get(row.id);
		});
		core.register("selfwork.skills.delete", (p, client) => {
			requireUser(core, client);
			const row = this.get(requireStr(p.id, "id"));
			this.core.db.run("UPDATE selfwork_skills SET deleted_at=? WHERE id=?", this.clock(), row.id);
			for (const sandbox of [true, false]) {
				const path = this.path(row, sandbox);
				this.core.library.write("skill", locator(path), { enabled: false, trust: "untrusted", butterflyAllowed: false });
				if (existsSync(path)) unlinkSync(path);
			}
			this.changed();
			return { deleted: row.id };
		});
	}

	private rows(): SkillRow[] {
		return this.core.db.all<SkillRow>("SELECT id,name,active_version,adopted_version FROM selfwork_skills WHERE deleted_at IS NULL ORDER BY name");
	}

	private get(id: string): SkillRow {
		const row = this.rows().find(skill => skill.id === id);
		if (!row) throw new RpcError("not_found", "没有这个蝶君自写技能");
		return row;
	}

	private version(id: string, version: number): Version | undefined {
		return this.core.db.get<Version>("SELECT * FROM selfwork_skill_versions WHERE skill_id=? AND version=?", id, version);
	}

	private path(skill: SkillRow, sandbox: boolean): string {
		return join(this.core.paths.cacheDir, "selfwork-skills", sandbox ? "butterfly" : "adopted", skill.id, skill.name, "SKILL.md");
	}

	private changed(): void { this.core.broadcast({ event: "skills.changed" }); }

	private async nameTaken(name: string, cwd = this.core.paths.butterflyDir): Promise<boolean> {
		const skills = this.core.module(SkillsModule);
		if (!skills) return true;
		return skills.selfworkNameTaken(name, cwd);
	}

	async validateAndRegister(draft: SkillDraft, ref: string, guard: () => boolean): Promise<{ id?: string; reason?: string }> {
		if (!guard()) return { reason: "permission_changed" };
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.name) || draft.name.length > 48 || !draft.description.trim() || !draft.body.trim() || draft.body.length > 12_000) return { reason: "invalid_skill" };
		const content = skillMarkdown(draft.name, draft.description, draft.body);
		if (!validateSkill(content, { name: draft.name }).ok) return { reason: "invalid_skill" };
		if (await this.nameTaken(draft.name)) return { reason: "skill_name_taken" };
		if (!guard()) return { reason: "permission_changed" };
		const answer = await trialSkill(this.core, {
			script: "check.py",
			files: { "SKILL.md": Buffer.from(content).toString("base64"), "check.py": Buffer.from(trial).toString("base64") },
			args: [createHash("sha256").update(content).digest("hex")],
		}, this.runner);
		if (!answer.ok || answer.exitCode !== 0 || answer.stdout?.trim() !== "skill-document-ok") return { reason: "skill_trial_failed" };
		if (await this.nameTaken(draft.name)) return { reason: "skill_name_taken" };
		if (!guard()) return { reason: "permission_changed" };
		const db = this.core.db;
		const id = db.transaction(() => {
			const previous = db.get<{ id: string; deleted_at: number | null }>("SELECT id,deleted_at FROM selfwork_skills WHERE name=?", draft.name);
			if (previous && previous.deleted_at !== null) return undefined; // A user's deletion is respected.
			const id = previous?.id ?? randomUUID();
			const { version } = db.get<{ version: number }>("SELECT COALESCE(MAX(version),0)+1 AS version FROM selfwork_skill_versions WHERE skill_id=?", id)!;
			db.run("INSERT INTO selfwork_skills(id,name,active_version) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET active_version=excluded.active_version", id, draft.name, version);
			db.run("INSERT INTO selfwork_skill_versions VALUES(?,?,?,?,?,?)", id, version, ref, draft.description, content, this.clock());
			return id;
		});
		if (!id) return { reason: "skill_deleted" };
		const skill = this.get(id);
		this.materialize(skill, skill.active_version, true);
		this.changed();
		return { id };
	}

	private materialize(skill: SkillRow, version: number, sandbox: boolean): string {
		const item = this.version(skill.id, version);
		if (!item) throw new Error("已验证的技能版本缺失");
		const path = this.path(skill, sandbox);
		mkdirSync(dirname(path), { recursive: true });
		if (existsSync(path) && !lstatSync(path).isFile()) throw new Error("技能缓存位置无效");
		if (!existsSync(path) || readFileSync(path, "utf8") !== item.content) {
			const temporary = path + "." + randomUUID() + ".tmp";
			writeFileSync(temporary, item.content, { encoding: "utf8", flag: "wx" });
			try { renameSync(temporary, path); }
			finally { if (existsSync(temporary)) unlinkSync(temporary); }
		}
		this.core.library.registerSelfworkSkill(path, item.source_ref);
		return path;
	}

	paths(sandbox: boolean): string[] {
		return this.rows().flatMap(skill => {
			const version = sandbox ? skill.active_version : skill.adopted_version;
			if (version === null) return [];
			try { return [this.materialize(skill, version, sandbox)]; }
			catch (error) { this.core.log.warn("could not load verified Butterfly skill", error); return []; }
		});
	}
}

function strCwd(input: unknown): string | undefined {
	return typeof input === "string" && input.trim() ? input : undefined;
}
