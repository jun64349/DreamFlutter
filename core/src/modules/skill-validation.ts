import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { bundledPython } from "../agent/toolchain.ts";
import { fileFingerprint } from "./library-registry.ts";
import { skillNameErrors } from "./skill-name.ts";

export const VALID_SKILL_NAME = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;
export interface SkillCheck {
	ok: boolean; durationMs: number; errors: string[]; warnings: string[];
	references: string[]; scripts: { path: string; executable: boolean; interpreter?: string }[];
	scriptTrial: { status: "not-run"; runtime: "butterfly-sandbox"; reason: string };
}
export function validateSkill(content: string, options: { filePath?: string; name?: string; files?: Record<string, string> } = {}): SkillCheck {
	const start = Date.now(), errors: string[] = [], warnings: string[] = [], references: string[] = [];
	const scripts: SkillCheck["scripts"] = [];
	let data: Record<string, unknown> = {};
	if (!/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(content)) errors.push("SKILL.md 缺少完整 YAML frontmatter");
	try { data = parseFrontmatter(content).frontmatter; } catch (error) { errors.push(`YAML 无效：${(error as Error).message}`); }
	const name = data.name;
	errors.push(...skillNameErrors(name, options.name ?? (options.filePath && basename(options.filePath) === "SKILL.md" ? basename(dirname(options.filePath)) : undefined)));
	if (typeof data.description !== "string" || !data.description.trim() || data.description.length > 1024) errors.push("description 必须为 1–1024 字的非空字符串");
	for (const key of ["license", "allowed-tools"]) if (data[key] !== undefined && typeof data[key] !== "string") errors.push(`${key} 必须是字符串`);
	if (data.compatibility !== undefined && (typeof data.compatibility !== "string" || !data.compatibility.trim() || data.compatibility.length > 500)) errors.push("compatibility 必须为 1–500 字的非空字符串");
	if (data.metadata !== undefined && (!data.metadata || typeof data.metadata !== "object" || Array.isArray(data.metadata) || Object.values(data.metadata).some((value) => typeof value !== "string"))) errors.push("metadata 必须是字符串键值映射");
	const root = options.filePath ? dirname(options.filePath) : undefined;
	if (root) try { fileFingerprint("skill", options.filePath!); } catch (error) { errors.push((error as Error).message); }
	const refs = new Set<string>();
	for (const match of content.matchAll(/\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))[^)]*\)|\b((?:scripts|references|assets)\/[\w./-]+)/g)) {
		let ref = match[1] ?? match[2] ?? match[3]!;
		if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(ref)) continue;
		try { ref = decodeURIComponent(ref.split("#")[0]!); } catch { errors.push(`引用路径编码无效：${ref}`); continue; }
		if (ref) refs.add(ref);
	}
	for (const ref of refs) {
		references.push(ref);
		if (isAbsolute(ref) || ref.split(/[\\/]/).includes("..")) { errors.push(`引用超出技能目录：${ref}`); continue; }
		if (options.files && Object.hasOwn(options.files, ref)) continue;
		if (root) {
			const file = resolve(root, ref);
			if (!existsSync(file)) errors.push(`引用文件不存在：${ref}`);
			else if (relative(realpathSync(root), realpathSync(file)).startsWith("..")) errors.push(`引用超出技能目录：${ref}`);
		} else errors.push(`引用文件不存在：${ref}`);
	}
	const interpreter = (extension: string): string | undefined => {
		if ([".js", ".mjs", ".cjs", ".ts"].includes(extension)) return process.execPath;
		const candidates = extension === ".py" ? [bundledPython(), "python3", "python"] : extension === ".sh" ? ["bash"] : extension === ".ps1" ? ["pwsh", "powershell"] : [".cmd", ".bat"].includes(extension) ? [process.env.ComSpec] : [];
		for (const candidate of candidates) {
			if (!candidate) continue;
			if (isAbsolute(candidate) && existsSync(candidate)) return candidate;
			for (const dir of (process.env.PATH ?? "").split(delimiter)) for (const suffix of process.platform === "win32" ? [".exe", ".cmd", ""] : [""]) {
				const file = join(dir, candidate + suffix);
				try { accessSync(file, constants.X_OK); return file; } catch { /* next */ }
			}
		}
		return undefined;
	};
	if (root && existsSync(join(root, "scripts")) && !errors.some((error) => /链接|联接|检查上限/.test(error))) {
		const visit = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const file = join(dir, entry.name);
				if (entry.isSymbolicLink()) continue;
				if (entry.isDirectory()) { visit(file); continue; }
				const path = relative(root, file), runner = interpreter(extname(file).toLowerCase());
				const executable = !!runner || process.platform !== "win32" && !!(lstatSync(file).mode & 0o111) && readFileSync(file, "utf8").startsWith("#!");
				scripts.push({ path, executable, interpreter: runner });
				if (!executable) errors.push(`脚本不可执行或缺少解释器：${path}`);
			}
		};
		visit(join(root, "scripts"));
	}
	for (const file of Object.keys(options.files ?? {})) {
		if (!file.replaceAll("\\", "/").startsWith("scripts/") || scripts.some((script) => script.path.replaceAll("\\", "/") === file)) continue;
		const runner = interpreter(extname(file).toLowerCase());
		scripts.push({ path: file, executable: !!runner, interpreter: runner });
		if (!runner) errors.push(`脚本不可执行或缺少解释器：${file}`);
	}
	if (content.split(/\r?\n/).length > 500) warnings.push("建议将超过 500 行的内容拆到 references 文件");
	return { ok: errors.length === 0, durationMs: Date.now() - start, errors, warnings, references, scripts,
		scriptTrial: { status: "not-run", runtime: "butterfly-sandbox", reason: "本次仅做静态检查；用 skills.scriptTrial / skill_script_trial 单独进行蝶君沙箱试运行" } };
}
