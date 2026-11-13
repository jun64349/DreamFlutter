import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { it, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ButterflyModule } from "../src/modules/butterfly.ts";
import { GoalsModule } from "../src/modules/goals.ts";
import { deliveryDirectory } from "../src/modules/goals/chat-task.ts";
import { settledCount, startTestCore } from "./harness.ts";

const TASK = "请先核对给定资料，再汇总，最后交付 report.md。";
const explanation = "核对了原始材料与汇总数字，报告包含约定的结果。";
type View = { goalId: string; status: string; inputs: string[]; deliverables: string[]; delivery: null | { explanation: string } };

async function setup(test: TestContext) {
	let t = await startTestCore();
	test.after(() => t.cleanup());
	const virtual = join(t.dir, "sandbox");
	const local = (path: string) => join(virtual, path.slice("/workspace".length));
	function configure() {
		t.core.sandboxProvider = () => ({ distro: "df-t115-fake", ready: async () => {}, online: () => false });
		t.core.autonomy.sandboxFile = async path => local(path);
		t.core.module(ButterflyModule)!.local = local;
	}
	configure();
	const slot = await t.core.openSlot({ cwd: t.core.paths.butterflyDir, sandbox: true, client: t.client });
	const file = slot.session.sessionFile!;
	const send = (id: string, message: string) => t.send(slot.slotId, { id, type: "prompt", message });
	return {
		get t() { return t; }, slot, file, send, local,
		get goals() { return t.core.module(GoalsModule)!; },
		list: () => t.core.call("butterfly.chat.tasks", { sessionFile: file }) as Promise<View[]>,
		restart: async () => { t = await t.reopen(); configure(); return t; },
	};
}

it("T115 ordinary questions stay in chat and an explicit multi-step sandbox handoff starts once without approval", async test => {
	const s = await setup(test), { t, slot } = s;
	s.goals.executor.stop();
	t.core.settings.update({ butterflyDailyBudget: 0 });
	for (const [index, question] of ["今天天气怎么样？", "你好", "请问怎么先查资料再交付 report.md？"].entries()) {
		t.respond(fauxAssistantMessage("普通回复"));
		await s.send(`chat-${index}`, question);
		await t.waitFor(() => settledCount(t.records(slot.slotId)) === index + 1);
	}
	assert.equal((await s.list()).length, 0);
	await s.send("assignment", TASK);
	await s.send("assignment", TASK);
	const [view] = await s.list();
	const goal = await t.waitFor(() => s.goals.scheduler.get(view!.goalId));
	assert.equal(goal.originText, TASK);
	assert.equal(goal.source, "user");
	assert.equal(goal.scope.sandbox, true);
	assert.equal(goal.status, "queued");
	assert.deepEqual(goal.spec.deliverables, [`${deliveryDirectory(goal.id)}/report.md`]);
	assert.equal(t.core.confirmations.list({ status: "pending" }).length, 0);
	assert.equal(t.core.db.get("SELECT 1 FROM goal_proposals"), undefined);
	assert.equal(t.core.autonomy.budget.spentToday(), 0);
	assert.equal(slot.session.messages.filter(message => JSON.stringify(message).includes("开始了，随时能停")).length, 1);
	await s.send("progress", "做到哪了");
	assert.ok(slot.session.messages.some(message => JSON.stringify(message).includes("排队中")));
	await t.core.module(ButterflyModule)!.chat.refresh();
	t.core.ledger?.importHistory();
	assert.equal(t.core.db.get("SELECT 1 FROM request_ledger WHERE provider='dreamflutter-system'"), undefined);
	const reconnected = t.core.addClient(() => {});
	await t.core.call("slot.send", { slotId: slot.slotId, record: { id: "assignment", type: "prompt", message: TASK } }, reconnected);
	assert.equal((await s.list()).length, 2, "a new connection can reuse transport IDs");
	t.core.removeClient(reconnected);
});

it("T115 a host-file handoff waits for an exact-action approval and a stopped pending request cannot start", async test => {
	const s = await setup(test), { t } = s;
	s.goals.executor.stop();
	const hostFile = join(t.workspace, "host.txt");
	const text = `请先核对本机文件 "${hostFile}"，然后修改那份文件，最后交付结果。`;
	await s.send("external-cancel", text);
	const [first] = await s.list();
	assert.equal(first?.status, "waiting_user");
	assert.equal(s.goals.scheduler.get(first!.goalId), undefined);
	await s.send("cancel-pending", "算了");
	assert.equal((await s.list())[0]?.status, "cancelled");
	assert.equal(t.core.confirmations.list({ status: "pending" }).length, 0);

	await s.send("external-accept", text);
	const [second] = await s.list();
	const approval = t.core.confirmations.list({ status: "pending" })[0]!;
	assert.match(String(approval.request.message), /host\.txt[\s\S]*edit/);
	assert.equal(s.goals.scheduler.get(second!.goalId), undefined);
	await t.core.call("confirm.answer", { id: approval.id, response: { confirmed: true } });
	const goal = await t.waitFor(() => s.goals.scheduler.get(second!.goalId));
	assert.equal(t.core.autonomy.checkGoal(goal, "edit", hostFile).ok, true);
	assert.equal(t.core.autonomy.checkGoal(goal, "read", hostFile).ok, true);
	assert.equal(t.core.autonomy.checkGoal(goal, "write", hostFile).ok, false);
	assert.equal(t.core.autonomy.checkGoal(goal, "edit", join(t.workspace, "other.txt")).ok, false);
});

it("T115 stopping an in-flight handoff cancels the goal and it stays stopped across restart", async test => {
	const s = await setup(test), { t, slot } = s;
	let entered = false;
	let chatting = false;
	let release!: () => void;
	const running = new Promise<void>(resolve => { release = resolve; });
	test.after(() => release());
	t.respond(async () => {
		entered = true;
		await running;
		return fauxAssistantMessage("刚才正在整理");
	});
	t.respond(async () => {
		chatting = true;
		await running;
		return fauxAssistantMessage("普通对话");
	});
	await s.send("work", TASK);
	const [view] = await s.list();
	await t.waitFor(() => entered);
	await s.send("ordinary", "你是谁？");
	await t.waitFor(() => chatting);
	await s.send("stop", "停");
	assert.equal(s.goals.scheduler.get(view!.goalId)?.status, "cancelled");
	release();
	await t.waitFor(() => slot.session.messages.some(message => JSON.stringify(message).includes("已停止")));
	const next = await s.restart();
	assert.equal(s.goals.scheduler.get(view!.goalId)?.status, "cancelled");
	assert.equal(next.faux.state.callCount, 0);
});

it("T115 an approved host write produces a separate sandbox receipt without copying host bytes", async test => {
	const s = await setup(test), { t } = s;
	const host = join(t.workspace, "host-result.txt");
	await s.send("host-write", `请先整理说明，然后写入本机文件 "${host}"，最后交付结果。`);
	const [view] = await s.list();
	const approval = t.core.confirmations.list({ status: "pending" })[0]!;
	t.respond(fauxAssistantMessage([fauxToolCall("write", { file_path: host, content: "合成主机文件正文" })]),
		fauxAssistantMessage([fauxToolCall("goal_report", { status: "done", note: explanation })]), fauxAssistantMessage("已核对操作"));
	await t.core.call("confirm.answer", { id: approval.id, response: { confirmed: true } });
	await t.waitFor(() => t.core.autonomy.effects.get(`chat-delivery:${view!.goalId}`)?.state === "completed", 15_000);
	const artifact = await t.core.call("butterfly.chat.artifact", { goalId: view!.goalId, name: "交付说明.md" }) as { path: string };
	assert.equal(readFileSync(host, "utf8"), "合成主机文件正文");
	const receipt = readFileSync(artifact.path, "utf8");
	assert.ok(receipt.includes(explanation));
	assert.doesNotMatch(receipt, /合成主机文件正文/);
	assert.equal(t.core.db.get("SELECT 1 FROM goal_evidence WHERE goal_id=? AND kind='program' AND detail LIKE ?", view!.goalId, "%合成主机文件正文%"), undefined);
});

it("T115 copied attachments are pinned under the handoff inbox and the originals stay intact", async test => {
	const s = await setup(test), { t } = s;
	s.goals.executor.stop();
	const file = join(t.workspace, "list.txt");
	const folder = join(t.workspace, "notes");
	mkdirSync(folder);
	writeFileSync(file, "original list");
	writeFileSync(join(folder, "note.md"), "original note");
	const imported = await t.core.call("butterfly.import", { paths: [file, folder] }) as { paths: string[] };
	const raw = `${TASK}\n\n<资料>\n- 文件：${imported.paths[0]}\n- 文件夹：${imported.paths[1]}\n</资料>`;
	await s.send("with-inputs", raw);
	const [view] = await s.list();
	assert.equal(view?.inputs.length, 2);
	const [a, b] = view!.inputs;
	assert.match(a!, /\/inbox\/tasks\/g_[\w]+\/1\/list\.txt$/);
	assert.equal(readFileSync(s.local(a!), "utf8"), "original list");
	assert.equal(readFileSync(s.local(posix.join(b!, "note.md")), "utf8"), "original note");
	assert.equal(readFileSync(file, "utf8"), "original list");
	assert.equal(readFileSync(join(folder, "note.md"), "utf8"), "original note");
	const goal = await t.waitFor(() => s.goals.scheduler.get(view!.goalId));
	assert.ok(goal.spec.constraints.some(constraint => constraint.text.includes(a!)));
	assert.equal(t.core.autonomy.checkGoal(goal, "write", a!).ok, false);
});

it("T115 checks missing and empty outputs before self-accepting and delivers one receipt across restart", async test => {
	const s = await setup(test), { t } = s;
	s.goals.executor.stop();
	await s.send("delivery", TASK);
	const [view] = await s.list();
	const id = view!.goalId, logical = view!.deliverables[0]!, file = s.local(logical);
	const done = () => fauxAssistantMessage([fauxToolCall("goal_report", { status: "done", note: explanation })]);
	let first = false, second = false;
	t.respond(done(), fauxAssistantMessage("第一轮"), () => {
		first = true;
		assert.notEqual(s.goals.scheduler.get(id)?.status, "completed");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "");
		return done();
	}, fauxAssistantMessage("第二轮"), () => {
		second = true;
		assert.notEqual(s.goals.scheduler.get(id)?.status, "completed");
		writeFileSync(file, "完整交付");
		return done();
	}, fauxAssistantMessage("第三轮"));
	s.goals.executor.start();
	await t.waitFor(() => s.goals.scheduler.get(id)?.status === "completed", 22_000);
	assert.equal(first && second, true);
	const receiptKey = `chat-delivery:${id}`;
	await t.waitFor(() => t.core.autonomy.effects.get(receiptKey)?.state === "completed");
	const [final] = await s.list();
	assert.equal(final?.delivery?.explanation, explanation);
	assert.equal(t.core.db.get("SELECT 1 FROM goal_reviews WHERE goal_id=? AND layer='model'", id), undefined);
	assert.equal(t.faux.state.callCount, 6);
	assert.equal(t.core.confirmations.list({ status: "pending" }).length, 0);
	const artifact = await t.core.call("butterfly.chat.artifact", { goalId: id, name: "report.md" }) as { path: string };
	assert.equal(readFileSync(artifact.path, "utf8"), "完整交付");
	await assert.rejects(t.core.call("butterfly.chat.artifact", { goalId: id, name: "../report.md" }));

	t.core.db.run("UPDATE autonomy_effects SET state='running',receipt=NULL WHERE key=?", receiptKey);
	const next = await s.restart();
	await next.waitFor(() => next.core.autonomy.effects.get(receiptKey)?.state === "completed");
	const log = readFileSync(s.file, "utf8").split(/\r?\n/).filter(line => line.includes(`"dfChatTaskMessage":"${receiptKey}"`));
	assert.equal(log.length, 1);
	assert.ok(log[0]!.includes(explanation));
});
