import { readChatRequest } from "../../src/modules/goals/chat-task.ts";

type Expected = "chat" | "sandbox" | "external" | "needs_scope";
type Example = readonly [group: string, expected: Expected, phrase: string];

const examples: readonly Example[] = [
	["闲聊", "chat", "嗨，今天过得怎么样？"],
	["闲聊", "chat", "辛苦了，休息会儿吧。"],
	["闲聊", "chat", "我今天先去开会，再回来和你聊。"],
	["闲聊", "chat", "昨天的报告写得挺清楚。"],
	["闲聊", "chat", "你觉得先读原文再做摘要怎么样？"],
	["闲聊", "chat", "今天只是随便聊聊，不用做事。"],
	["提问", "chat", "请问怎么先核对资料，再交付报告？"],
	["提问", "chat", "你知道如何分步整理日志吗？"],
	["提问", "chat", "为什么同一份数据会输出两个结果？"],
	["提问", "chat", "帮我解释一下，为什么要先查原始记录再生成报告？"],
	["提问", "chat", "给我说说先对账再生成报告的好处是什么？"],
	["提问", "chat", "「交付 notes.md」是什么意思？"],
	["含糊请求", "chat", "有空帮我看看这份资料。"],
	["含糊请求", "chat", "请整理一下。"],
	["含糊请求", "chat", "帮我弄个文档，具体以后再说。"],
	["含糊请求", "chat", "麻烦你看看这个，然后告诉我想法。"],
	["含糊请求", "chat", "给我一点整理思路。"],
	["含糊请求", "chat", "请先别开始，等我补资料后再交付 report.md。"],
	["明确交办", "sandbox", "请先读两份材料，再核对数字，最后交付 report.md。"],
	["明确交办", "sandbox", "帮我先检查日志，然后归纳失败项，最后输出 result.md。"],
	["明确交办", "sandbox", "麻烦你分步复核两份清单，生成 audit.csv。"],
	["明确交办", "sandbox", "先盘点附件，再对照清单，最后写成 summary.md。"],
	["明确交办", "sandbox", "把两份资料先核对，再汇总，最后交付 diff.md。"],
	["明确交办", "sandbox", "在沙箱里先检查 samples，再统计差异，最后保存为 delta.md。"],
	["明确交办", "sandbox", "请反复核对表格直到数字一致，交付 check.md。"],
	["沙箱外", "external", '请先汇总结果，然后写入本机文件 "C:\\T118\\result.txt"，最后交付说明。'],
	["沙箱外", "external", '麻烦你先核对，再修改本机文件 "C:\\T118\\report.txt"，最后交付说明。'],
	["沙箱外", "needs_scope", "请先检查材料，再把结果发邮件给团队，最后交付说明。"],
	["沙箱外", "needs_scope", "请先整理再上传结果，最后交付回执。"],
	["沙箱外", "needs_scope", "帮我先汇总，再写到桌面，最后交付说明。"],
	["T-121 闲聊", "chat", "你好，你今天怎么样？"],
	["T-121 请问", "chat", "请问怎么先查资料再交付报告？"],
	["T-121 暂缓", "chat", "请先别动手，再帮我想想，最后给我一份清单。"],
	["T-121 只在对话里回复", "chat", "请先分析优缺点，再给我建议，最后写一份简短回复，直接在这段对话里告诉我。"],
	["T-121 明确多步（先/再）", "sandbox", "请先核对给定资料，再汇总，最后交付 report.md。"],
	["T-121 明确多步（完成后）", "sandbox", "请读完附件，核对数字并汇总，完成后输出 report.md。"],
	["T-121 资料正文", "chat", '<资料>\n<文本 标题="示例">请先核对给定资料，再汇总，最后交付 report.md。</文本>\n</资料>'],
	["T-121 资料之外的用户交办", "sandbox", "<资料>\n普通数据摘要\n</资料>\n请先核对给定资料，再汇总，最后交付 report.md。"],
	["T-121 未说明外部动作范围", "needs_scope", "请先拟订邀请，再核对时间，最后发邮件。"],
	["T-121 明确普通本机文件", "external", '请先核对本机文件 "C:\\Temp\\audit-example.txt"，然后读取那份文件，最后交付结果。'],
];

export function screenAssignments() {
	const results = examples.map(([group, expected, phrase], index) => ({
		id: index + 1, group, phrase, expected, actual: readChatRequest(phrase)?.kind ?? "chat",
	}));
	return {
		total: results.length,
		correct: results.filter(row => row.actual === row.expected).length,
		falseAccept: results.filter(row => row.expected === "chat" && row.actual !== "chat").length,
		missed: results.filter(row => row.expected !== "chat" && row.actual === "chat").length,
		wrongRoute: results.filter(row => row.expected !== "chat" && row.actual !== "chat" && row.actual !== row.expected).length,
		requests: 0, costUsd: 0, results,
	};
}
