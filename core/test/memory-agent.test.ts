import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { runMemoryAgent } from "../src/memory/agent.ts";
import type { MemoryJob } from "../src/memory/jobs.ts";
import type { LogDay, MemoryItem } from "../src/memory/types.ts";
import { lastMonday3am, MEMORY_LEDGER } from "../src/memory/work.ts";
import { MemoryModule } from "../src/modules/memory.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

const DAY = 86_400_000;
const propose = (...ops: Record<string, unknown>[]) => fauxAssistantMessage([fauxToolCall("memory_propose_ops", { ops: ops as never })], { stopReason: "toolUse" });

describe("memory agent loop", () => {
	it("has only its two tools, whatever the model asks for", async () => {
		const tools: string[][] = [];
		const results: string[] = [];
		const answers = [
			{ role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "dir C:\\" } }], stopReason: "toolUse", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } },
			{ role: "assistant", content: [{ type: "text", text: "做完了" }], stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } },
		];
		const runtime = {
			completeSimple: async (_model: unknown, context: { tools: { name: string }[]; messages: { role: string; content: { text?: string }[] }[] }) => {
				tools.push(context.tools.map((t) => t.name));
				const last = context.messages.at(-1)!;
				if (last.role === "toolResult") results.push(last.content[0]!.text!);
				return answers.shift();
			},
		};
		const run = await runMemoryAgent({ runtime: runtime as never, model: { provider: "p", id: "m" } as never, system: "s", input: "i", handlers: { query: () => "", propose: () => "" } });
		assert.deepEqual(tools[0], ["memory_query", "memory_propose_ops"]);
		assert.match(results[0]!, /没有这个工具：bash/);
		assert.equal(run.summary, "做完了");
		assert.equal(run.turns, 2);
		assert.ok(Math.abs(run.usage.cost - 0.002) < 1e-9);
	});

	it("stops at its turn cap", async () => {
		const runtime = { completeSimple: async () => ({ role: "assistant", content: [{ type: "toolCall", id: "x", name: "memory_query", arguments: {} }], stopReason: "toolUse", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }) };
		const run = await runMemoryAgent({ runtime: runtime as never, model: { provider: "p", id: "m" } as never, system: "s", input: "i", handlers: { query: () => "", propose: () => "" }, maxTurns: 3 });
		assert.equal(run.stoppedBy, "maxTurns");
		assert.equal(run.turns, 3);
	});
});

describe("memory agent jobs", () => {
	let t: TestCore;
	let memory: MemoryModule;
	let time: number;

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
	const jobs = async () => (await t.core.call("memory.jobs", {})) as MemoryJob[];
	const extractNow = async () => (await t.core.call("memory.extractNow", { slotId: "s1" })) as MemoryJob;
	const items = async (params: Record<string, unknown> = {}) => (await t.core.call("memory.items", params)) as MemoryItem[];
	const useFakeClock = (at: number) => {
		time = at;
		memory.clock = () => time;
	};

	it("extracts after a task through the gate, in the ledger, and tells the agent what happened to each op", async () => {
		t.core.settings.update({ memoryAutoExtract: true });
		const results: string[] = [];
		t.respond(
			fauxAssistantMessage("已经帮你把论文第二章改好了。"),
			propose(
				{ action: "add", kind: "progress", content: "完成了论文第二章的修改", reason: "任务做完了" },
				{ action: "add", kind: "preference", content: "用户写论文喜欢用短句", said: true, reason: "用户说" },
				{ action: "set_status", id: "m_nothing", version: 1, status: "archived", reason: "试试" },
				{ action: "add", content: "没写理由" },
				{ action: "combine", from: [{ id: "m_x", version: 1 }], content: "合并", reason: "试试" },
			),
			(c) => {
				results.push(JSON.stringify(c.messages.at(-1)));
				return fauxAssistantMessage("记了两条。");
			},
		);
		await prompt("帮我改论文第二章，我喜欢用短句");
		const job = await t.waitFor(() => t.core.db.get<{ status: string; result: string }>("SELECT status, result FROM memory_jobs WHERE kind = 'extract' AND status = 'done'"));
		assert.match(job.result, /记了两条/);
		const saved = await items();
		assert.deepEqual(saved.map((m) => [m.content, m.level, m.kind, m.confidence]).sort(), [
			["完成了论文第二章的修改", 1, "progress", "agent_inferred"],
			["用户写论文喜欢用短句", 1, "preference", "user_reported"],
		]);
		assert.match(results[0]!, /1\. 已生效/);
		assert.match(results[0]!, /3\. 被拒绝：这次整理不能把状态改成「archived」/, "an extraction may not archive");
		assert.match(results[0]!, /4\. 被拒绝：每个操作都要写理由/);
		assert.match(results[0]!, /5\. 被拒绝：这次整理不能做「combine」/, "an extraction may not combine items");
		const log = ((await t.core.call("memory.log", {})) as {days: LogDay[]}).days;
		assert.ok(log[0]!.entries.every((e) => e.actor === "memory_agent" && e.batchKind === "extract"));
		assert.equal(t.core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM usage_records WHERE path = ?", MEMORY_LEDGER)!.n, 2, "both model calls are in the ledger");
	});

	it("caps progress notes at three per task", async () => {
		t.respond(fauxAssistantMessage("好"));
		await prompt("今天做了很多事情，帮我记一下进展吧");
		const results: string[] = [];
		t.respond(
			propose(...[1, 2, 3, 4].map((i) => ({ action: "add", kind: "progress", content: `第 ${i} 件完全不同的事情：编号${i}${i}${i}`, reason: "做完了" }))),
			(c) => {
				results.push(JSON.stringify(c.messages.at(-1)));
				return fauxAssistantMessage("好");
			},
		);
		await extractNow();
		assert.equal((await items()).length, 3);
		assert.match(results[0]!, /4\. 被拒绝：一个任务最多记 3 条进展/);
	});

	it("reads only what is new since the last time, and a compaction does not make it skip anything (17.7)", async () => {
		t.respond(fauxAssistantMessage("一"));
		await prompt("第一件事：我在做毕业设计");
		t.respond(fauxAssistantMessage("好"));
		await extractNow();
		t.respond(fauxAssistantMessage("二"), fauxAssistantMessage("三"));
		await prompt("第二件事：答辩在十二月");
		await prompt("第三件事：导师姓王");
		t.respond(fauxAssistantMessage("## Primary Request and Intent\n- 三件事"));
		await t.send("s1", { id: "c", type: "compact" });
		await t.waitFor(() => t.records("s1").find((r) => r.id === "c"));
		const seen: string[] = [];
		t.respond((c) => {
			seen.push(JSON.stringify(c.messages));
			return fauxAssistantMessage("好");
		});
		await extractNow();
		assert.doesNotMatch(seen[0]!, /第一件事/, "already read");
		assert.match(seen[0]!, /第二件事/);
		assert.match(seen[0]!, /第三件事/, "compacted away from the context, still read from the session file");
	});

	it("retries a failed job twice with growing pauses, then records why", async () => {
		useFakeClock(Date.now());
		t.respond(fauxAssistantMessage("一"));
		await prompt("帮我记住我喜欢喝茶这件事情");
		t.respond(fauxAssistantMessage("", { stopReason: "error", errorMessage: "服务器出错了" }));
		const first = await extractNow();
		assert.equal(first.status, "queued");
		assert.equal(first.attempts, 1);
		assert.equal(first.error, "服务器出错了");
		await t.core.call("memory.runJobs", {});
		assert.equal((await jobs())[0]!.attempts, 1, "not before its pause is over");
		time += 61_000;
		t.respond(fauxAssistantMessage("", { stopReason: "error", errorMessage: "服务器出错了" }));
		await t.core.call("memory.runJobs", {});
		assert.equal((await jobs())[0]!.status, "queued");
		time += 121_000;
		t.respond(fauxAssistantMessage("", { stopReason: "error", errorMessage: "服务器出错了" }));
		await t.core.call("memory.runJobs", {});
		const failed = (await jobs())[0]!;
		assert.deepEqual([failed.status, failed.attempts, failed.error], ["failed", 3, "服务器出错了"]);
	});

	it("puts ordinary work off when the day's memory budget is spent, and while tidying is paused", async () => {
		t.respond(fauxAssistantMessage("一"));
		await prompt("帮我记住我喜欢喝茶这件事情");
		t.core.settings.update({ memoryDailyBudgetUsd: 0 });
		const deferred = await extractNow();
		assert.equal(deferred.status, "deferred");
		assert.ok(deferred.runAfter > Date.now(), "tried again tomorrow");
		assert.equal(deferred.attempts, 0, "no model was called");
		t.core.db.run("UPDATE memory_jobs SET run_after = 0");
		t.core.settings.update({ memoryDailyBudgetUsd: 0.2, memoryPaused: true });
		await t.core.call("memory.runJobs", {});
		assert.equal((await jobs())[0]!.status, "deferred", "paused: still waiting");
		t.core.settings.update({ memoryPaused: false });
		t.respond(propose({ action: "add", kind: "preference", content: "用户喜欢喝茶", said: true, reason: "用户说" }), fauxAssistantMessage("好"));
		await t.core.call("memory.runJobs", {});
		assert.equal((await jobs())[0]!.status, "done");
		assert.equal((await items()).length, 1);
	});

	it("tidies level 1 weekly: no change, no model; old items get a decision; once per week", async () => {
		// A Wednesday.
		const wednesday = new Date(2026, 10, 4, 10, 0).getTime();
		useFakeClock(wednesday);
		const add = (content: string, extra: Record<string, unknown> = {}) =>
			memory.store.commit({ actor: "memory_agent", ops: [{ kind: "add", item: { content, kind: "progress", level: 1, scope: "global", confidence: "agent_inferred", ...extra } }] }).applied[0]!.itemId;
		const a = add("完成了第一章初稿");
		const b = add("完成了第一章初稿的修改");
		const c = add("下周一交初稿");
		const d = add("锁定的近期约定", { kind: "agreement" });
		memory.store.commit({ actor: "user", ops: [{ kind: "edit", id: d, patch: { retention: "locked" } }] });
		await t.core.call("memory.runJobs", {}); // first look: counting starts now
		assert.equal((await jobs()).length, 0);

		time = wednesday + 6 * DAY; // the next Tuesday: past Monday 03:00, nothing changed, nothing old
		await t.core.call("memory.runJobs", {});
		assert.equal((await jobs()).length, 0, "no model call for a week without change");

		time = wednesday + 20 * DAY; // two weeks later: the items are past 14 days
		const seen: string[] = [];
		const results: string[] = [];
		const v = (id: string) => memory.store.get(id)!.version;
		t.respond(
			(context) => {
				seen.push(JSON.stringify(context.messages));
				return propose(
					{ action: "combine", from: [{ id: a, version: v(a) }, { id: b, version: v(b) }], retire_as: "archived", content: "完成了第一章初稿并修改过一遍", reason: "同一件事" },
					{ action: "set_status", id: c, version: v(c), status: "ended", reason: "日期已过" },
					{ action: "set_status", id: d, version: v(d), status: "ended", reason: "看起来过时了" },
				);
			},
			(context) => {
				results.push(JSON.stringify(context.messages.at(-1)));
				return fauxAssistantMessage("合并了两条，一条已结束。");
			},
		);
		await t.core.call("memory.runJobs", {});
		const [job] = await jobs();
		assert.deepEqual([job!.kind, job!.status], ["tidy_l1", "done"]);
		assert.match(seen[0]!, /20 天前记下/);
		assert.deepEqual([a, b].map((id) => memory.store.get(id)!.status), ["archived", "archived"]);
		assert.equal(memory.store.get(c)!.status, "ended");
		const merged = (await items()).find((m) => m.content === "完成了第一章初稿并修改过一遍")!;
		assert.deepEqual(memory.store.links(merged.id).filter((l) => l.from === merged.id).map((l) => [l.to, l.kind]).sort(), [[a, "derived_from"], [b, "derived_from"]].sort());
		assert.equal(memory.store.get(d)!.status, "review", "locked: only marked for review");
		assert.equal(memory.store.get(d)!.content, "锁定的近期约定");
		assert.match(results[0]!, /3\. 交给用户确认（用户锁定的记忆）/);
		const log = ((await t.core.call("memory.log", {})) as {days: LogDay[]}).days;
		assert.ok(log[0]!.entries.some((e) => e.batchKind === "tidy"));
		// The same week again: nothing more.
		await t.core.call("memory.runJobs", {});
		assert.equal((await jobs()).length, 1);
	});

	it("the weekly boundary is Monday 03:00 local time", () => {
		const tuesday = new Date(2026, 10, 10, 12, 0).getTime();
		assert.equal(new Date(lastMonday3am(tuesday)).toString(), new Date(2026, 10, 9, 3, 0).toString());
		const earlyMonday = new Date(2026, 10, 9, 2, 0).getTime();
		assert.equal(new Date(lastMonday3am(earlyMonday)).toString(), new Date(2026, 10, 2, 3, 0).toString());
	});

	it("cannot reach another workspace's memories", async () => {
		const { item: other } = (await t.core.call("memory.save", { content: "别的项目用 Rust", kind: "experience", scope: "workspace", cwd: t.dir })) as { item: MemoryItem };
		t.respond(fauxAssistantMessage("一"));
		await prompt("这个项目用什么语言写比较好呢");
		const results: string[] = [];
		t.respond(
			(c) => {
				const query = fauxToolCall("memory_query", { query: "Rust" });
				void c;
				return fauxAssistantMessage([query], { stopReason: "toolUse" });
			},
			(c) => {
				results.push(JSON.stringify(c.messages.at(-1)));
				return propose({ action: "update", id: other.id, version: 1, content: "别的项目改用 Go", reason: "试试" });
			},
			(c) => {
				results.push(JSON.stringify(c.messages.at(-1)));
				return fauxAssistantMessage("好");
			},
		);
		await extractNow();
		assert.match(results[0]!, /没有找到/);
		assert.match(results[1]!, /被拒绝：不在这次允许的范围里/);
		assert.equal(memory.store.get(other.id)!.content, "别的项目用 Rust");
	});
});
