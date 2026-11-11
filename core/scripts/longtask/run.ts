import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { selectCases } from "./cases.ts";
import { runDryRun, type RunRow } from "./dry.ts";
import { renderReport } from "./report.ts";

const { values } = parseArgs({ options: { "dry-run": { type: "boolean" }, cases: { type: "string" },
	live: { type: "boolean" }, "source-data": { type: "string" }, help: { type: "boolean", short: "h" } } });
if (values.help) {
	console.log("node scripts/longtask/run.ts --dry-run [--cases L2,L3]");
	console.log('node scripts/longtask/run.ts --live --source-data "<现有测试版数据目录>"');
} else {
	if (values.live && (values["dry-run"] || !values["source-data"])) throw new Error("真实试跑须明确指定 --live 和 --source-data。");
	const items = selectCases(values.cases);
	const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
	const directory = new URL("../../../docs/testing/longtask/", import.meta.url);
	mkdirSync(directory, { recursive: true });
	const suffix = values.cases ? "-" + items.map(item => item.id).join("-") : "";
	const mode = values.live ? "live" : "dry";
	const publish = (model: string, rows: readonly RunRow[]) => {
		const name = mode === "dry" ? "dry-run" : model.replace(/[^a-zA-Z0-9._-]+/g, "-");
		const report = new URL(date + "-" + name + suffix + ".md", directory);
		writeFileSync(report, renderReport(date, model, mode, rows));
		if (rows.length === items.length) console.log(fileURLToPath(report));
	};
	const rows = values.live ? await (await import("./live.ts")).runLiveRound(items, values["source-data"]!, publish) : await runDryRun(items);
	if (!values.live) publish("无模型", rows);
	if (rows.some(row => !row.passed)) process.exitCode = 1;
}
