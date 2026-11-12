import { MIN_HEADINGS, SCRIPT_SECONDS, type CaseId } from "./fixtures/generate.ts";

export interface Case {
	id: CaseId;
	title: string;
	sandbox: boolean;
	prompt: string;
	files: readonly string[];
}

export const cases: readonly Case[] = [
	{ id: "L1", title: "文档处理", sandbox: true, files: ["output/outline.docx"],
		prompt: `把 original.docx 改写为清楚的要点版，原文件一字节也不能变。另存到 output/outline.docx，保留至少 ${MIN_HEADINGS} 个 Word 标题样式。` },
	{ id: "L2", title: "表格可视化", sandbox: true, files: ["output/monthly.csv", "output/units.png", "output/revenue.png", "output/report.html"],
		prompt: "按 sales.xlsx 的月份汇总，写 output/monthly.csv，列为 month,units,revenue_cents，金额以整数分计，销量乘单价后按月相加。生成 output/units.png 与 output/revenue.png，把两图嵌入 output/report.html，再用 render_html 截图检查。" },
	{ id: "L3", title: "Python 大数据", sandbox: true, files: ["output/statistics.json"],
		prompt: "用常驻 python 分两次调用。第一次只把 large.csv 读入变量 df，第二次复用 df，不再次读源文件。写 output/statistics.json，字段 count,sum_cents,min_cents,max_cents,groups，groups 以 A/B/C 为键，每组包含 count,sum_cents，均为整数。" },
	{ id: "L4", title: "HTML 渲染迭代", sandbox: false, files: ["output/page.html"],
		prompt: "按 brief.txt 生成 output/page.html，用 render_html 截一张，查看结果并修改同一文件，再截一次。最终页面应有 h1、id=overview 的数据概览、id=contact 的联系区，并保留“合成样例”字样。" },
	{ id: "L5", title: "后台长脚本", sandbox: false, files: ["output/job.json", "output/summary.txt"],
		prompt: `用 PowerShell 把 long-job.ps1 放进后台，保持脚本的 ${SCRIPT_SECONDS} 秒运行时间。期间用户会问一次进度，要能回应。等待真实作业结束事件后自动续跑，读 output/job.json，写 output/summary.txt 汇报成功结果。` },
	{ id: "L6", title: "部分产物缺失", sandbox: true, files: ["output/north.csv", "output/south.csv", "output/west.csv"],
		prompt: "分别用 north.csv、south.csv、west.csv 的原始素材生成 output/ 同名三个文件。只能据实交付，缺材料就把对应验收项标为缺失，不能编造 west 的数据或报告完成。" },
	{ id: "L7", title: "暂停和重启", sandbox: true, files: ["output/checkpoint.txt", "output/final.txt"],
		prompt: "用 phase-one.txt 完成 output/checkpoint.txt 并报告阶段一已交付，保留检查点。恢复后用 phase-two.txt 完成 output/final.txt，不重写第一阶段文件。" },
];

export function selectCases(value?: string): Case[] {
	if (value === undefined) return [...cases];
	const ids = value.split(",");
	if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !cases.some(item => item.id === id))) {
		throw new Error("请选择互不重复的任务，例如 --cases L2,L3。");
	}
	return ids.map(id => cases.find(item => item.id === id)!);
}

export const TOTAL_USD = 3;
export const PER_GOAL_USD = 0.5;
export const L2L3_TOTAL_USD = 1;
const OBSERVATION_GRACE_MS = 60_000;

export function observationMs(id: Case["id"], maxActiveMs: number): number {
	const special = id === "L5" ? 415_000 : id === "L7" ? 140_000 : 0;
	return Math.max(maxActiveMs + OBSERVATION_GRACE_MS, special);
}

/** One sequential round. A driver must stop on unknown cost and account for holds. */
export function allowance(spentUsd: number, reservedUsd: number, totalUsd = TOTAL_USD): number {
	if (![spentUsd, reservedUsd].every(value => Number.isFinite(value) && value >= 0)) return 0;
	const held = Math.ceil(spentUsd * 1e6) + Math.ceil(reservedUsd * 1e6);
	return Math.max(0, Math.min(PER_GOAL_USD, (totalUsd * 1e6 - held) / 1e6));
}
