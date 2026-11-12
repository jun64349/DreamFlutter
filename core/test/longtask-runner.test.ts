import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { copyOpenCodeGoChannel, LIVE_MODEL } from "../scripts/longtask/channel-config.ts";
import { allowance, observationMs, selectCases } from "../scripts/longtask/cases.ts";
import { evaluate } from "../scripts/longtask/checks.ts";
import { dryEvidence, runDryRun } from "../scripts/longtask/dry.ts";
import { generateFixture, sha256 } from "../scripts/longtask/fixtures/generate.ts";
import { LiveBudget } from "../scripts/longtask/live-budget.ts";
import { toolFacts } from "../scripts/longtask/live-evidence.ts";
import { renderReport } from "../scripts/longtask/report.ts";
import { hasFinalUsageFrame, requestEnd, requestFailure, requestReceipts } from "../scripts/longtask/request-evidence.ts";
import { REQUEST_LEDGER_ID } from "../src/ledger/types.ts";
import { Db } from "../src/db.ts";
import { SecretStore, secretFileOf } from "../src/modules/secrets.ts";
import { corePaths } from "../src/paths.ts";

it("copies encrypted channel keys and points their references at the isolated directory", { skip: process.platform !== "win32" }, async () => {
	const root = mkdtempSync(join(tmpdir(), "df-t105-copy-"));
	try {
		const source = join(root, "source"), target = join(root, "target");
		const sourceStore = new SecretStore(source), targetStore = new SecretStore(target);
		const fakeKey = "fixture-only-key-for-copy-test";
		const ref = await sourceStore.put("gateway-fixture", fakeKey);
		const db = new Db(corePaths(source).dbFile);
		try {
			db.run(`INSERT INTO gateway_channels(id,name,platform,kind,api,base_url,models,created_at)
				VALUES('fixture','Go','opencode-go','plan','openai-completions','https://example.invalid',?,1)`, JSON.stringify([{ id: LIVE_MODEL }]));
			db.run("INSERT INTO gateway_keys(id,channel_id,secret,created_at) VALUES('fixture','fixture',?,1)", ref);
		} finally { db.close(); }
		assert.equal(copyOpenCodeGoChannel(source, target), "fixture");
		const copied = new Db(corePaths(target).dbFile);
		try {
			const localRef = copied.get<{ secret: string }>("SELECT secret FROM gateway_keys WHERE id='fixture'")!.secret;
			assert.equal(secretFileOf(localRef)?.toLowerCase(), targetStore.fileFor("gateway-fixture").replaceAll("\\", "/").toLowerCase());
			assert.ok(readFileSync(sourceStore.fileFor("gateway-fixture")).equals(readFileSync(targetStore.fileFor("gateway-fixture"))));
			assert.equal(await targetStore.get("gateway-fixture"), fakeKey);
		} finally { copied.close(); }
		const original = new Db(corePaths(source).dbFile);
		try { assert.equal(original.get<{ secret: string }>("SELECT secret FROM gateway_keys WHERE id='fixture'")!.secret, ref); }
		finally { original.close(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it("runs selected cases without model runs or spending", async () => {
	const rows = await runDryRun(selectCases("L4,L6"));
	assert.deepEqual(rows.map(row => [row.id, row.passed, row.runs, row.costUsd, row.goalStatus]), [
		["L4", true, 0, 0, "paused"], ["L6", true, 0, 0, "paused"],
	]);
	assert.throws(() => selectCases("L4,L4"));
	assert.throws(() => selectCases("L8"));
	assert.equal(allowance(0, 0), 0.5);
	assert.equal(allowance(2.7, 0.2), 0.1);
	assert.equal(allowance(2.8, 0.3), 0);
	assert.equal(allowance(NaN, 0), 0);
	assert.equal(allowance(0.8, 0.1, 1), 0.1);
	assert.equal(allowance(0.8, 0.2, 1), 0);
});

it("renders subconditions for every check in the seven-case offline run", async () => {
	const rows = await runDryRun(selectCases());
	assert.equal(rows.length, 7);
	for (const row of rows) {
		assert.equal(row.passed, true, row.id);
		assert.equal(row.runs, 0);
		assert.equal(row.costUsd, 0);
		for (const check of row.checks) assert.ok(check.conditions.length, check.id);
	}
	const report = renderReport("2026-11-12", "合成回执", "dry", rows);
	assert.match(report, /成立 · 与首次读取在同一会话/);
	assert.match(report, /成立 · 作业启动早于用户插话/);
	assert.match(report, /成立 · 目标未标记完成/);
});

it("follows the effective goal observation budget with a minute for completion", () => {
	for (const { id } of selectCases()) assert.equal(observationMs(id, 600_000), 660_000);
	assert.equal(observationMs("L2", 120_000), 180_000);
	assert.equal(observationMs("L5", 120_000), 415_000);
	assert.equal(observationMs("L7", 60_000), 140_000);
});

const firstL3Read = 'import pandas as pd\ndf = pd.read_csv("/workspace/t105/L3/large.csv")';
const writeL3Result = 'import json\nresult = {"count": len(df)}\nwith open("output/statistics.json", "w") as out:\n    json.dump(result, out)';
type L3Call = { name: string; args: Record<string, unknown>; at?: number; ok?: boolean };
const pythonCall = (code: string, restart = false): L3Call => ({ name: "python", args: { code, restart } });

function l3Session(session: string, calls: L3Call[]) {
	const entries = calls.flatMap(({ name, args, at, ok }, index) => [
		{ type: "message", message: { role: "assistant", timestamp: at ?? index,
			content: [{ type: "toolCall", id: session + index, name, arguments: args }] } },
		{ type: "message", message: { role: "toolResult", toolName: name, toolCallId: session + index, isError: ok === false, content: [] } },
	]);
	return { session, text: entries.map(entry => JSON.stringify(entry)).join("\n") };
}

function l3Reuse(root: string, calls: L3Call[], otherSession: L3Call[] = []) {
	const tools = toolFacts([l3Session("secondary", otherSession), l3Session("L3", calls)]);
	const evidence = { status: "completed", missing: [], tools };
	return evaluate(selectCases("L3")[0]!, root, {}, evidence).find(check => check.id === "reuse")!;
}

it("accepts third-round L3 reuse when open writes the result and rejects a new source read", () => {
	const root = mkdtempSync(join(tmpdir(), "df-t105-l3-check-"));
	try {
		// Reconstruct the observed L3 receipt shape: two successful calls in one
		// session, first assigns df from large.csv, second writes statistics.json.
		const writeResult = writeL3Result;
		const reuse = (code: string, restart = false) => l3Reuse(root, [pythonCall(firstL3Read), pythonCall(code, restart)]).passed;
		assert.equal(reuse(writeResult), true);
		assert.equal(reuse(writeResult.replace('"output/statistics.json", "w"', 'Path("output") / "statistics.json", mode="a"')), true);
		assert.equal(reuse(writeResult.replace('"output/statistics.json", "w"', '"output/statistics.json", "x"')), true);
		assert.equal(reuse(writeResult + '\njson.load(open("output/statistics.json", "r"))'), true);
		assert.equal(reuse(writeResult + "\nagain = pd.read_csv(source_path)"), false);
		assert.equal(reuse(writeResult + "\nwith open(source_path): pass"), false);
		assert.equal(reuse(writeResult + '\nwith open(source_path, mode="rb"): pass'), false);
		assert.equal(reuse(writeResult + '\nwith open("large.csv", "r"): pass'), false);
		assert.equal(reuse(writeResult, true), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it("accepts the third-round L3 shape followed by prose naming the source", () => {
	const root = mkdtempSync(join(tmpdir(), "df-t105-l3-check-"));
	try {
		const calls = [pythonCall(firstL3Read), pythonCall(writeL3Result)];
		assert.equal(l3Reuse(root, calls).passed, true);
		// Perturb the reconstructed receipts with prose after the two known calls.
		const prose = { name: "write", args: { file_path: "output/note.txt", content: "已统计 large.csv" } };
		assert.equal(l3Reuse(root, [...calls, prose]).passed, true);
		const readSource = { name: "read", args: { file_path: "large.csv" }, at: 2 };
		assert.equal(l3Reuse(root, calls, [readSource]).passed, false);
		assert.equal(l3Reuse(root, calls, [{ ...readSource, at: -1 }]).passed, true);
		assert.equal(l3Reuse(root, calls, [{ ...readSource, ok: false }]).passed, true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it("accepts the reconstructed L3 rerun with additional calls and reports the result of each condition", () => {
	const root = mkdtempSync(join(tmpdir(), "df-t105-l3-check-"));
	try {
		// The rerun's isolated trace is gone. Exercise the two failure shapes
		// described in the card without claiming either occurred in that trace.
		const calls = [
			pythonCall('print("large.csv and df")'),
			pythonCall('source = "large.csv"\ndf = pd.read_csv(\n    filepath_or_buffer=source,\n)'),
			pythonCall('print("df from large.csv")'),
			pythonCall(writeL3Result + '\nprint("Processed large.csv")'),
			{ name: "write", args: { file_path: "output/note.txt", content: "源数据 large.csv" } },
		];
		const check = l3Reuse(root, calls);
		assert.equal(check.passed, true);
		assert.deepEqual(check.conditions.map(part => part.passed), [true, true, true, true, true]);
		const report = renderReport("2026-11-12", "合成回执", "dry", [{
			id: "L3", title: "Python 大数据", partition: "butterfly", passed: true, runs: 0,
			costUsd: 0, elapsedMs: 0, reason: "合成回执", goalStatus: "completed", checks: [check, l3Reuse(root, [])],
		}]);
		assert.match(report, /成立 · 至少两次 Python 调用。 共 4 次/);
		assert.match(report, /成立 · 找到首次读取 large\.csv 并给 df 赋值的调用。 工具调用 2/);
		assert.match(report, /不成立 · 引用了 df/);
		assert.match(report, /成立 · 引用了 df/);
		assert.match(report, /未验证 · 首次读取之后没有再次读取源文件/);
		assert.doesNotMatch(report, /pd\.read_csv|Processed/);
		assert.equal(l3Reuse(root, calls.slice(0, 3)).passed, false);
		assert.equal(l3Reuse(root, [calls[1]!, pythonCall("df = []")]).passed, false);
		assert.equal(l3Reuse(root, [calls[1]!, pythonCall(writeL3Result, true)]).passed, false);
		assert.equal(l3Reuse(root, [calls[1]!, pythonCall("pass", true), calls[3]!]).passed, false);
		assert.equal(l3Reuse(root, [calls[1]!], [{ ...calls[3]!, at: 3 }]).passed, false);
		assert.equal(l3Reuse(root, [...calls, pythonCall('again = pd.read_csv("large.csv")')]).passed, false);
		assert.equal(l3Reuse(root, [pythonCall('df = pd.read_csv("other.csv")\nprint("large.csv")'), calls[3]!]).passed, false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it("reproduces seeded fixtures and rejects mismatched output or missing evidence", () => {
	const root = mkdtempSync(join(tmpdir(), "df-t105-fixture-"));
	try {
		const first = join(root, "first"), second = join(root, "second");
		const [item] = selectCases("L2");
		const answers = generateFixture(item!.id, first);
		assert.deepEqual(generateFixture(item!.id, second), answers);
		assert.equal(sha256(join(first, "sales.xlsx")), sha256(join(second, "sales.xlsx")));
		const evidence = dryEvidence(item!, first, answers);
		assert.ok(evaluate(item!, first, answers, evidence).every(check => check.passed));
		writeFileSync(join(first, "output", "monthly.csv"), "month,units,revenue_cents\n2026-01,1,2\n");
		evidence.tools.length = 0;
		assert.deepEqual(evaluate(item!, first, answers, evidence).filter(check => !check.passed).map(check => check.id), ["monthly", "screenshot"]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it("reports observed provider usage frames and sanitized end states per request", () => {
	assert.equal(hasFinalUsageFrame({ choices: [{ finish_reason: "stop" }], usage: null }), false);
	assert.equal(hasFinalUsageFrame({ usage: { input: 10, output: 0 } }), false);
	assert.equal(hasFinalUsageFrame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 0 } }), true);
	assert.equal(requestEnd("toolUse"), "正常结束");
	assert.equal(requestEnd("error", "HTTP 403 details that must not enter the report"), "被拒");
	assert.equal(requestEnd("aborted", "request aborted"), "中断");
	assert.equal(requestEnd("error", "request timed out"), "超时");
	assert.equal(requestEnd("error", "unexpected end of stream"), "异常结束");
	const ledger = { state: "missing", success: 0, amount: null, currency: null, amount_source: "missing" };
	const receipts = requestReceipts([
		{ ...ledger, id: "private-first", error_code: "error" },
		{ ...ledger, id: "private-second", error_code: "cancelled_without_final_usage" },
	], [{ ledgerId: "private-first", status: "被拒", finalUsage: false, transport: true }]);
	assert.deepEqual(receipts, [
		{ status: "被拒", finalUsage: false, transport: true },
		{ status: "中断", finalUsage: false, transport: false },
	]);
	const report = renderReport("2026-11-12", "deepseek-v4.1-flash", "rerun", [{
		id: "L1", title: "任务", partition: "workbench", passed: false, runs: 1, rawRuns: 2,
		costUsd: null, elapsedMs: 0, reason: "中断", goalStatus: "paused", checks: [], receipts,
	}]);
	assert.match(report, /修正轮数 1，原始回执 2/);
	assert.match(report, /\| 1 \| 被拒 \| 否 \| 是 \|/);
	assert.match(report, /\| 2 \| 中断 \| 否 \| 否 \|/);
	assert.doesNotMatch(report, /private-|HTTP 403/);
});

it("T111 classifies provider failures using only allowlisted diagnostics", () => {
	const body = "https://private.invalid/api?token=fake-secret response-raw";
	assert.deepEqual(requestFailure(`HTTP 403: ${body}`, true), { category: "认证", httpStatus: 403 });
	assert.deepEqual(requestFailure(`429: exceeded_current_quota ${body}`, true), { category: "额度或订阅", httpStatus: 429 });
	assert.deepEqual(requestFailure("429: too many requests", true), { category: "限流", httpStatus: 429 });
	assert.deepEqual(requestFailure("OpenAI API error (503): unavailable", true), { category: "上游错误", httpStatus: 503 });
	assert.deepEqual(requestFailure("socket terminated after request abc-403-path", true), { category: "网络", httpStatus: undefined });
});

it("T111 captures the sanitized gateway refusal before transport and prints it in the report", async () => {
	const body = "https://private.invalid/api?token=fake-secret response-raw";
	const budget = new LiveBudget();
	budget.configure("fixture-provider", "fixture-model");
	budget.begin();
	type Registration = Parameters<ModelRuntime["registerProvider"]>[1];
	let stream: Registration["streamSimple"];
	const runtime: Pick<ModelRuntime, "registerProvider"> = { registerProvider(_provider, config) { stream = config.streamSimple; } };
	budget.observeGateway(runtime);
	runtime.registerProvider("fixture-provider", { streamSimple() {
		const result = createAssistantMessageEventStream();
		result.push({ type: "error", reason: "error", error: { ...fauxAssistantMessage(""), stopReason: "error",
			errorMessage: `渠道「${body}」的 Key 都被拒绝了（Key 无效），请在设置里检查 Key` } });
		result.end();
		return result;
	} });
	assert.ok(stream);
	await stream({} as never, { messages: [] } as never, { [REQUEST_LEDGER_ID]: "private-id" } as never).result();
	assert.equal(budget.snapshot().requests, 0);
	const receipts = requestReceipts([{ id: "private-id", state: "missing", success: 0, error_code: "error", amount: null,
		currency: null, amount_source: "missing" }], budget.snapshot().receipts);
	assert.deepEqual(receipts, [{ status: "被拒", finalUsage: false, transport: false,
		failure: { category: "网关已停用渠道", notSent: "渠道的 Key 都已被拒绝" } }]);
	const report = renderReport("2026-11-12", "fixture-model", "rerun", [{ id: "L1", title: "fixture", partition: "workbench",
		passed: false, runs: 1, costUsd: null, elapsedMs: 0, reason: "被拒", goalStatus: "paused", checks: [], receipts: [
			...receipts, { status: "被拒", finalUsage: false, transport: true, failure: requestFailure(`HTTP 403: ${body}`, true) },
		] }]);
	assert.match(report, /网关已停用渠道 \| — \| 渠道的 Key 都已被拒绝/);
	assert.match(report, /认证 \| 403 \| —/);
	assert.doesNotMatch(report, /private|fake-secret|response-raw|https:/);
});
