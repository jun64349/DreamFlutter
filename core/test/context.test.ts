import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type Candidate, candidateProblem, chooseCut, prefixFingerprint } from "../src/agent/background-compaction.ts";
import { CHECKPOINT_NOT_AUTHORITY, CONTEXT_RULES, dshCompactionSettings } from "../src/agent/harness.ts";
import { ContextModule } from "../src/modules/context.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((c) => (c as { text?: string }).text ?? "").join("") : "";
}

/** A synthetic session branch: [kind, size] per entry. */
function branch(spec: (["user" | "assistant" | "toolResult", number] | ["compaction", string])[]) {
	return spec.map(([kind, x], i) =>
		kind === "compaction"
			? ({ type: "compaction", id: `e${i}`, parentId: null, timestamp: "", summary: "s", firstKeptEntryId: x, tokensBefore: 0 } as never)
			: ({ type: "message", id: `e${i}`, parentId: null, timestamp: "", message: { role: kind, content: [{ type: "text", text: "x".repeat((x as number) * 4) }], timestamp: 0, ...(kind === "toolResult" ? { toolCallId: "t", toolName: "pwsh" } : {}) } } as never),
	);
}

describe("background compaction: the program's checks", () => {
	it("cuts before a user or assistant message, never between a tool call and its result, and only after the last checkpoint's kept part", () => {
		const b = branch([
			["user", 1000],
			["assistant", 100],
			["toolResult", 3000],
			["assistant", 100],
			["toolResult", 3000],
			["assistant", 200],
		]);
		const cut = chooseCut(b, 3000)!;
		assert.equal((b[cut] as { message: { role: string } }).message.role, "assistant", "moved back from the tool result to its call");
		assert.equal(cut, 3);
		const after = branch([
			["user", 5000],
			["assistant", 5000],
			["compaction", "e3"],
			["user", 100],
			["assistant", 100],
		]);
		assert.equal(chooseCut(after, 150), undefined, "nothing to cut inside what the context holds now");
	});

	it("drops a candidate whose history, model or instructions changed, or that would not free enough", () => {
		const b = branch([
			["user", 1000],
			["assistant", 1000],
			["user", 1000],
			["assistant", 1000],
		]);
		const candidate: Candidate = { cycle: "start", cutId: "e2", prefix: prefixFingerprint(b, 2), instructions: "i", model: "p/m", summary: "short", covered: 2000, cost: 0, writer: "p/m" };
		const now = { branch: b, instructions: "i", model: "p/m", tokensBefore: 5000, threshold: 4000 };
		assert.equal(candidateProblem(candidate, now), undefined);
		assert.equal(candidateProblem(candidate, { ...now, model: "p/other" }), "model_changed");
		assert.equal(candidateProblem(candidate, { ...now, instructions: "j" }), "instructions_changed");
		assert.equal(candidateProblem(candidate, { ...now, tokensBefore: 9000 }), "too_small");
		const forked = branch([
			["user", 999],
			["assistant", 1000],
			["user", 1000],
			["assistant", 1000],
		]).map((e, i) => (i === 0 ? { ...(e as object), id: "other" } : e)) as never[];
		assert.equal(candidateProblem(candidate, { ...now, branch: forked }), "history_changed");
		assert.equal(candidateProblem(candidate, { ...now, branch: [...b, ...branch([["compaction", "e2"]]).map((e) => ({ ...(e as object), id: "c9" }) as never)] }), "compacted_since");
	});
});

describe("the context service (roadmap 5.12)", () => {
	let t: TestCore;
	let context: ContextModule;
	let seen: Context["messages"][];
	let summaries: number;

	beforeEach(async () => {
		t = await startTestCore();
		context = t.core.module(ContextModule)!;
		seen = [];
		summaries = 0;
		await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
	});

	afterEach(async () => {
		await t.cleanup();
	});

	/** Answers replies with 「好」 and summary requests with a numbered checkpoint. */
	const smart = (context: Context) => {
		seen.push(context.messages);
		const last = textOf(context.messages.at(-1)!.content);
		if (last.includes("compaction engine")) return fauxAssistantMessage(`## Primary Request and Intent\n- 检查点 ${++summaries}`);
		return fauxAssistantMessage("好");
	};
	async function prompt(text: string, slotId = "s1"): Promise<void> {
		const before = settledCount(t.records(slotId));
		await t.send(slotId, { id: `p-${Math.random()}`, type: "prompt", message: text });
		await t.waitFor(() => settledCount(t.records(slotId)) === before + 1, 20_000);
	}
	const sessionId = () => t.core.slots.get("s1")!.session.sessionId;
	const records = () => t.core.db.all<{ kind: string; outcome: string; reason: string | null }>("SELECT kind, outcome, reason FROM context_compactions ORDER BY at, rowid");

	it("sets the threshold as a share of the window, never above dsh's safe one, and keeps less recent history with it", async () => {
		const model = { contextWindow: 200_000, maxTokens: 8_192 };
		const base = dshCompactionSettings(model, true);
		assert.deepEqual(context.settingsFor(undefined, model, base), base, "80% of 200k is above dsh's threshold: dsh's stays");
		t.respond(smart);
		await prompt("你好");
		await t.core.call("context.setSession", { slotId: "s1", thresholdPercent: 50 });
		const own = context.settingsFor(sessionId(), model, base);
		assert.equal(own.reserveTokens, 100_000);
		assert.ok(own.keepRecentTokens <= 40_000);
		await assert.rejects(t.core.call("context.setSession", { slotId: "s1", thresholdPercent: 99 }), /20–95/);
		const info = (await t.core.call("context.info", { slotId: "s1" })) as { thresholdPercent: number; thresholdTokens: number; background: { on: boolean } };
		assert.deepEqual([info.thresholdPercent, info.thresholdTokens, info.background.on], [50, 100_000, false], "background compaction is off in 工作台 by default");
		await t.core.call("context.setSession", { slotId: "s1", thresholdPercent: null, background: true });
		const again = (await t.core.call("context.info", { slotId: "s1" })) as { thresholdPercent: number; background: { on: boolean } };
		assert.deepEqual([again.thresholdPercent, again.background.on], [80, true]);
	});

	it("makes a normal checkpoint by DreamFlutter's rules, says it is no request from the user, and tells that the context is ready", async () => {
		t.respond(smart, smart);
		await prompt("第一件事：不要用 Docker，只在本机跑");
		await prompt("第二件事：测试还没跑过");
		t.messages.length = 0;
		t.respond(smart);
		await t.send("s1", { id: "c", type: "compact" });
		await t.waitFor(() => t.records("s1").find((r) => r.id === "c"));
		const request = textOf(seen.at(-1)!.at(-1)!.content);
		assert.ok(request.includes(CONTEXT_RULES), "negations, unverified work, running jobs");
		assert.ok(t.messages.some((m) => (m as { event?: string }).event === "context.available"), "the 「上下文可用」 event, nothing more");
		t.respond(smart);
		await prompt("继续");
		assert.ok(seen.at(-1)!.some((m) => textOf(m.content).includes(CHECKPOINT_NOT_AUTHORITY)));
		assert.deepEqual({ ...records().at(-1) }, { kind: "manual", outcome: "done", reason: null });
	});

	it("shows a checkpoint's original, takes a report that it is wrong, and writes it again from the original messages", async () => {
		t.respond(smart, smart);
		await prompt("第一件事：论文用 LaTeX 写");
		await prompt("第二件事：图表用 matplotlib 画");
		t.respond(smart);
		await t.send("s1", { id: "c", type: "compact" });
		await t.waitFor(() => t.records("s1").find((r) => r.id === "c"));
		const [checkpoint] = (await t.core.call("context.checkpoints", { slotId: "s1" })) as { entryId: string; summary: string; reported: boolean }[];
		assert.match(checkpoint!.summary, /检查点 1/);
		const original = (await t.core.call("context.original", { slotId: "s1", entryId: checkpoint!.entryId })) as { role: string; text: string }[];
		assert.ok(original.some((m) => m.role === "user" && m.text.includes("LaTeX")));
		await t.core.call("context.report", { slotId: "s1", entryId: checkpoint!.entryId, note: "漏了 LaTeX 这件事" });
		assert.equal(((await t.core.call("context.checkpoints", { slotId: "s1" })) as { reported: boolean }[])[0]!.reported, true);
		t.respond(smart, smart);
		await prompt("第三件事：参考文献用 GB/T 7714");
		await t.core.call("context.regenerate", { slotId: "s1" });
		const request = JSON.stringify(seen.at(-1));
		assert.match(request, /第一件事：论文用 LaTeX 写/, "from the original messages, not only the old summary");
		assert.match(request, /漏了 LaTeX 这件事/, "with what the user said was wrong");
		assert.equal(records().at(-1)!.kind, "regenerate");
		assert.ok(((await t.core.call("context.checkpoints", { slotId: "s1" })) as { reported: boolean }[]).every((c) => !c.reported), "the report is settled");
	});

	/** Turns the session's threshold down to a share of the 200k window and background compaction on. */
	async function smallWindow(): Promise<void> {
		t.respond(smart);
		await prompt("开始");
		t.core.settings.update({ backgroundCompactionLeadPercent: 75 });
		await t.core.call("context.setSession", { slotId: "s1", thresholdPercent: 20, background: true });
	}
	const big = (i: number) => `第 ${i} 段材料：${"字".repeat(20_000)}`;

	it("writes one candidate before the threshold, pays for it, and uses it when the session compacts (no summary call then)", async () => {
		await smallWindow();
		for (let i = 0; i < 40 && !records().some((r) => r.outcome === "made"); i++) {
			t.respond(smart, smart);
			await prompt(big(i));
		}
		await t.waitFor(() => records().some((r) => r.outcome === "made"));
		const madeAt = summaries;
		assert.ok(t.core.slots.get("s1")!.session.sessionManager.getEntries().some((e) => e.type === "usage" && (e as { kind?: string }).kind === "background_compaction"), "its cost is on the session's bill");
		for (let i = 0; i < 20 && !records().some((r) => r.outcome === "used" || r.outcome === "done" || r.outcome === "dropped"); i++) {
			t.respond(smart, smart);
			await prompt(big(100 + i));
		}
		assert.deepEqual(
			records().filter((r) => r.kind === "background").map((r) => [r.outcome, r.reason]),
			[
				["made", null],
				["used", null],
			],
			"one candidate for the cycle, used",
		);
		assert.equal(summaries, madeAt, "no summary call at the compaction itself");
		const [checkpoint] = (await t.core.call("context.checkpoints", { slotId: "s1" })) as { summary: string }[];
		assert.match(checkpoint!.summary, new RegExp(`检查点 ${madeAt}`));
		const stats = (await t.core.call("context.stats", {})) as { background: { made: number; used: number; useRate: number } };
		assert.deepEqual([stats.background.made, stats.background.used, stats.background.useRate], [1, 1, 1]);
	});

	it("does not try again in the same cycle after writing a candidate failed (no repeated spending near the threshold)", async () => {
		await smallWindow();
		let failures = 0;
		const failing = (context: Context) => {
			seen.push(context.messages);
			if (textOf(context.messages.at(-1)!.content).includes("compaction engine")) {
				failures++;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "服务器出错了" });
			}
			return fauxAssistantMessage("好");
		};
		// Small steps: the attempt (and its failure) comes soon after 75% of the threshold, leaving room for more turns.
		const step = (i: number) => `第 ${i} 段材料：${"字".repeat(6_000)}`;
		for (let i = 0; i < 120 && !records().some((r) => r.kind === "background"); i++) {
			t.respond(failing, failing);
			await prompt(step(i));
		}
		await t.waitFor(() => records().some((r) => r.outcome === "failed"));
		const threshold = ((await t.core.call("context.info", { slotId: "s1" })) as { thresholdTokens: number }).thresholdTokens;
		// More turns of the same size before the threshold (still past 75%), in the same cycle: no second attempt.
		let more = 0;
		for (let i = 0; i < 3; i++) {
			const tokens = t.core.slots.get("s1")!.session.getContextUsage()?.tokens ?? 0;
			if (tokens + 2_500 >= threshold) break;
			t.respond(failing, failing);
			await prompt(step(200 + i));
			more++;
		}
		assert.ok(more >= 2, `room for more turns in the cycle (${more})`);
		assert.equal(failures, 1);
		assert.deepEqual(
			records().filter((r) => r.kind === "background").map((r) => r.outcome),
			["failed"],
		);
	});

	it("drops the candidate when the model changed, and after a restart has none to use", async () => {
		await smallWindow();
		for (let i = 0; i < 40 && !records().some((r) => r.outcome === "made"); i++) {
			t.respond(smart, smart);
			await prompt(big(i));
		}
		await t.waitFor(() => records().some((r) => r.outcome === "made"));
		await t.send("s1", { id: "m", type: "set_model", provider: "faux", modelId: "faux-text" });
		await t.waitFor(() => t.records("s1").find((r) => r.id === "m"));
		for (let i = 0; i < 20 && !records().some((r) => r.kind !== "background" || r.outcome !== "made"); i++) {
			t.respond(smart, smart, smart);
			await prompt(big(100 + i));
		}
		const after = records();
		assert.ok(after.some((r) => r.kind === "background" && r.outcome === "dropped" && r.reason === "model_changed"), JSON.stringify(after));
		assert.ok(after.some((r) => r.kind === "normal" && r.outcome === "done"), "a normal summary instead");
	});

	it("loses a candidate on restart: the session compacts the normal way", async () => {
		await smallWindow();
		for (let i = 0; i < 40 && !records().some((r) => r.outcome === "made"); i++) {
			t.respond(smart, smart);
			await prompt(big(i));
		}
		await t.waitFor(() => records().some((r) => r.outcome === "made"));
		const file = t.core.slots.get("s1")!.session.sessionFile!;
		await t.core.call("slot.close", { slotId: "s1" });
		await t.core.call("slot.open", { slotId: "s2", cwd: t.workspace, sessionFile: file }, t.client);
		await t.core.call("context.setSession", { slotId: "s2", thresholdPercent: 20, background: false });
		for (let i = 0; i < 20 && !records().some((r) => r.kind === "normal"); i++) {
			t.respond(smart, smart);
			await prompt(big(100 + i), "s2");
		}
		assert.ok(!records().some((r) => r.outcome === "used"), "the candidate written before the restart is never used");
		assert.ok(records().some((r) => r.kind === "normal" && r.outcome === "done"));
	});
});
