/** Real DeepSeek shutdown probe; all writes use a fresh temporary data directory.
 * node --disable-warning=ExperimentalWarning scripts/live-memory-shutdown.ts <source-data-dir>
 * Copies encrypted OpenCode Go credentials using copy-channels.ts; never prints keys.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildCore } from "../src/app.ts";
import { Logger } from "../src/log.ts";
import { MemoryModule } from "../src/modules/memory.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { corePaths } from "../src/paths.ts";
import { configurePiNetworking } from "../src/pi/http.ts";

const source = process.argv[2];
assert.ok(source, "provide the existing app's data directory");
const dir = mkdtempSync(join(tmpdir(), "df-live-memory-"));
console.log(`Isolated test directory: ${dir}`);
const paths = corePaths(join(dir, "data"));
const copied = JSON.parse(execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("./copy-channels.ts", import.meta.url)), source, paths.dataDir], { encoding: "utf8" })) as { channel: string; models: string[] }[];
const channel = copied.find((c) => c.models.some((m) => /deepseek.*flash/i.test(m)));
assert.ok(channel, "no configured OpenCode Go DeepSeek channel; no live calls made");
const model = channel.models.find((m) => /deepseek.*flash/i.test(m))!;
const agentDir = join(dir, "agent");
mkdirSync(agentDir);
const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
const log = new Logger(paths.logFile, false);
await configurePiNetworking(agentDir, log);
const core = buildCore({ paths, agentDir, sessionDir: join(dir, "sessions"), log, notifier: new RecordingNotifier(), modelRuntime: () => runtime });
core.settings.update({ memoryModel: `df-${channel.channel}/${model}`, autoTitle: false, memoryAutoExtract: false });
const watchdog = setTimeout(() => { console.error("live probe exceeded 120 seconds"); process.exitCode = 1; void core.shutdown(); }, 120_000);
try {
	await core.start();
	const memory = core.module(MemoryModule)!;
	const seed = () => memory.store.commit({ actor: "user", ops: [{ kind: "add", item: { content: `用户正在进行独立退出验证 ${Date.now()}`, kind: "progress", level: 1, scope: "global", confidence: "user_explicit" } }] });
	seed();
	const completed = memory.work.jobs.enqueue({ kind: "review", scopeKey: "global", priority: 100, payload: { level: 1 } });
	await memory.work.drain();
	assert.equal(memory.work.jobs.get(completed.id)!.status, "done", "real model must finish the baseline job");
	const before = memory.work.spentToday();
	assert.ok(before > 0, "real usage should be present in the ledger");
	console.log(JSON.stringify({ model, baselineCostUsd: before, baselineStatus: "done" }));
	seed();
	const complete = runtime.completeSimple.bind(runtime);
	let started!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	let cancelled = false;
	let returnedCost = 0;
	runtime.completeSimple = async (...args) => {
		const signal = (args[2] as { signal?: AbortSignal } | undefined)?.signal;
		signal?.addEventListener("abort", () => { cancelled = true; }, { once: true });
		const pending = complete(...args);
		started();
		const answer = await pending;
		returnedCost += answer.usage.cost.total;
		return answer;
	};
	const job = memory.work.jobs.enqueue({ kind: "review", scopeKey: "global", priority: 100, payload: { level: 1 } });
	const draining = memory.work.drain();
	await ready;
	await new Promise((resolve) => setTimeout(resolve, 100));
	const at = Date.now();
	await memory.work.stop();
	await draining;
	const elapsedMs = Date.now() - at;
	const state = memory.work.jobs.get(job.id)!;
	assert.ok(cancelled);
	assert.equal(state.status, "queued");
	assert.equal(state.attempts, 0);
	assert.ok(state.runAfter <= Date.now());
	assert.ok(elapsedMs < 16_000);
	assert.equal(state.costUsd, returnedCost);
	assert.ok(Math.abs(memory.work.spentToday() - before - returnedCost) < 1e-9);
	console.log(JSON.stringify({ shutdownMs: elapsedMs, status: state.status, attempts: state.attempts, returnedCostUsd: returnedCost, ledgerCostUsd: memory.work.spentToday(), cancelled }));
	console.log("PASS; usage not returned by the provider cannot establish its final invoice.");
} finally { clearTimeout(watchdog); await core.shutdown(); }
