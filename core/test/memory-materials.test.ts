import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { TokenCalibration } from "../src/memory/calibrate.ts";
import type { MemoryJob } from "../src/memory/jobs.ts";
import { lineCost, type Material, planSnapshot } from "../src/memory/snapshot.ts";
import type { MemoryItem, NewItem } from "../src/memory/types.ts";
import { MemoryModule } from "../src/modules/memory.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

const propose = (...ops: Record<string, unknown>[]) => fauxAssistantMessage([fauxToolCall("memory_propose_ops", { ops: ops as never })], { stopReason: "toolUse" });

const item = (id: string, content: string, extra: Partial<MemoryItem> = {}): MemoryItem =>
	({ id, version: 1, level: 2, kind: "preference", content, conditions: null, scope: "global", workspaceId: null, groupId: null, confidence: "user_explicit", status: "active", pinned: false, retention: "normal", autoOk: true, createdAt: 1, updatedAt: 1, ...extra }) as MemoryItem;

describe("snapshot materials in the plan", () => {
	it("lets a fresh material stand for its items, shorter than their lines (§6.2)", () => {
		const a = item("m_a", "用户写论文时喜欢用短句，每句不超过二十个字");
		const b = item("m_b", "用户写论文时不喜欢用形容词堆砌，越朴素越好");
		const c = item("m_c", "用户喜欢在回复末尾列出下一步");
		const material: Material = { id: "mt_1", scopeKey: "global", text: "写论文：短句、少形容词（#m_a、#m_b）", items: [a, b] };
		const plain = planSnapshot([a, b, c], "帮我改论文", 1000);
		const plan = planSnapshot([a, b, c], "帮我改论文", 1000, [material]);
		assert.deepEqual(plan.materials.map((x) => x.id), ["mt_1"]);
		assert.deepEqual(plan.related.map((m) => m.id).sort(), ["m_a", "m_b", "m_c"], "its items count as included");
		assert.ok(plan.tokens < plain.tokens);
		const changed = planSnapshot([{ ...a, version: 2 }, b, c], "帮我改论文", 1000, [material]);
		assert.equal(changed.materials.length, 0, "an item changed since: the material is not used");
		assert.equal(changed.related.length, 3, "its items are shown one by one");
		const gone = planSnapshot([b, c], "帮我改论文", 1000, [material]);
		assert.equal(gone.materials.length, 0, "an item is no longer there");
	});

	it("counts with the measured token scale", () => {
		const items = Array.from({ length: 12 }, (_, i) => item(`m_${i}`, `用户的第 ${i} 条偏好：写作时要注意第 ${i} 件很具体的事情`));
		const normal = planSnapshot(items, "写作", 600);
		const doubled = planSnapshot(items, "写作", 600, [], 2);
		assert.ok(lineCost(items[0]!, 2) > lineCost(items[0]!) * 1.8);
		assert.ok(doubled.related.length < normal.related.length, "a model that counts twice as many tokens gets fewer lines");
	});
});

describe("token calibration (§6.1)", () => {
	let t: TestCore;
	beforeEach(async () => {
		t = await startTestCore();
	});
	afterEach(async () => {
		await t.cleanup();
	});

	const text = (n: number) => ({ role: "user", content: [{ type: "text", text: "字".repeat(n) }] });

	it("measures from the growth between two calls, so the system prompt and tools cancel out", () => {
		const c = new TokenCalibration(t.core.db, () => 1);
		c.beforeCall("s", [text(1000)]);
		assert.equal(c.afterCall("s", "p/m", { input: 9000 }), undefined, "the first call alone says nothing");
		c.beforeCall("s", [text(1000), text(1000)]);
		assert.equal(c.afterCall("s", "p/m", { input: 7000, cacheRead: 3500 }), 1.5, "1000 more estimated, 1500 more counted");
		assert.equal(c.scale("p/m"), 1.5);
		assert.equal(c.scale("other/model"), 1, "per model");
		c.beforeCall("s", [text(1000), text(1000), text(100)]);
		assert.equal(c.afterCall("s", "p/m", { input: 10_700 }), undefined, "too small a growth");
		c.beforeCall("s", [text(1000), text(1000), text(100), { role: "user", content: [{ type: "image" }, { type: "text", text: "字".repeat(1000) }] }]);
		assert.equal(c.afterCall("s", "p/m", { input: 13_000 }), undefined, "a new image: not comparable");
		c.beforeCall("s", [text(1000), text(1000), text(100), { role: "user", content: [{ type: "image" }, { type: "text", text: "字".repeat(1000) }] }, text(1000)]);
		assert.equal(c.afterCall("s", "p/m", { input: 14_000 }), 1.5 * 0.7 + 1 * 0.3, "a moving average");
	});
});

describe("snapshot materials in the core", () => {
	let t: TestCore;
	let memory: MemoryModule;
	let time: number;

	beforeEach(async () => {
		t = await startTestCore();
		memory = t.core.module(MemoryModule)!;
		time = new Date(2026, 10, 4, 10, 0).getTime();
		memory.clock = () => time;
	});

	afterEach(async () => {
		await t.cleanup();
	});

	const add = (content: string, extra: Partial<NewItem> = {}) =>
		memory.store.commit({ actor: "user", ops: [{ kind: "add", item: { content, kind: "preference", level: 2, scope: "global", confidence: "user_explicit", ...extra } }] }).applied[0]!.itemId;
	const get = (id: string) => memory.store.get(id)!;
	const jobs = async () => (await t.core.call("memory.jobs", {})) as MemoryJob[];
	const seven = [
		"用户写论文时喜欢用短句",
		"用户写论文时不喜欢堆砌形容词",
		"用户希望回复末尾列出下一步",
		"用户习惯先写测试再写代码",
		"用户的代码注释用英文写",
		"用户周报每周五下午发给导师",
		"用户的周报要分成完成和计划两部分",
	];

	it("prepares materials for the next task, checks them, uses them, and drops one that went out of date", async () => {
		t.core.settings.update({ memoryAutoExtract: true });
		const ids = seven.map((c) => add(c));
		assert.equal(memory.buildSnapshot("s-1", "帮我写周报", t.workspace, undefined, 0, "task_start")!.status, "ok");
		const [job] = await jobs();
		assert.deepEqual([job!.kind, job!.scopeKey, job!.status], ["snapshot", "global", "queued"], "queued for the next task; this one did not wait");
		const [a, b, c, d, e, f, g] = ids as [string, string, string, string, string, string, string];
		const v = (id: string) => ({ id, version: get(id).version });
		const results: string[] = [];
		t.respond(
			() =>
				propose(
					{ action: "material", from: [v(a), v(b)], content: `写论文：短句、不堆形容词（#${a}、#${b}）`, reason: "同一主题" },
					{ action: "material", from: [v(f), v(g)], content: `周报：周五下午发导师，分完成和计划（#${f}、#${g}）`, reason: "同一主题" },
					{ action: "material", from: [v(c)], content: `回复末尾列下一步（#${c}）`, reason: "单独一条" },
					{ action: "material", from: [v(d), v(e)], content: `写代码先写测试，注释用英文（#${d}）`, reason: "漏了一个" },
					{ action: "material", from: [v(d), v(e)], content: `写代码先写测试，注释用英文（#${d}、#${e}、#${a}）`, reason: "多了一个" },
					{ action: "material", from: [v(a), v(c)], content: `（#${a}、#${c}）`, reason: "重复" },
					{ action: "material", from: [v(d), v(e)], content: `用户在写代码的时候习惯先把测试写好再动手写实现代码，而且代码里的注释一律用英文来写，不用中文（#${d}、#${e}）`, reason: "太长" },
				),
			(context) => {
				results.push(JSON.stringify(context.messages.at(-1)));
				return fauxAssistantMessage("写了两段。");
			},
		);
		await t.core.call("memory.runJobs", {});
		assert.equal((await jobs()).find((j) => j.kind === "snapshot")!.status, "done");
		assert.match(results[0]!, /1\. 已写成素材/);
		assert.match(results[0]!, /2\. 已写成素材/);
		assert.match(results[0]!, /3\. 被拒绝：一段素材至少覆盖 2 条/);
		assert.match(results[0]!, /4\. 被拒绝：素材里要用 #id 标出/);
		assert.match(results[0]!, /5\. 被拒绝：素材里提到了没有列在 from 里的条目/);
		assert.match(results[0]!, /6\. 被拒绝：#m_\w+ 已经写进别的素材了/);
		assert.match(results[0]!, /7\. 被拒绝：素材（约 \d+ token）没有比分开列出/);
		assert.equal(t.core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_materials")!.n, 2);
		assert.equal(t.core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_batches WHERE kind = 'snapshot'")!.n, 0, "materials are not changes of memory: nothing in the memory log");

		const used = memory.snapshot("帮我写周报", t.workspace);
		assert.match(used.content, /周报：周五下午发导师/);
		assert.doesNotMatch(used.content, /用户周报每周五下午发给导师/, "its items are not listed again");
		assert.ok(used.ids.includes(f) && used.ids.includes(g), "its items are recorded as used");
		assert.deepEqual(used.needs, [], "nothing changed since: no new preparation");

		time += 60_000;
		await t.core.call("memory.update", { id: f, content: "用户周报每周四晚上发给导师" });
		const after = memory.snapshot("帮我写周报", t.workspace);
		assert.doesNotMatch(after.content, /周报：周五下午发导师/, "out of date: never shown");
		assert.match(after.content, /用户周报每周四晚上发给导师/);
		assert.match(after.content, /用户的周报要分成完成和计划两部分/, "the other item of the material is shown on its own");
		assert.equal(t.core.db.get<{ stale: number }>("SELECT stale FROM memory_materials WHERE text LIKE '周报%'")!.stale, 1);
		assert.deepEqual(after.needs, ["global"]);
	});

	it("says the snapshot was only partly loaded when missing materials cost it items (degraded)", () => {
		t.core.settings.update({ memoryBudgetTokens: 160 });
		for (const c of seven) add(`${c}，这条写得比较长，用来占满预算里相关记忆的份额`);
		assert.equal(memory.buildSnapshot("s-1", "帮我写周报", t.workspace, undefined, 0, "task_start")!.status, "degraded");
		assert.equal(t.core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_jobs")!.n, 0, "background tidying off: nothing queued");
	});

	it("is not degraded when there are too few items for materials anyway", () => {
		t.core.settings.update({ memoryBudgetTokens: 120 });
		for (const c of seven.slice(0, 3)) add(`${c}，这条写得比较长，用来占满预算里相关记忆的份额`);
		assert.equal(memory.buildSnapshot("s-1", "帮我写周报", t.workspace, undefined, 0, "task_start")!.status, "ok");
	});

	it("puts preparation off like other background work when the day's budget is spent", async () => {
		t.core.settings.update({ memoryAutoExtract: true, memoryDailyBudgetUsd: 0 });
		for (const c of seven) add(c);
		memory.buildSnapshot("s-1", "帮我写周报", t.workspace, undefined, 0, "task_start");
		await t.core.call("memory.runJobs", {});
		assert.equal((await jobs()).find((j) => j.kind === "snapshot")!.status, "deferred");
	});

	it("measures the scale from real calls in a session", async () => {
		await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
		const send = async (text: string) => {
			const before = settledCount(t.records("s1"));
			await t.send("s1", { id: `p-${Math.random()}`, type: "prompt", message: text });
			await t.waitFor(() => settledCount(t.records("s1")) === before + 1);
		};
		t.respond(fauxAssistantMessage("好"), fauxAssistantMessage("好"), fauxAssistantMessage("好"));
		// Three turns of the same size: the fake model's own way of counting the first, uncached call is left out.
		await send("第一段：" + "测".repeat(1200));
		await send("第二段：" + "试".repeat(1200));
		await send("第三段：" + "验".repeat(1200));
		// The fake model counts about four characters per token; we count one per Chinese character.
		await t.waitFor(() => t.core.db.get("SELECT 1 FROM app_flags WHERE key LIKE 'memory_token_scale:faux/%'"));
		const scale = Number(t.core.db.get<{ value: string }>("SELECT value FROM app_flags WHERE key LIKE 'memory_token_scale:faux/%'")!.value);
		assert.equal(scale, 0.5, "measured, and held to the lower limit");
	});

	it("uses the measured scale of the model in use", () => {
		t.core.settings.update({ memoryBudgetTokens: 400 });
		for (const c of seven) add(c);
		const model = { contextWindow: 200_000, maxTokens: 8_192, provider: "faux", id: "faux-1" };
		const before = memory.snapshot("帮我写周报", t.workspace, model).plan.tokens;
		t.core.db.run("INSERT INTO app_flags(key, value, at) VALUES('memory_token_scale:faux/faux-1', '2', 0)");
		const after = memory.snapshot("帮我写周报", t.workspace, model).plan;
		assert.equal(after.leftOut.filter((l) => l.reason === "budget").length, 0);
		assert.ok(after.tokens > before * 1.8, "the same lines, counted with the scale");
		assert.ok(after.tokens <= after.budget);
	});
});
