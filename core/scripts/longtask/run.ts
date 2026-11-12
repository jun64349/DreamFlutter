import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { L2L3_TOTAL_USD, selectCases } from "./cases.ts";
import { runDryRun, type RunRow } from "./dry.ts";
import { renderReport } from "./report.ts";

const { values } = parseArgs({ options: { "dry-run": { type: "boolean" }, cases: { type: "string" },
	live: { type: "boolean" }, rerun: { type: "boolean" }, third: { type: "boolean" }, l2l3: { type: "boolean" },
	channel: { type: "string" }, "source-data": { type: "string" }, help: { type: "boolean", short: "h" } } });
if (values.help) {
	console.log("node scripts/longtask/run.ts --dry-run [--cases L2,L3]");
	console.log('node scripts/longtask/run.ts --live --source-data "<现有测试版数据目录>"');
	console.log('node scripts/longtask/run.ts --live --rerun --source-data "<现有测试版数据目录>"');
	console.log('node scripts/longtask/run.ts --live --third --source-data "<现有测试版数据目录>"');
	console.log('node scripts/longtask/run.ts --live --l2l3 --channel <第三轮渠道 ID> --source-data "<现有测试版数据目录>"');
} else {
	if (values.live && (values["dry-run"] || !values["source-data"])) throw new Error("真实试跑须明确指定 --live 和 --source-data。");
	const namedModes = [values.rerun, values.third, values.l2l3].filter(Boolean).length;
	const namedRound = namedModes > 0;
	if (namedRound && (!values.live || values.cases !== undefined || namedModes !== 1)) throw new Error("命名轮次须单选，并使用该轮次固定的任务集合。");
	if (values.l2l3 && !values.channel?.trim()) throw new Error("L2、L3 重跑须指定第三轮使用的渠道 ID。");
	if (values.channel !== undefined && !values.l2l3) throw new Error("--channel 只用于 L2、L3 重跑。");
	const items = selectCases(values.l2l3 ? "L2,L3" : values.cases);
	const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
	const directory = new URL("../../../docs/testing/longtask/", import.meta.url);
	mkdirSync(directory, { recursive: true });
	const suffix = values.cases ? "-" + items.map(item => item.id).join("-") : "";
	const mode = values.l2l3 ? "l2l3" : values.third ? "third" : values.rerun ? "rerun" : values.live ? "live" : "dry";
	const roundName = values.l2l3 ? "L2L3重跑" : values.third ? "第三轮" : "复跑";
	const namedReport = new URL(date + "-deepseek-v4.1-flash-" + roundName + ".md", directory);
	if (namedRound && existsSync(namedReport)) throw new Error("当天该轮报告已存在，未发请求。");
	let published = false;
	const publish = (model: string, rows: readonly RunRow[]) => {
		const name = mode === "dry" ? "dry-run" : model.replace(/[^a-zA-Z0-9._-]+/g, "-");
		const report = namedRound ? namedReport : new URL(date + "-" + name + suffix + ".md", directory);
		writeFileSync(report, renderReport(date, model, mode, rows), { flag: namedRound && !published ? "wx" : "w" });
		published = true;
		if (rows.length === items.length) console.log(fileURLToPath(report));
	};
	const rows = values.live ? await (await import("./live.ts")).runLiveRound(items, values["source-data"]!, publish,
		{ totalUsd: values.l2l3 ? L2L3_TOTAL_USD : undefined, channel: values.channel }) : await runDryRun(items);
	if (!values.live) publish("无模型", rows);
	if (rows.some(row => !row.passed)) process.exitCode = 1;
}
