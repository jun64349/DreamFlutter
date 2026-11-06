import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { MemoryJob } from "../src/memory/jobs.ts";
import { conflictScore, failedOutput, lastMonthStart3am, possibleConflicts, promotionBlock, toolIdentifiers, unavailableClaim } from "../src/memory/lifecycle.ts";
import type { LogDay, MemoryItem, NewItem, SourceInput } from "../src/memory/types.ts";
import { MemoryModule } from "../src/modules/memory.ts";
import type { Slot } from "../src/slots/slot.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

const DAY = 86_400_000;
const propose = (...ops: Record<string, unknown>[]) => fauxAssistantMessage([fauxToolCall("memory_propose_ops", { ops: ops as never })], { stopReason: "toolUse" });

describe("memory lifecycle: the program's checks", () => {
	it("prefilters contradictions: same subject, negation or numbers differ (17.6)", () => {
		assert.ok(conflictScore("用户希望回复用中文", "用户不要用中文回复") > 0, "negation flips the meaning");
		assert.ok(conflictScore("用户答辩在十二月", "用户答辩在11月") > 0, "different month");
		assert.equal(conflictScore("用户答辩在十二月", "用户答辩在12月"), 0, "the same number written two ways");
		assert.equal(conflictScore("用户喜欢喝茶", "用户不喜欢咖啡"), 0, "different things");
		assert.equal(conflictScore("用户希望回复用中文", "用户希望回复用中文"), 0, "the same thing");
		assert.equal(conflictScore("用户在写毕业论文", "项目用 Rust 写，不用 Go"), 0);
		assert.ok(conflictScore("Always reply in English", "Never reply in English") > 0);
		const among = [
			{ id: "a", content: "用户喜欢喝咖啡" },
			{ id: "b", content: "用户不要用中文回复" },
		];
		assert.deepEqual(
			possibleConflicts("用户希望回复用中文", among).map((m) => m.id),
			["b"],
		);
	});

	it("knows what a successful tool call shows works, and when it did not succeed", () => {
		assert.deepEqual(toolIdentifiers("pwsh", { command: "cd docs && pandoc a.md -o a.pdf" }), ["pandoc"]);
		assert.deepEqual(toolIdentifiers("pwsh", { command: "pandoc a.md; echo ok" }), [], "after `;` only the last statement's exit status counts");
		assert.deepEqual(toolIdentifiers("bash", { command: "npx tsc --noEmit | head" }), ["tsc"]);
		assert.deepEqual(toolIdentifiers("pwsh", { command: "& \"C:\\tools\\ffmpeg.exe\" -i a.mp4 b.mp3" }), ["ffmpeg"]);
		assert.deepEqual(toolIdentifiers("web_fetch", { url: "https://www.example.org/page" }), ["web_fetch", "example.org"]);
		assert.ok(failedOutput("something\n[exit code: 1]"));
		assert.ok(failedOutput("pandoc : 无法将“pandoc”项识别为 cmdlet、函数、脚本文件或可运行程序的名称"));
		assert.ok(!failedOutput("pandoc 3.1.2\n[exit code: 0]"));
		assert.ok(unavailableClaim("pandoc 在这台电脑上用不了"));
		assert.ok(unavailableClaim("example.org 需要代理才能访问"));
		assert.ok(!unavailableClaim("pandoc 转中文 PDF 会失败，要加 --pdf-engine=xelatex"), "a lesson about a failure is not a claim that the tool is unavailable");
	});

	it("checks the evidence for a level change (§3, §12 item 3)", () => {
		const now = new Date(2026, 10, 30).getTime();
		const item = (extra: Partial<MemoryItem>): MemoryItem =>
			({ id: "m", version: 1, level: 1, kind: "experience", content: "x", conditions: null, scope: "global", workspaceId: null, groupId: null, confidence: "agent_inferred", status: "active", pinned: false, retention: "normal", autoOk: true, createdAt: now - 10 * DAY, updatedAt: now, ...extra }) as MemoryItem;
		const s = (ref: string) => ({ kind: "session" as const, ref, excerpt: null, at: now });
		assert.match(promotionBlock(item({ createdAt: now - 3 * DAY }), 2, [s("a"), s("b")], now)!, /满 7 天/);
		assert.match(promotionBlock(item({}), 2, [s("a"), s("a")], now)!, /2 个不同的会话/, "the same session twice is one source");
		assert.equal(promotionBlock(item({}), 2, [s("a"), s("b")], now), undefined);
		assert.equal(promotionBlock(item({ kind: "decision" }), 2, [s("a")], now), undefined, "a decision");
		assert.equal(promotionBlock(item({ confidence: "user_confirmed" }), 2, [], now), undefined, "the user confirmed it");
		assert.match(promotionBlock(item({}), 3, [s("a"), s("b")], now)!, /一次只能升一级/);
		const l2 = (extra: Partial<MemoryItem>) => item({ level: 2, createdAt: now - 40 * DAY, confidence: "user_explicit", conditions: "写论文时", ...extra });
		assert.equal(promotionBlock(l2({}), 3, [s("a"), s("b")], now), undefined);
		assert.match(promotionBlock(l2({ createdAt: now - 20 * DAY }), 3, [s("a"), s("b")], now)!, /满 30 天/);
		assert.match(promotionBlock(l2({ confidence: "agent_inferred" }), 3, [s("a"), s("b")], now)!, /用户明说/);
		assert.match(promotionBlock(l2({ conditions: null }), 3, [s("a"), s("b")], now)!, /适用条件/);
		assert.match(promotionBlock(l2({}), 3, [s("a")], now)!, /2 个任务或会话/);
		assert.equal(promotionBlock(l2({}), 1, [], now), undefined, "lowering is always allowed");
	});

	it("knows where months, quarters and years start", () => {
		const at = new Date(2026, 10, 15, 12).getTime();
		assert.equal(new Date(lastMonthStart3am(at)).toString(), new Date(2026, 10, 1, 3).toString());
		assert.equal(new Date(lastMonthStart3am(at, 3)).toString(), new Date(2026, 9, 1, 3).toString());
		assert.equal(new Date(lastMonthStart3am(at, 12)).toString(), new Date(2026, 0, 1, 3).toString());
		const newYearsNight = new Date(2027, 0, 1, 1).getTime();
		assert.equal(new Date(lastMonthStart3am(newYearsNight, 3)).toString(), new Date(2026, 9, 1, 3).toString(), "before 03:00 it is still the last quarter");
	});
});

describe("memory lifecycle in the core", () => {
	let t: TestCore;
	let memory: MemoryModule;
	let time: number;

	beforeEach(async () => {
		t = await startTestCore();
		memory = t.core.module(MemoryModule)!;
		time = new Date(2026, 10, 4, 10, 0).getTime(); // a Wednesday
		memory.clock = () => time;
		await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
	});

	afterEach(async () => {
		await t.cleanup();
	});

	const add = (item: Partial<NewItem> & { content: string }, actor: "memory_agent" | "user" | "main_agent" = "memory_agent", sources: SourceInput[] = []) =>
		memory.store.commit({ actor, ops: [{ kind: "add", item: { kind: "experience", level: 1, scope: "global", confidence: "agent_inferred", ...item }, sources }] }).applied[0]!.itemId;
	const get = (id: string) => memory.store.get(id)!;
	const jobs = async () => (await t.core.call("memory.jobs", {})) as MemoryJob[];
	const runJobs = () => t.core.call("memory.runJobs", {});
	const slot = () => t.core.slots.get("s1") as Slot;
	async function prompt(text: string): Promise<void> {
		const before = settledCount(t.records("s1"));
		await t.send("s1", { id: `p-${Math.random()}`, type: "prompt", message: text });
		await t.waitFor(() => settledCount(t.records("s1")) === before + 1);
	}

	it("ends what ran out of validity, out of the snapshot, and it can be restored (17.3)", async () => {
		const id = add({ content: "用户这周在赶论文，回复要尽量短", kind: "preference", level: 2, validUntil: time + 2 * DAY });
		assert.ok(memory.snapshot("帮我看看论文", t.workspace).ids.includes(id));
		time += 3 * DAY;
		assert.ok(!memory.snapshot("帮我看看论文", t.workspace).ids.includes(id), "swept before the snapshot is put together");
		assert.equal(get(id).status, "ended");
		const log = (await t.core.call("memory.log", {})) as LogDay[];
		const entry = log[0]!.entries.find((e) => e.itemId === id)!;
		assert.deepEqual([entry.actor, entry.batchKind, entry.after.status], ["system", "expire", "ended"]);
		assert.match(entry.reason!, /有效期到了/);
		await t.core.call("memory.undo", { opId: entry.opId });
		assert.equal(get(id).status, "active", "restored from the memory log");
		time += DAY;
		memory.snapshot("帮我看看论文", t.workspace);
		assert.equal(get(id).status, "active", "the user's restore stays");
	});

	it("only marks locked and level-3 items for review when they run out, once (17.3)", async () => {
		const locked = add({ content: "用户锁定的一条安排", kind: "agreement", level: 2, validUntil: time + DAY });
		memory.store.commit({ actor: "user", ops: [{ kind: "edit", id: locked, patch: { retention: "locked" } }] });
		const long = add({ content: "用户的长期背景：在读研究生", kind: "background", level: 3, confidence: "user_explicit", validUntil: time + DAY }, "user");
		const notices: unknown[] = [];
		t.messages.length = 0;
		time += 2 * DAY;
		await runJobs();
		assert.deepEqual([get(locked).status, get(long).status], ["review", "review"]);
		assert.equal(get(locked).content, "用户锁定的一条安排");
		for (const m of t.messages) if ((m as { event?: string }).event === "memory.notice") notices.push(m);
		assert.equal(notices.length, 1, "the user is told");
		// The user looks and keeps them: the next sweep leaves them alone.
		await t.core.call("memory.setStatus", { id: locked, status: "active" });
		await t.core.call("memory.setStatus", { id: long, status: "active" });
		time += DAY;
		await runJobs();
		assert.deepEqual([get(locked).status, get(long).status], ["active", "active"]);
	});

	it("gives a judgment about a tool 30 days when the background gave none (17.3)", () => {
		const agentSaid = add({ content: "pandoc 在这台电脑上用不了", kind: "observation" });
		assert.equal(get(agentSaid).validUntil, time + 30 * DAY);
		const userSaid = add({ content: "用户说 ffmpeg 装在 D 盘", kind: "observation", confidence: "user_explicit", level: 2 }, "user");
		assert.equal(get(userSaid).validUntil, null, "what the user wrote is left as written");
		const given = add({ content: "某网站这周要代理", kind: "observation", validUntil: time + 5 * DAY });
		assert.equal(get(given).validUntil, time + 5 * DAY);
	});

	it("refutes 「某工具用不了」 when that tool then runs fine, with the call as evidence (17.3)", () => {
		const claim = add({ content: "pandoc 在这台电脑上用不了", kind: "observation" });
		const other = add({ content: "ffmpeg 没装", kind: "observation" });
		const lesson = add({ content: "用户说 pandoc 要是用不了就改用 Word", kind: "preference", level: 2 });
		const call = (id: string, command: string, output: string) => {
			memory.onSlotEvent(slot(), { type: "tool_execution_start", toolCallId: id, toolName: "pwsh", args: { command } } as never);
			memory.onSlotEvent(slot(), { type: "tool_execution_end", toolCallId: id, toolName: "pwsh", result: { content: [{ type: "text", text: output }] }, isError: false } as never);
		};
		call("1", "pandoc a.md -o a.pdf", "pandoc : 无法将“pandoc”项识别为 cmdlet\n[exit code: 1]");
		assert.equal(get(claim).status, "active", "a failed run proves nothing");
		call("2", "pandoc --version", "pandoc 3.1.2");
		assert.equal(get(claim).status, "refuted");
		assert.equal(get(other).status, "active", "another tool");
		assert.equal(get(lesson).status, "active", "a preference is not a claim about the tool working");
		const evidence = memory.store.sources(claim).find((s) => s.kind === "tool")!;
		assert.match(evidence.excerpt!, /pandoc --version/);
		const op = t.core.db.get<{ actor: string; kind: string }>("SELECT o.actor, b.kind FROM memory_ops o JOIN memory_batches b ON b.id = o.batch_id WHERE o.item_id = ? ORDER BY o.rowid DESC LIMIT 1", claim)!;
		assert.deepEqual([op.actor, op.kind], ["system", "refute"]);
	});

	it("only marks a locked tool judgment for review and hands the refutation to the user", () => {
		const claim = add({ content: "ffmpeg 用不了", kind: "observation", level: 2 });
		memory.store.commit({ actor: "user", ops: [{ kind: "edit", id: claim, patch: { retention: "locked" } }] });
		memory.onSlotEvent(slot(), { type: "tool_execution_start", toolCallId: "1", toolName: "pwsh", args: { command: "ffmpeg -version" } } as never);
		memory.onSlotEvent(slot(), { type: "tool_execution_end", toolCallId: "1", toolName: "pwsh", result: { content: [{ type: "text", text: "ffmpeg version 7" }] }, isError: false } as never);
		assert.equal(get(claim).status, "review");
		assert.equal(memory.store.pending()[0]!.why, "locked");
	});

	it("lets the background raise a level only on enough evidence; the user and lowering are not limited", () => {
		const s = (ref: string): SourceInput => ({ kind: "session", ref });
		const id = add({ content: "用户写代码习惯先写测试" }, "memory_agent", [s("a.jsonl")]);
		const raise = (level: 1 | 2 | 3) => memory.store.commit({ actor: "memory_agent", ops: [{ kind: "edit", id, baseVersion: get(id).version, patch: { level } }] });
		assert.match(raise(2).rejected[0]!.reason, /满 7 天/);
		time += 8 * DAY;
		assert.match(raise(2).rejected[0]!.reason, /2 个不同的会话/);
		memory.store.commit({ actor: "memory_agent", ops: [{ kind: "edit", id, baseVersion: get(id).version, patch: { lastVerifiedAt: time }, sources: [s("b.jsonl")] }] });
		assert.equal(raise(2).applied.length, 1);
		assert.equal(get(id).level, 2);
		assert.match(raise(3).rejected[0]!.reason, /满 30 天/);
		assert.equal(raise(1).applied.length, 1, "lowering");
		memory.store.commit({ actor: "user", ops: [{ kind: "edit", id, patch: { level: 3 } }] });
		assert.deepEqual([get(id).level, get(id).retention], [3, "long"], "the user decides freely");
	});

	it("lets a review mark a locked item as checked without handing anything to the user", () => {
		const id = add({ content: "锁定的约定：周报周五发", kind: "agreement", level: 2 });
		memory.store.commit({ actor: "user", ops: [{ kind: "edit", id, patch: { retention: "locked" } }] });
		const result = memory.store.commit({ actor: "memory_agent", ops: [{ kind: "edit", id, baseVersion: get(id).version, patch: { lastVerifiedAt: time } }] });
		assert.equal(result.applied.length, 1);
		assert.equal(memory.store.pending().length, 0);
		assert.equal(get(id).status, "active");
	});

	it("reviews level 2 on its calendar: nothing new, no model; the largest review due covers the rest; promotes on evidence", async () => {
		const id = add({ content: "用户写论文时引用一律用 GB/T 7714", kind: "agreement", level: 2, confidence: "user_explicit", conditions: "写论文时" }, "user", [
			{ kind: "session", ref: "a.jsonl" },
			{ kind: "session", ref: "b.jsonl" },
		]);
		await runJobs(); // first look: counting starts now
		time += 6 * DAY; // past Monday 03:00; nothing changed
		await runJobs();
		assert.equal((await jobs()).length, 0, "no model call without a change");
		// 2026-11-10 → 2027-01-04: a new month, a new quarter and a new week all at once.
		time = new Date(2027, 0, 4, 10).getTime();
		const seen: string[] = [];
		t.respond(
			(c) => {
				seen.push(JSON.stringify(c.messages));
				return propose({ action: "promote", id, version: get(id).version, reason: "两次对话都这么说，长期有效" });
			},
			fauxAssistantMessage("升到了三级。"),
		);
		await runJobs();
		const list = await jobs();
		assert.equal(list.length, 1, "one review covers the month and the week");
		assert.deepEqual([list[0]!.kind, list[0]!.payload.period, list[0]!.payload.light, list[0]!.status], ["review", "quarter", false, "done"]);
		assert.match(seen[0]!, /可以升到 3 级/);
		assert.match(seen[0]!, /每季/);
		assert.deepEqual([get(id).level, get(id).retention], [3, "long"]);
		const log = (await t.core.call("memory.log", {})) as LogDay[];
		assert.equal(log[0]!.entries[0]!.batchKind, "review");
		// Its own change is not a reason for the next review.
		time += 7 * DAY;
		await runJobs();
		assert.equal((await jobs()).length, 1);
	});

	it("reviews level 3 lightly each month only when something changed or conflicts", async () => {
		const id = add({ content: "用户是计算机专业的研究生", kind: "background", level: 3, confidence: "user_explicit" }, "user");
		await runJobs();
		time = new Date(2026, 11, 2, 10).getTime(); // a new month
		await runJobs();
		assert.equal((await jobs()).length, 0);
		memory.store.markUsed([id, id, id]);
		time = new Date(2027, 0, 5, 10).getTime();
		await runJobs();
		assert.equal((await jobs()).length, 0, "being shown many times is not a change (17.11)");
		assert.equal(get(id).status, "active");
		time += 3_600_000;
		await t.core.call("memory.update", { id, content: "用户是计算机专业的博士研究生" });
		time = new Date(2027, 1, 2, 10).getTime();
		const seen: string[] = [];
		t.respond(
			(c) => {
				seen.push(JSON.stringify(c.messages));
				time += 60_000; // the review takes a while: its change is after the review started
				return propose({ action: "keep", id, version: get(id).version, reason: "用户刚改过，没问题" });
			},
			fauxAssistantMessage("没问题。"),
		);
		await runJobs();
		const [job] = await jobs();
		assert.deepEqual([job!.payload.level, job!.payload.period, job!.payload.light], [3, "month", true]);
		assert.match(seen[0]!, /轻量复查/);
		assert.equal(get(id).lastVerifiedAt, time);
		time = new Date(2027, 2, 2, 10).getTime();
		await runJobs();
		assert.equal((await jobs()).length, 1, "the review's own 「核对过」 is not a change");
	});

	it("checks new text against the items next to it and asks the agent only on a likely contradiction (17.6)", async () => {
		t.core.settings.update({ memoryAutoExtract: true });
		const first = ((await t.core.call("memory.save", { content: "用户希望回复用中文", kind: "preference" })) as { item: MemoryItem }).item;
		await t.core.call("memory.save", { content: "用户喜欢喝茶", kind: "preference" });
		assert.equal((await jobs()).length, 0, "nothing contradicts");
		const second = ((await t.core.call("memory.save", { content: "用户不要用中文回复", kind: "preference" })) as { item: MemoryItem }).item;
		const [job] = await jobs();
		assert.deepEqual([job!.kind, job!.payload.trigger, job!.payload.itemIds], ["conflict", "write", [second.id, first.id]]);
		const results: string[] = [];
		t.respond(
			propose({ action: "conflict", id: first.id, version: 1, with: second.id, reason: "两条正好相反，不知道哪条是现在的意思" }),
			(c) => {
				results.push(JSON.stringify(c.messages.at(-1)));
				return fauxAssistantMessage("交给用户看了。");
			},
		);
		await runJobs();
		assert.equal(get(first.id).status, "review");
		assert.deepEqual(
			memory.store.links(first.id).map((l) => [l.from, l.to, l.kind]),
			[[first.id, second.id, "conflicts"]],
		);
		assert.match(results[0]!, /1\. 已生效/);
		assert.equal((await jobs()).length, 1, "the check's own change starts no new check");
	});

	it("is off with background tidying off", async () => {
		t.core.settings.update({ memoryAutoExtract: false });
		await t.core.call("memory.save", { content: "用户希望回复用中文", kind: "preference" });
		await t.core.call("memory.save", { content: "用户不要用中文回复", kind: "preference" });
		assert.equal((await jobs()).length, 0);
	});

	it("asks the agent to look again at a recalled memory the conversation contradicts, and only then (17.4)", async () => {
		const pref = add({ content: "用户希望回复用中文", kind: "preference", level: 2, confidence: "user_explicit" }, "user");
		t.core.settings.update({ memoryAutoExtract: true });
		// A task that uses it without contradicting it: extraction only.
		t.respond(fauxAssistantMessage("好的。"), fauxAssistantMessage("没有要记的。"));
		await prompt("帮我写一段中文的项目介绍吧");
		await t.waitFor(() => t.core.db.get("SELECT 1 FROM memory_jobs WHERE kind = 'extract' AND status = 'done'"));
		assert.ok(!(await jobs()).some((j) => j.kind === "conflict"));
		// The user now says the opposite.
		const seen: string[] = [];
		t.respond(fauxAssistantMessage("Sure."), fauxAssistantMessage("没有要记的。"), (c) => {
			seen.push(JSON.stringify(c.messages));
			return propose({ action: "set_status", id: pref, version: get(pref).version, status: "outdated", reason: "用户说以后不要用中文回复" });
		}, fauxAssistantMessage("标为过时。"));
		await prompt("以后不要用中文回复了，改用英文。");
		const job = await t.waitFor(() => t.core.db.get<{ status: string; payload: string }>("SELECT status, payload FROM memory_jobs WHERE kind = 'conflict' AND status IN ('done', 'skipped', 'failed')"));
		assert.equal(job.status, "done");
		assert.match(JSON.parse(job.payload).excerpt, /不要用中文回复/);
		assert.match(seen[0]!, /用到的记忆/);
		assert.equal(get(pref).status, "outdated");
		const batch = t.core.db.get<{ kind: string }>("SELECT b.kind FROM memory_ops o JOIN memory_batches b ON b.id = o.batch_id WHERE o.item_id = ? ORDER BY o.rowid DESC LIMIT 1", pref)!;
		assert.equal(batch.kind, "conflict");
	});

	it("counts the user saying the same thing in another conversation as another source, not a second item", async () => {
		t.core.settings.update({ memoryAutoExtract: true });
		const id = add({ content: "用户喜欢先写测试再写代码", kind: "preference" }, "memory_agent", [{ kind: "session", ref: "old.jsonl" }]);
		const results: string[] = [];
		t.respond(
			fauxAssistantMessage("好。"),
			propose({ action: "add", kind: "preference", content: "用户喜欢先写测试再写代码", said: true, reason: "用户又说了" }),
			(c) => {
				results.push(JSON.stringify(c.messages.at(-1)));
				return fauxAssistantMessage("记下了来源。");
			},
		);
		await prompt("我还是习惯先写测试再写代码，你照这个来");
		await t.waitFor(() => t.core.db.get("SELECT 1 FROM memory_jobs WHERE kind = 'extract' AND status = 'done'"));
		assert.match(results[0]!, /记下了这次也是来源/);
		assert.equal(memory.store.list().length, 1);
		assert.equal(new Set(memory.store.sources(id).map((s) => s.ref)).size, 2);
	});
});
