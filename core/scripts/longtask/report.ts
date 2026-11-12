import type { RunRow } from "./dry.ts";
import type { Condition } from "./checks.ts";
import { L2L3_TOTAL_USD, PER_GOAL_USD, TOTAL_USD } from "./cases.ts";

const cell = (value: string) => value.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
const money = (value: number | null) => value === null ? "未知" : "$" + value.toFixed(6);

const modes = { dry: "A 段空跑", live: "B 段真实模型一轮", rerun: "B 段复跑一轮", third: "B 段第三轮", l2l3: "B 段 L2、L3 重跑" };

function conditionLines(conditions: readonly Condition[], depth = 1): string[] {
	return conditions.flatMap(condition => {
		const status = condition.passed === null ? "未验证" : condition.passed ? "成立" : "不成立";
		const detail = condition.detail ? "。 " + cell(condition.detail) : "";
		return ["  ".repeat(depth) + "- " + status + " · " + condition.title + detail,
			...conditionLines(condition.conditions ?? [], depth + 1)];
	});
}

export function renderReport(date: string, model: string, mode: keyof typeof modes, rows: readonly RunRow[]): string {
	const total = rows.some(row => row.costUsd === null) ? null : rows.reduce((sum, row) => sum + row.costUsd!, 0);
	const dry = mode === "dry";
	const budget = rows.reduce((sum, row) => sum + (row.budgetUsd ?? 0), 0);
	const corrected = rows.reduce((sum, row) => sum + row.runs, 0);
	const raw = rows.reduce((sum, row) => sum + (row.rawRuns ?? 0), 0);
	const receipts = rows.flatMap(row => row.receipts ?? []);
	return [
		"# 长任务验收报告",
		"",
		`- 日期 ${date}（Asia/Taipei）`,
		`- 模式 ${modes[mode]}`,
		`- 模型 ${cell(model)}`,
		`- 本轮账本花费 ${money(total)}，整轮限额 $${mode === "l2l3" ? L2L3_TOTAL_USD : TOTAL_USD}，单目标限额 $${PER_GOAL_USD.toFixed(2)}。`,
		...(!dry ? [
			`- 预算计入 ${money(budget)}。共 ${receipts.length} 条请求回执，其中 ${receipts.filter(receipt => receipt.transport).length} 次进入渠道传输，${receipts.filter(receipt => receipt.finalUsage).length} 次收到最终用量帧。预算按目录价格核算，缺最终用量时保留预留。账本花费以供应商返回的金额为准。`,
			`- 修正轮数 ${corrected}，原始回执 ${raw}。修正轮数取 goals.get 的 budgetStatus.used.runs，原始回执数包含 runs 表中与目标工作项关联的所有记录。尚未开始的回执、确认在预算或准备阶段被拦住且没有请求账本记录的回执不计入修正轮数。`,
		] : []),
		...(dry ? ["- 每个目标只创建，未执行。验收结论只针对固定素材、合成产物和回执。"] : []),
		"",
		`| 任务 | 工作区 | 验收 | ${dry ? "Run 次数" : "修正轮数 | 原始回执数"} | 账本花费 | ${dry ? "" : "预算计入 | 渠道请求数 | "}耗时 | 目标终态 | 停下原因 |`,
		`| --- | --- | --- | ---: | ${dry ? "" : "---: | "}---: | ${dry ? "" : "---: | ---: | "}---: | --- | --- |`,
		...rows.map(row => `| ${row.id} ${cell(row.title)} | ${row.partition === "butterfly" ? "蝶君" : "工作台"} | ${row.passed ? "通过" : "未通过"} | ${row.runs} | ${dry ? "" : `${row.rawRuns ?? 0} | `}${money(row.costUsd)} | ${dry ? "" : `${money(row.budgetUsd ?? 0)} | ${row.requests ?? 0} | `}${row.elapsedMs} ms | ${cell(row.goalStatus)} | ${cell(row.reason)} |`),
		...rows.flatMap(row => ["", `## ${row.id} ${row.title}`, "", ...row.checks.flatMap(check => [
			`- ${check.passed ? "通过" : "未通过"} · ${check.title}。 ${cell(check.detail)}`,
			...conditionLines(check.conditions),
		]),
			...(row.runNotes ? [`- 轮数差异。${row.runNotes}`] : []),
			...(!dry && row.receipts?.length ? ["", "| 请求序号 | 结束状态 | 最终用量帧 | 进入渠道传输 | 拒绝类别 | HTTP 状态码 | 未发原因 |", "| ---: | --- | --- | --- | --- | ---: | --- |",
				...row.receipts.map((receipt, index) => `| ${index + 1} | ${receipt.status} | ${receipt.finalUsage ? "是" : "否"} | ${receipt.transport ? "是" : "否"} | ${receipt.failure?.category ?? "—"} | ${receipt.failure?.httpStatus ?? "—"} | ${receipt.failure?.notSent ?? "—"} |`)] : []),
		]),
		"",
	].join("\n");
}
