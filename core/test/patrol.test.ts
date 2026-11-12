import assert from "node:assert/strict";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createBackup } from "../src/backup/export.ts";
import { stageBackup } from "../src/backup/restore.ts";
import { normalizeCwd, RpcError } from "../src/core.ts";
import { Gateway, type ChannelInfo } from "../src/gateway/gateway.ts";
import { PatrolModule, type PatrolClock } from "../src/modules/patrol.ts";
import { GoalsModule } from "../src/modules/goals.ts";
import { goalNoticeReceipt } from "../src/modules/goals/notices.ts";
import { SANDBOX_ENTRY, recordedSandbox } from "../src/pi/host.ts";
import { readSessionEntries } from "../src/pi/session-metadata.ts";
import { startTestCore, type TestCore } from "./harness.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

class Clock implements PatrolClock {
	at = new Date(2026, 10, 11, 10, 5).getTime();
	private timers = new Map<() => void, number>();
	now(): number { return this.at; }
	schedule(callback: () => void, delay: number): () => void {
		this.timers.set(callback, this.at + delay);
		return () => { this.timers.delete(callback); };
	}
	jump(at: number): void {
		this.at = at;
		for (const [callback, time] of [...this.timers].sort((a, b) => a[1] - b[1])) {
			if (time <= at && this.timers.delete(callback)) callback();
		}
	}
	advance(ms: number): void { this.jump(this.at + ms); }
}

interface Log {
	id: string; status: string; note: string; cost: number; error: string | null;
	notified: boolean; sessionFile: string | null; sessionAvailable: boolean; model: string | null;
	newFacts: { key: string; kind: string; text: string }[];
	notificationState: string | null; notificationNote: string | null;
	actions: { kind: string; note?: string }[];
}
interface Status {
	enabled: boolean; running: boolean; nextAt: number; intervalMin: number;
	quietNow: boolean; budgetUsedToday: number; cooldownUntil: number | null;
}
interface Watch { id: string; text: string; createdBy: string; until: number | null; doneAt: number | null }
let t: TestCore;
let clock: Clock;
beforeEach(async () => {
	clock = new Clock();
	t = await startTestCore(undefined, { patrolClock: clock });
	t.core.sandboxProvider = () => ({ distro: "df-test-patrol", ready: async () => {}, online: () => false });
});
afterEach(async () => { await t.cleanup(); });

function schedule(id: string, owner = "butterfly", nextAt: number | null = null, kind = "task"): void {
	t.core.db.run(`INSERT INTO schedules(id,name,prompt,cwd,kind,trigger,missed_policy,session_mode,status,created_by,created_at,updated_at,owner,next_run_at)
		VALUES(?,?,?,?,?,?,'skip','fresh','active','user',?,?,?,?)`,
		id, "检查 " + id, "检查", owner === "butterfly" ? t.core.paths.butterflyDir : t.workspace, kind,
		JSON.stringify({ type: "once", at: nextAt ?? clock.at }), clock.at, clock.at, owner, nextAt);
}

function failed(id: string, scheduleId = "morning"): void {
	t.core.db.run(`INSERT INTO schedule_runs(id,schedule_id,trigger_key,version,status,ended_at)
		VALUES(?,?,?,1,'failed',?)`, id, scheduleId, "test:" + id, clock.at);
}

function report(status: "handled" | "notified" | "waiting_user", note: string): void {
	t.respond(fauxAssistantMessage(fauxToolCall("patrol_update_log", { status, note }), { stopReason: "toolUse" }), fauxAssistantMessage("巡检结束"));
}

function logs(params = {}): Promise<Log[]> { return t.core.call("patrol.log", params) as Promise<Log[]>; }
function status(): Promise<Status> { return t.core.call("patrol.status", {}) as Promise<Status>; }
function start(): Promise<{ runId: string }> { return t.core.call("patrol.runNow", {}) as Promise<{ runId: string }>; }
async function result(id: string): Promise<Log> {
	await t.waitFor(() => t.messages.some(event => event.event === "patrol.finished" && event.runId === id));
	return (await logs()).find(log => log.id === id)!;
}
async function patrol(): Promise<Log> { return result((await start()).runId); }
function nextManual(): void { clock.advance(2 * MINUTE); }

it("T97 01 records a quiet result at zero cost without calling the model or notifier", async () => {
	const row = await patrol();
	assert.equal(row.status, "quiet");
	assert.equal(row.note, "巡检完毕，无需行动");
	assert.equal(row.cost, 0);
	assert.equal(row.sessionFile, null);
	assert.deepEqual(row.newFacts, []);
	assert.equal(t.faux.state.callCount, 0);
	assert.deepEqual(t.notifier.sent, []);
});

it("T97 02 reports one new butterfly failure once, and each subsequent attempt has its own identity", async () => {
	schedule("morning"); schedule("other", "workbench");
	failed("first"); failed("wrong-owner", "other");
	report("notified", "早间检查没做成");
	const first = await patrol();
	assert.equal(first.status, "notified", first.error ?? undefined);
	assert.deepEqual(first.newFacts.map(fact => fact.key), ["schedule_run:first"]);
	assert.deepEqual(t.notifier.sent, [{ title: "蝶君巡检", body: "早间检查没做成" }]);
	nextManual();
	assert.equal((await patrol()).status, "quiet");
	assert.equal(t.faux.state.callCount, 2, "one tool call and its concluding reply in one session");
	nextManual();
	failed("second"); report("handled", "已经补做");
	assert.deepEqual((await patrol()).newFacts.map(fact => fact.key), ["schedule_run:second"]);
	assert.equal(t.notifier.sent.length, 1);
});

it("T97 03 batches three findings into one sandbox session and chooses the small-task model", async () => {
	schedule("morning");
	failed("one"); failed("two"); failed("three");
	t.core.settings.update({ smallTaskModel: "faux/faux-text" });
	let launches = 0;
	t.respond((context, _options, _state, model) => {
		launches++;
		assert.equal(model.id, "faux-text");
		assert.match(JSON.stringify(context.messages), /系统巡检/);
		for (const key of ["one", "two", "three"]) assert.match(JSON.stringify(context.messages), new RegExp("schedule_run:" + key));
		return fauxAssistantMessage(fauxToolCall("patrol_update_log", { status: "handled", note: "三个发现一起处理" }), { stopReason: "toolUse" });
	}, fauxAssistantMessage("完成"));
	const row = await patrol();
	assert.equal(row.status, "handled", row.error ?? undefined);
	assert.equal(row.model, "faux/faux-text");
	assert.equal(launches, 1);
	assert.equal(row.newFacts.length, 3);
	assert.equal(t.core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs")!.n, 1);
});

it("T97 04 reminds about old attention after four hours and then every 24 hours without a model", async () => {
	t.core.db.run(`INSERT INTO notices(id,kind,title,status,created_at) VALUES('old','limit_turns','等你确认预算','pending',?)`, clock.at - 4 * HOUR + MINUTE);
	assert.equal((await patrol()).status, "quiet");
	nextManual();
	const first = await patrol();
	assert.equal(first.status, "notified");
	assert.equal(first.newFacts[0]?.kind, "stale_attention");
	nextManual();
	assert.equal((await patrol()).status, "quiet");
	clock.advance(DAY);
	assert.equal((await patrol()).newFacts[0]?.key, "attention:limit:old:1");
	assert.equal(t.faux.state.callCount, 0);
	assert.equal(t.notifier.sent.length, 2);
});

it("T97 05 alerts once on channel failure and recognizes failure again after recovery", async test => {
	const gateway = t.core.module(Gateway)!;
	let unavailable: ChannelInfo["unavailable"] = { kind: "quota", message: "limit" };
	const channel = { id: "relay", provider: "df-relay", name: "示例渠道", enabled: true };
	test.mock.method(gateway, "channels", () => [{ ...channel, unavailable }] as ChannelInfo[]);
	report("handled", "渠道额度用完");
	assert.equal((await patrol()).newFacts[0]?.kind, "health");
	nextManual();
	assert.equal((await patrol()).status, "quiet");
	unavailable = null;
	nextManual();
	assert.equal((await patrol()).status, "quiet");
	unavailable = { kind: "auth", message: "invalid" };
	report("handled", "已记录密钥问题");
	nextManual();
	assert.match((await patrol()).newFacts[0]!.text, /密钥失效/);
	assert.equal(t.faux.state.callCount, 4);
});

it("T97 06 projects night findings into attention, then releases one combined system notification", async () => {
	clock.jump(new Date(2026, 10, 11, 23, 5).getTime());
	t.core.settings.update({ patrolStaleHours: 12 });
	schedule("morning"); failed("night");
	report("waiting_user", "请决定是否重跑早间检查");
	const first = await patrol();
	assert.equal(first.status, "waiting_user", first.error ?? undefined);
	assert.equal(first.notified, false);
	assert.equal((await status()).quietNow, true);
	const inbox = await t.core.call("attention.list", {}) as { now: { id: string; kind: string; origin: { role: string } }[] };
	assert.equal(inbox.now[0]?.kind, "patrol_finding");
	assert.equal(inbox.now[0]?.origin.role, "butterfly");
	assert.equal(inbox.now[0]?.id, "patrol_finding:" + first.id);
	nextManual(); failed("night2");
	report("notified", "第二件事已经补做");
	assert.equal((await patrol()).notified, false);
	assert.equal(t.notifier.sent.length, 0);
	clock.jump(new Date(2026, 10, 12, 7, 5).getTime());
	assert.equal((await patrol()).status, "quiet");
	assert.equal(t.notifier.sent.length, 1);
	assert.match(t.notifier.sent[0]!.body, /请决定是否重跑早间检查\n第二件事已经补做/);
	assert.ok((await logs()).find(row => row.id === first.id)?.notified);
	await t.core.call("attention.resolve", { id: inbox.now[0]!.id, action: "reject" });
	assert.deepEqual((await t.core.call("attention.list", {}) as { now: unknown[] }).now, []);
});

it("T97 07 uses only patrol USD spending from the ledger and falls back to direct notice at the daily limit", async () => {
	const paid = await patrol();
	t.core.db.run(`INSERT INTO request_ledger(id,requested_at,state,provider,model,purpose,slot_id,amount,currency,amount_source,price_version,origin)
		VALUES('paid',?,'recorded','faux','faux-1','conversation',?,0.5,'USD','price_estimate','v1','live')`, clock.at, paid.id);
	nextManual(); schedule("morning"); failed("budget");
	const row = await patrol();
	assert.equal((await status()).budgetUsedToday, 0.5);
	assert.equal(row.status, "notified");
	assert.equal(row.note, "今天巡检的花费到上限了");
	assert.match(t.notifier.sent[0]!.body, /今天巡检的花费到上限了/);
	assert.match(t.notifier.sent[0]!.body, /没做成/);
	assert.equal(t.faux.state.callCount, 0);
});

it("T97 08 manual calls cool down and an overlapping tick is skipped without a second model session", async () => {
	clock.jump(new Date(2026, 10, 11, 10, 29).getTime());
	schedule("morning"); failed("busy");
	let release: () => void;
	const hold = new Promise<void>(resolve => { release = resolve; });
	t.respond(async () => {
		await hold;
		return fauxAssistantMessage(fauxToolCall("patrol_update_log", { status: "handled", note: "完成" }), { stopReason: "toolUse" });
	}, fauxAssistantMessage("完成"));
	const { runId } = await start();
	try {
		assert.equal((await status()).running, true);
		assert.equal((await status()).cooldownUntil, clock.at + 2 * MINUTE);
		await assert.rejects(start(), error => error instanceof RpcError && error.code === "cooldown" && /120 秒/.test(error.message));
		await t.waitFor(() => t.faux.state.callCount === 1);
		clock.advance(MINUTE);
		const skipped = (await logs()).find(row => row.status === "skipped");
		assert.equal(skipped?.note, "已有巡检正在运行");
		assert.equal(t.faux.state.callCount, 1);
	} finally { release!(); }
	assert.equal((await result(runId)).status, "handled");
});

it("T97 09 aborts an unfinished fake model at five minutes and closes its slot", async () => {
	schedule("morning"); failed("timeout");
	let aborted = false;
	t.respond((_context, options) => new Promise((_resolve, reject) => {
		assert.ok(options?.signal);
		options.signal.addEventListener("abort", () => { aborted = true; reject(options.signal!.reason); }, { once: true });
	}));
	const { runId } = await start();
	await t.waitFor(() => t.faux.state.callCount === 1);
	clock.advance(5 * MINUTE - 1);
	assert.equal((await status()).running, true);
	clock.advance(1);
	const row = await result(runId);
	assert.equal(row.status, "error");
	assert.match(row.error!, /5 分钟/);
	assert.equal(aborted, true);
	assert.equal(t.core.sessionSlots().length, 0);
});

it("T97 10 recalculates aligned ticks immediately, skips missed sleep boundaries and records disabled skips", async () => {
	assert.equal((await status()).nextAt, new Date(2026, 10, 11, 10, 30).getTime());
	await t.core.call("settings.update", { patrolIntervalMin: 20 });
	assert.equal((await status()).intervalMin, 30);
	await t.core.call("settings.update", { patrolIntervalMin: 15 });
	assert.equal((await status()).nextAt, new Date(2026, 10, 11, 10, 15).getTime());
	assert.ok(t.messages.some(event => event.event === "patrol.changed"));
	clock.jump(new Date(2026, 10, 11, 11, 2).getTime());
	assert.equal((await logs()).length, 0);
	assert.equal((await status()).nextAt, new Date(2026, 10, 11, 11, 15).getTime());
	await t.core.call("settings.update", { patrolEnabled: false });
	clock.jump(new Date(2026, 10, 11, 11, 15).getTime());
	assert.equal((await logs())[0]?.status, "skipped");
	assert.equal((await logs())[0]?.note, "蝶君巡检已关闭");
});

it("T97 11 keeps the marked patrol session off the regular conversation list without changing its order", async () => {
	const home = t.core.paths.butterflyDir;
	const ordinary = (title: string, time: number) => {
		const manager = SessionManager.create(home, t.sessionDir);
		manager.appendCustomEntry(SANDBOX_ENTRY, { sandbox: true });
		manager.appendMessage({ role: "user", content: title, timestamp: time });
		manager.appendMessage(fauxAssistantMessage(title, { timestamp: time }));
		return manager.getSessionFile()!;
	};
	const first = ordinary("先前对话", clock.at - MINUTE);
	const second = ordinary("更新对话", clock.at);
	const sessions = async () => (await t.core.call("sessions.list", { cwd: home }) as { path: string }[]).map(row => row.path);
	assert.deepEqual(await sessions(), [second, first]);
	schedule("morning"); failed("private");
	report("handled", "已检查");
	const row = await patrol();
	assert.ok(row.sessionFile && existsSync(row.sessionFile));
	assert.ok(readSessionEntries(row.sessionFile).some(entry => entry.customType === "df.patrol"));
	const manager = SessionManager.open(row.sessionFile);
	assert.equal(recordedSandbox(manager), true);
	assert.deepEqual(await sessions(), [second, first]);
	assert.equal(t.core.db.get("SELECT 1 FROM tasks WHERE session_file=?", row.sessionFile), undefined);
});

it("T97 12 registers all patrol tools only in butterfly and validates log calls inside a patrol", async () => {
	const names = ["patrol_update_log", "watch_add", "watch_done"];
	const workbench = await t.core.openSlot({ cwd: t.workspace });
	assert.ok(names.every(name => !workbench.session.getAllTools().some(tool => tool.name === name)));
	const butterfly = await t.core.openSlot({ cwd: t.core.paths.butterflyDir, sandbox: true, client: t.client });
	assert.ok(names.every(name => butterfly.session.getAllTools().some(tool => tool.name === name)), butterfly.session.getAllTools().map(tool => tool.name).join(", "));
	t.respond(fauxAssistantMessage([
		fauxToolCall("patrol_update_log", { note: "误调用", status: "handled" }),
		fauxToolCall("watch_add", { text: "月度账单" }),
	], { stopReason: "toolUse" }), fauxAssistantMessage("完成"));
	await t.send(butterfly.slotId, { id: "watch", type: "prompt", message: "帮我盯着月度账单" });
	await t.waitFor(() => t.records(butterfly.slotId).some(record => record.type === "agent_settled"));
	const [item] = await t.core.call("watch.list", {}) as Watch[];
	assert.equal(item?.createdBy, "butterfly");
	assert.equal(item?.text, "月度账单");
	assert.match(JSON.stringify(t.records(butterfly.slotId)), /只有正在运行的巡检可以写巡检记录/);
	assert.match(JSON.stringify(t.records(butterfly.slotId)), /已记下，巡检时会帮你盯着/);
	assert.deepEqual(await logs(), []);
});

it("T97 13 prunes expired patrol history and its private session, leaving recent history", async () => {
	await t.core.call("settings.update", { patrolKeepDays: 2 });
	const old = clock.at - 3 * DAY;
	const recent = clock.at - DAY;
	const path = join(t.core.module(PatrolModule)!.sessionDir, "expired.jsonl");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ type: "custom", customType: "df.patrol", data: { runId: "old" } }));
	t.core.db.run("INSERT INTO patrol_runs(id,started_at,ended_at,status,manual,session_file) VALUES('old',?,?,'quiet',0,?),('recent',?,?,'quiet',0,NULL)", old, old, path, recent, recent);
	await patrol();
	assert.deepEqual((await logs({ before: clock.at, limit: 1 })).map(row => row.id), ["recent"]);
	assert.equal(t.core.db.get("SELECT 1 FROM patrol_runs WHERE id='old'"), undefined);
	assert.equal(existsSync(path), false);
});

it("T97 14 leaves a source hook for goals and honors category settings, watch mutations and events", async () => {
	const item = await t.core.call("watch.save", { text: "候选包", until: clock.at + HOUR }) as Watch;
	const edited = await t.core.call("watch.save", { id: item.id, text: "新版候选包" }) as Watch;
	assert.equal(edited.until, item.until);
	assert.equal(edited.createdBy, "user");
	const done = await t.core.call("watch.done", { id: item.id }) as Watch;
	assert.equal(done.doneAt, clock.at);
	const dispose = t.core.module(PatrolModule)!.registerGoalSource(() => [{ key: "goal:first", text: "目标暂停" }]);
	report("handled", "汇总新情况");
	assert.deepEqual((await patrol()).newFacts.map(fact => fact.kind), ["goal_stuck"]);
	dispose();
	await t.core.call("watch.remove", { id: item.id });
	assert.deepEqual(await t.core.call("watch.list", {}), []);
	assert.equal(t.messages.filter(event => event.event === "watch.changed").length, 4);
	const checks = t.core.settings.get().patrolChecks;
	t.core.settings.update({ patrolChecks: { ...checks, failed: false, watch: false } });
	nextManual(); schedule("morning"); failed("disabled-category");
	assert.equal((await patrol()).status, "quiet");
});

it("T97 15 skips unavailable sandbox, but reports a new readiness failure and affected upcoming work only once", async () => {
	t.core.sandboxProvider = undefined;
	assert.equal((await patrol()).note, "蝶君的沙箱还没准备好");
	nextManual();
	schedule("task", "butterfly", clock.at + 15 * MINUTE);
	schedule("reminder", "butterfly", clock.at + 15 * MINUTE, "reminder");
	t.core.sandboxProvider = () => ({ distro: "df-test-patrol", ready: async () => { throw new Error("启动失败"); }, online: () => false });
	const row = await patrol();
	assert.equal(row.status, "skipped");
	assert.deepEqual(row.newFacts.map(fact => fact.kind), ["health", "upcoming"]);
	assert.match(t.notifier.sent[0]!.body, /检查 task/);
	nextManual();
	assert.equal((await patrol()).newFacts.length, 0);
	assert.equal(t.faux.state.callCount, 0);
	assert.equal(t.notifier.sent.length, 1);
});

it("T97 16 / T108 Q-03 exports patrol history and excludes the original conversation", async () => {
	const target = await startTestCore(undefined, { patrolClock: new Clock() });
	try {
		assert.deepEqual(t.core.backupParts.find(part => part.id === "patrol")?.tables, ["patrol_runs", "watch_items", "patrol_reported"]);
		clock.jump(new Date(2026, 10, 11, 23, 5).getTime());
		schedule("morning"); failed("backup");
		report("notified", "等到早上提醒");
		const run = await patrol();
		assert.ok(run.sessionFile && existsSync(run.sessionFile));
		const item = await t.core.call("watch.save", { text: "留意备份", until: clock.at + DAY }) as Watch;
		const out = join(t.dir, "patrol.dfbackup");
		await createBackup({
			paths: t.core.paths, agentDir: t.agentDir, sessionsDir: t.sessionDir, db: t.core.db.raw, appVersion: "0.8.3",
		}, { out, kind: "manual", credentials: "none", includeMaterials: false });
		const staged = await stageBackup(out, {
			paths: target.core.paths, agentDir: target.agentDir, sessionsDir: target.sessionDir, appVersion: "0.8.3",
		}, { parts: target.core.backupParts });
		assert.equal(existsSync(join(staged.dir, "raw", "data", "appdata", "patrol-sessions")), false);
		assert.equal(staged.sessionTargets.length, 0);
		const db = new DatabaseSync(join(staged.dir, "raw", "data", "appdata", "core.db"), { readOnly: true });
		try {
			const restored = db.prepare("SELECT status,notification,notified,session_file FROM patrol_runs WHERE id=?").get(run.id);
			assert.equal(restored?.status, "notified");
			assert.equal(restored?.notification, "等到早上提醒");
			assert.equal(restored?.notified, 0);
			assert.ok(String(restored?.session_file).startsWith(target.core.paths.dataDir));
			assert.equal(db.prepare("SELECT text FROM watch_items WHERE id=?").get(item.id)?.text, "留意备份");
		} finally { db.close(); }
	} finally { await target.cleanup(); }
});

it("T108 Q-02 checks a blocked Butterfly goal once and suppresses an existing goal notification", async () => {
	const service = t.core.module(GoalsModule)!;
	service.executor.stop();
	const create = (butterfly: boolean) => t.core.call("goals.create", {
		title: butterfly ? "蝶君阻塞夹具" : "工作台不可巡检夹具", originText: "交付合成材料", mandateRef: "user:t108",
		scope: { cwd: butterfly ? t.core.paths.butterflyDir : t.workspace, partition: butterfly ? "butterfly" : "workbench", sandbox: butterfly },
		spec: { objective: "核对合成材料" },
	}) as Promise<{ id: string }>;
	const butterfly = await create(true), workbench = await create(false);
	for (const goal of [butterfly, workbench]) t.core.db.run("UPDATE goals SET status='blocked',reason='missing_input' WHERE id=?", goal.id);
	t.core.db.run("UPDATE goal_intents SET status='dropped' WHERE action='run'");
	const id = butterfly.id, key = `goal:${id}:blocked:1`;
	const generation = t.core.db.get<{ lease_generation: number }>("SELECT lease_generation FROM goals WHERE id=?", id)!.lease_generation;
	t.core.db.run(`INSERT INTO goal_intents(id,goal_id,revision,generation,idem_key,action,status,reason,created_at)
		VALUES('notify-t108',?,1,?,?,'notify','pending','blocked',?)`, id, generation, `notify:${id}:1:blocked:${generation}:missing_input`, clock.at);
	service.executor.start();
	await t.waitFor(() => t.notifier.sent.some(item => item.title === "目标遇到阻塞"));
	t.respond(context => {
		const prompt = JSON.stringify(context.messages);
		assert.match(prompt, /蝶君阻塞夹具/);
		assert.doesNotMatch(prompt, /工作台不可巡检夹具/);
		return fauxAssistantMessage(fauxToolCall("patrol_update_log", { status: "notified", note: "重复通知目标阻塞" }), { stopReason: "toolUse" });
	}, fauxAssistantMessage("完成检查"));
	const first = await patrol();
	assert.equal(t.faux.state.callCount, 2);
	assert.equal(first.status, "quiet", first.error ?? undefined);
	assert.deepEqual(first.newFacts, []);
	assert.equal(t.notifier.sent.length, 1);
	assert.ok(t.core.db.get("SELECT 1 FROM patrol_reported WHERE fact_key=?", key));
	nextManual();
	assert.equal((await patrol()).status, "quiet");
	assert.equal(t.faux.state.callCount, 2);
	assert.equal(t.notifier.sent.length, 1);

	t.core.db.run("UPDATE goals SET revision=2 WHERE id=?", id);
	const revised = enqueueGoalNotice(id, 2, "missing_input");
	await t.waitFor(() => goalNoticeReceipt(t.core.db, revised)?.state === "sent");
	t.respond(fauxAssistantMessage(fauxToolCall("patrol_update_log", { status: "waiting_user", note: "这条通用提醒已发过",
		goalActions: [{ key: `goal:${id}:blocked:2`, kind: "questions", note: "请确认采用合成来源 A 还是 B。" }] }), { stopReason: "toolUse" }),
	fauxAssistantMessage("完成检查"));
	nextManual();
	const second = await patrol();
	assert.equal(second.status, "handled", second.error ?? undefined);
	assert.equal(second.note, "请确认采用合成来源 A 还是 B。");
	assert.deepEqual(second.newFacts.map(fact => fact.key), [`goal:${id}:blocked:2`]);
	assert.equal(t.notifier.sent.length, 2);
});

async function blockedGoal(status: "blocked" | "paused" = "blocked"): Promise<string> {
	t.core.module(GoalsModule)!.executor.stop();
	const { id } = await t.core.call("goals.create", {
		title: "巡检回归目标", originText: "核对合成记录", mandateRef: "user:t112",
		scope: { cwd: t.core.paths.butterflyDir, partition: "butterfly", sandbox: true },
		spec: { objective: "核对合成记录" },
	}) as { id: string };
	t.core.db.run("UPDATE goals SET status=?,reason='stalled' WHERE id=?", status, id);
	t.core.db.run("UPDATE goal_intents SET status='dropped' WHERE goal_id=? AND action='run'", id);
	return id;
}

function enqueueGoalNotice(id: string, revision = 1, reason = "stalled"): string {
	const generation = t.core.db.get<{ lease_generation: number }>("SELECT lease_generation FROM goals WHERE id=?", id)!.lease_generation;
	const key = `notify:${id}:${revision}:blocked:${generation}:${reason}`;
	t.core.db.run(`INSERT INTO goal_intents(id,goal_id,revision,generation,idem_key,action,status,reason,created_at)
		VALUES(?,?,?,?,?,'notify','pending','blocked',?)`, key, id, revision, generation, key, clock.at);
	t.core.module(GoalsModule)!.executor.start();
	return key;
}

async function reopenPatrol(): Promise<void> {
	t = await t.reopen();
	t.core.sandboxProvider = () => ({ distro: "df-test-patrol", ready: async () => {}, online: () => false });
}

it("T112 mute suppresses both senders but records goal and patrol outcomes", async () => {
	const id = await blockedGoal();
	t.core.settings.update({ notifications: false });
	const key = enqueueGoalNotice(id);
	await t.waitFor(() => t.core.db.get<{ status: string }>("SELECT status FROM goal_intents WHERE idem_key=?", key)?.status === "done");
	schedule("morning"); failed("muted");
	report("notified", "需要检查两项记录");
	const row = await patrol();
	assert.equal(row.notificationState, "muted");
	assert.equal(row.notificationNote, "通知关着");
	assert.equal(t.faux.state.callCount, 2);
	assert.deepEqual(goalNoticeReceipt(t.core.db, key), { notificationKey: key, sender: "goal", state: "muted", note: "通知关着" });
	assert.deepEqual(t.notifier.sent, []);
});

it("T112 reopening notifications never replays muted goal or patrol notices", async () => {
	clock.jump(new Date(2026, 10, 11, 23, 5).getTime());
	await blockedGoal();
	schedule("morning"); failed("queued-then-muted");
	report("notified", "这个摘要在静默时段排队");
	const queued = await patrol();
	assert.equal(queued.notificationState, "queued");
	t.core.settings.update({ notifications: false });
	assert.equal((await logs()).find(row => row.id === queued.id)?.notificationState, "muted");
	const id = await blockedGoal();
	const key = enqueueGoalNotice(id);
	await t.waitFor(() => t.core.db.get<{ status: string }>("SELECT status FROM goal_intents WHERE idem_key=?", key)?.status === "done");
	t.core.settings.update({ notifications: true });
	await reopenPatrol();
	clock.jump(new Date(2026, 10, 12, 7, 5).getTime());
	report("notified", "这个目标需要注意");
	assert.equal((await patrol()).status, "quiet");
	assert.equal(t.faux.state.callCount, 2);
	assert.equal((await logs()).find(row => row.id === queued.id)?.notificationState, "muted");
	assert.equal(goalNoticeReceipt(t.core.db, key)?.state, "muted");
	assert.deepEqual(t.notifier.sent, []);
});

for (const changed of [false, true]) {
	it(`T112 quiet notice rechecks ${changed ? "changed goal state" : "native delivery"} after restart`, async () => {
		clock.jump(new Date(2026, 10, 11, 23, 5).getTime());
		const id = await blockedGoal();
		report("notified", "阻塞目标需要注意");
		const queued = await patrol();
		assert.equal(queued.notificationState, "queued");
		if (changed) t.core.db.run("UPDATE goals SET status='cancelled' WHERE id=?", id);
		else {
			const key = enqueueGoalNotice(id);
			await t.waitFor(() => goalNoticeReceipt(t.core.db, key)?.state === "sent");
		}
		await reopenPatrol();
		clock.jump(new Date(2026, 10, 12, 7, 5).getTime());
		await patrol();
		const old = (await logs()).find(row => row.id === queued.id)!;
		assert.equal(old.notified, false);
		assert.match(old.notificationNote ?? "", changed ? /状态或修订已变化/ : /已由原发送方处理/);
		assert.equal(t.notifier.sent.length, 0);
	});
}

it("T112 an attempted intent with failed delivery can be supplemented exactly once", async () => {
	const id = await blockedGoal();
	const deliver = t.notifier.deliver.bind(t.notifier);
	const attempts: string[] = [];
	let failNative!: (result: "undelivered") => void;
	const native = new Promise<"undelivered">(resolve => { failNative = resolve; });
	Object.defineProperty(t.notifier, "deliver", { configurable: true, value: async (title: string, body: string) => {
		attempts.push(title);
		return title === "目标遇到阻塞" ? native : deliver(title, body);
	} });
	const key = enqueueGoalNotice(id);
	await t.waitFor(() => attempts.length === 1);
	assert.equal(goalNoticeReceipt(t.core.db, key)?.state, "queued");
	report("notified", "目标提醒仍在队列");
	assert.equal((await patrol()).status, "quiet");
	assert.equal(attempts.length, 1);
	failNative("undelivered");
	await t.waitFor(() => goalNoticeReceipt(t.core.db, key)?.state === "failed");
	nextManual();
	report("notified", "补发阻塞提醒");
	assert.equal((await patrol()).notificationState, "sent");
	assert.equal(goalNoticeReceipt(t.core.db, key)?.sender, "patrol");
	nextManual();
	assert.equal((await patrol()).status, "quiet");
	assert.deepEqual(attempts, ["目标遇到阻塞", "蝶君巡检"]);
});

for (const started of [false, true]) {
	it(`T112 an interrupted finding ${started ? "with" : "without"} a model call follows the persisted phase`, async () => {
		const fact = { key: "report:interrupted", kind: "report", text: "重启前发现的报告" };
		t.core.db.run("INSERT INTO patrol_runs(id,started_at,manual,model_started) VALUES('interrupted',?,0,?)", clock.at, Number(started));
		t.core.db.run("INSERT INTO patrol_reported(fact_key,state,run_id,fact) VALUES(?,'processing','interrupted',?)", fact.key, JSON.stringify(fact));
		await reopenPatrol();
		const phase = () => t.core.db.get<{ state: string }>("SELECT state FROM patrol_reported WHERE fact_key=?", fact.key)?.state;
		assert.equal(phase(), started ? "processed" : "discovered");
		if (!started) report("handled", "补处理发现");
		const before = t.faux.state.callCount;
		const row = await patrol();
		assert.equal(row.status, started ? "quiet" : "handled", row.error ?? undefined);
		assert.equal(t.faux.state.callCount - before, started ? 0 : 2);
		assert.equal(phase(), "processed");
		assert.equal((await logs()).find(log => log.id === "interrupted")?.status, "error");
	});
}

for (const changed of [false, true]) {
	it(`T112 a route claim ${changed ? "accepts this goal's revision" : "rejects an unrelated successful read"}`, async test => {
		const id = await blockedGoal();
		const key = enqueueGoalNotice(id);
		await t.waitFor(() => goalNoticeReceipt(t.core.db, key)?.state === "sent");
		const file = join(t.core.paths.butterflyDir, "route-check.txt");
		writeFileSync(file, "unrelated synthetic material");
		const translate = (path: unknown) => typeof path === "string" && path.startsWith("\\\\wsl.localhost\\df-test-patrol\\")
			&& path.endsWith("\\route-check.txt") ? file : path;
		const stat = fs.stat, readFile = fs.readFile, realpath = fs.realpath;
		test.mock.method(fs, "stat", (path: unknown, options: unknown) => Reflect.apply(stat, fs, [translate(path), options]));
		test.mock.method(fs, "readFile", (path: unknown, options: unknown) => Reflect.apply(readFile, fs, [translate(path), options]));
		test.mock.method(fs, "realpath", (path: unknown, options: unknown) => Reflect.apply(realpath, fs, [translate(path), options]));
		syncBuiltinESMExports();
		test.after(() => { test.mock.restoreAll(); syncBuiltinESMExports(); });
		t.respond(fauxAssistantMessage(fauxToolCall("read", { file_path: "/workspace/route-check.txt" }), { stopReason: "toolUse" }), context => {
			const receipt = context.messages.at(-1);
			assert.equal(receipt?.role, "toolResult");
			assert.equal(receipt?.isError, false, JSON.stringify(receipt?.content));
			if (changed) t.core.db.run("UPDATE goals SET revision=2 WHERE id=?", id);
			return fauxAssistantMessage(fauxToolCall("patrol_update_log", { status: "handled", note: "我换路了",
				goalActions: [{ key: `goal:${id}:blocked:1`, kind: "route", note: "我换路了" }] }), { stopReason: "toolUse" });
		}, fauxAssistantMessage("检查完成"));
		const row = await patrol();
		assert.equal(row.status, changed ? "handled" : "quiet", row.error ?? undefined);
		assert.equal(row.actions.at(-1)?.kind, changed ? "route" : "observed");
		assert.equal(row.note, changed ? "我换路了" : "看过，没有动作");
	});
}

it("T112 a paused stalled goal stays deduplicated after restart and patrol pruning", async () => {
	const id = await blockedGoal("paused");
	report("notified", "目标停滞");
	const first = await patrol();
	assert.equal(first.notificationState, "sent");
	await reopenPatrol();
	const before = t.faux.state.callCount;
	const notices = t.notifier.sent.length;
	clock.advance(32 * DAY);
	assert.equal((await patrol()).status, "quiet");
	assert.ok(!(await logs()).some(row => row.id === first.id));
	assert.equal(t.faux.state.callCount, before);
	assert.equal(t.notifier.sent.length, notices);
	assert.ok(t.core.db.get("SELECT 1 FROM patrol_reported WHERE fact_key=? AND state='processed'", `goal:${id}:paused:1`));
});

it("T97 17 shuts down an active patrol and persists its stopped result before closing the database", async () => {
	schedule("morning"); failed("shutdown");
	let aborted = false;
	t.respond((_context, options) => new Promise((_resolve, reject) => {
		assert.ok(options?.signal);
		options.signal.addEventListener("abort", () => { aborted = true; reject(options.signal!.reason); }, { once: true });
	}));
	const { runId } = await start();
	await t.waitFor(() => t.faux.state.callCount === 1);
	await t.core.shutdown();
	assert.equal(aborted, true);
	assert.equal(t.core.sessionSlots().length, 0);
	const db = new DatabaseSync(t.core.paths.dbFile, { readOnly: true });
	try {
		const run = db.prepare("SELECT status,error FROM patrol_runs WHERE id=?").get(runId);
		assert.equal(run?.status, "error");
		assert.match(String(run?.error), /后台正在退出/);
	} finally { db.close(); }
	assert.deepEqual(t.notifier.sent, []);
});

it("T97 18 stops the next model turn at the global spending limit and queues its notice during quiet hours", async () => {
	clock.jump(new Date(2026, 10, 11, 23, 5).getTime());
	t.core.settings.update({ dailyBudgetUsd: 0.25 });
	schedule("morning"); failed("global-cap");
	t.respond(() => {
		t.core.db.run(`INSERT INTO request_ledger(id,requested_at,state,provider,model,purpose,amount,currency,amount_source,price_version,origin)
			VALUES('global',?,'recorded','faux','faux-1','conversation',0.25,'USD','price_estimate','v1','live')`, clock.at);
		return fauxAssistantMessage(fauxToolCall("watch_add", { text: "已经记下" }), { stopReason: "toolUse" });
	}, fauxAssistantMessage("不应继续调用"));
	const row = await patrol();
	assert.equal(row.status, "notified", row.error ?? undefined);
	assert.equal(row.note, "今天的总花费到上限了");
	assert.equal(row.notified, false);
	assert.equal(t.faux.state.callCount, 1);
	assert.equal(t.notifier.sent.length, 0);
	assert.equal(t.core.db.get("SELECT 1 FROM notices WHERE slot_id=?", row.id), undefined);
	assert.deepEqual((await t.core.call("attention.list", {}) as { now: unknown[] }).now, []);
	clock.jump(new Date(2026, 10, 12, 7, 5).getTime());
	assert.equal((await patrol()).status, "quiet");
	assert.match(t.notifier.sent[0]!.body, /今天的总花费到上限了/);
});

function conversation(title: string, at = clock.at, cwd = t.core.paths.butterflyDir): string {
	const manager = SessionManager.create(cwd, t.sessionDir);
	manager.appendCustomEntry(SANDBOX_ENTRY, { sandbox: true });
	manager.appendMessage({ role: "user", content: title, timestamp: at });
	manager.appendMessage(fauxAssistantMessage(title, { timestamp: at }));
	return manager.getSessionFile()!;
}

it("T100 01 reports an unread delivery once and ignores seen, reminder and patrol deliveries", async test => {
	const home = t.core.paths.butterflyDir;
	const files = { unseen: conversation("未读"), earlier: conversation("提前打开"), seen: conversation("交付后打开"), remind: conversation("提醒") };
	schedule("reminder", "butterfly", null, "reminder");
	const insert = (id: string, path: string, cwd = home, scheduleId: string | null = null) => t.core.db.run(`
		INSERT INTO tasks(id,title,goal,cwd,cwd_key,session_file,source,status,schedule_id,created_at,updated_at,ended_at)
		VALUES(?,?,?,?,?,?,'chat','done',?,?,?,?)`, id, id, id, cwd, normalizeCwd(cwd), path, scheduleId, clock.at - 10, clock.at - 5, clock.at - 5);
	for (const [id, path] of Object.entries(files)) insert(id, path, home, id === "remind" ? "reminder" : null);
	insert("patrol", join(t.core.module(PatrolModule)!.sessionDir, "patrol.jsonl"));
	const seen = async (file: string, at: number) => {
		const now = test.mock.method(Date, "now", () => at);
		try { await t.core.call("sessions.markSeen", { sessionFile: file }); } finally { now.mock.restore(); }
	};
	await seen(files.earlier, clock.at - 10);
	await seen(files.seen, clock.at);
	report("handled", "汇总未读交付");
	const first = await patrol();
	assert.equal(first.status, "handled", first.error ?? undefined);
	assert.deepEqual(first.newFacts.map(fact => fact.key), ["delivered:earlier", "delivered:unseen"]);
	t.core.db.run("DELETE FROM patrol_runs WHERE id=?", first.id);
	nextManual();
	t.core.db.run("UPDATE tasks SET ended_at=? WHERE id IN ('earlier','unseen')", clock.at);
	assert.equal((await patrol()).status, "quiet");
	assert.equal(t.faux.state.callCount, 2);
});

it("T100 02 records when a conversation was opened and leaves the conversation list and ordering intact", async () => {
	const earlier = conversation("先前", clock.at - MINUTE);
	const later = conversation("最新", clock.at);
	const list = () => t.core.call("sessions.list", { cwd: t.core.paths.butterflyDir });
	const before = await list() as { path: string }[];
	assert.deepEqual(before.map(row => row.path), [later, earlier]);
	const start = Date.now();
	await t.core.call("sessions.markSeen", { sessionFile: earlier });
	const mark = t.core.db.get<{ seen_at: number }>("SELECT seen_at FROM session_seen WHERE session_key=?", normalizeCwd(earlier));
	assert.ok(mark && mark.seen_at >= start);
	assert.deepEqual(await list(), before);
});

it("T100 03 sends active watches as context and calls the model for an expired watch only once", async () => {
	const active = await t.core.call("watch.save", { text: "留意研发进展" }) as Watch;
	const due = await t.core.call("watch.save", { text: "留意候选包", until: clock.at + MINUTE }) as Watch;
	const done = await t.core.call("watch.save", { text: "以前的提醒" }) as Watch;
	await t.core.call("watch.done", { id: done.id });
	assert.equal((await patrol()).status, "quiet");
	assert.equal(t.faux.state.callCount, 0);
	nextManual();
	t.respond(context => {
		const input = JSON.stringify(context.messages);
		assert.match(input, new RegExp(active.id));
		assert.match(input, /留意研发进展/);
		assert.doesNotMatch(input, /以前的提醒/);
		return fauxAssistantMessage(fauxToolCall("patrol_update_log", { status: "handled", note: "查看到期项" }), { stopReason: "toolUse" });
	}, fauxAssistantMessage("完成"));
	const first = await patrol();
	assert.equal(first.status, "handled", first.error ?? undefined);
	assert.deepEqual(first.newFacts.map(fact => fact.key), ["watch_due:" + due.id]);
	t.core.db.run("DELETE FROM patrol_runs WHERE id=?", first.id);
	nextManual();
	assert.equal((await patrol()).status, "quiet");
});

it("T100 04 attributes creation and edit history to patrol and lets normal Butterfly edit its schedules", async () => {
	schedule("morning"); failed("schedule-actor");
	const create = (name: string) => fauxAssistantMessage(fauxToolCall("schedule_create", {
		name, prompt: "收集简报", trigger: "interval", every_minutes: 60,
	}), { stopReason: "toolUse" });
	const edit = () => {
		const row = t.core.db.get<{ id: string; version: number }>("SELECT id,version FROM schedules WHERE name='巡检建的'")!;
		return fauxAssistantMessage(fauxToolCall("schedule_update", { ...row, prompt: "更新简报内容" }), { stopReason: "toolUse" });
	};
	t.respond(create("巡检建的"), edit);
	report("handled", "改了自己的日程");
	const row = await patrol();
	assert.equal(row.status, "handled", row.error ?? undefined);
	const added = t.core.db.get<{ id: string; created_role: string }>("SELECT id,created_role FROM schedules WHERE name='巡检建的'")!;
	assert.equal(added.created_role, "patrol");
	const actors = () => t.core.db.all<{ actor: string }>("SELECT actor FROM schedule_changes WHERE schedule_id=? ORDER BY rowid", added.id).map(row => row.actor);
	assert.deepEqual(actors(), ["patrol", "patrol"]);
	const ordinary = await t.core.openSlot({ cwd: t.core.paths.butterflyDir, sandbox: true, client: t.client });
	t.respond(create("普通蝶君建的"), edit, fauxAssistantMessage("已改"));
	await t.send(ordinary.slotId, { id: "schedule-actor", type: "prompt", message: "改日程" });
	await t.waitFor(() => t.records(ordinary.slotId).some(record => record.type === "agent_settled"));
	assert.deepEqual(actors(), ["patrol", "patrol", "butterfly"]);
	assert.equal(t.core.db.get<{ created_role: string }>("SELECT created_role FROM schedules WHERE name='普通蝶君建的'")?.created_role, "butterfly");
});

it("T100 05 exposes session availability without removing the patrol history or its file reference", async () => {
	schedule("morning"); failed("session-file");
	report("handled", "完成");
	const row = await patrol();
	assert.equal(row.sessionAvailable, true);
	unlinkSync(row.sessionFile!);
	const [missing] = await logs();
	assert.equal(missing?.sessionFile, row.sessionFile);
	assert.equal(missing?.sessionAvailable, false);
});

it("T100 06 projects one sentence and a schedule target and only dismisses on reject", async () => {
	schedule("morning"); failed("finding-card");
	const note = "早间提醒没发出去，请检查通知";
	report("waiting_user", note);
	const row = await patrol();
	const list = async () => (await t.core.call("attention.list", {}) as { now: import("../src/modules/attention.ts").AttentionItem[] }).now;
	const [item] = await list();
	assert.equal(item?.kind, "patrol_finding");
	assert.equal(item.title, note);
	assert.equal(item.reason, "");
	assert.deepEqual(item.target, { page: "schedule", itemId: row.id });
	assert.deepEqual(item.actions, ["open", "reject"]);
	const opened = await t.core.call("attention.resolve", { id: item.id, action: "open" }) as { result: unknown };
	assert.deepEqual(opened.result, { target: item.target });
	assert.equal((await list()).length, 1);
	await t.core.call("attention.resolve", { id: item.id, action: "reject" });
	assert.deepEqual(await list(), []);
});
