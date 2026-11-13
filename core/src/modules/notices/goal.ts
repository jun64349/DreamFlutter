import type { Notice } from "../../notify.ts";
import type { Goal } from "../goals/types.ts";

export function goalNotification(goal: Goal, key: string, kind: "completed" | "decision" | "acceptance" | "blocked" | "budget", itemId?: string): Notice {
	const category = kind === "completed" || kind === "acceptance" && goal.scope.sandbox ? "done"
		: kind === "acceptance" ? "review" : kind === "decision" ? "decision" : "blocked";
	const situation = kind === "completed" ? "已完成" : kind === "decision" ? "等你决定"
		: kind === "acceptance" ? (goal.scope.sandbox ? "产物已生成" : "等你验收")
		: kind === "budget" ? "预算已用完" : "遇到阻塞";
	const impact = kind === "completed"
		? goal.spec.deliverables.length ? `已完成约定的 ${goal.spec.deliverables.length} 项交付` : "本次执行与验收已结束"
		: kind === "acceptance" ? (goal.scope.sandbox ? "可查看产物与验收说明" : "验收后可以结束目标")
		: goal.resumeWhen ?? (kind === "decision" ? "需要你的答复才能继续" : "目标暂时不能继续");
	return { key, category, object: goal.title, situation, impact, objectRef: goal.id, itemId,
		action: kind === "decision" ? "查看并决定" : kind === "blocked" || kind === "budget" ? "查看卡住的原因" : "查看结果",
		target: { page: goal.sessionFile ? (goal.scope.sandbox ? "butterfly" : "chat") : "goals", goalId: goal.id, sessionFile: goal.sessionFile, taskId: goal.currentTaskId, itemId } };
}
