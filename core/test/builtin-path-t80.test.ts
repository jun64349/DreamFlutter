import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { BUILTIN_SKILLS_DIR, isBuiltinSkillPath } from "../src/modules/builtin-skills.ts";
import { settledCount, startTestCore } from "./harness.ts";

test("T80 R79-02 junctions protect new descendants and ordinary tool writes; user directories still work", async () => {
	const t = await startTestCore();
	try {
		const alias = join(t.workspace, "builtin-alias"); symlinkSync(BUILTIN_SKILLS_DIR, alias, "junction");
		for (const path of [alias, join(alias, "t80-never-created", "SKILL.md"), join(alias, "skill-builder", "new", "deeper", "file.txt")]) assert.equal(isBuiltinSkillPath(path), true, path);
		const userFile = join(t.workspace, "normal", "new", "SKILL.md");
		assert.equal(isBuiltinSkillPath(userFile), false);
		const dangling = join(t.workspace, "dangling"); symlinkSync(join(t.dir, "missing"), dangling, "junction");
		assert.equal(isBuiltinSkillPath(join(dangling, "new.txt")), true, "unresolvable existing link must deny");
		const regular = join(t.workspace, "regular.txt"); writeFileSync(regular, "file");
		assert.equal(isBuiltinSkillPath(join(regular, "child.txt")), true, "ENOTDIR must deny");
		t.core.settings.update({ approvalMode: "off" });
		await t.core.call("slot.open", { slotId: "junction", cwd: t.workspace }, t.client);
		const target = join(alias, "t80-never-created", "SKILL.md");
		t.respond(fauxAssistantMessage([fauxToolCall("write", { file_path: target, content: "must be blocked" })], { stopReason: "toolUse" }), fauxAssistantMessage("blocked"));
		await t.send("junction", { type: "prompt", message: "Exercise new-file write through existing junction" });
		await t.waitFor(() => settledCount(t.records("junction")) === 1);
		assert.equal(t.records("junction").find(r => r.type === "tool_execution_end")?.isError, true);
		assert.equal(existsSync(join(BUILTIN_SKILLS_DIR, "t80-never-created")), false);
		t.respond(fauxAssistantMessage([fauxToolCall("write", { file_path: userFile, content: "user fixture" })], { stopReason: "toolUse" }), fauxAssistantMessage("written"));
		await t.send("junction", { type: "prompt", message: "Exercise normal user file write" });
		await t.waitFor(() => settledCount(t.records("junction")) === 2);
		assert.equal(readFileSync(userFile, "utf8"), "user fixture");
	} finally { await t.cleanup(); }
});

test("T80 R79-02 real directory and file symlinks protect builtin paths and discovery rejects linked entries", async () => {
	const root = mkdtempSync(join(tmpdir(), "df-t80-builtin-"));
	try {
		const builtinRoot = join(root, "assets", "skills"), valid = join(builtinRoot, "valid"), outside = join(root, "outside");
		mkdirSync(valid, { recursive: true }); mkdirSync(outside);
		const markdown = (name: string) => `---\nname: ${name}\ndescription: Isolated validation fixture\n---\nFixture.\n`;
		writeFileSync(join(valid, "SKILL.md"), markdown("valid"));
		writeFileSync(join(outside, "SKILL.md"), markdown("linked-dir"));
		// Symlink privileges/developer mode are required; failing to create them is a test failure, never a silent skip.
		const alias = join(root, "symbolic-alias"); symlinkSync(BUILTIN_SKILLS_DIR, alias, "dir");
		assert.equal(isBuiltinSkillPath(join(alias, "new", "nested", "SKILL.md")), true);
		const fileAlias = join(root, "symbolic-file.md"); symlinkSync(join(BUILTIN_SKILLS_DIR, "skill-builder", "SKILL.md"), fileAlias, "file");
		assert.equal(isBuiltinSkillPath(fileAlias), true);
		symlinkSync(outside, join(builtinRoot, "linked-dir"), "junction");
		// Use the unchanged discovery implementation in an isolated root: never add fixtures to shipped assets.
		const moduleUrl = new URL("../src/modules/builtin-skills.ts", import.meta.url);
		let code = readFileSync(moduleUrl, "utf8").replace('fileURLToPath(new URL("../../assets/skills/", import.meta.url))', JSON.stringify(builtinRoot));
		code = code.replace('"@earendil-works/pi-coding-agent"', JSON.stringify(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url).href));
		code = code.replace('"./skill-name.ts"', JSON.stringify(new URL("../src/modules/skill-name.ts", import.meta.url).href));
		writeFileSync(join(root, "package.json"), '{"type":"module"}');
		const mirror = join(root, "builtin-skills.ts"); writeFileSync(mirror, code);
		const implementation = await import(pathToFileURL(mirror).href);
		assert.deepEqual(implementation.builtinSkills().map((s: { name: string }) => s.name), ["valid"]);
		const fileDir = join(builtinRoot, "linked-file"); mkdirSync(fileDir);
		symlinkSync(join(outside, "SKILL.md"), join(fileDir, "SKILL.md"), "file");
		assert.equal(implementation.builtinSkillKey(join(fileDir, "SKILL.md")), undefined);
		assert.throws(() => implementation.builtinSkills(), /内置技能路径无效/);
	} finally {
		assert.ok(root.startsWith(join(tmpdir(), "df-t80-builtin-")));
		rmSync(root, { recursive: true, force: true });
	}
});
