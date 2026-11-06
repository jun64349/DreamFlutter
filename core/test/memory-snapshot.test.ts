import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { MEMORY_SUMMARY_NOTE } from "../src/agent/harness.ts";
import { lineCost, memoryBudget, planSnapshot } from "../src/memory/snapshot.ts";
import type { MemoryItem } from "../src/memory/types.ts";
import { MemoryModule, type SnapshotRow } from "../src/modules/memory.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

function item(id: string, content: string, extra: Partial<MemoryItem> = {}): MemoryItem {
	return {
		id,
		version: 1,
		level: 1,
		kind: "background",
		content,
		conditions: null,
		scope: "global",
		workspaceId: null,
		groupId: null,
		confidence: "user_explicit",
		status: "active",
		pinned: false,
		retention: "normal",
		autoOk: true,
		occurredAt: null,
		validFrom: null,
		validUntil: null,
		lastVerifiedAt: null,
		nextReviewAt: null,
		lastUsedAt: null,
		useCount: 0,
		createdAt: 0,
		updatedAt: 0,
		createdBy: "user",
		...extra,
	};
}

describe("snapshot plan (§6.1–6.2)", () => {
	it("takes the smallest of the user's cap, 3% of the window and 15% of the room left", () => {
		assert.equal(memoryBudget({ cap: 2000, contextWindow: 200_000, maxOutput: 8_192, nonMemory: 0 }), 2000);
		assert.equal(memoryBudget({ cap: 2000, contextWindow: 32_000, maxOutput: 4_096, nonMemory: 0 }), 960);
		assert.equal(memoryBudget({ cap: 2000, contextWindow: 200_000, maxOutput: 8_192, nonMemory: 180_000 }), 571);
		assert.equal(memoryBudget({ cap: 2000, contextWindow: 32_000, maxOutput: 8_192, nonMemory: 30_000 }), 0);
	});

	it("shares the related part by level, softly: what one level leaves the others use", () => {
		const items = Array.from({ length: 40 }, (_, i) => item(`a${i}`, `周报的写法第 ${i} 条：先写进展`, { level: 1 }));
		const plan = planSnapshot(items, "帮我写周报", 1000);
		const related = plan.related.reduce((sum, m) => sum + lineCost(m), 0);
		assert.ok(related > 1000 * 0.7 * 0.4, "level 1 took more than its 40% when levels 2 and 3 had nothing");
		assert.ok(plan.tokens <= 1000 - Math.floor(1000 * 0.15), "the search share stays free");
		assert.ok(plan.leftOut.every((l) => l.reason === "budget"));
		const mixed = [...items, item("b1", "周报的写法：二级的那条", { level: 2 }), item("c1", "周报的写法：三级的那条", { level: 3 })];
		const plan2 = planSnapshot(mixed, "帮我写周报", 1000);
		assert.ok(plan2.related.some((m) => m.id === "b1") && plan2.related.some((m) => m.id === "c1"), "each level keeps its share");
	});

	it("keeps every pinned item and flags pinned over their share instead of cutting", () => {
		const pinned = Array.from({ length: 10 }, (_, i) => item(`p${i}`, `常驻的约定第 ${i} 条，写得比较长一些，免得太短`, { pinned: true }));
		const plan = planSnapshot(pinned, "随便", 600);
		assert.equal(plan.pinned.length, 10);
		assert.equal(plan.pinnedOver, true);
	});

	it("leaves out what has nothing to do with the task, but not general preferences; 「待复核」 last", () => {
		const plan = planSnapshot(
			[item("cat", "家里的猫叫团子"), item("pref", "回复要简洁", { kind: "preference" }), item("r", "周报每周五发（待核对）", { status: "review" }), item("a", "周报用三段式")],
			"帮我写周报",
			2000,
		);
		assert.deepEqual(plan.leftOut, [{ id: "cat", reason: "irrelevant" }]);
		assert.deepEqual(plan.related.map((m) => m.id).at(-1), "r");
		assert.ok(plan.related.some((m) => m.id === "pref"));
	});
});

describe("snapshot in the session (§6.3)", () => {
	let t: TestCore;
	let memory: MemoryModule;

	beforeEach(async () => {
		t = await startTestCore();
		memory = t.core.module(MemoryModule)!;
		await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
	});

	afterEach(async () => {
		await t.cleanup();
	});

	async function prompt(text: string): Promise<void> {
		const before = settledCount(t.records("s1"));
		await t.send("s1", { id: `p-${Math.random()}`, type: "prompt", message: text });
		await t.waitFor(() => settledCount(t.records("s1")) === before + 1);
	}
	/** Snapshots in what the model was sent (custom messages reach it as user messages). */
	const snapshotsSent = (messages: unknown[]) => (messages as { content: unknown }[]).filter((m) => JSON.stringify(m.content).includes("<记忆快照"));
	const sessionId = () => t.core.slot("s1").session.sessionId;
	const save = async (content: string, extra: Record<string, unknown> = {}) => ((await t.core.call("memory.save", { content, kind: "preference", ...extra })) as { item: MemoryItem }).item;

	it("sends only the newest snapshot after a refresh", async () => {
		await save("回复要简洁");
		const seen: unknown[][] = [];
		t.respond((c) => (seen.push(c.messages), fauxAssistantMessage("一")), (c) => (seen.push(c.messages), fauxAssistantMessage("二")));
		await prompt("你好");
		await save("回复里不用表情");
		await t.core.call("memory.refresh", { sessionId: sessionId() });
		await prompt("再来");
		const sent = snapshotsSent(seen[1]!);
		assert.equal(sent.length, 1, "the older snapshot is not sent again (it stays in the session file)");
		assert.match(JSON.stringify(sent[0]!.content), /不用表情/);
	});

	it("puts the user's correction in at the next model call, not the agent's", async () => {
		const pinned = await save("周报每周五发", { pinned: true, kind: "agreement" });
		const other = await save("回复要简洁");
		const seen: string[] = [];
		t.respond(
			(c) => {
				seen.push(JSON.stringify(snapshotsSent(c.messages)));
				// While the model works the user corrects one memory, and the agent changes another.
				void t.core.call("memory.update", { id: pinned.id, content: "周报每周四发" });
				memory.store.commit({ actor: "main_agent", explicit: true, ops: [{ kind: "edit", id: other.id, patch: { content: "回复要非常简洁" } }] });
				return fauxAssistantMessage([fauxToolCall("memory_search", { query: "周报" })], { stopReason: "toolUse" });
			},
			(c) => {
				seen.push(JSON.stringify(snapshotsSent(c.messages)));
				return fauxAssistantMessage("好");
			},
		);
		await prompt("周报怎么安排");
		assert.match(seen[0]!, /周报每周五发/);
		assert.match(seen[1]!, /周报每周四发/, "the user's correction takes effect within the run");
		assert.doesNotMatch(seen[1]!, /周报每周五发/);
		assert.match(seen[1]!, /回复要简洁/, "the agent's own change waits for the next task");
		const rows = memory.snapshotsFor(sessionId());
		assert.deepEqual(rows.map((r) => r.reason), ["correction", "task_start"]);
	});

	it("takes the snapshot away when memory is turned off", async () => {
		await save("回复要简洁");
		const seen: unknown[][] = [];
		t.respond((c) => (seen.push(c.messages), fauxAssistantMessage("一")), (c) => (seen.push(c.messages), fauxAssistantMessage("二")));
		await prompt("你好");
		t.core.settings.update({ memoryEnabled: false });
		await prompt("再来");
		assert.equal(snapshotsSent(seen[0]!).length, 1);
		assert.equal(snapshotsSent(seen[1]!).length, 0);
	});

	it("keeps the snapshot out of a compaction summary and brings the current one back after it", async () => {
		const old = await save("项目用 Node 18", { kind: "experience" });
		const seen: unknown[][] = [];
		t.respond(fauxAssistantMessage("一"), fauxAssistantMessage("二"));
		await prompt("项目用什么 Node");
		await prompt("好的");
		await t.core.call("memory.update", { id: old.id, content: "项目用 Node 22" });
		let summarized = "";
		t.respond((c) => {
			summarized = JSON.stringify(c.messages);
			return fauxAssistantMessage("## Primary Request and Intent\n- 问了 Node 版本");
		});
		await t.send("s1", { id: "c", type: "compact" });
		const response = await t.waitFor(() => t.records("s1").find((r) => r.id === "c"));
		assert.equal(response.success, true, JSON.stringify(response));
		assert.doesNotMatch(summarized, /记忆快照/, "the snapshot is not summarized");
		assert.ok(summarized.includes(MEMORY_SUMMARY_NOTE.slice(0, 40)), "and the summarizer is told why");
		t.respond((c) => (seen.push(c.messages), fauxAssistantMessage("三")));
		await prompt("继续，Node 版本是多少");
		const sent = snapshotsSent(seen[0]!);
		assert.equal(sent.length, 1);
		assert.match(JSON.stringify(sent[0]!.content), /Node 22/);
		assert.doesNotMatch(JSON.stringify(seen[0]!), /Node 18/, "the corrected fact does not come back");
	});

	it("brings the snapshot back after a compaction in the middle of a run (no new prompt in between)", async () => {
		await save("周报用三段式");
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const fakePi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler), registerTool: () => {} };
		memory.extension({ slotId: "s1" })(fakePi as never);
		const ctx = { sessionManager: { getSessionId: () => "mid-run" }, cwd: t.workspace, model: undefined, getContextUsage: () => undefined };
		memory.buildSnapshot("mid-run", "帮我写周报", t.workspace, undefined, 0, "task_start");
		const checkpoint = { role: "custom", customType: "df.checkpoint", content: "<compacted-summary>…</compacted-summary>", display: false, timestamp: 1 };
		const tail = { role: "user", content: [{ type: "text", text: "继续" }], timestamp: 2 };
		const context = handlers.get("context")!;
		assert.equal(context({ messages: [checkpoint, tail] }, ctx), undefined, "no compaction, no snapshot in the task: nothing added");
		await handlers.get("session_compact")!({ compactionEntry: { summary: "## Primary Request and Intent\n- 写周报" } }, ctx);
		const result = context({ messages: [checkpoint, tail] }, ctx) as { messages: { content: unknown }[] };
		assert.equal(result.messages.length, 3);
		assert.match(JSON.stringify(result.messages[1]!.content), /三段式/, "right after the checkpoint");
		assert.equal(memory.latestSnapshot("mid-run")!.reason, "compaction");
	});

	it("warns when a compaction summary repeats a memory the user set aside", async () => {
		const gone = await save("用户住在杭州西湖区", { kind: "background" });
		t.respond(fauxAssistantMessage("一"));
		await prompt("我住哪");
		await t.core.call("memory.setStatus", { id: gone.id, status: "forgotten" });
		t.respond(() => fauxAssistantMessage("## Primary Request and Intent\n- 用户住在杭州西湖区"));
		await t.send("s1", { id: "c", type: "compact" });
		const warning = await t.waitFor(() => t.messages.find((m) => m.event === "memory.warning"));
		assert.deepEqual(warning.itemIds, [gone.id]);
	});

	it("says memory did not load instead of going on without a word (§6.3 静默失败)", async () => {
		await save("回复要简洁");
		const list = memory.store.list.bind(memory.store);
		memory.store.list = () => {
			throw new Error("disk trouble");
		};
		const seen: string[] = [];
		t.respond((c) => (seen.push(JSON.stringify(c.messages)), fauxAssistantMessage("好")));
		await prompt("你好");
		memory.store.list = list;
		assert.match(seen[0]!, /未能加载/);
		assert.doesNotMatch(seen[0]!, /回复要简洁/);
		assert.equal((await t.core.call("memory.snapshotInfo", { sessionId: sessionId() }) as SnapshotRow).status, "failed");
	});

	it("tells why a memory is not in the snapshot (17.8)", async () => {
		t.core.settings.update({ memoryBudgetTokens: 60 });
		const cat = await save("家里的猫叫团子", { kind: "background" });
		const fits = await save("周报用三段式：进展、风险、计划");
		const tooMany = await save("周报里风险写在第二段，每条都写清楚影响和应对");
		const gone = await save("周报每周五发");
		await t.core.call("memory.setStatus", { id: gone.id, status: "forgotten" });
		t.respond(fauxAssistantMessage("好"));
		await prompt("帮我写周报");
		const why = async (id: string) => ((await t.core.call("memory.whyNot", { sessionId: sessionId(), itemId: id })) as { reason: string }).reason;
		assert.equal(await why(cat.id), "irrelevant");
		assert.deepEqual([await why(fits.id), await why(tooMany.id)].sort(), ["budget", "included"]);
		assert.equal(await why(gone.id), "forgotten");
	});

	it("memory_search stays within the search share and says how many more there are", async () => {
		t.core.settings.update({ memoryBudgetTokens: 400 });
		for (let i = 0; i < 12; i++) await save(`周报的第 ${i} 条习惯：这一条写得稍微长一点，好占地方`);
		let result = "";
		t.respond(fauxAssistantMessage([fauxToolCall("memory_search", { query: "周报" })], { stopReason: "toolUse" }), (c) => {
			result = JSON.stringify(c.messages.at(-1));
			return fauxAssistantMessage("好");
		});
		await prompt("我有哪些习惯");
		assert.match(result, /还有 \d+ 条相关记忆没有列出/);
	});
});
