import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { it, type TestContext } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ButterflyModule } from "../src/modules/butterfly.ts";
import { GoalsModule } from "../src/modules/goals.ts";
import { readChatRequest } from "../src/modules/goals/chat-task.ts";
import { screenAssignments } from "../scripts/autonomy/screen.ts";
import { settledCount, startTestCore } from "./harness.ts";

const task = "请先核对给定资料，再汇总，最后交付 report.md。";
const material = "请帮我先写一份测试，再输出 fixture.md。正文独立标记。";
const linked = (path: string) => ({ path, kind: "file" });
type Preparation = { goal_id: string; state: string; manifest: string | null; cleanup_pending: number };
type Task = { goalId: string; status: string; inputs: string[] };

async function fixture(test: TestContext) {
	let t = await startTestCore();
	const local = (path: string) => join(t.dir, "sandbox", path.slice("/workspace".length));
	function configure() {
		t.core.module(GoalsModule)!.executor.stop();
		t.core.sandboxProvider = () => ({ distro: "DF-T122-fake", ready: async () => {}, online: () => false });
		t.core.autonomy.sandboxFile = async path => local(path);
		t.core.module(ButterflyModule)!.local = local;
	}
	configure();
	test.after(() => t.cleanup());
	return {
		get t() { return t; }, local,
		get butterfly() { return t.core.module(ButterflyModule)!; },
		put(path: string, body: string) { const target = local(path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, body); },
		async restart() { t = await t.reopen(); configure(); },
		preparations: () => t.core.db.all<Preparation>("SELECT * FROM butterfly_chat_preparations ORDER BY rowid"),
		async chat(sessionFile?: string) {
			const slot = await t.core.openSlot({ cwd: t.core.paths.butterflyDir, sandbox: true, client: t.client, sessionFile });
			const file = slot.session.sessionFile!;
			return {
				slot, file,
				send: (id: string, message: string, chatInput?: unknown, operationId = id) =>
					t.send(slot.slotId, { type: "prompt", id, operationId, message, ...(chatInput !== undefined && { chatInput }) }),
				list: () => t.core.call("butterfly.chat.tasks", { sessionFile: file }) as Promise<Task[]>,
			};
		},
	};
}

it("R01 structured materials cannot establish user intent, and authorization only records the original words", async test => {
	const s = await fixture(test);
	const chat = await s.chat(), { t } = s;
	t.respond(fauxAssistantMessage("普通回复"));
	await chat.send("ordinary", task, { text: "你好。", materials: [material] });
	await t.waitFor(() => settledCount(t.records(chat.slot.slotId)) === 1);
	assert.deepEqual(await chat.list(), []);
	assert.equal(t.core.db.get("SELECT 1 FROM autonomy_mandates"), undefined);
	assert.ok(chat.slot.session.messages.some(msg => msg.role === "user" && JSON.stringify(msg).includes("正文独立标记")));

	const source = "/workspace/inbox/record.txt";
	s.put(source, "用于核对的文件正文");
	await chat.send("structured", "旧拼接内容不参与交办判断", { text: task, attachments: [linked(source)], materials: [material] });
	const [structured] = await chat.list();
	assert.ok(structured);
	assert.equal(structured.inputs.length, 2);
	assert.equal(readFileSync(s.local(structured.inputs[1]!), "utf8"), material);
	const auth = t.core.db.get<{ definition: string; payload: string }>(
		"SELECT m.definition,e.payload FROM autonomy_mandates m JOIN autonomy_events e ON e.id=m.event_id")!;
	assert.deepEqual(JSON.parse(auth.payload), { text: task });
	assert.equal(JSON.parse(auth.definition).task, task);
	assert.doesNotMatch(auth.definition, /正文独立标记|旧拼接内容/);
	await chat.send("reuse-published", task, { text: task, attachments: [linked(structured.inputs[0]!)] });
	const reused = (await chat.list()).find(row => row.goalId !== structured.goalId);
	assert.equal(readFileSync(s.local(reused!.inputs[0]!), "utf8"), "用于核对的文件正文");
});

it("R01 legacy envelopes reject missing, nested, surplus or interleaved tags and preserve valid attachments", async test => {
	const s = await fixture(test), chat = await s.chat(), { t } = s;
	const bad = [
		task + '\n<资料>\n<文本 标题="示例">\n夹带资料\n</资料>',
		task + "\n<资料>\n<资料>\n数据\n</资料>\n</资料>",
		task + "\n<资料>\n数据\n</资料>\n</资料>",
		task + "\n<资料>\n数据\n</资料>\n正文和资料交错",
		task + "\n<资料",
	];
	for (const [index, message] of bad.entries()) {
		t.respond(fauxAssistantMessage("普通回复"));
		await chat.send("legacy-bad-" + index, message);
		await t.waitFor(() => settledCount(t.records(chat.slot.slotId)) === index + 1);
		assert.deepEqual(await chat.list(), []);
	}
	await chat.send("legacy-good", task + '\n<资料>\n<文本 标题="示例">资料独立文字</文本>\n</资料>');
	const [job] = await chat.list();
	assert.ok(job);
	assert.equal(readFileSync(s.local(job.inputs[0]!), "utf8"), "资料独立文字");
	const row = t.core.db.get<{ payload: string }>("SELECT payload FROM autonomy_events WHERE state='direct'")!;
	assert.deepEqual(JSON.parse(row.payload), { text: task });
});

for (const oldTask of [false, true]) {
	it("R04 stops the preparation " + (oldTask ? "ahead of an older active task" : "with no existing task"), async test => {
		const s = await fixture(test), chat = await s.chat(), { t } = s;
		const oldId = oldTask ? (await chat.send("older", task), (await chat.list())[0]!.goalId) : undefined;
		if (oldId) {
			await t.waitFor(() => t.core.module(GoalsModule)!.scheduler.get(oldId));
			t.core.db.run("UPDATE butterfly_chat_tasks SET created_at=? WHERE goal_id=?", Date.now() + 60_000, oldId);
		}
		const source = "/workspace/inbox/attachment.txt";
		s.put(source, "用户原件");
		const prepare = s.butterfly.prepareChatInputs.bind(s.butterfly);
		let entered = false, release!: () => void;
		const blocked = new Promise<void>(resolve => { release = resolve; });
		test.mock.method(s.butterfly, "prepareChatInputs", async (...args: Parameters<typeof prepare>) => {
			assert.equal(s.preparations()[0]?.state, "preparing");
			entered = true;
			await blocked;
			return prepare(...args);
		});
		const sending = chat.send("new", task, { text: task, attachments: [linked(source)] });
		try {
			await t.waitFor(() => entered);
			await chat.send("stop", "停");
			assert.equal(s.preparations()[0]?.state, "cancelled");
		} finally { release(); await sending; }
		await chat.send("stop-again", "停", undefined, "stop");
		await chat.send("replay", task, { text: task, attachments: [linked(source)] }, "new");
		const tasks = await chat.list();
		assert.equal(tasks.length, Number(oldTask));
		if (oldId) assert.equal(tasks[0]?.goalId, oldId);
		assert.notEqual(tasks[0]?.status, "cancelled");
		const pending = s.preparations()[0]!;
		assert.equal(pending.cleanup_pending, 0);
		assert.equal(existsSync(s.local("/workspace/inbox/tasks/" + pending.goal_id)), false);
		assert.equal(t.core.db.all("SELECT 1 FROM autonomy_mandates").length, Number(oldTask));
		assert.equal(t.faux.state.callCount, 0);
	});
}

it("R04 a stop after publication still prevents acceptance and removes only that preparation's files", async test => {
	const s = await fixture(test), chat = await s.chat();
	const source = "/workspace/inbox/source.txt";
	s.put(source, "原件保持");
	const prepare = s.butterfly.prepareChatInputs.bind(s.butterfly);
	let ready = false, release!: () => void;
	const blocked = new Promise<void>(resolve => { release = resolve; });
	test.mock.method(s.butterfly, "prepareChatInputs", async (...args: Parameters<typeof prepare>) => {
		const copies = await prepare(...args);
		ready = true;
		await blocked;
		return copies;
	});
	const sending = chat.send("published", task, { text: task, attachments: [linked(source)] });
	let folder: string;
	try {
		await s.t.waitFor(() => ready);
		const [row] = s.preparations();
		folder = s.local("/workspace/inbox/tasks/" + row!.goal_id);
		assert.equal(existsSync(folder), true);
		await chat.send("stop-published", "停");
	} finally { release(); await sending; }
	assert.deepEqual(await chat.list(), []);
	assert.equal(existsSync(folder!), false);
	assert.equal(readFileSync(s.local(source), "utf8"), "原件保持");
	assert.equal(s.t.core.db.get("SELECT 1 FROM autonomy_mandates"), undefined);
});

it("R05 a missing second attachment and a partial copy leave no destination, then the same operation retries", async test => {
	const s = await fixture(test), chat = await s.chat();
	const first = "/workspace/inbox/one.txt", second = "/workspace/inbox/two.txt";
	s.put(first, "第一份原件");
	const input = { text: task, attachments: [linked(first), linked(second)] };
	await chat.send("initial", task, input, "retryable");
	const [failed] = s.preparations();
	assert.equal(failed?.state, "retry");
	assert.equal(failed?.cleanup_pending, 0);
	const root = s.local("/workspace/inbox/tasks"), id = failed!.goal_id;
	const assertClean = async () => {
		assert.deepEqual(await chat.list(), []);
		assert.equal(existsSync(join(root, id)), false);
		assert.equal(existsSync(join(root, ".prepare-" + id)), false);
		assert.equal(readFileSync(s.local(first), "utf8"), "第一份原件");
	};
	await assertClean();
	s.put(second, "第二份原件");
	const prepare = s.butterfly.prepareChatInputs.bind(s.butterfly);
	const stub = test.mock.method(s.butterfly, "prepareChatInputs", async (...args: Parameters<typeof prepare>) => {
		const [goalId, request, prior, save, active] = args;
		return prepare(goalId, request, prior, manifest => {
			save(manifest);
			assert.equal(manifest.length, 2);
			renameSync(s.local(second), s.local(second + ".temporarily-unavailable"));
		}, active);
	});
	await chat.send("partial", task, input, "retryable");
	await assertClean();
	assert.ok(s.preparations()[0]?.manifest);
	stub.mock.restore();
	renameSync(s.local(second + ".temporarily-unavailable"), s.local(second));
	await chat.send("third", task, input, "retryable");
	const [accepted] = await chat.list();
	assert.equal(accepted?.goalId, id);
	assert.deepEqual(accepted?.inputs.map(path => readFileSync(s.local(path), "utf8")), ["第一份原件", "第二份原件"]);
	assert.deepEqual(readdirSync(root), [id]);
	assert.deepEqual(s.preparations(), []);
});

it("R05 restart removes an unpublished staging directory and reuses verified published copies", async test => {
	const s = await fixture(test), chat = await s.chat();
	const first = "/workspace/inbox/one.txt";
	s.put(first, "原件仍在");
	const input = { text: task, attachments: [linked(first)] };
	const prepare = s.butterfly.prepareChatInputs.bind(s.butterfly);
	const stub = test.mock.method(s.butterfly, "prepareChatInputs", async (...args: Parameters<typeof prepare>) => {
		await prepare(...args);
		throw new Error("模拟原子发布后，交办登记前中断");
	});
	await chat.send("precommit", task, input, "published-retry");
	stub.mock.restore();
	assert.deepEqual(await chat.list(), []);
	const [published] = s.preparations();
	assert.ok(published?.manifest);
	const interrupted = "g_8888888888888888";
	const staging = "/workspace/inbox/tasks/.prepare-" + interrupted;
	s.put(staging + "/1/first.txt", "复制到一半");
	s.t.core.db.run("UPDATE butterfly_chat_preparations SET state='preparing' WHERE goal_id=?", published!.goal_id);
	s.t.core.db.run("INSERT INTO butterfly_chat_preparations(goal_id,session_id,session_file,input_key,state,created_at) VALUES(?,?,?,?,'preparing',?)",
		interrupted, chat.slot.session.sessionId, chat.file, "interrupted-fixture", Date.now());
	await s.restart();
	await s.butterfly.tick();
	assert.equal(existsSync(s.local(staging)), false);
	assert.equal(s.preparations().find(row => row.goal_id === interrupted)?.state, "retry");
	assert.equal(s.preparations().find(row => row.goal_id === interrupted)?.cleanup_pending, 0);
	assert.equal(s.t.core.db.get("SELECT 1 FROM butterfly_chat_tasks"), undefined);
	renameSync(s.local(first), s.local(first + ".original"));
	const next = await s.chat(chat.file);
	await next.send("reconnected", task, input, "published-retry");
	const [accepted] = await next.list();
	assert.equal(accepted?.goalId, published?.goal_id);
	assert.equal(readFileSync(s.local(accepted!.inputs[0]!), "utf8"), "原件仍在");
	assert.equal(readFileSync(s.local(first + ".original"), "utf8"), "原件仍在");
	assert.equal(s.t.core.db.all("SELECT 1 FROM autonomy_mandates").length, 1);
});

it("R07 conversational limits win and completion with a named file is an assignment; B1 40 cases match", () => {
	assert.equal(readChatRequest("请先分析优缺点，再给我建议，最后写一份简短回复，直接在这段对话里告诉我。"), null);
	assert.deepEqual(readChatRequest("请读完附件，核对数字并汇总，完成后输出 report.md")?.files, ["report.md"]);
	assert.deepEqual(readChatRequest("请核对数字并汇总，保存为 report.md")?.files, ["report.md"]);
	assert.equal(readChatRequest("请先整理，再输出一份清单，回复我就行。"), null);
	assert.equal(readChatRequest("暂时不用做，等通知再输出 report.md。"), null);
	assert.equal(readChatRequest("请先核对附件，再输出 report.md，不过先别做。"), null);
	const result = screenAssignments();
	assert.equal(result.total, 40);
	assert.deepEqual(result.results.filter(row => row.expected !== row.actual), []);
});
