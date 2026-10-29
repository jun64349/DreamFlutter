import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { compileTemplate, decompileTemplate, templateCommand, type Proposal, type SkillInfo, type TemplateInfo } from "../src/modules/skills.ts";
import { dialogs, settledCount, startTestCore, type TestCore } from "./harness.ts";

describe("skills", () => {
	let t: TestCore;

	beforeEach(async () => {
		t = await startTestCore();
		mkdirSync(join(t.agentDir, "skills", "weekly-report"), { recursive: true });
		writeFileSync(join(t.agentDir, "skills", "weekly-report", "SKILL.md"), "---\nname: weekly-report\ndescription: Write a weekly report\n---\nSteps.\n");
	});

	afterEach(async () => {
		await t.cleanup();
	});

	it("reads and removes only Markdown files below a skills folder", async () => {
		const notes = join(t.workspace, "notes");
		mkdirSync(notes, { recursive: true });
		writeFileSync(join(notes, "README.md"), "private");
		await assert.rejects(t.core.call("skills.read", { filePath: join(notes, "README.md") }), /不是技能文件/);
		await assert.rejects(t.core.call("skills.remove", { filePath: join(notes, "README.md") }), /不是技能文件/);
		assert.ok(existsSync(join(notes, "README.md")), "the folder was not moved");
		const skill = join(t.agentDir, "skills", "weekly-report", "SKILL.md");
		assert.match((await t.core.call("skills.read", { filePath: skill })) as string, /weekly-report/);
		await t.core.call("skills.remove", { filePath: skill });
		assert.ok(!existsSync(join(t.agentDir, "skills", "weekly-report")));
	});

	it("lists, disables and re-enables skills through Pi's settings", async () => {
		const list = (await t.core.call("skills.list", { cwd: t.workspace })) as SkillInfo[];
		const skill = list.find((s) => s.name === "weekly-report")!;
		assert.equal(skill.enabled, true);
		assert.equal(skill.scope, "user");

		await t.core.call("skills.setEnabled", { filePath: skill.filePath, enabled: false });
		const settings = JSON.parse(readFileSync(join(t.agentDir, "settings.json"), "utf8"));
		assert.deepEqual(settings.skills, [`-${skill.filePath}`]);
		const after = (await t.core.call("skills.list", { cwd: t.workspace })) as SkillInfo[];
		assert.equal(after.find((s) => s.name === "weekly-report")!.enabled, false, "disabled skills are still listed");

		await t.core.call("skills.setEnabled", { filePath: skill.filePath, enabled: true });
		assert.deepEqual(JSON.parse(readFileSync(join(t.agentDir, "settings.json"), "utf8")).skills, []);
	});

	it("turns an agent's skill_propose into a proposal the user accepts", async () => {
		t.core.settings.update({ approvalMode: "all" });
		await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
		t.respond(
			fauxAssistantMessage(
				[fauxToolCall("skill_propose", { name: "Trip Planner", description: "Plan slow-paced trips", body: "1. Ask budget\n2. Pick 2 sights per day", reason: "worked well" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("我建议把这个方法存成技能"),
		);
		await t.send("s1", { id: "p", type: "prompt", message: "规划完了" });
		await t.waitFor(() => settledCount(t.records("s1")) === 1);
		assert.equal(dialogs(t.records("s1")).length, 0, "proposing needs no approval: the proposal itself is the check");

		const [proposal] = (await t.core.call("proposals.list", {})) as Proposal[];
		assert.equal(proposal!.payload.name, "trip-planner");
		assert.match(proposal!.payload.content, /^---\nname: trip-planner\ndescription: "Plan slow-paced trips"/);
		assert.equal(proposal!.payload.previous, null);

		const { path } = (await t.core.call("proposals.accept", { id: proposal!.id })) as { path: string };
		assert.equal(path, join(t.agentDir, "skills", "trip-planner", "SKILL.md"));
		assert.match(readFileSync(path, "utf8"), /Pick 2 sights per day/);
		assert.equal(((await t.core.call("proposals.list", {})) as Proposal[]).length, 0);
		const skills = (await t.core.call("skills.list", { cwd: t.workspace })) as SkillInfo[];
		assert.ok(skills.some((s) => s.name === "trip-planner"));
	});

	it("drafts a skill from a session", async () => {
		await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
		t.respond(fauxAssistantMessage("整理好了报销单"));
		await t.send("s1", { id: "p", type: "prompt", message: "帮我整理这个月的报销单" });
		await t.waitFor(() => settledCount(t.records("s1")) === 1);
		t.respond(fauxAssistantMessage('{"name":"expense-report","description":"整理报销单","body":"## 步骤\\n1. 收集发票"}'));
		const proposal = (await t.core.call("skills.draftFromSession", { slotId: "s1" })) as Proposal;
		assert.equal(proposal.payload.name, "expense-report");
		assert.match(proposal.payload.content, /收集发票/);
	});

	it("shows the previous text when a proposal changes an existing skill", async () => {
		await t.core.call("slot.open", { slotId: "s2", cwd: t.workspace }, t.client);
		t.respond(fauxAssistantMessage([fauxToolCall("skill_propose", { name: "weekly-report", description: "v2", body: "New steps" })], { stopReason: "toolUse" }), fauxAssistantMessage("ok"));
		await t.send("s2", { id: "p", type: "prompt", message: "改进周报技能" });
		await t.waitFor(() => settledCount(t.records("s2")) === 1);
		const [p] = (await t.core.call("proposals.list", {})) as Proposal[];
		assert.match(p!.payload.previous ?? "", /Steps\./);
		await t.core.call("proposals.reject", { id: p!.id });
		assert.match(readFileSync(join(t.agentDir, "skills", "weekly-report", "SKILL.md"), "utf8"), /Steps\./, "rejected proposals change nothing");
	});
});

describe("templates", () => {
	it("converts named parameters to Pi arguments and back", () => {
		const { piBody, params } = compileTemplate("写一份{{主题}}的周报，截止{{日期}}，主题是{{主题}}", [{ name: "日期", default: "周五" }]);
		assert.equal(piBody, "写一份${1:-}的周报，截止${2:-周五}，主题是${1:-}");
		assert.deepEqual(params, [{ name: "主题", default: undefined }, { name: "日期", default: "周五" }]);
		assert.equal(decompileTemplate(piBody, params), "写一份{{主题}}的周报，截止{{日期}}，主题是{{主题}}");
		assert.equal(templateCommand("周报", params, { 主题: '新"产品"' }), '/周报 "新”产品”" "周五"');
	});

	it("saves templates as Pi prompt templates that Pi expands", async () => {
		const t = await startTestCore();
		try {
			await t.core.call("templates.save", { name: "周报", description: "生成周报", body: "为{{项目}}写本周周报" });
			const file = join(t.agentDir, "prompts", "周报.md");
			assert.ok(existsSync(file));
			const list = (await t.core.call("templates.list", {})) as TemplateInfo[];
			assert.equal(list[0]!.body, "为{{项目}}写本周周报");

			const { command } = (await t.core.call("templates.command", { name: "周报", values: { 项目: "DreamFlutter" } })) as { command: string };
			await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
			const seen: string[] = [];
			t.respond((context) => {
				seen.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("ok");
			});
			await t.send("s1", { id: "p", type: "prompt", message: command });
			await t.waitFor(() => settledCount(t.records("s1")) === 1);
			assert.match(seen[0]!, /为DreamFlutter写本周周报/, "Pi expanded the template");
		} finally {
			await t.cleanup();
		}
	});
});
