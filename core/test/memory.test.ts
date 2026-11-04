import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { Memory } from "../src/modules/memory.ts";
import { dialogs, settledCount, startTestCore, type TestCore } from "./harness.ts";

/** A faux response that records the text the model was sent. */
function capture(into: string[], reply: string): FauxResponseFactory {
	return (context) => {
		into.push(JSON.stringify(context.messages));
		return fauxAssistantMessage(reply);
	};
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

	it("injects a snapshot of blocks and related memories once per session", async () => {
		await t.core.call("memory.setBlock", { key: "about_me", content: "我叫小明，是一名产品经理。" });
		await t.core.call("memory.add", { content: "写周报时喜欢用三段式：进展、风险、下周计划", kind: "preference" });
		await t.core.call("memory.add", { content: "家里的猫叫团子", kind: "background" });
		const seen: string[] = [];
		t.respond(capture(seen, "好的"), capture(seen, "好的"));
		await prompt("帮我写这周的周报");
		await prompt("再精简一点");

		assert.match(seen[0]!, /记忆快照/);
		assert.match(seen[0]!, /我叫小明/);
		assert.match(seen[0]!, /三段式/);
		assert.equal((seen[1]!.match(/<记忆快照/g) ?? []).length, 1, "the snapshot is not repeated within the task");

		const sessionId = t.core.slot("s1").session.sessionId;
		const snapshots = (await t.core.call("memory.snapshots", { sessionId })) as { memoryIds: string[] }[];
		assert.equal(snapshots.length, 1);
		assert.ok(snapshots[0]!.memoryIds.length >= 1);
	});

	it("saves explicit memories directly and inferred ones as candidates, without approval prompts", async () => {
		t.core.settings.update({ approvalMode: "all" });
		t.respond(
			fauxAssistantMessage([fauxToolCall("memory_save", { content: "回复用中文", kind: "preference", explicit: true })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("memory_save", { content: "用户的项目用 pnpm", kind: "experience", scope: "workspace", explicit: false, reason: "安装时报错后改用 pnpm" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("记好了"),
		);
		await prompt("记住：以后都用中文回复我");
		assert.equal(dialogs(t.records("s1")).length, 0, "memory tools are exempt from approval");
		const active = (await t.core.call("memory.list", {})) as Memory[];
		assert.deepEqual(active.map((m) => [m.content, m.source]), [["回复用中文", "user"]]);
		const candidates = (await t.core.call("memory.list", { status: "candidate" })) as Memory[];
		assert.equal(candidates[0]!.content, "用户的项目用 pnpm");
		assert.equal(candidates[0]!.scope, "workspace");
		assert.equal(candidates[0]!.cwd, t.workspace);
		assert.ok(t.messages.some((m) => m.event === "memory.changed"));
	});

	it("accepting an update candidate supersedes the old memory and keeps history", async () => {
		const old = (await t.core.call("memory.add", { content: "使用 Node 18" })) as Memory;
		t.respond(fauxAssistantMessage([fauxToolCall("memory_update", { id: `#${old.id}`, content: "使用 Node 22", explicit: false })], { stopReason: "toolUse" }), fauxAssistantMessage("ok"));
		await prompt("我们升级到 Node 22 了");
		const [proposal] = (await t.core.call("memory.list", { status: "candidate" })) as Memory[];
		assert.equal(proposal!.action, "update");
		assert.equal(proposal!.targetId, old.id);

		await t.core.call("memory.accept", { id: proposal!.id });
		const active = (await t.core.call("memory.list", {})) as Memory[];
		assert.deepEqual(active.map((m) => m.content), ["使用 Node 22"]);
		const history = (await t.core.call("memory.history", { id: proposal!.id })) as Memory[];
		assert.deepEqual(history.map((m) => m.content), ["使用 Node 22", "使用 Node 18"]);
		assert.equal(history[1]!.status, "superseded");
	});

	it("edits keep history and deletes are soft", async () => {
		const m = (await t.core.call("memory.add", { content: "喜欢咖啡" })) as Memory;
		const edited = (await t.core.call("memory.edit", { id: m.id, content: "喜欢美式咖啡" })) as Memory;
		assert.equal(edited.source, "manual");
		await t.core.call("memory.remove", { id: edited.id });
		assert.equal(((await t.core.call("memory.list", {})) as Memory[]).length, 0);
		assert.equal(((await t.core.call("memory.list", { status: ["deleted", "superseded"] })) as Memory[]).length, 2);
	});

	it("extracts candidates after a run when enabled", async () => {
		t.core.settings.update({ memoryAutoExtract: true });
		t.respond(
			fauxAssistantMessage("这是为你规划的东京五日行程……"),
			fauxAssistantMessage('```json\n[{"action":"add","kind":"preference","scope":"global","content":"旅行偏好慢节奏，不喜欢赶景点","reason":"用户说不想太累"}]\n```'),
		);
		await prompt("帮我规划东京五日游，我不喜欢赶景点，想慢慢逛");
		const list = await t.waitFor(() => {
			const rows = t.core.db.all<{ content: string }>("SELECT content FROM memories WHERE status = 'candidate'");
			return rows.length ? rows : undefined;
		});
		assert.equal(list[0]!.content, "旅行偏好慢节奏，不喜欢赶景点");
	});

	it("extraction does not repeat a memory in other words and sees every memory (v0.3.2 test)", async () => {
		t.core.settings.update({ memoryAutoExtract: true });
		const old = (await t.core.call("memory.add", { content: "回复要简练，少说话", kind: "preference" })) as Memory;
		const seen: string[] = [];
		t.respond(fauxAssistantMessage("好的。"), (context) => {
			seen.push(JSON.stringify(context.messages));
			return fauxAssistantMessage(
				JSON.stringify([
					{ action: "add", kind: "preference", content: "回复要简练，少说话。" },
					{ action: "add", kind: "preference", content: "回复要简练，别长篇大论；正常问答不要用卡片" },
					{ action: "add", kind: "preference", content: "回复要简练，别长篇大论" },
				]),
			);
		});
		await prompt("以后回复简练一点，别长篇大论，普通问答也不要做卡片");
		const candidates = await t.waitFor(() => {
			const rows = t.core.db.all<{ content: string; action: string; target_id: string | null }>("SELECT content, action, target_id FROM memories WHERE status = 'candidate'");
			return rows.length ? rows : undefined;
		});
		// The first repeats the memory; the second says more, so it is an update of it; the third repeats the second.
		assert.deepEqual(candidates.map((c) => ({ ...c })), [{ content: "回复要简练，别长篇大论；正常问答不要用卡片", action: "update", target_id: old.id }]);
		assert.match(seen[0]!, /回复要简练，少说话/, "the extractor is shown the memories even when the words differ");
		assert.match(seen[0]!, /不是用户的信息/);
	});

	it("memory_save does not save a near repeat twice", async () => {
		await t.core.call("memory.add", { content: "用户要求思考和输出一律使用简体中文", kind: "preference" });
		t.respond(
			fauxAssistantMessage([fauxToolCall("memory_save", { content: "用户要求思考和输出一律使用简体中文。", kind: "preference", explicit: true })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		);
		await prompt("记住：都用简体中文");
		const active = (await t.core.call("memory.list", {})) as Memory[];
		assert.equal(active.length, 1);
	});

	it("locked blocks only accept proposals", async () => {
		await t.core.call("memory.setBlock", { key: "agreements", content: "周报每周五发", locked: true });
		t.respond(fauxAssistantMessage([fauxToolCall("memory_block_edit", { key: "agreements", content: "周报每周四发", explicit: true })], { stopReason: "toolUse" }), fauxAssistantMessage("ok"));
		await prompt("以后周报改成周四发");
		const blocks = (await t.core.call("memory.blocks", {})) as { key: string; content: string }[];
		assert.equal(blocks.find((b) => b.key === "agreements")!.content, "周报每周五发");
		const [proposal] = (await t.core.call("memory.list", { status: "candidate" })) as Memory[];
		assert.equal(proposal!.targetId, "block:agreements");
		await t.core.call("memory.accept", { id: proposal!.id });
		const after = (await t.core.call("memory.blocks", {})) as { key: string; content: string }[];
		assert.equal(after.find((b) => b.key === "agreements")!.content, "周报每周四发");
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
		assert.equal(((await t.core.call("memory.list", {})) as Memory[]).length, 0);
	});
});
