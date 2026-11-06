import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { normalizeCwd } from "../src/core.ts";
import { SessionIndex } from "../src/modules/session-index.ts";
import { HISTORY_ENTRY, inheritedIds } from "../src/pi/session-metadata.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

function gate() {
	let release!: () => void;
	let enter!: () => void;
	return { wait: new Promise<void>((r) => { release = r; }), ready: new Promise<void>((r) => { enter = r; }), release: () => release(), enter: () => enter() };
}

describe("T-07R regressions", () => {
	let t: TestCore;
	beforeEach(async () => { t = await startTestCore(); });
	afterEach(async () => { mock.restoreAll(); await t.cleanup(); });
	async function open(slotId: string, extra: Record<string, unknown> = {}) {
		await t.core.call("slot.open", { slotId, cwd: t.workspace, ...extra }, t.client);
		return t.core.slot(slotId);
	}
	async function send(slotId: string, message: string) {
		t.respond(fauxAssistantMessage("收到"));
		const before = settledCount(t.records(slotId));
		await t.send(slotId, { id: message, type: "prompt", message });
		await t.waitFor(() => settledCount(t.records(slotId)) > before);
	}
	async function parent() {
		const slot = await open("parent"); await send("parent", "父历史"); return slot;
	}
	async function stats(slotId: string) {
		const id = `stats-${Math.random()}`;
		await t.send(slotId, { id, type: "get_session_stats" });
		const response = await t.waitFor(() => t.records(slotId).find((r) => r.id === id));
		assert.equal(response.success, true);
		return response.data as { cost: number };
	}
	it("R-01 keeps a closing slot's identity/file/control until disposal, then permits safe ID reuse", async () => {
		const old = await parent(); const file = old.info().sessionFile!;
		const paused = gate(); const dispose = old.dispose.bind(old);
		mock.method(old, "dispose", async () => { paused.enter(); await paused.wait; await dispose(); });
		const controls = (t.core as any).hostConfig.harnessControls as Map<string, unknown>;
		const oldControl = controls.get("parent");
		const closing = t.core.closeSlot("parent");
		try {
			await paused.ready;
			assert.ok(t.core.sessionSlots().includes(old)); assert.equal(t.core.findSlotByFile(file), old);
			await assert.rejects(open("parent"), /关闭|closing/);
			await assert.rejects(open("other", { sessionFile: file }), /关闭|closing/);
			assert.equal(controls.get("parent"), oldControl);
			const joined = t.core.closeSlot("parent"); paused.release(); await Promise.all([closing, joined]);
			assert.equal(controls.has("parent"), false);
			const replacement = await open("parent", { sessionFile: file });
			assert.notEqual(replacement, old); assert.ok(controls.has("parent"));
			const nextDispose = mock.method(replacement, "dispose");
			await t.core.closeSlot("parent"); assert.equal(nextDispose.mock.callCount(), 1);
			assert.equal(t.core.slots.has("parent"), false); assert.equal(controls.has("parent"), false);
			assert.equal(t.messages.filter((e) => e.event === "slot.closed" && e.slotId === "parent").length, 2);
		} finally { paused.release(); await closing; }
	});
	it("R-01 parent deletion joins a closing side whose accepted first send still owns a pending file", async () => {
		const p = await parent(); const parentFile = p.info().sessionFile!;
		const side = await open("side", { forkOf: parentFile });
		const original = (side as any).runtime;
		const dispose = original.dispose.bind(original); const paused = gate();
		mock.method(original, "dispose", async () => { paused.enter(); await paused.wait; await dispose(); });
		t.respond(fauxAssistantMessage("首发已经接受"));
		const sending = t.send("side", { id: "first", type: "prompt", message: "保存中的侧边" });
		let closing: Promise<void> | undefined;
		let deleting: Promise<unknown> | undefined;
		try {
			await paused.ready;
			const sideFile = side.info().sessionFile!; assert.ok(existsSync(sideFile));
			assert.ok(t.core.pendingSessionFiles.has(normalizeCwd(sideFile)));
			closing = t.core.closeSlot("side"); let deleted = false;
			deleting = t.core.call("sessions.delete", { path: parentFile }).then((out) => { deleted = true; return out; });
			await t.waitFor(() => t.core.deletingSessionFiles.has(normalizeCwd(parentFile)));
			assert.equal(deleted, false); assert.ok(existsSync(parentFile));
			paused.release(); await sending; await closing;
			const out = await deleting as { sideCount: number; deleted: string[] };
			assert.equal(out.sideCount, 1); assert.deepEqual(new Set(out.deleted), new Set([parentFile, sideFile]));
			assert.equal(existsSync(sideFile), false); assert.equal(existsSync(parentFile), false);
			assert.equal(t.core.pendingSessionFiles.size, 0); assert.equal(t.core.deletingSessionFiles.size, 0);
			assert.equal(t.core.db.get("SELECT path FROM session_meta WHERE path=?", sideFile), undefined);
		} finally { paused.release(); await Promise.allSettled([sending, closing, deleting]); }
	});
	for (const active of [true, false]) it(`R-02 rejects bound schedules for ${active ? "active" : "closed"} side files before creating a task`, async () => {
		const p = await parent(); const side = await open("side", { forkOf: p.info().sessionFile }); await send("side", "侧边问题");
		const file = side.info().sessionFile!;
		assert.throws(() => { side.taskId = "preassigned"; }, /侧边/);
		if (!active) await t.core.closeSlot("side");
		const params = { name: "绑定侧边", prompt: "不得启动", cwd: t.workspace, trigger: { type: "interval", everyMs: 600000 } };
		await assert.rejects(t.core.call("schedules.save", { ...params, sessionMode: "bound", sessionFile: file }), /侧边/);
		await assert.rejects(t.core.openSlot({ cwd: t.workspace, sessionFile: file, taskId: "preassigned" }), /侧边/);
		const schedule = await t.core.call("schedules.save", params) as { id: string };
		// An invalid binding persisted before this fix must be rejected on execution too.
		t.core.db.run("UPDATE schedules SET session_mode='bound', session_file=? WHERE id=?", file, schedule.id);
		const tasks = t.core.db.all("SELECT * FROM tasks"); const runs = t.core.db.all("SELECT * FROM runs");
		await t.core.call("schedules.runNow", { id: schedule.id });
		const failed = await t.waitFor(() => t.core.db.get<{ error: string; task_id: string | null }>("SELECT error,task_id FROM schedule_runs WHERE schedule_id=? AND status='failed'", schedule.id));
		assert.match(failed.error, /侧边/); assert.equal(failed.task_id, null);
		assert.deepEqual(t.core.db.all("SELECT * FROM tasks"), tasks); assert.deepEqual(t.core.db.all("SELECT * FROM runs"), runs);
		assert.equal(t.core.findSlotByFile(file)?.taskId ?? null, null);
	});
	it("R-02 the run recorder ignores even a stale preassigned task on a side", async () => {
		const p = await parent(); const side = await open("side", { forkOf: p.info().sessionFile });
		(side as any).boundTaskId = p.taskId;
		const before = t.core.db.all("SELECT * FROM tasks");
		await send("side", "旧绑定不能影响通用任务");
		assert.equal(t.core.runs.list({ sessionFile: side.info().sessionFile! })[0]?.taskId, null);
		assert.deepEqual(t.core.db.all("SELECT * FROM tasks"), before);
	});

	const time = "2026-11-06T12:00:00.000Z";
	function reply(id: string, parentId: string | null, at: string, cost: number) {
		return { type: "message", id, parentId, timestamp: at, message: { role: "assistant", content: [{ type: "text", text: id }], api: "faux", provider: "faux", model: "faux-1", stopReason: "stop", timestamp: Date.parse(at), usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } } } };
	}
	function fixture(path: string, id: string, entries: unknown[], parentSession?: string) {
		writeFileSync(path, [{ type: "session", version: 3, id, timestamp: time, cwd: t.workspace, ...(parentSession ? { parentSession } : {}) }, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
	}
	it("R-03 legacy orphan fallback includes equal-millisecond usage, but not later or non-usage entries", async () => {
		const path = join(t.sessionDir, "legacy-child.jsonl"), missing = join(t.sessionDir, "missing-parent.jsonl");
		const inherited = reply("inherited", null, time, 1); const own = reply("own", "inherited", "2026-11-06T12:00:00.001Z", 2);
		const noUsage = { type: "message", id: "user", timestamp: time, message: { role: "user", content: "hello" } };
		assert.deepEqual([...inheritedIds([inherited, noUsage, own], "legacy", missing, time, t.core.db)], ["inherited"]);
		fixture(path, "legacy", [inherited, own], missing); const before = readFileSync(path, "utf8");
		await t.core.module(SessionIndex)!.refresh(); assert.equal(readFileSync(path, "utf8"), before);
		assert.equal(t.core.db.get<{ cost: number }>("SELECT SUM(cost) cost FROM usage_records WHERE path=?", path)?.cost, 2);
		await open("legacy", { sessionFile: path }); assert.equal((await stats("legacy")).cost, 2);
		assert.equal(t.core.db.get("SELECT * FROM session_inherited_history WHERE session_id='legacy'"), undefined, "do not cache estimates");
	});
	it("R-03 confirmed inheritance survives parent deletion and restart, preserving a same-millisecond own reply", async () => {
		const parentFile = join(t.sessionDir, "legacy-parent.jsonl"), child = join(t.sessionDir, "legacy-child.jsonl");
		const inherited = reply("inherited", null, time, 1), own = reply("own", "inherited", time, 2);
		fixture(parentFile, "old-parent", [inherited]); fixture(child, "old-child", [inherited, own], parentFile);
		const before = readFileSync(child, "utf8"); const index = t.core.module(SessionIndex)!;
		await index.refresh(); assert.equal(readFileSync(child, "utf8"), before);
		assert.deepEqual(JSON.parse(t.core.db.get<{ entry_ids: string }>("SELECT entry_ids FROM session_inherited_history WHERE session_id='old-child'")!.entry_ids), ["inherited"]);
		await open("legacy", { sessionFile: child }); assert.equal((await stats("legacy")).cost, 2);
		const opened = readFileSync(child, "utf8");
		await t.core.call("sessions.delete", { path: parentFile }); assert.equal(existsSync(parentFile), false);
		assert.equal((await stats("legacy")).cost, 2);
		const st = statSync(child); index.indexFile(child, Math.floor(st.mtimeMs), st.size);
		assert.equal(t.core.db.get<{ cost: number }>("SELECT SUM(cost) cost FROM usage_records WHERE path=?", child)?.cost, 2);
		assert.equal(readFileSync(child, "utf8"), opened);
		await t.core.closeSlot("legacy"); t = await t.reopen();
		await open("again", { sessionFile: child }); assert.equal((await stats("again")).cost, 2);
		const marker = { type: "custom", customType: HISTORY_ENTRY, data: { sessionId: "old-child", lastEntryId: "own" } };
		assert.deepEqual([...inheritedIds([inherited, own, marker], "old-child", parentFile, time, t.core.db)], ["inherited", "own"], "explicit markers win over the cached boundary");
	});
});
