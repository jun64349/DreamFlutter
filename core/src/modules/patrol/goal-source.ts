import type { Core } from "../../core.ts";
import type { Goal, GoalRow } from "../goals/types.ts";
import { goalNotice } from "../goals/presentation.ts";
import { goalNoticeBlocksPatrol, goalNoticeReceipt } from "../goals/notices.ts";
import type { GoalFinding, GoalSource } from "./facts.ts";

const statuses = ["blocked", "paused", "waiting_user"] as const;
const stage = { blocked: "遇到阻塞", paused: "停滞", waiting_user: "在等用户决定" };

export function stalledGoals(core: Core): GoalSource {
	return async () => {
		const lists = await Promise.all(statuses.map(status => core.call("goals.list", { status, partition: "butterfly", limit: 500 }) as Promise<Goal[]>));
		return lists.flatMap((goals, index) => {
			const status = statuses[index]!;
			return goals.flatMap(goal => {
				if (status === "paused" && goal.reason !== "stalled" || status === "waiting_user" && goal.reason === "acceptance") return [];
				const row = core.db.get<GoalRow>("SELECT * FROM goals WHERE id=?", goal.id);
				if (!row || row.stop_intent || row.status !== status || row.revision !== goal.revision) return [];
				const key = `goal:${goal.id}:${status}:${goal.revision}`;
				const noticeKey = goalNotice(row)?.key ?? key;
				const receipt = goalNoticeReceipt(core.db, noticeKey);
				const alreadyNotified = goalNoticeBlocksPatrol(core.db, noticeKey);
				// A native delivery can fail after patrol has already reviewed a queued finding.
				const fallback = !alreadyNotified && receipt?.sender === "goal" && receipt.state === "failed"
					&& core.db.get(`SELECT 1 FROM patrol_reported WHERE fact_key=? AND state='processed'
						AND json_extract(fact,'$.alreadyNotified')=1`, key);
				return [{
					key: fallback ? `${noticeKey}:fallback` : key,
					text: `蝶君目标「${goal.title}」${stage[status]}${goal.resumeWhen ? "，" + goal.resumeWhen : ""}`,
					alreadyNotified,
					goal: { id: goal.id, status, revision: goal.revision, generation: row.lease_generation, reason: row.reason, noticeKey },
				}];
			});
		});
	};
}

export function currentFinding(core: Core, finding: GoalFinding): boolean {
	return !!core.db.get(`SELECT 1 FROM goals WHERE id=? AND status=? AND revision=? AND lease_generation=?
		AND reason IS ? AND stop_intent IS NULL`, finding.id, finding.status, finding.revision, finding.generation, finding.reason);
}
