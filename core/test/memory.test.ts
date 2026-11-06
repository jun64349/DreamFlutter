import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { Memory } from "../src/modules/memory.ts";
import type { LogDay, MemoryItem, PendingChange } from "../src/memory/types.ts";
import { dialogs, settledCount, startTestCore, type TestCore } from "./harness.ts";

/** A faux response that records the text the model was sent. */
function capture(into: string[], reply: string): FauxResponseFactory {
	return (context) => {
		into.push(JSON.stringify(context.messages));
		return fauxAssistantMessage(reply);
	};
}

/** The text of the last tool result the model was sent. */
function lastToolResult(context: { messages: unknown[] }): string {
	const results = (context.messages as { role: string; content: unknown }[]).filter((m) => m.role === "toolResult");
	return JSON.stringify(results[results.length - 1]?.content ?? "");
}

describe("memory", () => {
	let t: TestCore;

	beforeEach(async () => {
		t = await startTestCore();
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

	const items = async (params: Record<string, unknown> = {}) => (await t.core.call("memory.items", params)) as (MemoryItem & { workspacePath: string | null })[];
	const log = async () => (await t.core.call("memory.log", {})) as LogDay[];

	it("injects a snapshot of pinned and related memories once per session", async () => {
		await t.core.call("memory.setBlock", { key: "about_me", content: "我叫小明，是一名产品经理。" });
		await t.core.call("memory.save", { content: "写周报时喜欢用三段式：进展、风险、下周计划", kind: "preference" });
		await t.core.call("memory.save", { content: "家里的猫叫团子", kind: "background" });
		await t.core.call("memory.save", { content: "用户称 Agent 为小蝶", kind: "persona", pinned: true });
		const seen: string[] = [];
		t.respond(capture(seen, "好的"), capture(seen, "好的"));
		await prompt("帮我写这周的周报");
		await prompt("再精简一点");

		assert.match(seen[0]!, /记忆快照/);
		assert.match(seen[0]!, /我叫小明/);
		assert.match(seen[0]!, /三段式/);
		assert.match(seen[0]!, /用户给你（Agent）的设定[^#]*小蝶/, "what the user set about the agent is apart from facts about the user");
		assert.equal((seen[1]!.match(/<记忆快照/g) ?? []).length, 1, "the snapshot is not repeated within the task");

		const sessionId = t.core.slot("s1").session.sessionId;
		const snapshots = (await t.core.call("memory.snapshots", { sessionId })) as { memoryIds: string[] }[];
		assert.equal(snapshots.length, 1);
		assert.ok(snapshots[0]!.memoryIds.length >= 2);
		const used = (await items()).filter((m) => m.useCount > 0);
		assert.ok(used.length >= 2, "being shown is only noted as a hint");
		assert.ok(used.every((m) => m.version === 1), "being shown changes no memory (§11.5)");
	});

	it("saves what the agent is told and what it infers at once, the inference marked, without approval prompts", async () => {
		t.core.settings.update({ approvalMode: "all" });
		const results: string[] = [];
		t.respond(
			fauxAssistantMessage([fauxToolCall("memory_save", { content: "用户要求回复用中文", kind: "preference", scope: "global", explicit: true })], { stopReason: "toolUse" }),
			(context) => {
				results.push(lastToolResult(context));
				return fauxAssistantMessage([fauxToolCall("memory_save", { content: "这个项目用 pnpm 装依赖", kind: "experience", explicit: false, reason: "安装时报错后改用 pnpm" })], { stopReason: "toolUse" });
			},
			(context) => {
				results.push(lastToolResult(context));
				return fauxAssistantMessage("记好了");
			},
		);
		await prompt("记住：以后都用中文回复我");
		assert.equal(dialogs(t.records("s1")).length, 0, "memory tools are exempt from approval");
		const saved = await items();
		const told = saved.find((m) => m.content === "用户要求回复用中文")!;
		assert.deepEqual([told.scope, told.level, told.confidence, told.status], ["global", 2, "user_explicit", "active"]);
		const inferred = saved.find((m) => m.content === "这个项目用 pnpm 装依赖")!;
		assert.deepEqual([inferred.scope, inferred.level, inferred.confidence], ["workspace", 1, "agent_inferred"], "not said to be global: stays in the workspace");
		assert.equal(inferred.workspacePath, t.workspace);
		assert.match(results[0]!, /已保存到全局·阶段记忆/, "the receipt says where it went, after the commit");
		assert.match(results[1]!, /本工作区·近期记忆.*推测/);
		const entries = (await log())[0]!.entries;
		assert.deepEqual(entries.map((e) => [e.after.content, e.actor, e.inferred]), [
			["这个项目用 pnpm 装依赖", "main_agent", true],
			["用户要求回复用中文", "main_agent", false],
		]);
		assert.ok(entries.every((e) => e.sessionRef === t.core.slot("s1").info().sessionFile), "the log knows the conversation");
		assert.ok(t.messages.some((m) => m.event === "memory.changed"));
	});

	it("with 「写入前要我确认」 on, inferred memories wait for the user", async () => {
		t.core.settings.update({ memoryConfirmWrites: true });
		const results: string[] = [];
		t.respond(
			fauxAssistantMessage([fauxToolCall("memory_save", { content: "用户可能在写毕业论文", kind: "background", explicit: false })], { stopReason: "toolUse" }),
			(context) => {
				results.push(lastToolResult(context));
				return fauxAssistantMessage("ok");
			},
		);
		await prompt("帮我看看这一章");
		assert.equal((await items()).length, 0);
		assert.match(results[0]!, /等用户确认/, "never 「已记住」 for something waiting");
		const [pending] = (await t.core.call("memory.pending", {})) as PendingChange[];
		assert.equal(pending!.why, "confirm");
		const inbox = (await t.core.call("inbox.list", {})) as { kind: string; id: string }[];
		assert.ok(inbox.some((i) => i.kind === "memory" && i.id === pending!.id), "waiting changes show in the inbox");
		await t.core.call("memory.acceptPending", { id: pending!.id, content: "用户在写毕业论文" });
		assert.deepEqual((await items()).map((m) => m.content), ["用户在写毕业论文"]);
	});

	it("a locked memory only gets a suggestion; the user accepts it", async () => {
		const { item } = (await t.core.call("memory.save", { content: "周报每周五发", kind: "agreement", retention: "locked" })) as { item: MemoryItem };
		const results: string[] = [];
		t.respond(
			fauxAssistantMessage([fauxToolCall("memory_update", { id: `#${item.id}`, content: "周报每周四发", explicit: true })], { stopReason: "toolUse" }),
			(context) => {
				results.push(lastToolResult(context));
				return fauxAssistantMessage("ok");
			},
		);
		await prompt("以后周报改成周四发");
		assert.match(results[0]!, /锁定.*没有生效/);
		const now = (await items())[0]!;
		assert.equal(now.content, "周报每周五发");
		assert.equal(now.status, "review");
		const [pending] = (await t.core.call("memory.pending", {})) as PendingChange[];
		await t.core.call("memory.acceptPending", { id: pending!.id });
		assert.equal((await items())[0]!.content, "周报每周四发");
	});

	it("the user's edits keep versions; forgetting is soft and undoable from the log", async () => {
		const { item } = (await t.core.call("memory.save", { content: "喜欢咖啡" })) as { item: MemoryItem };
		await t.core.call("memory.update", { id: item.id, version: 1, content: "喜欢美式咖啡" });
		await assert.rejects(t.core.call("memory.update", { id: item.id, version: 1, content: "喜欢拿铁" }), /已经有更新/);
		await t.core.call("memory.setStatus", { id: item.id, status: "forgotten" });
		assert.equal((await items()).length, 0);
		const detail = (await t.core.call("memory.item", { id: item.id })) as { versions: { item: MemoryItem }[]; log: { opId: string; kind: string }[] };
		assert.deepEqual(detail.versions.map((v) => v.item.content), ["喜欢美式咖啡", "喜欢美式咖啡", "喜欢咖啡"]);
		const forgot = detail.log[0]!;
		await t.core.call("memory.undo", { opId: forgot.opId });
		assert.deepEqual((await items()).map((m) => m.content), ["喜欢美式咖啡"]);
	});

	it("clearing is one batch, undone in one go", async () => {
		await t.core.call("memory.save", { content: "一" });
		await t.core.call("memory.save", { content: "二" });
		await t.core.call("memory.clear", { scope: "all" });
		assert.equal((await items()).length, 0);
		const clear = (await log())[0]!.entries[0]!;
		assert.equal(clear.batchKind, "clear");
		await t.core.call("memory.undoBatch", { batchId: clear.batchId });
		assert.equal((await items()).length, 2);
	});

	it("keeps workspaces apart: snapshot, memory_search and session_search", async () => {
		const other = join(t.dir, "other");
		mkdirSync(other);
		await t.core.call("slot.open", { slotId: "s2", cwd: other }, t.client);
		await t.core.call("memory.save", { content: "独角兽项目的接口用 GraphQL", kind: "experience", scope: "workspace", cwd: t.workspace });
		const seen: string[] = [];
		const results: string[] = [];
		t.respond(capture(seen, "好"));
		await prompt("独角兽项目的接口怎么写");
		t.respond(
			(context) => {
				seen.push(JSON.stringify(context.messages));
				return fauxAssistantMessage([fauxToolCall("memory_search", { query: "独角兽" })], { stopReason: "toolUse" });
			},
			(context) => {
				results.push(lastToolResult(context));
				return fauxAssistantMessage([fauxToolCall("session_search", { query: "独角兽" })], { stopReason: "toolUse" });
			},
			(context) => {
				results.push(lastToolResult(context));
				return fauxAssistantMessage("不知道");
			},
		);
		await prompt("那个项目的接口怎么写", "s2");
		assert.match(seen[0]!, /GraphQL/, "its own workspace sees it");
		assert.doesNotMatch(seen[1]!, /GraphQL/, "another workspace's snapshot does not");
		assert.match(results[0]!, /没有找到相关记忆/);
		assert.match(results[1]!, /没有找到/, "nor its conversations");
	});

	it("extracts after a run, applied at once and logged as the memory agent's", async () => {
		t.core.settings.update({ memoryAutoExtract: true });
		t.respond(
			fauxAssistantMessage("这是为你规划的东京五日行程……"),
			fauxAssistantMessage([fauxToolCall("memory_propose_ops", { ops: [{ action: "add", kind: "preference", scope: "global", content: "用户旅行偏好慢节奏，不喜欢赶景点", said: true, reason: "用户说不想太累" }] })], { stopReason: "toolUse" }),
			fauxAssistantMessage("记了一条旅行偏好。"),
		);
		await prompt("帮我规划东京五日游，我不喜欢赶景点，想慢慢逛");
		const found = await t.waitFor(() => t.core.db.get<{ id: string }>("SELECT id FROM memory_items WHERE content = '用户旅行偏好慢节奏，不喜欢赶景点'"));
		const item = (await t.core.call("memory.item", { id: found.id })) as { item: MemoryItem; sources: { kind: string; ref: string; excerpt: string }[]; log: { actor: string; batchKind: string }[] };
		assert.deepEqual([item.item.level, item.item.confidence, item.item.status, item.item.scope], [1, "user_reported", "active", "global"]);
		assert.equal(item.sources[0]!.kind, "session");
		assert.equal(item.sources[0]!.ref, t.core.slot("s1").info().sessionFile);
		assert.deepEqual([item.log[0]!.actor, item.log[0]!.batchKind], ["memory_agent", "extract"]);
	});

	it("extraction does not repeat a memory in other words and sees every memory (v0.3.2 test)", async () => {
		t.core.settings.update({ memoryAutoExtract: true });
		const { item: old } = (await t.core.call("memory.save", { content: "回复要简练，少说话", kind: "preference" })) as { item: MemoryItem };
		const seen: string[] = [];
		t.respond(
			fauxAssistantMessage("好的。"),
			(context) => {
				seen.push(JSON.stringify(context));
				return fauxAssistantMessage(
					[
						fauxToolCall("memory_propose_ops", {
							ops: [
								{ action: "add", kind: "preference", content: "回复要简练，少说话。", reason: "用户说" },
								{ action: "add", kind: "preference", content: "回复要简练，别长篇大论；正常问答不要用卡片", reason: "用户说" },
								{ action: "add", kind: "preference", content: "回复要简练，别长篇大论", reason: "用户说" },
							],
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("好"),
		);
		await prompt("以后回复简练一点，别长篇大论，普通问答也不要做卡片");
		await t.waitFor(() => t.core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_ops WHERE kind = 'edit'")!.n === 1);
		// The first repeats the memory; the second says more, so it updates it; the third repeats the second.
		assert.deepEqual((await items()).map((m) => [m.id, m.content]), [[old.id, "回复要简练，别长篇大论；正常问答不要用卡片"]]);
		assert.match(seen[0]!, /回复要简练，少说话/, "the extractor is shown the memories even when the words differ");
		assert.match(seen[0]!, /不是用户的信息/);
		assert.match(seen[0]!, /没有解决的失败/, "the list of what not to remember (17.2)");
	});

	it("temporary chats neither read nor write memory", async () => {
		await t.core.call("memory.setBlock", { key: "about_me", content: "秘密背景" });
		await t.core.call("slot.open", { slotId: "tmp", cwd: t.workspace, incognito: true }, t.client);
		const seen: string[] = [];
		t.respond(
			(context) => {
				seen.push(JSON.stringify(context.messages));
				return fauxAssistantMessage([fauxToolCall("memory_save", { content: "不该保存", explicit: true })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("ok"),
		);
		await prompt("你好", "tmp");
		assert.doesNotMatch(seen[0]!, /秘密背景/);
		assert.deepEqual((await items()).map((m) => m.content), ["秘密背景"]);
	});

	it("moves v0.2's memory over once, marked for review, without making up sources (§11)", async () => {
		const at = Date.now() - 30 * 86_400_000;
		const insert = (id: string, fields: Record<string, unknown>) => {
			const row = { scope: "global", cwd: null, kind: "preference", source: "user", source_session: null, status: "active", action: null, target_id: null, replaced_by: null, reason: null, created_at: at, updated_at: at, ...fields, id };
			t.core.db.run(
				"INSERT INTO memories(id, scope, cwd, kind, content, source, source_session, status, action, target_id, replaced_by, reason, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				...(["id", "scope", "cwd", "kind", "content", "source", "source_session", "status", "action", "target_id", "replaced_by", "reason", "created_at", "updated_at"].map((k) => (row as Record<string, unknown>)[k]) as never[]),
			);
		};
		insert("m_old1", { content: "使用 Node 18", status: "superseded", replaced_by: "m_new1" });
		insert("m_new1", { content: "使用 Node 22", source: "agent", source_session: join(t.sessionDir, "a.jsonl"), scope: "workspace", cwd: t.workspace, kind: "experience" });
		insert("m_bf", { content: "蝶君的沙箱里装了 R", scope: "workspace", cwd: t.core.paths.butterflyDir, kind: "experience" });
		insert("m_cand", { content: "用户喜欢深色主题", status: "candidate", action: "add", source: "agent", reason: "用户说" });
		insert("m_upd", { content: "使用 Node 24", status: "candidate", action: "update", target_id: "m_new1", source: "agent" });
		insert("m_rej", { content: "不要的", status: "rejected" });
		insert("m_del", { content: "删掉的", status: "deleted" });
		t.core.db.run("INSERT INTO memory_blocks(key, content, locked, updated_at) VALUES('agreements', '- 周报每周五发\n- 会议纪要当天发', 1, ?)", at);
		t.core.db.run("INSERT INTO memory_blocks(key, content, locked, updated_at) VALUES('about_me', '我是产品经理', 0, ?)", at);
		// As if this database came from v0.4.
		t.core.db.run("DELETE FROM memory_items");
		t.core.db.run("DELETE FROM app_flags");
		t = await t.reopen();

		const report = (await t.core.call("memory.migrationReport", {})) as { items: number; superseded: number; pending: number; blockLines: number; skipped: { id: string; reason: string }[] };
		assert.deepEqual([report.items, report.superseded, report.pending, report.blockLines], [2, 1, 2, 3]);
		assert.deepEqual(report.skipped.map((s) => s.id).sort(), ["m_del", "m_rej"]);
		const node = (await t.core.call("memory.item", { id: "m_new1" })) as { item: MemoryItem & { workspacePath: string }; sources: { kind: string; ref: string }[]; links: { from: string; to: string; kind: string }[] };
		assert.deepEqual([node.item.level, node.item.status, node.item.confidence, node.item.scope, node.item.workspacePath], [2, "review", "user_confirmed", "workspace", t.workspace], "level 2 to review, never level 3 for being old");
		assert.deepEqual(node.sources.map((s) => [s.kind, s.ref]), [["session", join(t.sessionDir, "a.jsonl")]]);
		assert.deepEqual(node.links.map((l) => [l.from, l.to, l.kind]), [["m_new1", "m_old1", "supersedes"]]);
		assert.equal(((await t.core.call("memory.item", { id: "m_old1" })) as { item: MemoryItem }).item.status, "superseded");
		const butterfly = ((await t.core.call("memory.item", { id: "m_bf" })) as { item: MemoryItem; sources: { kind: string }[] });
		assert.equal(butterfly.item.scope, "butterfly", "蝶君's memories go to its own partition");
		assert.deepEqual(butterfly.sources.map((s) => s.kind), ["migration"], "no session known: no source made up");
		const pinned = await items({ pinned: true });
		assert.deepEqual(pinned.map((m) => [m.content, m.retention]).sort(), [["会议纪要当天发", "locked"], ["周报每周五发", "locked"], ["我是产品经理", "normal"]]);
		const pending = (await t.core.call("memory.pending", {})) as PendingChange[];
		assert.deepEqual(pending.map((p) => p.op.kind).sort(), ["add", "edit"]);
		const migrated = (await log())[0]!.entries.filter((e) => e.batchKind === "migration");
		assert.equal(migrated.length, 6);

		// Once only: running it again (a crash before the flag was written) adds nothing twice.
		t.core.db.run("DELETE FROM app_flags");
		t = await t.reopen();
		assert.equal(t.core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_items")!.n, 6);
		assert.equal(t.core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_pending")!.n, 2);
		// The whole migration can be undone from the log.
		await t.core.call("memory.undoBatch", { batchId: migrated[0]!.batchId });
		assert.equal((await items()).length, 0);
	});

	it("v0.2's memory page methods still work on the new store", async () => {
		const m = (await t.core.call("memory.add", { content: "使用 Node 18", kind: "experience", scope: "workspace", cwd: t.workspace })) as Memory;
		assert.equal(m.cwd, t.workspace);
		const edited = (await t.core.call("memory.edit", { id: m.id, content: "使用 Node 22" })) as Memory;
		assert.equal(edited.id, m.id, "an edit is a new version of the same memory");
		const history = (await t.core.call("memory.history", { id: m.id })) as Memory[];
		assert.deepEqual(history.map((h) => h.content), ["使用 Node 22", "使用 Node 18"]);
		await t.core.call("memory.setBlock", { key: "agreements", content: "- 周报每周五发\n- 会议纪要当天发", locked: true });
		const blocks = (await t.core.call("memory.blocks", {})) as { key: string; content: string; locked: boolean }[];
		const agreements = blocks.find((b) => b.key === "agreements")!;
		assert.deepEqual([agreements.content, agreements.locked], ["周报每周五发\n会议纪要当天发", true]);
		assert.deepEqual(((await t.core.call("memory.list", {})) as Memory[]).map((x) => x.content), ["使用 Node 22"], "block lines show in the blocks, not the list");
		await t.core.call("memory.remove", { id: m.id });
		assert.equal(((await t.core.call("memory.list", {})) as Memory[]).length, 0);
	});
});
