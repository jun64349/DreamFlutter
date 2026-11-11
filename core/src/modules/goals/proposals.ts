import { randomUUID } from "node:crypto";
import { RpcError, requireStr, type Core } from "../../core.ts";
import { json, parseJson } from "../../db.ts";
import type { Slot } from "../../slots/slot.ts";
import type { GoalScheduler } from "../goals.ts";
import { budgetPatch } from "./budget.ts";
import { object, readScope, readSpec } from "./types.ts";

interface ProposalRow {
	id: string; session_file: string; message_id: string; origin_text: string; draft: string;
	created_at: number; status: string; goal_id: string | null;
}

export function qualifyingRequest(text: string): boolean {
	const output = /(?:报告|表格|清单|文档|演示|脚本|项目|\.\w{2,5}\b|\breport\b|\bspreadsheet\b|\bdeliverable\b)/i;
	const phases = /(?:先[\s\S]*(?:再|然后|最后)|分[阶步]|多轮|反复|直到|测试[\s\S]*(?:修|迭代)|\bfirst\b[\s\S]*\b(?:then|finally)\b|\b(?:multiple stages|iterate)\b)/i;
	const scope = /(?:范围|只(?:看|用|读|改|在)|(?:文件夹|目录|资料|工作区|附件)里|[\\/][\w.-]+|\b(?:within|using only|scope)\b)/i;
	return output.test(text) && phases.test(text) && scope.test(text);
}

export class GoalProposals {
	private readonly core: Core;
	private readonly scheduler: GoalScheduler;
	constructor(core: Core, scheduler: GoalScheduler) { this.core = core; this.scheduler = scheduler; }

	pending() {
		return this.core.db.all<ProposalRow>("SELECT * FROM goal_proposals WHERE status='pending' ORDER BY created_at DESC,rowid DESC")
			.map(row => ({ id: row.id, sessionFile: row.session_file, originText: row.origin_text, createdAt: row.created_at,
				draft: parseJson<Record<string, unknown>>(row.draft, {}) }));
	}
	propose(slot: Slot, messageId: string, originText: string, value: unknown) {
		const file = slot.info().sessionFile;
		if (!file || !slot.sandboxed || slot.incognito || slot.unattended || !this.core.settings.get().goalProposalEnabled
			|| this.scheduler.goalForSlot(slot) || !qualifyingRequest(originText)) throw new RpcError("bad_request", "这次对话不需要提议设为目标");
		const input = object(value, "目标提议");
		const title = requireStr(input.title, "title").trim().slice(0, 180);
		const boundary = requireStr(input.boundary, "boundary").trim().slice(0, 2000);
		const spec = readSpec(input.spec);
		if (!title || !boundary || !spec.objective.trim() || !spec.deliverables.length || !spec.acceptance.length) {
			throw new RpcError("bad_request", "提议需要给出对象、结果、范围和验收草稿");
		}
		if (!spec.constraints.some(rule => rule.kind === "must" && rule.text === boundary)) spec.constraints.push({ text: boundary, kind: "must" });
		const defaults = this.core.settings.get().goalDefaultBudget;
		const budget = { maxCostUsd: defaults.costUsd, maxActiveMs: Math.floor(defaults.activeMinutes * 60_000), maxRuns: defaults.runs,
			maxParallel: defaults.concurrency, maxTokens: null, ...budgetPatch(input.budget ?? null) };
		const scope = readScope({ allowedPaths: input.allowedPaths, cwd: slot.cwd, partition: "butterfly", sandbox: true });
		const draft = { title, spec, boundary, budget, scope };
		const id = randomUUID();
		const change = this.core.db.run(`INSERT INTO goal_proposals(id,session_file,message_id,origin_text,draft,created_at,status)
			VALUES(?,?,?,?,?,?,'pending') ON CONFLICT(session_file,message_id) DO NOTHING`, id, file, messageId, originText, json(draft), Date.now());
		if (change.changes) this.changed();
		return "已提议设为目标，可以继续当前对话";
	}
	resolve(id: string, action: "accept" | "edit" | "reject", edits?: unknown) {
		const row = this.core.db.get<ProposalRow>("SELECT * FROM goal_proposals WHERE id=?", id);
		if (!row) throw new RpcError("not_found", "没有这条目标提议");
		if (row.status === "accepted" && action !== "reject" && row.goal_id) return this.scheduler.detail(row.goal_id);
		if (row.status !== "pending") throw new RpcError("gone", "这个目标提议已经处理");
		if (action === "reject") {
			this.core.db.run("UPDATE goal_proposals SET status='rejected' WHERE id=? AND status='pending'", id);
			this.changed();
			return { ok: true };
		}
		const draft = parseJson<Record<string, unknown>>(row.draft, {});
		if (action === "edit" && edits === undefined) return { id, draft };
		const changes = action === "edit" ? object(edits, "目标修改") : {};
		const spec = readSpec(changes.spec ?? {}, readSpec(draft.spec));
		const scope = { ...object(draft.scope, "目标范围"), ...object(changes.scope ?? {}, "目标范围") };
		const result = this.scheduler.create({ title: changes.title ?? draft.title, spec, scope, budget: changes.budget ?? draft.budget,
			sessionFile: row.session_file, originText: row.origin_text, source: "card", mandateRef: `user:goal-proposal-${id}` }, id);
		this.changed();
		return result;
	}
	private changed() { this.core.broadcast({ event: "goal.proposals.changed" }); }
}
