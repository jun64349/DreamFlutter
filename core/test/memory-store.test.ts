import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Db } from "../src/db.ts";
import { allowedScopes, visibleIn, Workspaces } from "../src/memory/scopes.ts";
import { localDay, MemoryStore } from "../src/memory/store.ts";
import type { NewItem } from "../src/memory/types.ts";

const DAY = 86_400_000;

describe("memory store (0.5 step 1: the gate, versions, the memory log)", () => {
	let dir: string;
	let db: Db;
	let time: number;
	let confirm: boolean;
	let store: MemoryStore;
	let workspaces: Workspaces;
	const clock = () => time;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "df-mem-"));
		db = new Db(join(dir, "core.db"));
		time = new Date(2026, 10, 2, 10, 0).getTime();
		confirm = false;
		store = new MemoryStore(db, { clock, confirmWrites: () => confirm });
		workspaces = new Workspaces(db, clock);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const item = (content: string, extra: Partial<NewItem> = {}): NewItem => ({ content, kind: "preference", level: 2, scope: "global", confidence: "user_explicit", ...extra });
	const add = (content: string, extra: Partial<NewItem> = {}, actor: "user" | "main_agent" | "memory_agent" = "user") => {
		const result = store.commit({ actor, ops: [{ kind: "add", item: item(content, extra) }] });
		assert.equal(result.applied.length, 1, JSON.stringify(result));
		return store.get(result.applied[0]!.itemId)!;
	};

	it("keeps every version and logs who changed what, by day", () => {
		const m = add("喜欢咖啡");
		time += DAY;
		store.commit({ actor: "main_agent", explicit: true, ops: [{ kind: "edit", id: m.id, baseVersion: 1, patch: { content: "喜欢美式咖啡" } }], reason: "用户说得更具体" });
		const after = store.get(m.id)!;
		assert.equal(after.version, 2);
		assert.deepEqual(store.versions(m.id).map((v) => v.item.content), ["喜欢美式咖啡", "喜欢咖啡"]);
		const days = store.log();
		assert.deepEqual(days.map((d) => d.day), [localDay(time), localDay(time - DAY)], "newest day first");
		const edit = days[0]!.entries[0]!;
		assert.equal(edit.actor, "main_agent");
		assert.equal(edit.before!.content, "喜欢咖啡");
		assert.equal(edit.after.content, "喜欢美式咖啡");
		assert.deepEqual(edit.changed, ["content"]);
		assert.equal(edit.reason, "用户说得更具体");
		assert.equal(days[1]!.entries[0]!.before, null, "an add has nothing before");
	});

	it("marks changes resting on the agent's inference", () => {
		add("用户可能在准备毕业论文", { confidence: "agent_inferred", level: 1 }, "main_agent");
		const [entry] = store.log()[0]!.entries;
		assert.equal(entry!.inferred, true);
	});

	it("refuses a change made against an old version (no last-write-wins)", () => {
		const m = add("使用 Node 18");
		store.commit({ actor: "user", ops: [{ kind: "edit", id: m.id, patch: { content: "使用 Node 20" } }] });
		const stale = store.commit({ actor: "memory_agent", ops: [{ kind: "edit", id: m.id, baseVersion: 1, patch: { content: "使用 Node 19" } }] });
		assert.equal(stale.applied.length, 0);
		assert.match(stale.rejected[0]!.reason, /已经有更新/);
		assert.equal(store.get(m.id)!.content, "使用 Node 20");
		const noVersion = store.commit({ actor: "memory_agent", ops: [{ kind: "edit", id: m.id, patch: { content: "使用 Node 22" } }] });
		assert.match(noVersion.rejected[0]!.reason, /版本/, "the memory agent always says which version it read");
	});

	it("applies a batch in one transaction: a failure while writing leaves nothing behind", () => {
		const m = add("原来的");
		db.raw.exec("CREATE TRIGGER boom BEFORE INSERT ON memory_items WHEN NEW.content = '炸' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
		assert.throws(() =>
			store.commit({
				actor: "user",
				ops: [
					{ kind: "edit", id: m.id, patch: { content: "改过的" } },
					{ kind: "add", item: item("炸") },
				],
			}),
		);
		assert.equal(store.get(m.id)!.content, "原来的");
		assert.equal(store.get(m.id)!.version, 1);
		assert.equal(db.all("SELECT * FROM memory_ops").length, 1, "only the first add was logged");
		assert.equal(db.all("SELECT * FROM memory_batches").length, 1);
	});

	it("rejects the bad ops of a batch and applies the rest", () => {
		const result = store.commit({
			actor: "user",
			ops: [{ kind: "add", item: item("好的") }, { kind: "add", item: item("  ") }, { kind: "status", id: "m_nothing", status: "forgotten" }],
		});
		assert.equal(result.applied.length, 1);
		assert.deepEqual(result.rejected.map((r) => r.index), [1, 2]);
	});

	it("only the user changes a locked memory: the agents get a pending suggestion and a review mark", () => {
		const m = add("周报每周五发", { retention: "locked" });
		const result = store.commit({ actor: "main_agent", explicit: true, ops: [{ kind: "edit", id: m.id, baseVersion: 1, patch: { content: "周报每周四发" } }] });
		assert.equal(result.pending[0]!.why, "locked");
		const now = store.get(m.id)!;
		assert.equal(now.content, "周报每周五发");
		assert.equal(now.status, "review", "marked for review");
		assert.equal(store.commit({ actor: "memory_agent", ops: [{ kind: "status", id: m.id, baseVersion: now.version, status: "forgotten" }] }).pending[0]!.why, "locked");
		assert.equal(store.commit({ actor: "main_agent", ops: [{ kind: "edit", id: m.id, patch: { retention: "normal" } }] }).pending.length, 1, "unlocking is the user's too");
		assert.match(store.commit({ actor: "memory_agent", ops: [{ kind: "add", item: item("别的", { retention: "locked" }) }] }).rejected[0]!.reason, /锁定/);

		const pending = store.pending();
		const edit = pending.find((p) => p.op.kind === "edit" && p.op.patch.content === "周报每周四发")!;
		store.acceptPending(edit.id);
		const accepted = store.get(m.id)!;
		assert.equal(accepted.content, "周报每周四发");
		assert.equal(accepted.status, "active", "the user agreed: no longer waiting for review");
		assert.equal(accepted.retention, "locked");
		assert.equal(store.commit({ actor: "user", ops: [{ kind: "edit", id: m.id, patch: { content: "周报每周三发" } }] }).applied.length, 1, "the user changes it directly");
	});

	it("a workspace memory becomes global only by the user", () => {
		const ws = workspaces.ensure(join(dir, "proj"));
		const m = add("这个项目用 pnpm", { scope: "workspace", workspaceId: ws.id, kind: "experience" });
		const set = allowedScopes(workspaces, join(dir, "proj"), join(dir, "butterfly"));
		const result = store.commit({ actor: "memory_agent", allowed: set, ops: [{ kind: "edit", id: m.id, baseVersion: 1, patch: { scope: "global" } }] });
		assert.equal(result.pending[0]!.why, "promote_global");
		assert.equal(store.get(m.id)!.scope, "workspace");
		store.commit({ actor: "user", ops: [{ kind: "edit", id: m.id, patch: { scope: "global" } }] });
		assert.equal(store.get(m.id)!.scope, "global");
		assert.equal(store.get(m.id)!.workspaceId, null);
	});

	it("keeps sessions inside their scope (workspaces, 蝶君)", () => {
		const home = join(dir, "butterfly");
		const a = allowedScopes(workspaces, join(dir, "a"), home);
		const b = allowedScopes(workspaces, join(dir, "b"), home);
		const bf = allowedScopes(workspaces, home, home);
		assert.equal(bf.butterfly, true);
		assert.notEqual(a.workspaceId, b.workspaceId);
		assert.equal(allowedScopes(workspaces, join(dir, "A"), home).workspaceId, a.workspaceId, "the same folder, whatever the case");
		const inA = add("A 的事", { scope: "workspace", workspaceId: a.workspaceId });
		const inBf = add("蝶君的事", { scope: "butterfly" });
		const global = add("全局的事");
		assert.deepEqual(store.list({ set: b }).map((m) => m.id), [global.id]);
		assert.deepEqual(new Set(store.list({ set: a }).map((m) => m.id)), new Set([inA.id, global.id]));
		assert.deepEqual(new Set(store.list({ set: bf }).map((m) => m.id)), new Set([inBf.id, global.id]), "蝶君 never reads a workspace's memories");
		// Writing outside the session's scope is refused.
		assert.match(store.commit({ actor: "main_agent", allowed: b, ops: [{ kind: "add", item: item("写到 A", { scope: "workspace", workspaceId: a.workspaceId }) }] }).rejected[0]!.reason, /范围/);
		assert.match(store.commit({ actor: "main_agent", allowed: b, ops: [{ kind: "edit", id: inA.id, patch: { content: "改 A 的" } }] }).rejected[0]!.reason, /范围/);
		assert.match(store.commit({ actor: "main_agent", allowed: a, ops: [{ kind: "add", item: item("写到蝶君", { scope: "butterfly" }) }] }).rejected[0]!.reason, /范围/);
		// A workspace can hide the user's personal background kept globally.
		const bg = add("用户是产品经理", { kind: "background" });
		workspaces.setGlobalBackground(a.workspaceId!, false);
		const quiet = allowedScopes(workspaces, join(dir, "a"), home);
		assert.equal(visibleIn(bg, quiet), false);
		assert.equal(visibleIn(global, quiet), true);
	});

	it("「写入前要我确认」 sends what the agents change to the user first, as §4's table says", () => {
		confirm = true;
		const inferred = store.commit({ actor: "main_agent", ops: [{ kind: "add", item: item("推测的偏好", { confidence: "agent_inferred", level: 1 }) }] });
		assert.equal(inferred.pending[0]!.why, "confirm");
		const asked = store.commit({ actor: "main_agent", explicit: true, ops: [{ kind: "add", item: item("用户让记住的") }] });
		assert.equal(asked.applied.length, 1, "what the user asked for still takes effect");
		const progress = store.commit({ actor: "memory_agent", ops: [{ kind: "add", item: item("完成了第一章", { kind: "progress", level: 1, confidence: "agent_inferred" }) }] });
		assert.equal(progress.applied.length, 1, "level-1 progress is recorded directly");
		const m = store.get(asked.applied[0]!.itemId)!;
		assert.equal(store.commit({ actor: "memory_agent", ops: [{ kind: "status", id: m.id, baseVersion: m.version, status: "review" }] }).applied.length, 1);
		assert.equal(store.commit({ actor: "memory_agent", ops: [{ kind: "edit", id: m.id, baseVersion: m.version + 1, patch: { level: 3 } }] }).pending.length, 1);
		assert.equal(store.commit({ actor: "user", ops: [{ kind: "add", item: item("用户自己加的") }] }).applied.length, 1);
	});

	it("a suggestion accepted after the memory changed is refused, to be looked at again", () => {
		confirm = true;
		const m = add("用中文回复");
		const result = store.commit({ actor: "memory_agent", ops: [{ kind: "edit", id: m.id, baseVersion: 1, patch: { content: "用简体中文回复" } }] });
		store.commit({ actor: "user", ops: [{ kind: "edit", id: m.id, patch: { content: "用简体中文、简短回复" } }] });
		assert.throws(() => store.acceptPending(result.pending[0]!.pendingId), /重新看/);
		assert.equal(store.get(m.id)!.content, "用简体中文、简短回复");
		assert.equal(store.getPending(result.pending[0]!.pendingId)!.status, "stale");
	});

	it("undoes one change, and leaves alone what changed since", () => {
		const m = add("喜欢咖啡");
		const forgot = store.commit({ actor: "user", ops: [{ kind: "status", id: m.id, status: "forgotten" }] });
		const undone = store.undo(forgot.applied[0]!.opId);
		assert.deepEqual(undone.conflicts, []);
		assert.equal(store.get(m.id)!.status, "active");
		assert.equal(store.get(m.id)!.version, 3, "the undo is a version of its own");
		const log = store.log()[0]!.entries;
		assert.equal(log[0]!.kind, "undo");
		assert.equal(log[1]!.undone, true);
		assert.equal(log[1]!.undoable, false);
		assert.equal(store.undo(forgot.applied[0]!.opId).conflicts[0]!.reason, "已经撤销过了");

		const edit = store.commit({ actor: "main_agent", explicit: true, ops: [{ kind: "edit", id: m.id, patch: { content: "喜欢茶" } }] });
		store.commit({ actor: "user", ops: [{ kind: "edit", id: m.id, patch: { content: "喜欢绿茶" } }] });
		assert.match(store.undo(edit.applied[0]!.opId).conflicts[0]!.reason, /之后又改过/);
		assert.equal(store.get(m.id)!.content, "喜欢绿茶");

		const added = store.commit({ actor: "main_agent", ops: [{ kind: "add", item: item("说错了的") }] });
		store.undo(added.applied[0]!.opId);
		assert.equal(store.get(added.applied[0]!.itemId)!.status, "withdrawn", "an undone add leaves the snapshot, kept as a record");
	});

	it("undoes a whole batch, listing the items the user changed since", () => {
		const a = add("一");
		const b = add("二");
		const c = add("三");
		const clear = store.commit({ actor: "user", batchKind: "clear", ops: [a, b, c].map((m) => ({ kind: "status" as const, id: m.id, status: "forgotten" as const })) });
		store.commit({ actor: "user", ops: [{ kind: "status", id: b.id, status: "active" }] });
		const result = store.undoBatch(clear.batchId!);
		assert.equal(result.undone.length, 2);
		assert.equal(result.conflicts.length, 1);
		assert.equal(result.conflicts[0]!.itemId, b.id);
		assert.deepEqual([a, b, c].map((m) => store.get(m.id)!.status), ["active", "active", "active"]);
		assert.equal(db.get<{ undone_at: number | null }>("SELECT undone_at FROM memory_batches WHERE id = ?", clear.batchId!)!.undone_at, null, "not fully undone");
	});

	it("a workspace keeps its memories when its folder moves", () => {
		const ws = workspaces.ensure(join(dir, "old"));
		const m = add("项目约定", { scope: "workspace", workspaceId: ws.id });
		workspaces.move(ws.id, join(dir, "new"));
		const set = allowedScopes(workspaces, join(dir, "new"), join(dir, "butterfly"));
		assert.equal(set.workspaceId, ws.id);
		assert.deepEqual(store.list({ set }).map((x) => x.id), [m.id]);
	});

	it("sources stay when their session is deleted, and say so", () => {
		const r = store.commit({ actor: "main_agent", ops: [{ kind: "add", item: item("来自对话"), sources: [{ kind: "session", ref: "s.jsonl", excerpt: "用户说" }] }] });
		store.markSessionDeleted("s.jsonl");
		store.markSessionDeleted("s.jsonl");
		assert.deepEqual(store.sources(r.applied[0]!.itemId).map((s) => s.excerpt), ["用户说（会话已删除）"]);
		assert.equal(store.get(r.applied[0]!.itemId)!.status, "active");
	});
});
