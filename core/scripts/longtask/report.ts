import type { RunRow } from "./dry.ts";

const cell = (value: string) => value.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
const money = (value: number | null) => value === null ? "未知" : "$" + value.toFixed(6);

export function renderReport(date: string, model: string, mode: "dry" | "live", rows: readonly RunRow[]): string {
	const total = rows.some(row => row.costUsd === null) ? null : rows.reduce((sum, row) => sum + row.costUsd!, 0);
	const dry = mode === "dry";
	const budget = rows.reduce((sum, row) => sum + (row.budgetUsd ?? 0), 0);
	return [
		"# 长任务验收报告",
		"",
		`- 日期 ${date}（Asia/Taipei）`,
		`- 模式 ${dry ? "A 段空跑" : "B 段真实模型一轮"}`,
		`- 模型 ${cell(model)}`,
		`- 本轮账本花费 ${money(total)}，整轮限额 $3，单目标限额 $0.50。`,
		...(!dry ? [`- 预算计入 ${money(budget)}，共 ${rows.reduce((sum, row) => sum + (row.requests ?? 0), 0)} 次请求。预算采用目录价格；缺最终用量时保留该请求的预留。账本花费以供应商返回的金额为准。`] : []),
		...(dry ? ["- 每个目标只创建，未执行。验收结论只针对固定素材、合成产物和回执。"] : []),
		"",
		`| 任务 | 工作区 | 验收 | Run 次数 | 账本花费 | ${dry ? "" : "预算计入 | 请求数 | "}耗时 | 目标终态 | 停下原因 |`,
		`| --- | --- | --- | ---: | ---: | ${dry ? "" : "---: | ---: | "}---: | --- | --- |`,
		...rows.map(row => `| ${row.id} ${cell(row.title)} | ${row.partition === "butterfly" ? "蝶君" : "工作台"} | ${row.passed ? "通过" : "未通过"} | ${row.runs} | ${money(row.costUsd)} | ${dry ? "" : `${money(row.budgetUsd ?? 0)} | ${row.requests ?? 0} | `}${row.elapsedMs} ms | ${cell(row.goalStatus)} | ${cell(row.reason)} |`),
		...rows.flatMap(row => ["", `## ${row.id} ${row.title}`, "", ...row.checks.map(check =>
			`- ${check.passed ? "通过" : "未通过"} · ${check.title}。 ${cell(check.detail)}`)]),
		"",
	].join("\n");
}
