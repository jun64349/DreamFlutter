// 内测版（第 6 步朋友内测，用户 2026-11-19 定）：程序根目录有 beta-edition.json 时不检查、不下载更新。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const harness = fileURLToPath(new URL("./harness.ts", import.meta.url));

function run(beta: boolean) {
	const script = `
		const { startTestCore } = await import(${JSON.stringify("file:///" + harness.replaceAll("\\", "/"))});
		const { BETA_EDITION } = await import(${JSON.stringify(new URL("../src/paths.ts", import.meta.url).href)});
		const t = await startTestCore();
		const out = { beta: BETA_EDITION, check: null, download: null };
		for (const m of ["check", "download"]) {
			try { await t.core.call("updates." + m, {}, t.client); out[m] = "ran"; } catch (e) { out[m] = e.code ?? e.message; }
		}
		await t.cleanup();
		console.log(JSON.stringify(out));`;
	const env = { ...process.env };
	if (beta) env.DREAMFLUTTER_BETA = "1"; else delete env.DREAMFLUTTER_BETA;
	const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], { env, encoding: "utf8", timeout: 120_000 });
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout.trim().split("\n").at(-1)!);
}

test("内测版不检查、不下载更新", () => {
	const out = run(true);
	assert.equal(out.beta, true);
	assert.equal(out.check, "unavailable");
	assert.equal(out.download, "unavailable");
});

test("普通版的更新入口不受影响", () => {
	const out = run(false);
	assert.equal(out.beta, false);
	assert.notEqual(out.check, "unavailable");
	assert.notEqual(out.download, "unavailable");
});
