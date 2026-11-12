import { statSync } from "node:fs";
import { basename, extname, isAbsolute, posix, resolve } from "node:path";
import { sandboxEnv } from "../../agent/state.ts";
import { normalizeCwd, type Core } from "../../core.ts";
import { parseJson } from "../../db.ts";
import { SANDBOX_WORKSPACE } from "../../sandbox/sandbox.ts";
import { COUNTED_GOAL_RUN } from "./budget.ts";
import { toGoal, type Goal, type GoalRow, type GoalStatus } from "./types.ts";

export const GOAL_VIEWS = ["decide", "blocked", "accept", "running", "paused", "done"] as const;
export type GoalView = typeof GOAL_VIEWS[number];
type Partition = Goal["scope"]["partition"];
type Counts = Record<GoalView, number>;
const VIEW = `CASE
	WHEN status='draft' OR (status='waiting_user' AND reason IS NOT 'acceptance') THEN 'decide'
	WHEN status='blocked' THEN 'blocked'
	WHEN status='waiting_user' THEN 'accept'
	WHEN status IN ('queued','running','reviewing','waiting_dependency') THEN 'running'
	WHEN status='paused' THEN 'paused'
	ELSE 'done' END`;
const PARTITION = "COALESCE(json_extract(scope,'$.partition'),'workbench')";

export const GOAL_NOTICE_TITLES = {
	completed: "目标已完成", decision: "目标等你决定", acceptance: "目标等你验收",
	blocked: "目标遇到阻塞", budget: "目标预算已用完",
};
type Notice = keyof typeof GOAL_NOTICE_TITLES;
export function goalNotice(row: GoalRow): { kind: Notice; key: string } | null {
	if (row.stop_intent) return null;
	let kind: Notice;
	if (row.status === "completed") kind = "completed";
	else if (row.status === "waiting_user") kind = row.reason === "acceptance" ? "acceptance" : "decision";
	else if (row.status === "blocked") kind = "blocked";
	else if (row.status === "paused" && row.reason?.startsWith("budget_")) kind = "budget";
	else return null;
	const episode = kind === "completed" ? kind : `${kind}:${row.lease_generation}:${row.reason ?? ""}`;
	return { kind, key: `notify:${row.id}:${row.revision}:${episode}` };
}

const oneLine = (text: string | undefined | null) => text?.replace(/\s+/g, " ").trim().slice(0, 160) || undefined;
const LABELS: Record<string, string> = {
	budget_cost: "费用预算已用完", budget_tokens: "Token 预算已用完", budget_time: "活跃时长已用完", budget_runs: "执行次数已用完",
	restart_check: "等你核对恢复情况", imported: "等你核对导入的范围", needs_permission: "等你确认执行范围",
	channel_unavailable: "渠道不可用",
	waiting_job: "等待后台作业", waiting_subagent: "等待子任务", waiting_event: "等待外部事件",
};
interface RunFiles { id: string; task_id: string; cwd: string; files: string | null }
interface TaskArtifact { id: string; task_id: string; path: string; updated_at: number }
interface Proposal { id: string; session_file: string; origin_text: string; draft: string; created_at: number }

export class GoalViews {
	private readonly core: Core;
	constructor(core: Core) { this.core = core; }

	list(status: GoalStatus | undefined, limit: number, view?: GoalView, partition?: Partition) {
		const where: string[] = [];
		const params: string[] = [];
		if (status) { where.push("status=?"); params.push(status); }
		if (view) { where.push(`(${VIEW})=?`); params.push(view); }
		if (partition) { where.push(`${PARTITION}=?`); params.push(partition); }
		const rows = this.core.db.all<GoalRow & { view: GoalView }>(`SELECT *, ${VIEW} view FROM goals
			${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC,rowid DESC LIMIT ?`, ...params, limit);
		const goals = rows.map(row => {
			const goal = toGoal(row);
			return { ...goal, kind: "goal" as const, view: row.view, ...this.labels(goal) };
		});
		if (view !== "decide" || status || partition === "workbench") return goals;
		const proposals = this.core.db.all<Proposal>(`SELECT * FROM goal_proposals WHERE status='pending'
			ORDER BY created_at DESC,rowid DESC LIMIT ?`, limit).map(row => {
			const draft = parseJson<{ title?: string }>(row.draft, {});
			return { id: row.id, kind: "goal_proposal" as const, view: "decide" as const, title: draft.title ?? "目标提议",
				sessionFile: row.session_file, originText: row.origin_text, draft, partition: "butterfly" as const,
				createdAt: row.created_at, updatedAt: row.created_at, stage: "等你决定", next: "查看目标提议" };
		});
		return [...goals, ...proposals].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
	}

	counts() {
		const empty = () => Object.fromEntries(GOAL_VIEWS.map(view => [view, 0])) as Counts;
		const counts = { butterfly: empty(), workbench: empty() };
		const rows = this.core.db.all<{ partition: Partition; view: GoalView; count: number }>(`
			SELECT ${PARTITION} partition,${VIEW} view,count(*) count FROM goals GROUP BY 1,2
			UNION ALL SELECT 'butterfly','decide',count(*) FROM goal_proposals WHERE status='pending'`);
		for (const row of rows) counts[row.partition][row.view] += row.count;
		return counts;
	}

	private runs(id: string) {
		return this.core.db.all<RunFiles>(`SELECT r.id,r.task_id,r.cwd,r.files FROM runs r JOIN tasks t ON t.id=r.task_id
			WHERE t.goal_id=? AND r.kind='conversation' AND ${COUNTED_GOAL_RUN} ORDER BY r.started_at,r.rowid`, id);
	}

	artifacts(goal: Goal) {
		const rows = this.core.db.all<TaskArtifact>(`SELECT a.id,a.task_id,a.path,a.updated_at FROM artifacts a JOIN tasks t ON t.id=a.task_id
			WHERE t.goal_id=? ORDER BY a.updated_at DESC,a.rowid DESC`, goal.id);
		if (!rows.length) return [];
		const distro = goal.scope.sandbox ? this.core.sandboxProvider?.()?.distro : undefined;
		const sandbox = distro ? sandboxEnv(distro) : undefined;
		const origin = new Map<string, { runId: string; round: number }>();
		for (const [index, run] of this.runs(goal.id).entries()) {
			for (const raw of parseJson<string[]>(run.files, [])) {
				const path = sandbox ? sandbox.local(posix.resolve(SANDBOX_WORKSPACE, raw)) : isAbsolute(raw) ? raw : resolve(run.cwd, raw);
				origin.set(`${run.task_id}:${normalizeCwd(path)}`, { runId: run.id, round: index + 1 });
			}
		}
		const seen = new Set<string>();
		return rows.flatMap(row => {
			const key = normalizeCwd(row.path);
			if (seen.has(key)) return [];
			try {
				const stat = statSync(row.path);
				if (!stat.isFile()) return [];
				seen.add(key);
				const run = origin.get(`${row.task_id}:${key}`);
				return [{ id: row.id, taskId: row.task_id, path: row.path, name: basename(row.path),
					type: extname(row.path).slice(1).toLowerCase() || "file", size: stat.size, updatedAt: row.updated_at,
					runId: run?.runId ?? null, round: run?.round ?? null }];
			} catch { return []; }
		});
	}

	labels(goal: Goal, artifactName?: string): { stage: string; next: string } {
		const review = goal.latestReviewId && this.core.db.get<{ next: string | null }>(
			"SELECT json_extract(reasons,'$.next') AS next FROM goal_reviews WHERE id=? AND revision=?", goal.latestReviewId, goal.revision);
		const advice = oneLine(review ? review.next : null);
		const recovery = oneLine(goal.resumeWhen);
		const reason = goal.reason && LABELS[goal.reason];
		const round = () => this.core.db.get<{ count: number }>(`SELECT count(*) count FROM runs r JOIN tasks t ON t.id=r.task_id
			WHERE t.goal_id=? AND r.kind='conversation' AND ${COUNTED_GOAL_RUN}`, goal.id)!.count;
		const inRound = (text: string, pending = false) => `第 ${Math.max(1, round() + Number(pending))} 轮 · ${text}`;
		switch (goal.status) {
			case "draft": return { stage: "等你补齐目标", next: recovery ?? "补齐目标结果和工作区" };
			case "queued": return { stage: inRound("等待执行", true), next: advice ?? "继续推进目标" };
			case "running": return { stage: inRound("正在执行"), next: advice ?? "执行后核验产物" };
			case "reviewing": return { stage: inRound("正在验收"), next: "核对产物和验收项" };
			case "waiting_dependency": return { stage: inRound(recovery ? `等${recovery.replace(/^等待?|^等/, "")}` : reason ?? "等待条件"), next: advice ?? "条件满足后继续" };
			case "waiting_user": {
				if (goal.reason !== "acceptance") return { stage: "等你决定", next: recovery ?? reason ?? "查看需要你确认的事项" };
				const name = artifactName ?? this.artifacts(goal)[0]?.name;
				return { stage: "等你验收", next: name ? `等你验收：${name}` : "等你验收产物" };
			}
			case "blocked": return { stage: "遇到阻塞", next: recovery ?? advice ?? "查看阻塞原因" };
			case "paused": return { stage: reason ?? "已暂停", next: recovery ?? "由你继续这个目标" };
			case "completed": return { stage: "已完成", next: "查看产物" };
			case "failed": return { stage: "未完成", next: recovery ?? "查看失败原因" };
			case "cancelled": return { stage: "已取消", next: "目标已结束" };
		}
	}
}
