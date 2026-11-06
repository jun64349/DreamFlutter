import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionIndex } from "../src/modules/session-index.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

describe("T-11 F-02 immediate checkpoint regeneration", () => {
	let t: TestCore;
	beforeEach(async () => {
		t = await startTestCore();
		t.core.settings.update({ backgroundCompaction: "off", autoCompaction: false });
		await t.core.call("slot.open", { slotId: "s", cwd: t.workspace }, t.client);
	});
	afterEach(async () => { mock.restoreAll(); await t.cleanup(); });
	const slot = () => t.core.slot("s");
	const manager = () => slot().session.sessionManager;
	async function prompt(text: string) {
		const count = settledCount(t.records("s"));
		t.respond(fauxAssistantMessage("收到"));
		await t.send("s", { id: `p-${count}`, type: "prompt", message: text });
		await t.waitFor(() => settledCount(t.records("s")) > count);
	}
	async function checkpoint() {
		await prompt("约束：当前端口8453，旧端口7319已否定；禁止Docker；测试未运行。");
		await prompt("材料：" + "rivers and meadows. ".repeat(100));
		t.respond(fauxAssistantMessage("旧摘要：端口8453；禁止Docker；测试未运行"));
		await t.core.call("context.compactNow", { slotId: "s" });
		const entry = manager().getLeafEntry()!;
		assert.equal(entry.type, "compaction");
		return entry;
	}
	it("immediately branches before the checkpoint, preserves old history, refreshes context and bills once", async () => {
		const old = await checkpoint(); const file = slot().info().sessionFile!;
		const bytes = readFileSync(file, "utf8"), entries = structuredClone(manager().getEntries());
		const runsBefore = t.core.runs.list().length;
		const runtime = slot().session.modelRuntime, complete = runtime.completeSimple.bind(runtime);
		mock.method(runtime, "completeSimple", async (...args: Parameters<typeof complete>) => {
			const result = await complete(...args);
			return { ...result, usage: { ...result.usage, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } } };
		});
		let calls = 0;
		t.respond(context => {
			calls++;
			assert.match(JSON.stringify(context.messages), /旧端口7319已否定/);
			return fauxAssistantMessage("重写摘要：当前8453；禁止Docker；测试未运行");
		});
		const result = await t.core.call("context.regenerate", { slotId: "s", entryId: old.id, note: "不能把旧端口写成当前事实" }) as { source: string; estimatedTokensAfter: number };
		assert.equal(result.source, "original"); assert.equal(calls, 1);
		const fresh = manager().getLeafEntry()!;
		assert.equal(fresh.type, "compaction"); assert.notEqual(fresh.id, old.id); assert.equal(fresh.parentId, old.parentId);
		assert.deepEqual(manager().getEntries().slice(0, entries.length), entries);
		assert.ok(readFileSync(file, "utf8").startsWith(bytes), "old JSONL is append-only");
		assert.deepEqual(manager().getEntry(old.id), old);
		assert.equal(manager().getEntries().filter(e => e.type === "message").length, entries.filter(e => e.type === "message").length, "no fake messages");
		const points = await t.core.call("context.checkpoints", { slotId: "s" }) as { entryId: string }[];
		assert.deepEqual(points.map(p => p.entryId), [fresh.id]);
		assert.match(JSON.stringify(slot().session.state.messages), /重写摘要/);
		assert.doesNotMatch(JSON.stringify(slot().session.state.messages), /旧摘要：/);
		const info = await t.core.call("context.info", { slotId: "s" }) as { checkpoints: number; compacting: boolean; usage: { tokens: number | null } };
		assert.equal(info.checkpoints, 1); assert.equal(info.compacting, false);
		assert.equal(info.usage.tokens, null, "Pi cannot trust pre-compaction model usage until a new reply");
		assert.ok(result.estimatedTokensAfter > 0);
		assert.equal(t.core.runs.list().length, runsBefore + 1);
		assert.equal(t.core.runs.list().filter(r => r.kind === "compaction").reduce((sum, r) => sum + r.cost, 0), 0.3);
		assert.equal(slot().session.getSessionStats().cost, 0.3);
		await t.core.module(SessionIndex)!.refresh();
		assert.equal(t.core.db.get<{ cost: number }>("SELECT SUM(cost) cost FROM usage_records WHERE path=?", file)?.cost, 0.3);
		await assert.rejects(t.core.call("context.regenerate", { slotId: "s", entryId: old.id }), /最新/);
		// The old summary remains readable through the public session tree API.
		await slot().session.navigateTree(old.id); assert.match(JSON.stringify(slot().session.state.messages), /旧摘要：/);
		await slot().session.navigateTree(fresh.id);
		await t.core.closeSlot("s");
		await t.core.call("slot.open", { slotId: "s", cwd: t.workspace, sessionFile: file }, t.client);
		assert.equal(manager().getLeafId(), fresh.id); assert.ok(manager().getEntry(old.id));
	});
	it("restores the original branch on summary failure and allows an immediate retry", async () => {
		const old = await checkpoint(), file = slot().info().sessionFile!;
		const bytes = readFileSync(file, "utf8"), messages = structuredClone(slot().session.state.messages);
		t.respond(() => { throw new Error("synthetic summary failure"); });
		await assert.rejects(t.core.call("context.regenerate", { slotId: "s", entryId: old.id }), /synthetic summary failure/);
		assert.equal(manager().getLeafId(), old.id); assert.equal(readFileSync(file, "utf8"), bytes);
		assert.deepEqual(slot().session.state.messages, messages); assert.equal(slot().compacting, false);
		t.respond(fauxAssistantMessage("重试成功摘要"));
		const result = await t.core.call("context.regenerate", { slotId: "s", entryId: old.id }) as { source: string };
		assert.equal(result.source, "original"); assert.notEqual(manager().getLeafId(), old.id);
	});
	it("uses the replaced summary when originals are oversized, without resending the oversized originals", async () => {
		await prompt("BIG_ORIGINAL_START " + "material ".repeat(80000));
		await prompt("当前端口8453，禁止Docker，测试未运行。");
		t.respond(fauxAssistantMessage("LATEST_SAVED_SUMMARY 当前端口8453，禁止Docker，测试未运行。"));
		await t.core.call("context.compactNow", { slotId: "s" });
		const old = manager().getLeafEntry()!;
		t.respond(context => {
			const input = JSON.stringify(context.messages);
			assert.match(input, /LATEST_SAVED_SUMMARY/);
			assert.doesNotMatch(input, /BIG_ORIGINAL_START/);
			return fauxAssistantMessage("修订摘要：当前8453，禁止Docker，测试未运行。");
		});
		const result = await t.core.call("context.regenerate", { slotId: "s", entryId: old.id }) as { source: string };
		assert.equal(result.source, "previous_summary");
		assert.equal(manager().getLeafEntry()!.parentId, old.parentId); assert.ok(manager().getEntry(old.id));
	});
});
