import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { readZip } from "../../src/cards/zip.ts";
import { Core } from "../../src/core.ts";
import { Logger } from "../../src/log.ts";
import { RecordingNotifier } from "../../src/notify.ts";
import { corePaths } from "../../src/paths.ts";
import { evaluate, readSessionEvidence, wordHeadings, type Check, type Evidence } from "./checks.ts";
import type { Case } from "./cases.ts";
import type { RequestReceipt } from "./request-evidence.ts";
import { DATA_ROWS, generateFixture, makeDocx, MIN_HEADINGS, SALES_ROWS, SCRIPT_SECONDS, sha256, type Answers } from "./fixtures/generate.ts";

export interface RunRow {
	id: string;
	title: string;
	partition: string;
	passed: boolean;
	runs: number;
	rawRuns?: number;
	runNotes?: string;
	costUsd: number | null;
	budgetUsd?: number;
	requests?: number;
	receipts?: RequestReceipt[];
	elapsedMs: number;
	reason: string;
	goalStatus: string;
	checks: Check[];
}

function png(): Buffer {
	const chunk = (name: string, data: Buffer) => {
		const typed = Buffer.concat([Buffer.from(name), data]);
		const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
		size.writeUInt32BE(data.length);
		checksum.writeUInt32BE(crc32(typed));
		return Buffer.concat([size, typed, checksum]);
	};
	const header = Buffer.from("00000001000000010802000000", "hex");
	return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.from([0, 40, 95, 172]))), chunk("IEND", Buffer.alloc(0))]);
}

function verifyInputs(item: Case, directory: string, answers: Answers): void {
	const read = (name: string) => readFileSync(join(directory, name));
	switch (item.id) {
		case "L1": assert.equal(wordHeadings(read("original.docx")), 8); break;
		case "L2": {
			const sheet = readZip(read("sales.xlsx")).find(part => part.name === "xl/worksheets/sheet1.xml");
			assert.equal([...sheet!.data.toString().matchAll(/<row r=/g)].length, SALES_ROWS + 1);
			assert.equal(answers.months?.length, 12);
			break;
		}
		case "L3": assert.equal(read("large.csv").toString().trimEnd().split("\n").length, DATA_ROWS + 1); break;
		case "L4": assert.match(read("brief.txt").toString(), /合成样例/); break;
		case "L5": assert.match(read("long-job.ps1").toString(), new RegExp("Start-Sleep -Seconds " + SCRIPT_SECONDS)); break;
		case "L6":
			assert.ok(read("north.csv").length && read("south.csv").length);
			assert.throws(() => read("west.csv"), { code: "ENOENT" });
			break;
		case "L7": assert.ok(read("phase-one.txt").length && read("phase-two.txt").length); break;
	}
}

/** Synthetic files and receipts exercise the same evaluator the live driver will call. */
export function dryEvidence(item: Case, directory: string, answers: Answers): Evidence {
	const output = join(directory, "output");
	mkdirSync(output);
	const file = (name: string, content: string | Buffer) => writeFileSync(join(output, name), content);
	const source = (name: string) => readFileSync(join(directory, name));
	const session: object[] = [];
	const image = { type: "image", mimeType: "image/png", data: png().toString("base64") };
	const tool = (name: string, args: Record<string, unknown>, shot = false) => {
		const id = "tool-" + session.length;
		session.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name, id, arguments: args }] } });
		session.push({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: name, isError: false, content: shot ? [image] : [] } });
	};
	const evidence: Evidence = { status: "completed", missing: [], tools: [] };
	switch (item.id) {
		case "L1": file("outline.docx", makeDocx(Array.from({ length: MIN_HEADINGS }, (_, i) => ({ title: "要点 " + (i + 1), text: "合成输出。" })))); break;
		case "L2":
			file("monthly.csv", "month,units,revenue_cents\n" + answers.months!.map(row => [row.month, row.units, row.revenue_cents].join(",")).join("\n"));
			file("units.png", png());
			file("revenue.png", png());
			file("report.html", '<h1>销售报告</h1><img src="units.png"><img src="revenue.png">');
			tool("render_html", { file_path: "output/report.html" }, true);
			break;
		case "L3":
			file("statistics.json", JSON.stringify(answers.statistics));
			tool("python", { code: "import pandas as pd\ndf = pd.read_csv('large.csv')" });
			tool("python", { code: "stats = df.groupby('group').amount_cents.sum()" });
			break;
		case "L4":
			file("page.html", '<h1>合成样例</h1><section id="overview">概览</section><section id="contact">联系</section>');
			tool("render_html", { file_path: "output/page.html" }, true);
			tool("edit", { file_path: "output/page.html" });
			tool("render_html", { file_path: "output/page.html" }, true);
			break;
		case "L5": {
			const start = 1000, end = start + SCRIPT_SECONDS * 1000;
			file("job.json", JSON.stringify({ status: "done", startedAt: start, endedAt: end }));
			file("summary.txt", "合成结果，后台作业完成。\n");
			evidence.job = { start, end, userAt: 2000, replyAt: 3000, continuationAt: end + 1000, sameGoal: true, automatic: true, status: "completed" };
			break;
		}
		case "L6":
			file("north.csv", source("north.csv"));
			file("south.csv", source("south.csv"));
			evidence.status = "blocked";
			evidence.missing = ["output/west.csv"];
			break;
		case "L7": {
			file("checkpoint.txt", source("phase-one.txt"));
			file("final.txt", source("phase-two.txt"));
			const checkpoint = join(output, "checkpoint.txt");
			evidence.restart = { before: "paused", after: "paused", resumed: true, checkpointSha: sha256(checkpoint), checkpointMtime: lstatSync(checkpoint).mtimeMs, rewrites: 0 };
			break;
		}
	}
	evidence.tools = readSessionEvidence(session.map(entry => JSON.stringify(entry)).join("\n"), item.id + "-synthetic");
	return evidence;
}

export async function runDryRun(items: readonly Case[]): Promise<RunRow[]> {
	const root = mkdtempSync(join(resolve(tmpdir()), "df-t105-dry-"));
	let core: Core | undefined;
	try {
		const agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
		mkdirSync(agentDir);
		mkdirSync(sessionDir);
		core = new Core({ paths: corePaths(join(root, "data")), agentDir, sessionDir, log: new Logger(undefined, false), notifier: new RecordingNotifier() });
		await core.call("goals.control", { action: "emergency" });
		const rows: RunRow[] = [];
		for (const item of items) {
			const started = performance.now(), workspace = join(root, item.id);
			const answers = generateFixture(item.id, workspace);
			verifyInputs(item, workspace, answers);
			const partition = item.sandbox ? "butterfly" : "workbench";
			const goal = await core.call("goals.create", {
				title: item.title, originText: item.prompt, mandateRef: "user:t105-dry:" + item.id,
				scope: { cwd: workspace, partition, sandbox: item.sandbox },
				spec: { objective: item.prompt, acceptance: item.files.map(path => ({ id: path, text: "核验 " + path, layer: "program",
					check: { kind: "file_exists", args: { path } } })) }, budget: { maxCostUsd: 0.5 },
			}) as { status: string; stopIntent: string };
			assert.deepEqual([goal.status, goal.stopIntent], ["paused", "emergency"]);
			const evidence = dryEvidence(item, workspace, answers);
			const checks = evaluate(item, workspace, answers, evidence);
			rows.push({ id: item.id, title: item.title, partition, passed: checks.every(check => check.passed),
				runs: 0, costUsd: 0, elapsedMs: Math.round(performance.now() - started), goalStatus: goal.status,
				reason: "空跑保护：只创建目标，验收器使用合成回执", checks });
		}
		assert.equal(core.db.get<{ n: number }>("SELECT count(*) AS n FROM runs")?.n, 0);
		assert.equal(core.db.get<{ n: number }>("SELECT count(*) AS n FROM request_ledger")?.n, 0);
		return rows;
	} finally {
		try { await core?.shutdown(); }
		finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
	}
}
