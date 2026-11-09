/** T77 real WSL trial: one uniquely owned disposable distro, no user sandbox or storage configuration changes. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Core } from "../src/core.ts";
import { corePaths } from "../src/paths.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { trialSkill } from "../src/modules/skill-trial.ts";
import { runWsl } from "../src/sandbox/sandbox.ts";

const evidence = process.argv[2]; assert.ok(evidence, "evidence JSON required"); assert.ok(!existsSync(evidence), "do not reuse an existing trial run");
const image = resolve("E:/DreamFlutter测试版/core/sandbox-image/dreamflutter-sandbox.tar.gz"); assert.ok(existsSync(image));
const root = mkdtempSync(join(tmpdir(), "df-t77-trial-")), distro = `df-t77-trial-${randomUUID().slice(0, 12)}`, directory = join(root, "distro"); mkdirSync(directory);
const proof: Record<string, unknown> = { root, distro, image, userSandboxTouched: false, results: [], imported: false, cleanup: false };
const save = () => writeFileSync(evidence, JSON.stringify(proof, null, 2));
const core = new Core({ paths: corePaths(join(root, "data")), agentDir: join(root, "agent"), log: new Logger(), notifier: new RecordingNotifier() });
let imported = false;
try {
	const inventory = await runWsl(["--list", "--quiet"], { timeoutMs: 10000 }); assert.equal(inventory.code, 0); assert.ok(!inventory.stdout.includes(distro));
	save(); const created = await runWsl(["--import", distro, directory, image, "--version", "2"], { timeoutMs: 120000 }); assert.equal(created.code, 0, created.stderr); imported = true; proof.imported = true;
	const uid = await runWsl(["-d", distro, "-u", "agent", "--exec", "id", "-u"], { timeoutMs: 15000 }); assert.equal(uid.code, 0); assert.equal(uid.stdout.trim(), "23456"); proof.agentUid = uid.stdout.trim();
	core.sandboxProvider = () => ({ distro, ready: async () => {}, online: () => false });
	const cases = [
		{ id: "success-artifact-unicode", script: "import os,json\nfrom pathlib import Path\nassert os.getuid()==23456\nPath('result.json').write_text(json.dumps({'value':'中文结果'},ensure_ascii=False),encoding='utf8')\nprint('中文输出：成功')", options: {}, status: "passed" },
		{ id: "timeout", script: "import time\ntime.sleep(20)", options: { timeoutMs: 200 }, status: "timeout" },
		{ id: "output-limit", script: "print('噪声'*200000,flush=True)", options: { maxOutputBytes: 1024 }, status: "output-limit" },
		{ id: "exit-code", script: "raise SystemExit(3)", options: {}, status: "failed" },
	];
	for (const item of cases) {
		const result = await trialSkill(core, { files: { "SKILL.md": Buffer.from("---\nname: trial-sample\ndescription: Disposable trial\n---\nTest.").toString("base64"), "scripts/check.py": Buffer.from(item.script).toString("base64") }, script: "scripts/check.py", ...item.options });
		(proof.results as unknown[]).push({ id: item.id, result }); save(); assert.equal(result.status, item.status, result.reason);
		if (item.id === "success-artifact-unicode") { assert.match(result.stdout!, /中文输出/); assert.ok(result.artifacts?.some((entry) => entry.path === "result.json" && entry.textPreview?.includes("中文结果"))); }
		if (item.id === "exit-code") assert.equal(result.exitCode, 3);
	}
	const leftovers = await runWsl(["-d", distro, "-u", "agent", "--exec", "python3", "-c", "import glob,json;print(json.dumps(glob.glob('/tmp/df-skill-trial-*')))"], { timeoutMs: 10000 });
	assert.equal(leftovers.code, 0); assert.deepEqual(JSON.parse(leftovers.stdout), []); proof.trialDirectoriesCleaned = true; proof.passed = true;
} catch (error) { proof.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
	await core.shutdown();
	if (imported) {
		assert.ok(distro.startsWith("df-t77-trial-") && resolve(directory).startsWith(resolve(root) + "\\"));
		await runWsl(["--terminate", distro], { timeoutMs: 10000 }); const removed = await runWsl(["--unregister", distro], { timeoutMs: 30000 });
		proof.cleanup = removed.code === 0; if (removed.code !== 0) { proof.cleanupError = removed.stderr; process.exitCode = 1; }
	}
	save(); console.log(JSON.stringify(proof));
}
