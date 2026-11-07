/** Gate only: invoke production PowerShell tools against an isolated Chinese-path Python venv. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledPython } from "../src/agent/toolchain.ts";
import { JobRegistry, PersistentShell, pwshTool } from "../src/agent/shell.ts";
import { HarnessState } from "../src/agent/state.ts";

const evidence = process.argv[2]; assert.ok(evidence, "evidence output path required");
const root = mkdtempSync(join(tmpdir(), "df-t68-中文路径-")), workspace = join(root, "中文工作区"); mkdirSync(workspace);
const python = bundledPython(); assert.ok(python, "existing bundled Python is required; do not download a replacement");
const venv = join(workspace, "中文虚拟环境"), script = join(workspace, "中文报错样例.py");
const expectedStderr = "STDERR_T68：中文标准错误完整输出", expectedAssert = "AssertionError: T68 中文断言：虚拟环境错误";
writeFileSync(script, `import json, os, sys\nprint(json.dumps({"python":sys.version.split()[0],"prefix":sys.prefix,"stdout":sys.stdout.encoding,"stderr":sys.stderr.encoding,"utf8":os.environ.get("PYTHONUTF8")},ensure_ascii=False),flush=True)\nsys.stderr.write("${expectedStderr}\\n")\nsys.stderr.flush()\nassert False, "T68 中文断言：虚拟环境错误"\n`, "utf8");
const q = (value: string) => `'${value.replaceAll("'", "''")}'`;
const jobs = new JobRegistry(), tool = pwshTool(new HarnessState(workspace), jobs), persistent = new PersistentShell(() => workspace);
const rows: Record<string, unknown>[] = [];
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((block) => block.text ?? "").join("\n");
const clean = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
try {
	const created = await tool.execute("create-venv", { command: `& ${q(python)} -m venv --without-pip ${q(venv)}`, description: "Create isolated Chinese path Python venv", timeoutMs: 20000 }, undefined, undefined, {} as never);
	assert.equal((created.details as { exitCode?: number }).exitCode, 0, textOf(created as never));
	const command = `& ${q(join(venv, "Scripts", "python.exe"))} ${q(script)}`;
	const response = await tool.execute("assert-stderr", { command, description: "Reproduce Chinese Python assert and stderr", timeoutMs: 10000 }, undefined, undefined, {} as never);
	const standard = clean(textOf(response as never));
	rows.push({ tool: "pwsh", exitCode: (response.details as { exitCode?: number }).exitCode, output: standard, stderrPreserved: standard.includes(expectedStderr), assertPreserved: standard.includes(expectedAssert), replacementCharacter: standard.includes("\uFFFD") });
	const minimal = clean(await persistent.run(command, undefined));
	rows.push({ tool: "persistent_pwsh", output: minimal, stderrPreserved: minimal.includes(expectedStderr), assertPreserved: minimal.includes(expectedAssert), replacementCharacter: minimal.includes("\uFFFD") });
	const reproduced = rows.some((row) => !row.stderrPreserved || !row.assertPreserved || row.replacementCharacter);
	writeFileSync(evidence, JSON.stringify({ at: new Date().toISOString(), root, python, venv, script, command, reproduced, modelCalls: 0, changedEncodingCode: false, rows }, null, 2));
	console.log(JSON.stringify({ reproduced, evidence, root, rows }));
} finally { jobs.killAll(); persistent.reset(); }
