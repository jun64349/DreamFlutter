import assert from "node:assert/strict";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { it } from "node:test";
import { ButterflyModule, OUTBOX } from "../src/modules/butterfly.ts";
import { isProactiveTerminal } from "../src/modules/persona/proactive.ts";
import { configureProfile, exercise, type Profile } from "../scripts/autonomy/exercise.ts";
import { cleanupStep, writeReport } from "../scripts/autonomy/report.ts";
import { startTestCore } from "./harness.ts";

it("T127 B4 holds its settings through proactive generation and reaches sent before B5", async test => {
	let at = Date.now();
	const t = await startTestCore(undefined, { selfwork: { clock: () => at }, personaClock: () => at });
	test.after(() => t.cleanup());
	const profile: Profile = {
		core: t.core, faux: t, notices: t.notifier.sent, local: path => join(t.dir, "sandbox", path.slice("/workspace".length)),
		async idle() { at += 15 * 60_000; },
		async restart() { assert.fail("B4 and B5 do not restart"); },
		startMeter() {},
		meter: () => ({ transportRequests: 0, reservedOrEstimatedUsd: 0 }),
	};
	configureProfile(profile);
	for (const state of ["waiting", "generating", "sending"]) assert.equal(isProactiveTerminal(state), false, state);
	for (const state of ["sent", "skipped"]) assert.equal(isProactiveTerminal(state), true, state);
	const [learning, personas] = await exercise(profile, ["B4", "B5"]);
	assert.equal(learning!.passed, true, learning!.error);
	assert.equal(personas!.passed, true, personas!.error);
	assert.deepEqual(t.core.db.all<{ state: string; reason: string | null }>("SELECT state,reason FROM butterfly_proactive")
		.map(({ state, reason }) => [state, reason]), [["sent", null]]);
});

it("T127 shutdown can close the database while a run-start outbox scan is suspended", { timeout: 15_000 }, async test => {
	const t = await startTestCore();
	test.after(() => t.cleanup());
	const butterfly = t.core.module(ButterflyModule)!;
	t.core.sandboxProvider = () => ({ distro: "DF-T127-fake", ready: async () => {}, online: () => false });
	const root = join(t.dir, "outbox-fixture");
	mkdirSync(root);
	writeFileSync(join(root, "report.md"), "fixture");
	butterfly.local = path => { assert.equal(path, OUTBOX); return root; };
	const slot = await t.core.openSlot({ sandbox: true, cwd: butterfly.home });
	let entered!: () => void, release!: () => void;
	const scanEntered = new Promise<void>(resolve => { entered = resolve; });
	const releaseScan = new Promise<void>(resolve => { release = resolve; });
	const readdir = fs.readdir;
	const patch = test.mock.method(fs, "readdir", async (...args: Parameters<typeof readdir>) => {
		const files = await readdir(...args);
		if (args[0] === root) {
			entered();
			await releaseScan;
		}
		return files;
	});
	syncBuiltinESMExports();
	const scan = test.mock.method(butterfly, "outbox");
	try {
		butterfly.onRunStarted(slot);
		await scanEntered;
		await t.core.shutdown();
		assert.equal(t.core.db.raw.isOpen, false);
		release();
		assert.deepEqual(await scan.mock.calls[0]!.result, []);
	} finally {
		release();
		patch.mock.restore();
		syncBuiltinESMExports();
	}
});

it("T127 report checkpoint contains the cases before cleanup and final file identifies failed steps", async test => {
	const t = await startTestCore();
	test.after(() => t.cleanup());
	const path = join(t.dir, "trial-report.json");
	const out = openSync(path, "wx");
	const cases = [{ name: "B4", passed: true }];
	const errors: Record<string, string> = {};
	try {
		writeReport(out, { cases, cleanup: { errors, pending: true, note: "initial checkpoint".repeat(10) } });
		const stopped = await cleanupStep(errors, "coreShutdown", () => {
			assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).cases, cases);
			throw new Error("fixture shutdown error");
		});
		assert.equal(stopped, false);
		assert.equal(await cleanupStep(errors, "wslUnregister", () => {}), true);
		writeReport(out, { cases, cleanup: { errors, pending: false } });
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { cases, cleanup: { errors: { coreShutdown: "fixture shutdown error" }, pending: false } });
	} finally { closeSync(out); }
});
