import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { TasksModule, type Artifact, type Material, type Note, type Notice, type Task } from "../src/modules/tasks.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

function capture(into: string[], reply: string): FauxResponseFactory {
	return (context) => {
		into.push(JSON.stringify(context.messages));
		return fauxAssistantMessage(reply);
	};
}

describe("tasks and the desk", () => {
	let t: TestCore;

	beforeEach(async () => {
		t = await startTestCore();
		t.core.settings.update({ approvalMode: "off" });
		await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
	});

	afterEach(async () => {
		await t.cleanup();
	});

	async function prompt(text: string, slotId = "s1"): Promise<void> {
		const before = settledCount(t.records(slotId));
		await t.send(slotId, { id: `p-${Math.random()}`, type: "prompt", message: text });
		await t.waitFor(() => settledCount(t.records(slotId)) === before + 1);
	}

	const tasks = async (params: Record<string, unknown> = {}) => (await t.core.call("tasks.list", params)) as Task[];

	it("every chat session is a task that collects status, cost and artifacts", async () => {
		t.respond(fauxAssistantMessage([fauxToolCall("write", { file_path: "out.md", content: "# 结果" })], { stopReason: "toolUse" }), fauxAssistantMessage("写好了"));
		await prompt("把结果写进 out.md");
		const [task] = await tasks({ cwd: t.workspace });
		assert.equal(task!.source, "chat");
		assert.equal(task!.goal, "把结果写进 out.md");
		assert.equal(task!.status, "done");
		assert.equal(task!.runs, 1);
		assert.equal(task!.result, "写好了");
		assert.equal(task!.sessionFile, t.core.slot("s1").info().sessionFile);

		const artifacts = (await t.core.call("artifacts.list", { cwd: t.workspace })) as Artifact[];
		assert.equal(artifacts.length, 1);
		assert.equal(artifacts[0]!.path, join(t.workspace, "out.md"));
		assert.equal(artifacts[0]!.exists, true);

		// The next run in the same session belongs to the same task.
		t.respond(fauxAssistantMessage("好的"));
		await prompt("谢谢");
		const again = await tasks();
		assert.equal(again.length, 1);
		assert.equal(again[0]!.runs, 2);
		assert.ok(t.messages.some((m) => m.event === "tasks.changed"));
	});

	it("a new session in the same slot becomes a new task; temporary chats are not tasks", async () => {
		t.respond(fauxAssistantMessage("一"), fauxAssistantMessage("二"));
		await prompt("第一个");
		await t.send("s1", { id: "n", type: "new_session" });
		await t.waitFor(() => t.records("s1").some((r) => r.type === "response" && r.id === "n"));
		await prompt("第二个");
		assert.deepEqual((await tasks()).map((x) => x.goal).sort(), ["第一个", "第二个"]);

		await t.core.call("slot.open", { slotId: "tmp", cwd: t.workspace, incognito: true }, t.client);
		t.respond(fauxAssistantMessage("临时"));
		await prompt("临时问题", "tmp");
		assert.equal((await tasks()).length, 2);
	});

	it("a note handed to the agent carries its text and materials, and gets the artifacts", async () => {
		const note = (await t.core.call("notes.save", { cwd: t.workspace, content: "# 季度复盘\n收入增长 12%" })) as Note;
		assert.equal(note.title, "季度复盘");
		const file = join(t.workspace, "data.csv");
		writeFileSync(file, "q,revenue\n");
		const material = t.core.module(TasksModule)!.addMaterial({ cwd: t.workspace, kind: "file", path: file });
		const pasted = t.core.module(TasksModule)!.addMaterial({ cwd: t.workspace, kind: "text", content: "去年同期收入 100 万" });
		assert.equal(material.title, "data.csv");

		const { task, prompt: text } = (await t.core.call("tasks.create", {
			cwd: t.workspace,
			goal: "写成一份报告",
			source: "note",
			noteId: note.id,
			materialIds: [material.id, pasted.id],
		})) as { task: Task; prompt: string };
		assert.match(text, /收入增长 12%/);
		assert.match(text, /data\.csv/);
		assert.match(text, /去年同期收入 100 万/);

		await t.core.call("tasks.bind", { taskId: task.id, slotId: "s1" });
		const seen: string[] = [];
		t.respond(fauxAssistantMessage([fauxToolCall("write", { file_path: "report.md", content: "# 报告" })], { stopReason: "toolUse" }), capture(seen, "报告写好了"));
		await prompt(text);

		const all = await tasks();
		assert.equal(all.length, 1, "the bound task is used, no extra chat task");
		assert.equal(all[0]!.status, "done");
		assert.equal(all[0]!.noteId, note.id);
		const desk = (await t.core.call("desk.get", { cwd: t.workspace })) as { notes: Note[]; materials: Material[]; tasks: Task[]; artifacts: Artifact[] };
		assert.equal(desk.notes.length, 1);
		assert.equal(desk.materials.length, 2);
		assert.equal(desk.artifacts[0]!.noteId, note.id);
		assert.equal(((await t.core.call("tasks.list", { noteId: note.id })) as Task[]).length, 1);
		assert.ok(t.messages.some((m) => m.event === "desk.changed"));
	});

	it("notes autosave in place, materials dedupe by path, removal hides them", async () => {
		const note = (await t.core.call("notes.save", { cwd: t.workspace, content: "草稿" })) as Note;
		const saved = (await t.core.call("notes.save", { id: note.id, cwd: t.workspace, content: "草稿二", title: "标题" })) as Note;
		assert.equal(saved.id, note.id);
		assert.equal(saved.title, "标题");
		assert.equal(saved.content, "草稿二");
		const a = t.core.module(TasksModule)!.addMaterial({ cwd: t.workspace, kind: "folder", path: t.workspace });
		const b = t.core.module(TasksModule)!.addMaterial({ cwd: t.workspace, kind: "folder", path: t.workspace });
		assert.equal(a.id, b.id);
		assert.throws(() => t.core.module(TasksModule)!.addMaterial({ cwd: t.workspace, kind: "file", path: join(t.workspace, "missing.txt") }));
		t.core.module(TasksModule)!.removeNote(note.id);
		assert.equal(((await t.core.call("desk.get", { cwd: t.workspace }) as { notes: Note[] }).notes).length, 0);
	});

	it("keeps stored notes and materials readable through desk.get after retiring their old routes", async () => {
		const module = t.core.module(TasksModule)!;
		const note = module.saveNote({ cwd: t.workspace, content: "# 旧写笺" });
		const material = module.addMaterial({ cwd: t.workspace, kind: "text", content: "旧资料" });
		const { notes, materials } = await t.core.call("desk.get", { cwd: t.workspace }) as { notes: Note[]; materials: Material[] };
		assert.deepEqual(notes, [note]);
		assert.deepEqual(materials, [material]);
		for (const method of ["notes.get", "notes.list", "notes.remove", "materials.list", "materials.add", "materials.remove"]) {
			await assert.rejects(t.core.call(method, {}), { code: "unknown_method" });
		}
	});

	it("a run over the turn limit is paused with a card; continue lets it finish", async () => {
		t.core.settings.update({ maxTurnsPerRun: 2 });
		const call = () => fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" });
		t.respond(call(), call(), call(), call());
		await prompt("一直列目录");
		const [notice] = (await t.core.call("notices.list", {})) as Notice[];
		assert.equal(notice!.kind, "limit_turns");
		assert.equal((await tasks())[0]!.status, "needs_input");
		const inbox = (await t.core.call("inbox.list", {})) as { kind: string }[];
		assert.ok(inbox.some((i) => i.kind === "limit"));

		t.respond(fauxAssistantMessage("好了，做完了"));
		const before = settledCount(t.records("s1"));
		await t.core.call("notices.resolve", { id: notice!.id, action: "continue" });
		await t.waitFor(() => settledCount(t.records("s1")) === before + 1);
		assert.equal(((await t.core.call("notices.list", {})) as Notice[]).length, 0);
		assert.equal((await tasks())[0]!.status, "done");
	});

	it("the daily budget stops runs until the user overrides it for the day", async () => {
		t.core.settings.update({ dailyBudgetUsd: 0.01 });
		t.core.db.run("INSERT INTO runs(id, cwd, status, started_at, cost) VALUES('old', ?, 'done', ?, 1)", t.workspace, Date.now());
		const charged = t.core.ledger!.begin(t.core.slots.get("s1")!.session.model!);
		t.core.ledger!.finish(charged, t.core.slots.get("s1")!.session.model!, { ...fauxAssistantMessage("synthetic prior request"), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }, { actual: 1, currency: "USD" });
		t.respond(fauxAssistantMessage("不该出现"));
		await prompt("花钱的任务");
		const [notice] = (await t.core.call("notices.list", {})) as Notice[];
		assert.equal(notice!.kind, "limit_budget");
		await t.core.call("notices.resolve", { id: notice!.id, action: "stop" });
		assert.equal((await tasks())[0]!.status, "interrupted");
	});

	it("the monthly budget stops runs on its own notice, which lifts only the monthly cap", async () => {
		t.core.settings.update({ dailyBudgetUsd: 100, monthlyBudgetUsd: 0.5 });
		t.core.db.run("INSERT INTO runs(id, cwd, status, started_at, cost) VALUES('old', ?, 'done', ?, 1)", t.workspace, Date.now());
		const charged = t.core.ledger!.begin(t.core.slots.get("s1")!.session.model!);
		t.core.ledger!.finish(charged, t.core.slots.get("s1")!.session.model!, { ...fauxAssistantMessage("synthetic prior request"), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }, { actual: 1, currency: "USD" });
		t.respond(fauxAssistantMessage("不该出现"));
		await prompt("花钱的任务");
		const [notice] = (await t.core.call("notices.list", {})) as Notice[];
		assert.equal(notice!.kind, "limit_budget_month", "under the daily cap, over the monthly one");
		assert.match(notice!.title, /本月的花费已达到上限（\$1\.00 \/ \$0\.50）/);
		await t.core.call("notices.resolve", { id: notice!.id, action: "stop" });
	});

	it("tasks left running by a crashed core come back as interrupted", async () => {
		t.respond(fauxAssistantMessage("ok"));
		await prompt("任务");
		const id = (await tasks())[0]!.id;
		t.core.db.run("UPDATE tasks SET status = 'running' WHERE id = ?", id);
		t = await t.reopen();
		assert.equal(((await t.core.call("tasks.get", { id })) as { task: Task }).task.status, "interrupted");
	});

	it("artifact paths outside the workspace are kept absolute", async () => {
		const outside = join(t.dir, "elsewhere.txt");
		t.respond(fauxAssistantMessage([fauxToolCall("write", { file_path: outside, content: "x" })], { stopReason: "toolUse" }), fauxAssistantMessage("ok"));
		await prompt("写到外面");
		assert.ok(existsSync(outside));
		assert.equal(readFileSync(outside, "utf8"), "x");
		const artifacts = (await t.core.call("artifacts.list", { cwd: t.workspace })) as Artifact[];
		assert.equal(artifacts[0]!.path, outside);
	});

	it("a helper script written and removed again during the run is not a product", async () => {
		const helper = join(t.workspace, "render.ps1");
		t.respond(
			fauxAssistantMessage([fauxToolCall("write", { file_path: "report.md", content: "# 报告" }), fauxToolCall("write", { file_path: "render.ps1", content: "echo" })], { stopReason: "toolUse" }),
			() => {
				rmSync(helper);
				return fauxAssistantMessage("写好了，临时脚本已删除");
			},
		);
		await prompt("写报告");
		const artifacts = (await t.core.call("artifacts.list", { cwd: t.workspace })) as Artifact[];
		assert.deepEqual(artifacts.map((a) => basename(a.path)), ["report.md"]);
	});
});
