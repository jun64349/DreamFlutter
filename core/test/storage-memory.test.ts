import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Db } from "../src/db.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { MemoryJobs, PRIORITY } from "../src/memory/jobs.ts";
import { compactMemoryHistory, MemorySpaceGuard, memoryUsage, LOW_SPACE_MESSAGE } from "../src/storage/memory-maintenance.ts";
import { startTestCore, settledCount } from "./harness.ts";
import { runMemoryAgent } from "../src/memory/agent.ts";

describe("G-07 storage maintenance (temporary directories only)", () => {
	let dir: string; let db: Db;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "df-storage-")); db = new Db(join(dir, "core.db")); });
	afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

	it("backs up WAL data before pruning only old middle versions, keeping both old endpoints and recent versions", () => {
		const at = new Date(2026, 10, 7).getTime();
		const old = new Date(2024, 1, 1).getTime();
		for (let v = 1; v <= 6; v++) db.run("INSERT INTO memory_versions VALUES(?,?,?,?,?)", "a", v, JSON.stringify({ content: `版本${v}` }), null, v <= 4 ? old + v : at);
		for (let v = 1; v <= 2; v++) db.run("INSERT INTO memory_versions VALUES(?,?,?,?,?)", "b", v, "{}", null, old);
		const result = compactMemoryHistory(db, join(dir, "backups"), at);
		assert.equal(result.deleted, 2);
		assert.deepEqual(db.all<{ version: number }>("SELECT version FROM memory_versions WHERE item_id='a' ORDER BY version").map((r) => r.version), [1, 4, 5, 6]);
		const backup = new Db(result.backup);
		try { assert.equal(backup.get<{ n: number }>("SELECT count(*) n FROM memory_versions")!.n, 8); } finally { backup.close(); }
		assert.ok(memoryUsage(db).logicalBytes > 0);
		assert.equal(memoryUsage(db).versions, 6);
		assert.equal(compactMemoryHistory(db, join(dir, "backups"), at).deleted, 0);
	});

	it("backup failure leaves all versions untouched", () => {
		for (let v = 1; v <= 5; v++) db.run("INSERT INTO memory_versions VALUES(?,?,?,?,?)", "a", v, "{}", null, 0);
		writeFileSync(join(dir, "not-a-directory"), "keep");
		assert.throws(() => compactMemoryHistory(db, join(dir, "not-a-directory")));
		assert.equal(db.get<{ n: number }>("SELECT count(*) n FROM memory_versions")!.n, 5);
	});

	it("low space rejects saves without creating batches or pending items, and recovers automatically", () => {
		let free = 99;
		const guard = new MemorySpaceGuard(dir, () => 100, () => free);
		const store = new MemoryStore(db); store.writeBlocked = () => guard.status().reason;
		const save = () => store.commit({ actor: "user", ops: [{ kind: "add", item: { content: "测试记忆", kind: "preference", level: 2, scope: "global", confidence: "user_explicit" } }] });
		assert.equal(save().rejected[0]!.reason, LOW_SPACE_MESSAGE);
		assert.equal(store.list().length, 0);
		assert.equal(db.get<{ n: number }>("SELECT count(*) n FROM memory_batches")!.n, 0);
		free = 100; const applied = save(); assert.equal(applied.applied.length, 1);
		free = 99;
		assert.throws(() => store.undo(applied.applied[0]!.opId), /空间/);
		assert.throws(() => store.undoBatch(applied.batchId!), /空间/);
		assert.equal(store.get(applied.applied[0]!.itemId)!.version, 1);
		assert.equal(new MemorySpaceGuard(dir, () => 100, () => { throw new Error("offline"); }).status().paused, true);
	});

	it("leaves urgent and ordinary queued jobs unchanged until space recovers", async () => {
		let blocked = true; let ran = 0;
		const jobs = new MemoryJobs(db, Date.now, { run: async () => { ran++; return { status: "done" }; }, paused: () => false, blocked: () => blocked, budgetLeft: () => 1, nextBudgetAt: Date.now });
		const job = jobs.enqueue({ kind: "extract", scopeKey: "global", priority: PRIORITY.extract });
		await jobs.drain(); assert.equal(ran, 0); assert.equal(jobs.get(job.id)!.attempts, 0);
		blocked = false; await jobs.drain(); assert.equal(ran, 1); await jobs.stop();
	});
});

it("space dropping during a model call prevents late memory writes while retaining billable usage", async () => {
	let blocked = false; let writes = 0;
	const runtime = { completeSimple: async () => {
		blocked = true;
		return { role: "assistant", content: [{ type: "toolCall", id: "x", name: "memory_propose_ops", arguments: {} }], stopReason: "toolUse",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } } };
	} };
	const result = await runMemoryAgent({ runtime: runtime as never, model: { provider: "p", id: "m" } as never, system: "s", input: "i",
		handlers: { query: () => "", propose: () => { writes++; return ""; } }, pauseReason: () => blocked ? LOW_SPACE_MESSAGE : null });
	assert.equal(writes, 0); assert.equal(result.turns, 1); assert.equal(result.usage.cost, 0.002); assert.equal(result.error, LOW_SPACE_MESSAGE);
});

it("storage RPC backup, guard and normal conversation work through the assembled backend", async () => {
	const t = await startTestCore();
	try {
		const overview = await t.core.call("storage.memory", {}) as { path: string; space: { minimumBytes: number } };
		assert.ok(overview.path.startsWith(t.dir));
		assert.equal(overview.space.minimumBytes, 1024 ** 3);
		const result = await t.core.call("storage.compactMemory", {}) as { backup: string; deleted: number };
		assert.equal(result.deleted, 0); assert.ok(existsSync(result.backup));
		await t.core.call("settings.update", { memoryMinFreeBytes: Number.MAX_SAFE_INTEGER, memoryAutoExtract: true });
		await assert.rejects(t.core.call("memory.save", { content: "不能假装保存" }), /空间/);
		await t.core.call("slot.open", { slotId: "s", cwd: t.workspace }, t.client);
		await t.send("s", { type: "prompt", message: "普通对话" });
		await t.waitFor(() => settledCount(t.records("s")) === 1);
		assert.equal((await t.core.call("memory.jobs", {}) as unknown[]).length, 0);
		await assert.rejects(t.core.call("storage.compactMemory", {}), /空间/);
		await t.core.call("settings.update", { memoryMinFreeBytes: 0 });
		await t.core.call("memory.save", { content: "恢复后能写入" });
		assert.equal((await t.core.call("memory.items", {}) as unknown[]).length, 1);
	} finally { await t.cleanup(); }
});
