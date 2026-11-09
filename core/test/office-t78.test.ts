import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { builtinSkills } from "../src/modules/builtin-skills.ts";
import { validateSkill } from "../src/modules/skill-validation.ts";
import { bundledPython } from "../src/agent/toolchain.ts";
import { startTestCore } from "./harness.ts";
import type { SkillInfo } from "../src/modules/skills.ts";

const NAMES = ["office-docx", "office-xlsx", "office-pptx", "office-pdf", "data-analysis"];
test("T78 all five shipped skills and referenced resources validate", () => {
	const skills = builtinSkills().filter((s) => NAMES.includes(s.name));
	assert.equal(skills.length, 5);
	for (const skill of skills) {
		const check = validateSkill(readFileSync(skill.filePath, "utf8"), { filePath: skill.filePath, name: skill.name });
		assert.equal(check.ok, true, JSON.stringify(check));
		assert.ok(check.references.length > 0);
		assert.ok(check.scripts.every((script) => script.executable));
	}
});
test("T78 builtins are discovered, trusted, read-only and obey user disable through T77", async () => {
	const t = await startTestCore();
	try {
		const skills = await t.core.call("skills.list", { cwd: t.workspace }) as SkillInfo[];
		for (const name of NAMES) {
			const skill = skills.find((s) => s.name === name)!;
			assert.ok(skill, name); assert.equal(skill.sourceKind, "builtin"); assert.equal(skill.trust, "trusted"); assert.equal(skill.enabled, true); assert.equal(skill.readOnly, true);
		}
		const pdf = skills.find((s) => s.name === "office-pdf")!;
		await t.core.call("skills.setEnabled", { filePath: pdf.filePath, enabled: false });
		assert.equal((await t.core.call("skills.list", { cwd: t.workspace }) as SkillInfo[]).find((s) => s.name === pdf.name)!.enabled, false);
	} finally { await t.cleanup(); }
});
test("T78 converter validates artifacts and fails without modifying existing input/output", () => {
	const python = bundledPython(); assert.ok(python);
	const result = spawnSync(python, ["-I", "-B", join(import.meta.dirname, "../../scripts/t78-converter-tests.py")], { encoding: "utf8", windowsHide: true });
	assert.equal(result.status, 0, result.stdout + result.stderr);
});
