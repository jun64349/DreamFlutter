import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import type { LibraryRegistry } from "./library-registry.ts";
import { skillNameErrors } from "./skill-name.ts";

/** Existing production packaging already copies core/assets recursively. T-78 owns the office subdirectories. */
export const BUILTIN_SKILLS_DIR = fileURLToPath(new URL("../../assets/skills/", import.meta.url));
const pathKey = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
export function isBuiltinSkillPath(path: string): boolean {
	const lexicalRoot = pathKey(BUILTIN_SKILLS_DIR);
	const within = (value: string, root: string) => pathKey(value) === root || pathKey(value).startsWith(root + sep);
	if (within(path, lexicalRoot)) return true;
	try {
		const realRoot = pathKey(realpathSync(BUILTIN_SKILLS_DIR));
		let ancestor = resolve(path), remainder: string[] = [];
		for (;;) {
			try {
				// lstat distinguishes an absent component from an existing dangling link.
				const entry = lstatSync(ancestor);
				const real = realpathSync(ancestor);
				if (remainder.length && !entry.isDirectory() && !entry.isSymbolicLink()) return true;
				if (within(real, realRoot) || within(join(real, ...remainder), realRoot)) return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
				// A dangling junction/symlink exists but cannot be resolved: fail closed.
				try { lstatSync(ancestor); return true; }
				catch (missing) { if ((missing as NodeJS.ErrnoException).code !== "ENOENT") return true; }
			}
			const parent = dirname(ancestor);
			if (parent === ancestor) return false;
			remainder.unshift(basename(ancestor)); ancestor = parent;
			// Continue after finding the nearest ancestor: an outer junction may point
			// into builtin space even when a nested link points back out again.
		}
	} catch { return true; }
}
export function builtinSkillKey(path: string): string | undefined {
	if (basename(path).toLowerCase() !== "skill.md" || pathKey(dirname(dirname(path))) !== pathKey(BUILTIN_SKILLS_DIR)) return undefined;
	try {
		if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(dirname(path)).isSymbolicLink()
			|| pathKey(realpathSync(path)) !== pathKey(path)) return undefined;
	} catch { return undefined; }
	return `builtin:${basename(dirname(path))}`;
}
export function builtinSkills(): Skill[] {
	if (!existsSync(BUILTIN_SKILLS_DIR)) return [];
	return readdirSync(BUILTIN_SKILLS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).flatMap((entry) => {
		const baseDir = join(BUILTIN_SKILLS_DIR, entry.name), filePath = join(baseDir, "SKILL.md");
		if (!existsSync(filePath)) return [];
		if (!builtinSkillKey(filePath)) throw new Error(`内置技能路径无效：${entry.name}`);
		const { frontmatter } = parseFrontmatter(readFileSync(filePath, "utf8"));
		if (skillNameErrors(frontmatter.name, entry.name).length || typeof frontmatter.description !== "string" || !frontmatter.description.trim()) throw new Error(`内置技能包无效：${entry.name}`);
		return [{ name: entry.name, description: frontmatter.description, filePath, baseDir, disableModelInvocation: frontmatter["disable-model-invocation"] === true,
			sourceInfo: { path: filePath, source: "builtin", scope: "user" as const, origin: "top-level" as const, baseDir } }];
	});
}
export function mergeBuiltinSkills<T extends { skills: Skill[] }>(base: T, registry?: LibraryRegistry): T {
	const builtins = builtinSkills(), names = new Set(builtins.map((skill) => skill.name));
	for (const skill of builtins) registry?.write("skill", builtinSkillKey(skill.filePath)!, { sourceKind: "builtin", sourceUrl: `app:builtin/${skill.name}`, trust: "trusted" }, null);
	return { ...base, skills: [...builtins, ...base.skills.filter((skill) => !names.has(skill.name))] };
}
