// 0.13.1 install verification: Velopack's apply ends every process whose program lies under the install root,
// and the installed data folder is inside it. The update guardian ran from data/updates/runs, was killed, and the
// new version never started. Its programs now run from outside the install root.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { it } from "node:test";
import { corePaths } from "../src/paths.ts";
import { guardianExecDir } from "../src/update/bridge.ts";
import { recoverUpdateStartup } from "../src/update/startup.ts";
import { JournalStore, type UpdateJournal } from "../src/update/state.ts";

const inside = (child: string, parent: string) => (resolve(child) + sep).toLowerCase().startsWith((resolve(parent) + sep).toLowerCase());

it("v0.13.1 the guardian's programs live outside an install root that holds the data folder", () => {
	const installRoot = join(tmpdir(), "..", "Local", "DreamFlutter");
	const data = join(installRoot, "data");
	const dir = guardianExecDir("abc");
	assert.ok(!inside(dir, installRoot), dir);
	assert.ok(!inside(dir, data), dir);
	assert.ok(inside(dir, tmpdir()), dir);
});

it("v0.13.1 a guardian restarted after replacement runs from outside the install root, copied again when temp was cleaned", async () => {
	const root = mkdtempSync(join(tmpdir(), "df-v0131-guard-")), data = join(root, "data"), paths = corePaths(data), store = new JournalStore(data);
	const id = `v0131-${Date.now()}`, guard = join(data, "updates", "runs", id);
	mkdirSync(guard, { recursive: true });
	const journal = { id, phase: "applying", at: Date.now(), from: "0.13.0", to: "0.13.1", guardDir: guard, nonce: "n", acceptedWrites: false, attemptedRollback: false, backup: join(data, "kept.dfbackup") } as UpdateJournal;
	writeFileSync(join(guard, "guard-config.json"), JSON.stringify({ ...journal, helper: join(guard, "dreamflutter_update.exe") }));
	store.mutate(() => journal);
	const launched: string[] = [], prepared: string[] = [];
	try {
		const result = await recoverUpdateStartup(paths, {
			version: journal.to, alive: () => false,
			prepare: async (_app, dir) => { prepared.push(dir); return { node: join(dir, "node.exe"), script: join(dir, "guardian.mjs"), helper: join(dir, "dreamflutter_update.exe") }; },
			launch: (node) => { launched.push(node); return 4242; },
		});
		assert.equal(result, "guardian-active");
		assert.deepEqual(prepared, [guardianExecDir(id)], "copied again: nothing was left in temp");
		assert.equal(launched.length, 1);
		assert.ok(!inside(launched[0]!, root), `guardian program ${launched[0]} must not be under the install root`);
		assert.equal(store.read()?.guardPid, 4242);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it("v0.13.1 the guardian does not keep current/ as its working directory (Velopack could not move it aside)", async () => {
	const { launchGuardian } = await import("../src/update/bridge.ts");
	const { copyFileSync, existsSync, readFileSync } = await import("node:fs");
	const { dirname } = await import("node:path");
	const root = mkdtempSync(join(tmpdir(), "df-v0131-cwd-")), dir = join(root, "guard");
	mkdirSync(dir);
	const node = join(dir, "node.exe"), script = join(dir, "probe.mjs"), out = join(root, "cwd.txt");
	copyFileSync(process.execPath, node);
	writeFileSync(script, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], process.cwd());");
	try {
		launchGuardian(node, script, out);
		for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((done) => setTimeout(done, 100));
		assert.equal(resolve(readFileSync(out, "utf8")).toLowerCase(), resolve(dirname(node)).toLowerCase());
		assert.notEqual(resolve(readFileSync(out, "utf8")).toLowerCase(), resolve(process.cwd()).toLowerCase());
	} finally { await new Promise((done) => setTimeout(done, 300)); rmSync(root, { recursive: true, force: true }); }
});
