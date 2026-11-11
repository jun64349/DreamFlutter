import assert from "node:assert/strict";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
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

it("T97 16 exports and stages the patrol history, deferred notification and watch list", async () => {
	const target = await startTestCore(undefined, { patrolClock: new Clock() });
	try {
		assert.deepEqual(t.core.backupParts.find(part => part.id === "patrol")?.tables, ["patrol_runs", "watch_items", "patrol_reported"]);
		clock.jump(new Date(2026, 10, 11, 23, 5).getTime());
		schedule("morning"); failed("backup");
		report("notified", "等到早上提醒");
		const run = await patrol();
		const item = await t.core.call("watch.save", { text: "留意备份", until: clock.at + DAY }) as Watch;
		const out = join(t.dir, "patrol.dfbackup");
		await createBackup({
			paths: t.core.paths, agentDir: t.agentDir, sessionsDir: t.sessionDir, db: t.core.db.raw, appVersion: "0.8.3",
		}, { out, kind: "manual", credentials: "none", includeMaterials: false });
		const staged = await stageBackup(out, {
			paths: target.core.paths, agentDir: target.agentDir, sessionsDir: target.sessionDir, appVersion: "0.8.3",
		}, { parts: target.core.backupParts });
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
