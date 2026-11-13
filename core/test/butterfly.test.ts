import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ButterflyModule, INBOX, OUTBOX, safeName, type OutboxFile } from "../src/modules/butterfly.ts";
import { TasksModule, type Material, type Note, type Task } from "../src/modules/tasks.ts";
import { startTestCore, type TestCore } from "./harness.ts";

/** 蝶君 (roadmap 3.5): its home, the desk moving over, hand-off through the inbox, the outbox. */
describe("蝶君", () => {
	let t: TestCore;
	let sandboxRoot: string;

	/** Points 蝶君's sandbox paths at a plain folder (no WSL in unit tests). */
	function fakeSandbox(core: TestCore["core"]): ButterflyModule {
		const butterfly = core.module(ButterflyModule)!;
		sandboxRoot = join(t.dir, "sandbox-root");
		butterfly.local = (path) => join(sandboxRoot, ...path.split("/").filter(Boolean));
		return butterfly;
	}

	beforeEach(async () => {
		t = await startTestCore();
	});

	afterEach(async () => {
		await t.cleanup();
	});

	it("has a home of its own, given in core.hello", async () => {
		const hello = (await t.core.call("core.hello", {})) as { butterflyHome: string };
		const info = (await t.core.call("butterfly.info", {})) as { home: string; inbox: string; outbox: string };
		assert.equal(info.home, hello.butterflyHome);
		assert.equal(info.home, t.core.paths.butterflyDir);
		assert.deepEqual([info.inbox, info.outbox], ["/workspace/inbox", "/workspace/outbox"]);
	});

	it("moves every workspace's notes, materials and desk cards to its home once", async () => {
		const other = join(t.dir, "other");
		mkdirSync(other);
		const file = join(t.workspace, "data.csv");
		writeFileSync(file, "a,b\n1,2\n");
		await t.core.call("notes.save", { cwd: t.workspace, content: "# 甲" });
		await t.core.call("notes.save", { cwd: other, content: "# 乙" });
		t.core.module(TasksModule)!.addMaterial({ cwd: t.workspace, kind: "file", path: file });
		t.core.module(TasksModule)!.addMaterial({ cwd: other, kind: "file", path: file });
		t.core.module(TasksModule)!.addMaterial({ cwd: other, kind: "text", content: "一段文字" });
		// As if this database came from v0.2.
		t.core.db.run("DELETE FROM app_flags");
		t = await t.reopen();
		const home = t.core.paths.butterflyDir;
		const notes = (await t.core.call("desk.get", { cwd: home }) as { notes: Note[] }).notes;
		assert.deepEqual(notes.map((n) => n.title).sort(), ["乙", "甲"]);
		const materials = (await t.core.call("desk.get", { cwd: home }) as { materials: Material[] }).materials;
		assert.equal(materials.length, 2, "the same file on two desks is one material now");
		assert.equal(((await t.core.call("desk.get", { cwd: t.workspace }) as { notes: Note[] }).notes).length, 0, "the workbench has no desk any more");
		// Once only: a note written in a workspace later stays there.
		await t.core.call("notes.save", { cwd: t.workspace, content: "# 丙" });
		t = await t.reopen();
		assert.equal(((await t.core.call("desk.get", { cwd: t.workspace }) as { notes: Note[] }).notes).length, 1);
	});

	it("hands a note over with copies of the materials in the inbox", async () => {
		fakeSandbox(t.core);
		const home = t.core.paths.butterflyDir;
		const file = join(t.workspace, "销量.csv");
		writeFileSync(file, "月,量\n1,3\n");
		const folder = join(t.workspace, "图");
		mkdirSync(folder);
		writeFileSync(join(folder, "a.txt"), "甲");
		t.core.module(TasksModule)!.addMaterial({ cwd: home, kind: "file", path: file });
		t.core.module(TasksModule)!.addMaterial({ cwd: home, kind: "folder", path: folder });
		t.core.module(TasksModule)!.addMaterial({ cwd: home, kind: "text", title: "要求: 画/图", content: "用柱状图" });
		const note = (await t.core.call("notes.save", { cwd: home, content: "# 出图\n把销量画成图" })) as Note;

		const { task, prompt } = (await t.core.call("butterfly.handOff", { noteId: note.id })) as { task: Task; prompt: string };
		assert.equal(task.cwd, home);
		assert.equal(task.source, "note");
		assert.equal(task.noteId, note.id);
		assert.match(prompt, /<写笺 标题="出图">/);
		assert.match(prompt, /把销量画成图/);
		for (const p of [`${INBOX}/销量.csv`, `${INBOX}/图`, `${INBOX}/要求 画 图.md`]) assert.ok(prompt.includes(p), `${p} in the prompt`);
		assert.ok(prompt.includes(OUTBOX));
		assert.equal(readFileSync(join(sandboxRoot, "workspace", "inbox", "销量.csv"), "utf8"), "月,量\n1,3\n");
		assert.equal(readFileSync(join(sandboxRoot, "workspace", "inbox", "图", "a.txt"), "utf8"), "甲");
		assert.equal(readFileSync(join(sandboxRoot, "workspace", "inbox", "要求 画 图.md"), "utf8"), "用柱状图\n");
		// Handing over again replaces the copies.
		writeFileSync(file, "月,量\n1,4\n");
		await t.core.call("butterfly.handOff", { noteId: note.id });
		assert.equal(readFileSync(join(sandboxRoot, "workspace", "inbox", "销量.csv"), "utf8"), "月,量\n1,4\n");
	});

	it("refuses a hand-off before the sandbox is set up, and creates no task", async () => {
		const home = t.core.paths.butterflyDir;
		const note = (await t.core.call("notes.save", { cwd: home, content: "做事" })) as Note;
		await assert.rejects(t.core.call("butterfly.handOff", { noteId: note.id }), /沙箱还没有建好/);
		t.core.module(TasksModule)!.addMaterial({ cwd: home, kind: "text", content: "x" });
		await assert.rejects(t.core.call("butterfly.handOff", { noteId: note.id }), /沙箱还没有建好/);
		assert.equal(((await t.core.call("tasks.list", { cwd: home })) as Task[]).length, 0);
	});

	it("copies dropped files into the inbox and lists the outbox, newest first", async () => {
		fakeSandbox(t.core);
		const file = join(t.workspace, "表.xlsx");
		writeFileSync(file, "x");
		const { paths } = (await t.core.call("butterfly.import", { paths: [file, join(t.workspace, "不存在")] })) as { paths: string[] };
		assert.deepEqual(paths, [`${INBOX}/表.xlsx`]);

		const out = join(sandboxRoot, "workspace", "outbox");
		mkdirSync(join(out, "图"), { recursive: true });
		writeFileSync(join(out, "报告.md"), "# 报告");
		writeFileSync(join(out, "图", "1.png"), "png");
		utimesSync(join(out, "报告.md"), new Date(2026, 0, 1), new Date(2026, 0, 1));
		const files = (await t.core.call("butterfly.outbox", {})) as OutboxFile[];
		assert.deepEqual(files.map((f) => f.name), ["图/1.png", "报告.md"]);
		assert.equal(files[1]!.size, Buffer.byteLength("# 报告"));
		assert.equal(files[1]!.path, join(out, "报告.md"));
	});

	it("gives its cards nothing on this machine", async () => {
		const manifest = `<script type="application/json" data-card-manifest>${JSON.stringify({ toolBindings: { t: { tool: "time.now" } } })}</script>`;
		const path = join(t.dir, "clock.card.html");
		writeFileSync(path, `<!DOCTYPE html><html><head><title>钟</title></head><body>${manifest}<p>钟</p></body></html>`);
		const request = (id: string) => t.core.call("cards.request", { id, capability: "invoke", payload: { bindingId: "t" } }) as Promise<Record<string, unknown>>;
		const mine = (await t.core.call("cards.import", { path, cwd: t.core.paths.butterflyDir })) as { id: string };
		const answer = await request(mine.id);
		assert.equal(answer.ok, false);
		assert.match(JSON.stringify(answer), /蝶君的卡片不能使用这台电脑上的文件、网络或程序/);
		// The same card on the workbench may.
		const theirs = (await t.core.call("cards.import", { path, cwd: t.workspace })) as { id: string };
		assert.equal((await request(theirs.id)).ok, true);
	});

	it("makes file names out of titles", () => {
		assert.equal(safeName(' a/b\\c:d*e?f"g<h>i|j '), "a b c d e f g h i j");
		assert.equal(safeName("x".repeat(80)).length, 60);
	});
});
