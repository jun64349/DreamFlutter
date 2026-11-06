import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Db } from "../src/db.ts";
import { runMemoryAgent } from "../src/memory/agent.ts";
import { MemoryJobs, PRIORITY } from "../src/memory/jobs.ts";
import { MEMORY_SHUTDOWN_TIMEOUT_MS } from "../src/memory/work.ts";
import { TaskViews } from "../src/memory/tasks.ts";
import { MemoryModule } from "../src/modules/memory.ts";
import { startTestCore } from "./harness.ts";

describe("review: memory lifecycle", () => {
	for (const shutdown of [false, true]) {
		it(`cancels boundary checks on ${shutdown ? "shutdown" : "timeout"} and bills a late response`, async () => {
			const t = await startTestCore();
			const keepAlive = setTimeout(() => {}, 12_000);
			try {
				const memory = t.core.module(MemoryModule)!;
				await t.core.call("slot.open", { slotId: "s", cwd: t.workspace }, t.client);
				const runtime = t.core.slot("s").session.modelRuntime;
				let started!: () => void;
				const ready = new Promise<void>((resolve) => { started = resolve; });
				let cancelled = false;
				runtime.completeSimple = (async (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => {
					assert.ok(options.signal);
					started();
					await new Promise<void>((resolve) => options.signal!.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
					return { ...answer(), content: [{ type: "text", text: '{"new_task":true,"confidence":1}' }] };
				}) as typeof runtime.completeSimple;
				const decision = memory.work.classifyBoundary({ taskPrompt: "old", recent: "", prompt: "new", cwd: t.workspace });
				await ready;
				if (shutdown) await memory.work.stop();
				assert.equal(await decision, undefined, "late decisions never switch tasks");
				await memory.work.stop();
				assert.ok(cancelled);
				assert.equal(memory.work.spentToday(), 0.01, "returned usage is charged even after the deadline");
			} finally { clearTimeout(keepAlive); await t.cleanup(); }
		});
	}

	it("core shutdown aborts an active memory call and settles its queue before closing the database", async () => {
		const t = await startTestCore();
		try {
			const memory = t.core.module(MemoryModule)!;
			const saved = memory.store.commit({ actor: "user", ops: [{ kind: "add", item: { content: "用户正在编写测试", kind: "progress", level: 1, scope: "global", confidence: "user_explicit" } }] });
			assert.equal(saved.applied.length, 1);
			await t.core.call("slot.open", { slotId: "s", cwd: t.workspace }, t.client);
			const runtime = t.core.slot("s").session.modelRuntime;
			let started!: () => void;
			const ready = new Promise<void>((resolve) => { started = resolve; });
			let cancelled = false;
			runtime.completeSimple = (async (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => {
				assert.ok(options.signal, "shutdown signal reaches the actual model call");
				started();
				await new Promise<void>((resolve) => options.signal!.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
				return answer(true); // A transport may still deliver a response after abort.
			}) as typeof runtime.completeSimple;
			const job = memory.work.jobs.enqueue({ kind: "review", scopeKey: "global", priority: 100, payload: { level: 1 } });
			const drain = memory.work.drain();
			await ready;
			await memory.work.stop();
			await drain;
			assert.ok(cancelled);
			const interrupted = memory.work.jobs.get(job.id)!;
			assert.equal(interrupted.status, "queued");
			assert.equal(interrupted.attempts, 0, "shutdown is not a failed attempt");
			assert.ok(interrupted.runAfter <= Date.now(), "no failure backoff on shutdown");
			assert.equal(interrupted.costUsd, 0.01);
			await t.core.shutdown();
		} finally { await t.cleanup(); }
	});

	it("three shutdown interruptions keep a job retryable and preserve each execution's cost", async () => {
		let t = await startTestCore();
		try {
			const memory = t.core.module(MemoryModule)!;
			memory.store.commit({ actor: "user", ops: [{ kind: "add", item: { content: "用户正在编写测试", kind: "progress", level: 1, scope: "global", confidence: "user_explicit" } }] });
			const job = memory.work.jobs.enqueue({ kind: "review", scopeKey: "global", priority: PRIORITY.extract, payload: { level: 1 } });
			for (let pass = 0; pass < 4; pass++) {
				const work = t.core.module(MemoryModule)!.work;
				await t.core.call("slot.open", { slotId: "s", cwd: t.workspace }, t.client);
				const runtime = t.core.slot("s").session.modelRuntime;
				const ready = gate();
				runtime.completeSimple = (async (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => {
					ready.resolve();
					if (pass < 3) await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
					return answer();
				}) as typeof runtime.completeSimple;
				t.core.settings.update({ memoryPaused: false });
				const draining = work.drain();
				await ready.promise;
				if (pass < 3) await work.stop();
				await draining;
				const state = work.jobs.get(job.id)!;
				assert.equal(state.status, pass < 3 ? "queued" : "done");
				assert.equal(state.attempts, pass < 3 ? 0 : 1);
				assert.ok(state.runAfter <= Date.now());
				assert.equal(state.costUsd, (pass + 1) * 0.01);
				assert.equal(work.spentToday(), state.costUsd, "earlier interrupted executions must not be overwritten");
				if (pass < 3) {
					t.core.settings.update({ memoryPaused: true });
					t = await t.reopen();
				}
			}
		} finally { await t.cleanup(); }
	});

	for (const phase of ["runtime", "catalog", "request", "boundary", "gateway"] as const) {
		it(`bounds shutdown when ${phase} ignores cancellation and isolates late completion`, async (ctx) => {
			const ready = gate();
			const late = gate();
			let calls = 0;
			const t = await startTestCore(undefined, phase === "gateway" ? { gatewayTransport: () => {
				const stream = createAssistantMessageEventStream();
				calls++;
				ready.resolve();
				void late.promise.then(() => {
					stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("done") });
					stream.end();
				});
				return stream;
			} } : {});
			try {
				const memory = t.core.module(MemoryModule)!;
				memory.store.commit({ actor: "user", ops: [{ kind: "add", item: { content: "用户正在编写测试", kind: "progress", level: 1, scope: "global", confidence: "user_explicit" } }] });
				await t.core.call("slot.open", { slotId: "s", cwd: t.workspace }, t.client);
				const runtime = t.core.slot("s").session.modelRuntime;
				if (phase === "gateway") {
					const channel = await t.core.call("gateway.saveChannel", { name: "shutdown probe", platform: "custom", api: "openai-completions", baseUrl: "http://test.invalid", models: [{ id: "m", contextWindow: 8192, maxTokens: 4096 }], keys: [{ secret: "test-only" }] }) as { id: string };
					t.core.settings.update({ memoryModel: `df-${channel.id}/m` });
				} else {
					runtime.completeSimple = (async () => { calls++; ready.resolve(); await late.promise; return answer(true); }) as unknown as typeof runtime.completeSimple;
				}
				if (phase === "runtime") {
					const llm = (memory.work as unknown as { llm: { runtime: () => Promise<typeof runtime> } }).llm;
					llm.runtime = async () => { ready.resolve(); await late.promise; return runtime; };
				} else if (phase === "catalog") {
					const available = await runtime.getAvailable();
					runtime.getAvailable = async () => { ready.resolve(); await late.promise; return available; };
				}
				const job = phase === "boundary" ? undefined : memory.work.jobs.enqueue({ kind: "review", scopeKey: "global", priority: 100, payload: { level: 1 } });
				const pending = phase === "boundary"
					? memory.work.classifyBoundary({ taskPrompt: "old", recent: "", prompt: "new", cwd: t.workspace })
					: memory.work.drain();
				await ready.promise;
				ctx.mock.timers.enable({ apis: ["setTimeout"] });
				let stopped = false;
				const stopping = memory.work.stop().then(() => { stopped = true; });
				ctx.mock.timers.tick(MEMORY_SHUTDOWN_TIMEOUT_MS - 1);
				await Promise.resolve();
				assert.equal(stopped, false, "allow the full grace period for returned usage");
				ctx.mock.timers.tick(1);
				await stopping;
				ctx.mock.timers.reset();
				await pending;
				if (job) {
					assert.equal(memory.work.jobs.get(job.id)!.status, "queued");
					assert.equal(memory.work.jobs.get(job.id)!.attempts, 0);
				}
				assert.equal(memory.work.spentToday(), 0, "unreturned usage is unknown, not invented");
				await t.core.shutdown();
				const write = ctx.mock.method(t.core.db, "run", () => { throw new Error("late database write"); });
				late.resolve();
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.equal(write.mock.callCount(), 0, "no database writes after shutdown");
				assert.equal(calls, phase === "runtime" || phase === "catalog" ? 0 : 1);
			} finally { ctx.mock.timers.reset(); await t.cleanup(); }
		});
	}

	it("does not call the model when already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		const run = await runMemoryAgent({
			runtime: { completeSimple: async () => { calls++; return answer(); } } as never,
			model: { provider: "p", id: "m" } as never, system: "", input: "", signal: controller.signal,
			handlers: { query: () => "", propose: () => "" },
		});
		assert.equal(calls, 0);
		assert.equal(run.stoppedBy, "error");
	});

	it("does not apply a late tool response after cancellation, but preserves its usage", async () => {
		const controller = new AbortController();
		let writes = 0;
		const run = await runMemoryAgent({
			runtime: { completeSimple: async () => { controller.abort(); return answer(true); } } as never,
			model: { provider: "p", id: "m" } as never, system: "", input: "", signal: controller.signal,
			handlers: { query: () => "", propose: () => { writes++; return "ok"; } }, maxTurns: 1,
		});
		assert.equal(writes, 0);
		assert.equal(run.usage.cost, 0.01);
		assert.equal(run.stoppedBy, "error");
	});

	it("returns earlier usage when a later model call throws", async () => {
		let calls = 0;
		const run = await runMemoryAgent({
			runtime: { completeSimple: async () => { if (++calls === 2) throw new Error("transport failed"); return answer(true); } } as never,
			model: { provider: "p", id: "m" } as never, system: "", input: "",
			handlers: { query: () => "", propose: () => "ok" },
		});
		assert.equal(run.stoppedBy, "error");
		assert.equal(run.error, "transport failed");
		assert.equal(run.usage.cost, 0.01);
		assert.equal(run.calls.length, 1);
	});

	it("stopping an idle queue never starts even a correction job", async () => {
		const db = new Db(":memory:");
		try {
			let calls = 0;
			const jobs = new MemoryJobs(db, Date.now, { run: async () => { calls++; return { status: "done" }; }, budgetLeft: () => 1, paused: () => false, nextBudgetAt: () => 0 });
			const job = jobs.enqueue({ kind: "review", scopeKey: "global", priority: PRIORITY.correction });
			await jobs.stop();
			await jobs.drain();
			assert.equal(calls, 0);
			assert.equal(jobs.get(job.id)!.status, "queued");
		} finally { db.close(); }
	});

	it("stopping a busy queue waits for its active job and leaves the next job queued", async () => {
		const db = new Db(":memory:");
		try {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => { release = resolve; });
			let calls = 0;
			const jobs = new MemoryJobs(db, Date.now, { run: async () => { calls++; await gate; return { status: "done" }; }, budgetLeft: () => 1, paused: () => false, nextBudgetAt: () => 0 });
			jobs.enqueue({ kind: "review", scopeKey: "global", priority: 100 });
			const next = jobs.enqueue({ kind: "review", scopeKey: "global", priority: 90 });
			const drain = jobs.drain();
			let stopped = false;
			const stopping = jobs.stop().then(() => { stopped = true; });
			await Promise.resolve();
			assert.equal(stopped, false);
			release();
			await Promise.all([drain, stopping]);
			assert.equal(calls, 1);
			assert.equal(jobs.get(next.id)!.status, "queued");
		} finally { db.close(); }
	});

	it("keeps the current task active if inserting its replacement fails", () => {
		const db = new Db(":memory:");
		try {
			const tasks = new TaskViews(db, Date.now);
			const input = { sessionId: "s", scopeKey: "global", reason: "user_marked" as const, prompt: "first" };
			const first = tasks.start(input);
			db.raw.exec("CREATE TRIGGER reject_new_task BEFORE INSERT ON memory_task_views BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END");
			assert.throws(() => tasks.start({ ...input, prompt: "second" }), /simulated write failure/);
			assert.equal(tasks.current("s")?.id, first.id);
			assert.equal(tasks.list("s").length, 1);
		} finally { db.close(); }
	});
});

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function answer(tool = false) {
	return { role: "assistant", content: tool ? [{ type: "toolCall", id: "x", name: "memory_propose_ops", arguments: { ops: [] } }] : [{ type: "text", text: "done" }], stopReason: tool ? "toolUse" : "stop", usage: { input: 1, output: 1, cost: { total: 0.01 } } };
}
