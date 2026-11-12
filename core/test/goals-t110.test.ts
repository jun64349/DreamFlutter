import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { GoalsModule, type GoalScheduler } from "../src/modules/goals.ts";
import { allowedTool } from "../src/modules/goals/acceptance.ts";
import { TasksModule } from "../src/modules/tasks.ts";
import { startTestCore, type TestCore } from "./harness.ts";

type Detail = ReturnType<GoalScheduler["detail"]>;
const rates = { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 };
const goals = (t: TestCore) => t.core.module(GoalsModule)!;
const completed = () => fauxAssistantMessage("[目标已完成]\n已核对");
const review: FauxResponseFactory = context => {
	const content = context.messages.at(-1)?.content;
	const { revision, evidence_version } = JSON.parse(typeof content === "string" ? content : content?.map(part => "text" in part ? part.text : "").join("") ?? "");
	return fauxAssistantMessage(JSON.stringify({ verdict: "done", revision, evidence_version, next: "", missing: [], questions: [] }));
};

function longOutputModel(t: TestCore) {
	const resolve = t.core.resolveModel;
	t.core.resolveModel = model => ({ ...resolve(model), maxTokens: 1_000_000, cost: rates });
}

function create(t: TestCore, extra: Record<string, unknown> = {}) {
	return t.core.call("goals.create", { title: "核对材料", originText: "核对隔离测试材料", mandateRef: "user:t110",
		spec: { objective: "核对材料" }, scope: { cwd: t.workspace }, budget: { maxCostUsd: 0.5 }, ...extra }) as Promise<Detail>;
}

const until = (t: TestCore, id: string, predicate: (detail: Detail) => boolean) => t.waitFor(() => {
	const detail = goals(t).scheduler.detail(id);
	return predicate(detail) && detail;
});
const runs = (t: TestCore, goalId: string) => t.core.db.all<{ id: string; status: string }>(
	"SELECT r.id,r.status FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.goal_id=? ORDER BY r.started_at,r.rowid", goalId);

it("T110 a long-output model sends its first request with a 0.50 dollar budget", async test => {
	const t = await startTestCore();
	test.after(() => t.cleanup());
	longOutputModel(t);
	let calls = 0;
	t.respond(() => { calls++; return completed(); }, review);
	const goal = await create(t);
	const result = await until(t, goal.id, detail => detail.completed || detail.status === "paused");
	assert.equal(result.status, "completed");
	assert.equal(calls, 1);
	const charges = goals(t).scheduler.ledger.entries(goal.id, 10);
	assert.equal(charges.find(charge => charge.kind === "main")?.estOutputTokens, 8192);
	assert.equal(charges.find(charge => charge.kind === "review")?.estOutputTokens, 1024);
	assert.equal(result.budgetStatus.used.runs, 1);
});

it("T110 reserves a normal-size request when the larger explicit request cannot fit", async test => {
	const t = await startTestCore();
	test.after(() => t.cleanup());
	const service = goals(t);
	service.executor.stop();
	const goal = await create(t);
	const request = { id: "large-request", kind: "main" as const, inputTokens: 1000, outputTokens: 1_000_000, costUsd: 0.60015 };
	const normal = { outputTokens: 8192, costUsd: 0.0050652 };
	for (let i = 0; i < 2; i++) {
		const result = service.scheduler.reserve(goal.id, request, undefined, normal);
		assert.ok(result.ok);
		assert.equal(result.entry.estOutputTokens, normal.outputTokens);
		assert.equal(result.entry.estCost, normal.costUsd);
	}
	assert.equal(service.scheduler.ledger.entries(goal.id, 10).length, 1);
});

it("T110 true cost exhaustion shows both the remaining and the estimated amount", async test => {
	const t = await startTestCore();
	test.after(() => t.cleanup());
	longOutputModel(t);
	const goal = await create(t, { budget: { maxCostUsd: 0.001 } });
	const result = await until(t, goal.id, detail => detail.reason === "budget_cost");
	const match = result.resumeWhen?.match(/剩余 \$([\d.]+)，这一次预计要 \$([\d.]+)/);
	assert.equal(Number(match?.[1]), 0.001);
	assert.ok(Number(match?.[2]) > 0.001 && Number(match?.[2]) < 0.02);
	assert.equal(t.core.ledger!.entries().length, 0);
});

it("T110 a pre-send budget denial uses no run and allows the first real run after resume", async test => {
	const t = await startTestCore();
	test.after(() => t.cleanup());
	longOutputModel(t);
	const goal = await create(t, { budget: { maxCostUsd: 0.001, maxRuns: 1 } });
	const paused = await until(t, goal.id, detail => detail.reason === "budget_cost");
	assert.equal(paused.budgetStatus.used.runs, 0);
	await t.waitFor(() => runs(t, goal.id)[0]?.status === "failed");
	assert.equal(runs(t, goal.id).length, 1);
	assert.equal(t.core.ledger!.entries().length, 0);
	t.respond(completed(), review);
	await t.core.call("goals.budget", { id: goal.id, budget: { maxCostUsd: 0.5 } });
	const resumed = await t.core.call("goals.control", { id: goal.id, action: "resume" }) as Detail;
	assert.match(resumed.stage, /^第 1 轮/);
	const done = await until(t, goal.id, detail => detail.completed);
	assert.equal(done.budgetStatus.used.runs, 1);
	assert.equal(runs(t, goal.id).length, 2);
});

it("T110 a failed preparation with a run receipt and no request cannot queue another attempt", async test => {
	const t = await startTestCore();
	test.after(() => t.cleanup());
	const service = goals(t);
	service.executor.stop();
	const goal = await create(t);
	const scheduler = service.scheduler;
	const task = t.core.module(TasksModule)!.create({ cwd: t.workspace, goal: goal.originText, goalId: goal.id, source: "chat" });
	const intent = scheduler.pendingIntents().find(item => item.goal_id === goal.id)!;
	assert.ok(scheduler.claimIntent(intent.id, () => true));
	assert.ok(scheduler.beginRun(intent, task.id, () => true));
	const at = Date.now();
	t.core.db.run("INSERT INTO runs(id,cwd,task_id,status,started_at,ended_at,error) VALUES(?,?,?,'failed',?,?,?)",
		"prep", t.workspace, task.id, at - 1, at, "模型准备失败");
	assert.ok(scheduler.bindRun(intent, "prep"));
	scheduler.post(goal.id, "run.finished", "run:prep", {
		runId: "prep", taskId: task.id, status: "failed", revision: intent.revision, generation: intent.generation, reportedComplete: false,
	});
	scheduler.process(goal.id);
	const result = scheduler.detail(goal.id);
	assert.deepEqual([result.status, result.reason, result.budgetStatus.used.runs], ["failed", "prep_failed", 0]);
	assert.equal(runs(t, goal.id).length, 1);
	assert.equal(scheduler.pendingIntents().some(item => item.goal_id === goal.id), false);
	assert.equal(t.core.ledger!.entries().length, 0);
});

it("T110 settles a real local stream without final usage from its request and reply estimates", async test => {
	const payloads: { max_tokens?: number; stream_options?: { include_usage?: boolean } }[] = [];
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk);
		payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		response.writeHead(200, { "content-type": "text/event-stream" });
		for (const [delta, finish_reason] of [[{ role: "assistant", content: "abcdefgh" }, null], [{}, "stop"]] as const) {
			const frame = { id: "synthetic", object: "chat.completion.chunk", created: 1, model: "no-usage", choices: [{ index: 0, delta, finish_reason }] };
			response.write(`data: ${JSON.stringify(frame)}\n\n`);
		}
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	test.after(() => { server.closeAllConnections(); return new Promise<void>(done => server.close(() => done())); });
	const t = await startTestCore();
	test.after(() => t.cleanup());
	const { id } = await t.core.call("gateway.saveChannel", { name: "T110 local", platform: "opencode-go", api: "openai-completions",
		baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
		models: [{ id: "no-usage", contextWindow: 200_000, maxTokens: 100_000, cost: rates }], keys: [{ secret: "synthetic-test-key" }],
	}) as { id: string };
	t.core.settings.update({ defaultModel: `df-${id}/no-usage` });
	const goal = await create(t, { budget: { maxCostUsd: 0.5, maxRuns: 1 } });
	const result = await until(t, goal.id, detail => detail.reason === "budget_runs");
	const [charge] = goals(t).scheduler.ledger.entries(goal.id, 10);
	assert.equal(payloads.length, 1);
	assert.equal(payloads[0]?.max_tokens, 8192);
	assert.equal(payloads[0]?.stream_options?.include_usage, true);
	assert.ok(charge);
	assert.deepEqual([charge.state, charge.costEstimated, charge.outputTokens], ["settled", true, 2]);
	assert.equal(charge.inputTokens, charge.estInputTokens);
	assert.ok(Math.abs(charge.cost! - (charge.estInputTokens * rates.input + 2 * rates.output) / 1e6) < 1e-9);
	assert.equal(result.budgetStatus.reserved.costUsd, 0);
	assert.equal(result.budgetStatus.reserved.tokens, 0);
	assert.equal(result.budgetStatus.reserved.parallel, 0);
	assert.deepEqual(t.core.ledger!.entries().map(row => [row.state, row.amount]), [["missing", null]]);
});

it("T110 authorized Butterfly goals can use Python and in-scope HTML, while workbench cannot use Python", async test => {
	const t = await startTestCore();
	test.after(() => t.cleanup());
	goals(t).executor.stop();
	const distro = "df-t110-test";
	t.core.sandboxProvider = () => ({ distro, ready: async () => {}, online: () => false });
	const nativeRealpath = fs.realpath;
	const mock = test.mock.method(fs, "realpath", async (path: Parameters<typeof fs.realpath>[0]) => {
		if (typeof path === "string" && path.startsWith(`\\\\wsl.localhost\\${distro}\\`)) return path;
		return nativeRealpath(path);
	});
	syncBuiltinESMExports();
	try {
		const tools = ["python", "render_html"];
		const butterfly = await create(t, { scope: { cwd: t.core.paths.butterflyDir, sandbox: true, partition: "butterfly",
			allowedTools: tools, allowedPaths: ["/workspace/reports"] } });
		const workbench = await create(t, { scope: { cwd: t.workspace, allowedTools: tools } });
		assert.equal(await allowedTool(t.core, butterfly, "python", { code: "1 + 1" }), true);
		assert.equal(await allowedTool(t.core, butterfly, "render_html", { file_path: "/workspace/reports/page.html" }), true);
		assert.equal(await allowedTool(t.core, butterfly, "render_html", { file_path: "/workspace/other.html" }), false);
		assert.equal(await allowedTool(t.core, workbench, "python", { code: "1 + 1" }), false);
		assert.equal(await allowedTool(t.core, workbench, "render_html", { file_path: join(t.workspace, "page.html") }), true);
		assert.equal(await allowedTool(t.core, { ...butterfly, scope: { ...butterfly.scope, allowedTools: ["read"] } }, "python", { code: "1 + 1" }), false);
	} finally { mock.mock.restore(); syncBuiltinESMExports(); }
});
