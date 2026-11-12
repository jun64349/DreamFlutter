import { existsSync, readFileSync } from "node:fs";
import type { Core } from "../../src/core.ts";
import { readSessionEvidence, type Evidence } from "./checks.ts";

export const L5_QUESTION = "脚本还在后台运行吗？请先简短回复我的进度问题，完成事件到达后照原任务自动收尾。";

export interface JobFact {
	id: string;
	slot_id: string;
	status: string;
	started_at: number;
	ended_at: number | null;
	exit_code: number | null;
}

export function backgroundJob(core: Core, id: string): JobFact | undefined {
	return core.db.get<JobFact>("SELECT id,slot_id,status,started_at,ended_at,exit_code FROM jobs WHERE goal_id=? AND service=0 ORDER BY started_at LIMIT 1", id);
}

export function sessionTrace(core: Core, id: string) {
	const files = core.db.all<{ session_file: string }>(`SELECT DISTINCT session_file FROM tasks
		WHERE goal_id=? AND session_file IS NOT NULL UNION SELECT session_file FROM goals WHERE id=? AND session_file IS NOT NULL`, id, id)
		.map(row => row.session_file).filter(existsSync);
	return files.map((file, index) => ({ session: String(index + 1), text: readFileSync(file, "utf8") }));
}

export type Trace = ReturnType<typeof sessionTrace>;
export function toolFacts(trace: Trace) {
	const tools = trace.flatMap(record => readSessionEvidence(record.text, record.session));
	// Session line numbers are local. Merge timestamped traces before looking
	// for source reads after the initial Python call.
	return tools.every(tool => tool.at !== undefined) ? tools.sort((a, b) => a.at! - b.at!) : tools;
}

export function jobEvidence(core: Core, goal: string, trace: Trace, sentAt: number | undefined): Evidence["job"] {
	const job = backgroundJob(core, goal);
	if (!job) return;
	let userAt = NaN, replyAt = NaN;
	for (const file of trace) {
		let questionSeen = false;
		for (const line of file.text.split(/\r?\n/).filter(Boolean)) {
			const entry = JSON.parse(line);
			if (entry.type !== "message" || !entry.message) continue;
			const message = entry.message;
			const content = typeof message.content === "string" ? message.content
				: Array.isArray(message.content) ? message.content.filter((block: { type?: string }) => block.type === "text")
					.map((block: { text?: string }) => block.text).join("\n") : "";
			const at = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp);
			if (message.role === "user") {
				questionSeen = !!sentAt && content.trim() === L5_QUESTION && at >= sentAt;
				if (questionSeen) userAt = at;
			}
			if (questionSeen && message.role === "assistant" && content.trim() && !["error", "aborted"].includes(message.stopReason)) {
				replyAt = at;
				break;
			}
		}
		if (Number.isFinite(replyAt)) break;
	}
	const continuation = core.db.get<{ at: number | null }>(`SELECT MIN(r.started_at) AS at FROM runs r
		JOIN goal_intents i ON i.run_id=r.id WHERE i.goal_id=? AND i.action='run' AND r.started_at>=?
		AND r.prompt LIKE '继续推进目标%'`, goal, job.ended_at ?? Number.MAX_SAFE_INTEGER);
	const finished = core.db.get(`SELECT 1 FROM goal_events WHERE goal_id=? AND kind='job.finished'
		AND json_extract(payload, '$.jobId')=?`, goal, job.id);
	return { start: job.started_at, end: job.ended_at ?? NaN, userAt, replyAt, continuationAt: continuation?.at ?? NaN,
		sameGoal: true, automatic: !!finished && continuation?.at != null, status: job.exit_code === 0 ? job.status : "failed" };
}
