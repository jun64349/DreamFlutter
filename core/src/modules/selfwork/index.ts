import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type Core, type CoreModule, requireStr, RpcError } from "../../core.ts";
import { json, parseJson } from "../../db.ts";
import { Gateway } from "../../gateway/gateway.ts";
import { finite, withLedgerContext } from "../../ledger/types.ts";
import { SANDBOX_ENTRY } from "../../pi/host.ts";
import { readSessionEntries } from "../../pi/session-metadata.ts";
import { textOf } from "../../runs.ts";
import { redact } from "../../security/redaction.ts";
import type { Slot } from "../../slots/slot.ts";
import { GoalsModule } from "../goals.ts";
import { estimateGoalCost } from "../goals/budget.ts";
import { selfworkDeliverable, type SelfworkDelivery, type SelfworkDraft } from "../goals/selfwork.ts";
import type { Goal } from "../goals/types.ts";
import { Llm, parseJsonAnswer } from "../llm.ts";
import { MemoryModule } from "../memory.ts";
import { localDay, SessionIndex } from "../session-index.ts";
import type { TrialRunner } from "../skill-trial.ts";
import { SelfworkSkills, type SkillDraft } from "./skills.ts";
import { requireUser } from "./access.ts";

const minute = 60_000;
const idleFor = 15 * minute;
const cooldown = 7 * 24 * 60 * minute;
const maxOutput = 1200;
const learningMaxOutput = 4096;
const planningPreviewLength = 240;
type Source = "goal" | "learning" | "skill";
type State = "planning" | "testing" | "held" | "running" | "completed" | "skipped" | "stopped";
interface LongGoal { id: string; title: string; instruction: string; revision: number }
interface Run {
	id: string; source: Source; long_goal_id: string | null; long_goal_revision: number | null;
	goal_id: string | null; state: State; topic: string | null; plan: string | null; reason: string | null;
}
interface Decision { topic: string; title: string; instruction: string; share: boolean; external: boolean; skill?: SkillDraft }
export type GoalDraft = SelfworkDraft;

/** Requires a goal service that checks the callback before each request and protected tool, and accounts in the supplied source. */
export interface SelfworkGoalService {
	launch(draft: GoalDraft, authorize: () => boolean): string;
	get(id: string): (Pick<Goal, "status" | "reason" | "stopIntent"> & { delivery?: SelfworkDelivery }) | undefined;
	pause(id: string, reason?: string): void;
}
export interface SelfworkOptions {
	clock?: () => number;
	trialRunner?: TrialRunner;
	goalService?: SelfworkGoalService | null;
}

const actions = { goal: "goal_self", learning: "learning", skill: "skill" } as const;
const activeStates = "('planning','testing','running')";
const label = { goal: "长期目标", learning: "空闲学习", skill: "蝶君自写技能" } as const;

function bounded(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max ? value.trim() : undefined;
}

function decision(obj: Record<string, unknown> | undefined, source: Source): Decision | undefined {
	if (!obj || obj.action !== "proceed" && obj.action !== "external") return undefined;
	const topic = bounded(obj.topic, 120), title = bounded(obj.title, 100), instruction = bounded(obj.instruction, 1200);
	if (!topic || !title || !instruction || !topicKey(topic)) return undefined;
	const output = { topic, title, instruction, share: obj.share === true, external: obj.action === "external" };
	if (source !== "skill" || output.external) return output;
	const draft = obj.skill as Record<string, unknown> | undefined;
	const name = bounded(draft?.name, 48), description = bounded(draft?.description, 500), body = bounded(draft?.body, 12_000);
	return name && description && body ? { ...output, skill: { name, description, body } } : undefined;
}

function topicKey(topic: string): string {
	return topic.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export class SelfworkModule implements CoreModule {
	readonly modelFacing = true;
	private readonly core: Core;
	private readonly clock: () => number;
	private readonly llm: Llm;
	private readonly skills: SelfworkSkills;
	private readonly goalService?: SelfworkGoalService;
	private readonly integratedGoals: boolean;
	private timer?: ReturnType<typeof setInterval>;
	private working?: Promise<void>;
	private lastUserActivity: number;
	private controller?: AbortController;
	private unlisten?: () => void;
	private unlistenSettings?: () => void;
	private stopping = false;

	constructor(core: Core, runtime?: ConstructorParameters<typeof Llm>[1], options: SelfworkOptions = {}) {
		this.core = core;
		this.clock = options.clock ?? Date.now;
		this.lastUserActivity = this.clock();
		this.integratedGoals = options.goalService === undefined;
		this.goalService = this.integratedGoals ? {
			launch: draft => core.module(GoalsModule)!.scheduler.launchSelfwork(draft),
			get: id => core.module(GoalsModule)!.scheduler.getSelfwork(id),
			pause: (id, reason) => core.module(GoalsModule)!.scheduler.pauseSelfwork(id, reason),
		} : options.goalService ?? undefined;
		this.llm = new Llm(core, runtime);
		this.llm.extendRuntime = rt => core.module(Gateway)?.installRuntime(rt);
		this.skills = new SelfworkSkills(core, this.clock, options.trialRunner);
		core.declareBackup({
			id: "selfwork", title: "蝶君长期目标、自主工作与自写技能",
			tables: ["selfwork_goals", "selfwork_runs", "selfwork_skills", "selfwork_skill_versions"],
			paths: { selfwork_runs: { plan: "json" } },
			onStage: db => {
				db.run(`UPDATE selfwork_runs SET restore_review_required=1
					WHERE state='held' AND reason='goal_api_unavailable' AND goal_id IS NULL AND source IN ('goal','learning')`);
			},
		});
		core.register("selfwork.restoredPlans.list", (_p, client) => {
			requireUser(core, client);
			return core.db.all<Run & { restore_review_required: 1 }>(`SELECT * FROM selfwork_runs WHERE state='held' AND restore_review_required=1 ORDER BY started_at,rowid`);
		});
		core.register("selfwork.restoredPlans.confirm", (p, client) => {
			requireUser(core, client);
			const id = requireStr(p.id, "id");
			if (!core.db.run(`UPDATE selfwork_runs SET restore_review_required=0
				WHERE id=? AND state='held' AND restore_review_required=1 AND goal_id IS NULL`, id).changes)
				throw new RpcError("conflict", "这份恢复的草案已处理或不再可用");
			return this.run(id);
		});
		core.register("selfwork.longGoals.list", () => this.longGoals());
		core.register("selfwork.longGoals.save", (p, client) => {
			requireUser(core, client);
			const title = bounded(p.title, 100), instruction = bounded(p.instruction, 2000);
			if (!title || !instruction) throw new RpcError("bad_request", "请填写长期目标标题和说明");
			const at = this.clock();
			const id = p.id === undefined ? randomUUID() : requireStr(p.id, "id");
			if (p.id === undefined) core.db.run("INSERT INTO selfwork_goals VALUES(?,?,?,1,?,?,NULL)", id, title, instruction, at, at);
			else if (!core.db.run("UPDATE selfwork_goals SET title=?,instruction=?,revision=revision+1,updated_at=? WHERE id=? AND deleted_at IS NULL AND revision=?",
				title, instruction, at, id, typeof p.revision === "number" ? p.revision : -1).changes) throw new RpcError("conflict", "长期目标已经变化，请重新读取");
			this.recheck();
			return this.longGoal(id);
		});
		core.register("selfwork.longGoals.delete", (p, client) => {
			requireUser(core, client);
			const id = requireStr(p.id, "id");
			if (!core.db.run("UPDATE selfwork_goals SET deleted_at=?,revision=revision+1 WHERE id=? AND deleted_at IS NULL", this.clock(), id).changes)
				throw new RpcError("not_found", "没有这个长期目标");
			this.recheck();
			return { deleted: id };
		});
		core.register("selfwork.history", () => core.db.all<Run>("SELECT * FROM selfwork_runs ORDER BY started_at DESC,rowid DESC LIMIT 100"));
		core.register("selfwork.stop", (p, client) => {
			requireUser(core, client);
			const run = this.run(requireStr(p.id, "id"));
			if (!run) throw new RpcError("not_found", "没有这条自主工作");
			if (run.state === "planning" || run.state === "testing" || run.state === "running" || run.state === "held") this.halt(run, "user_stopped");
			return this.run(run.id);
		});
	}

	start(): void {
		this.recover();
		this.unlistenSettings = this.core.settings.onChange(() => this.recheck());
		this.unlisten = this.core.onBroadcast(message => {
			if (message.event === "goals.changed" || message.event === "jobs.changed") queueMicrotask(() => this.recheck());
		});
		this.timer = setInterval(() => { void this.tick(); }, minute);
		this.timer.unref();
	}

	async stop(): Promise<void> {
		this.stopping = true;
		clearInterval(this.timer);
		this.unlisten?.();
		this.unlistenSettings?.();
		const active = this.active();
		if (active && !(this.integratedGoals && active.state === "running" && active.goal_id)) this.halt(active, "interrupted");
		await this.working;
	}

	extensions({ sandboxed }: { slotId: string; sandboxed?: boolean }) {
		return [pi => {
			pi.on("resources_discover", () => {
				const skillPaths = this.skills.paths(sandboxed === true);
				return skillPaths.length ? { skillPaths } : undefined;
			});
		}] satisfies NonNullable<ReturnType<NonNullable<CoreModule["extensions"]>>>;
	}

	onSlotEvent(slot: Slot, event: AgentSessionEvent): void {
		if (!slot.sandboxed || slot.unattended || event.type !== "message_start" || event.message.role !== "user") return;
		this.lastUserActivity = this.clock();
		const active = this.active();
		if (active) this.halt(active, "user_priority");
	}

	tick(): Promise<void> {
		if (this.working) return this.working;
		if (this.stopping || this.core.maintenance) return Promise.resolve();
		this.working = this.advance().catch(error => {
			const active = this.active();
			if (active && active.state !== "running") this.finish(active.id, "skipped", "failed");
			this.core.log.warn("Butterfly self work failed", error);
		}).finally(() => { this.working = undefined; });
		return this.working;
	}

	private longGoals(): LongGoal[] {
		return this.core.db.all<LongGoal>("SELECT id,title,instruction,revision FROM selfwork_goals WHERE deleted_at IS NULL ORDER BY created_at,rowid");
	}

	private longGoal(id: string): LongGoal | undefined {
		return this.core.db.get<LongGoal>("SELECT id,title,instruction,revision FROM selfwork_goals WHERE id=? AND deleted_at IS NULL", id);
	}

	private run(id: string): Run | undefined {
		return this.core.db.get<Run>("SELECT * FROM selfwork_runs WHERE id=?", id);
	}

	private active(): Run | undefined {
		return this.core.db.get<Run>(`SELECT * FROM selfwork_runs WHERE state IN ${activeStates} LIMIT 1`);
	}

	private userBusy(run?: Pick<Run, "goal_id">): boolean {
		const goals = this.core.module(GoalsModule)?.scheduler;
		if (this.core.sessionSlots().some(slot => slot.sandboxed && slot.started &&
			(slot.running || slot.compacting || slot.session.isStreaming || slot.ui.pendingCount > 0) &&
			(!run?.goal_id || goals?.goalForSlot(slot)?.id !== run.goal_id))) return true;
		return !!goals && (["queued", "running", "reviewing"] as const).some(state =>
			goals.list(state, 2, undefined, "butterfly").some(goal => goal.id !== run?.goal_id));
	}

	private allowed(run: Pick<Run, "source" | "long_goal_id" | "long_goal_revision" | "goal_id">): string | undefined {
		if (this.stopping || this.core.maintenance || !this.core.sandboxProvider?.()) return "unavailable";
		if (!this.core.persona.allows(actions[run.source])) return "proactivity";
		if (run.long_goal_id && this.longGoal(run.long_goal_id)?.revision !== run.long_goal_revision) return "mandate_changed";
		if (this.userBusy(run)) return "user_priority";
		if (run.source !== "goal" && !run.goal_id && this.clock() - this.lastUserActivity < idleFor) return "user_priority";
	}

	private finish(id: string, state: State, reason: string | null, responsePreview?: string): void {
		this.core.db.run(`UPDATE selfwork_runs SET state=?,reason=?,ended_at=?,plan=COALESCE(?,plan)
			WHERE id=? AND (state IN ${activeStates} OR state='held')`,
			state, reason, this.clock(), responsePreview === undefined ? null : json({ responsePreview }), id);
	}

	private halt(run: Run, reason: string): void {
		this.finish(run.id, "stopped", reason);
		if (run.state === "planning") this.controller?.abort();
		if (run.goal_id) {
			if (this.goalService) this.goalService.pause(run.goal_id, reason);
			else this.core.module(GoalsModule)?.scheduler.control(run.goal_id, "pause");
		}
	}

	private recheck(): void {
		if (this.stopping || this.core.maintenance) return;
		const run = this.active();
		if (!run) return;
		if (run.state === "running" && run.goal_id) {
			const goal = this.goalService?.get(run.goal_id);
			if (!goal || goal.stopIntent || goal.status === "cancelled" || goal.reason === "user_paused") {
				this.finish(run.id, "stopped", goal ? "user_stopped" : "goal_missing");
				return;
			}
			if (goal.status === "completed") {
				if (!this.integratedGoals || goal.delivery) this.completed(run, goal.delivery);
				return;
			}
			if (goal.status === "failed") { this.finish(run.id, "skipped", "goal_failed"); return; }
		}
		const denial = this.allowed(run);
		if (denial) this.halt(run, denial);
		else if (this.core.settings.get().butterflyDailyBudget === 0) this.halt(run, "daily_cap");
	}

	private recover(): void {
		for (const run of this.core.db.all<Run>(`SELECT r.* FROM selfwork_runs r
			JOIN autonomy_budget_holds h ON h.source=r.source AND h.ref_id=r.id`)) this.settle(run);
		const active = this.active();
		if (!active) return;
		if (this.integratedGoals && active.state === "running" && active.goal_id && this.goalService?.get(active.goal_id)) return;
		this.halt(active, "interrupted");
	}

	private due(source: Source, goal?: LongGoal): boolean {
		const day = localDay(this.clock());
		const prior = this.core.db.all<{ day: string; state: State; reason: string | null }>(`SELECT day,state,reason FROM selfwork_runs WHERE source=? AND long_goal_id IS ?
			AND long_goal_revision IS ? AND (day=? OR (state='held' AND restore_review_required=1) OR (?=0 AND reason='goal_api_unavailable')) LIMIT 2`,
			source, goal?.id ?? null, goal?.revision ?? null, day, Number(!!this.goalService));
		return prior.length === 0 || source === "learning" && prior.length === 1 &&
			prior[0]?.day === day && prior[0].state === "skipped" && prior[0].reason === "truncated";
	}

	private async recent(): Promise<string> {
		const index = this.core.module(SessionIndex), memory = this.core.module(MemoryModule);
		if (!index || !memory || !this.core.settings.get().memoryEnabled) return "";
		await index.refresh();
		for (const row of index.list({ cwd: this.core.paths.butterflyDir }).sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0)).slice(0, 5)) {
			if (!row.sessionId || memory.sessionMode(row.sessionId) !== "normal" || this.clock() - (row.modifiedAt ?? 0) > cooldown) continue;
			try {
				const entries = readSessionEntries(row.path);
				if (!entries.some(entry => entry.type === "custom" && entry.customType === SANDBOX_ENTRY && entry.data?.sandbox === true)) continue;
				const first = entries.find(entry => entry.type === "message" && entry.message?.role === "user");
				if (!first) continue;
				const task = this.core.db.get<{ source: string; goal_id: string | null }>("SELECT source,goal_id FROM tasks WHERE session_file=? ORDER BY created_at,rowid LIMIT 1", row.path);
				if (task?.source === "schedule" || task?.goal_id) continue;
				const text = entries.filter(entry => entry.type === "message" && entry.message?.role === "user")
					.slice(-3).map(entry => redact(textOf(entry.message.content), true).slice(0, 400)).join("\n");
				if (text.trim()) return text;
			} catch { /* An unavailable session is not evidence. */ }
		}
		return "";
	}

	private async advance(): Promise<void> {
		this.recheck();
		if (this.active() || this.stopping || this.core.maintenance || !this.core.sandboxProvider?.() || this.userBusy() ||
			!this.core.persona.allows("goal_self")) return;
		if (this.integratedGoals && this.dispatchHeldPlan()) return;
		const goals = this.longGoals();
		const mandate = goals.find(goal => this.due("goal", goal));
		const idle = this.clock() - this.lastUserActivity >= idleFor;
		if (!mandate && (!idle || !this.core.persona.allows("learning"))) return;
		const recent = mandate ? "" : await this.recent();
		if (!mandate && !goals.length && !recent) return;
		const source = mandate ? "goal" : this.due("learning") ? "learning" : this.due("skill") ? "skill" : undefined;
		if (!source || !this.core.autonomy.budget.check(0, source).ok) return;
		const run: Run = { id: randomUUID(), source, long_goal_id: mandate?.id ?? null, long_goal_revision: mandate?.revision ?? null,
			goal_id: null, state: "planning", topic: null, plan: null, reason: null };
		if (this.allowed(run)) return;
		this.core.db.run("INSERT INTO selfwork_runs(id,source,long_goal_id,long_goal_revision,state,started_at,day) VALUES(?,?,?,?,'planning',?,?)",
			run.id, source, run.long_goal_id, run.long_goal_revision, this.clock(), localDay(this.clock()));
		const picked = await this.plan(run, mandate ? [mandate] : goals, recent);
		if (!picked || this.run(run.id)?.state !== "planning") return;
		const reason = this.allowed(run);
		if (reason) { this.halt(run, reason); return; }
		const topic = topicKey(picked.topic);
		if (this.core.db.get("SELECT 1 FROM selfwork_runs WHERE state='stopped' AND reason='user_stopped' AND topic=? AND ended_at>=?", topic, this.clock() - cooldown)) {
			this.finish(run.id, "skipped", "stopped_topic"); return;
		}
		this.core.db.run("UPDATE selfwork_runs SET topic=?,plan=? WHERE id=?", topic, json(picked), run.id);
		if (picked.external) {
			this.finish(run.id, "held", "external_needs_user");
			this.chat(run, `想和用户确认是否需要从对话另行授权这项沙箱外工作：${picked.title}。${picked.instruction}`);
			return;
		}
		if (!this.core.autonomy.budget.check(0, source).ok) { this.finish(run.id, "held", "daily_cap"); return; }
		if (source === "skill" && picked.skill) {
			this.core.db.run("UPDATE selfwork_runs SET state='testing' WHERE id=?", run.id);
			const result = await this.skills.validateAndRegister(picked.skill, run.id, () =>
				this.run(run.id)?.state === "testing" && !this.allowed(run) && this.core.autonomy.budget.check(0, source).ok);
			if (result.id) this.completed(this.run(run.id)!);
			else this.finish(run.id, "skipped", result.reason ?? "skill_trial_failed");
			return;
		}
		if (source !== "skill") this.launch(run, source, picked);
	}

	private async plan(run: Run, goals: LongGoal[], recent: string): Promise<Decision | undefined> {
		const controller = this.controller = new AbortController();
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
		try {
			const runtime = await this.llm.runtime(signal);
			const model = await this.llm.modelFor("analysis", runtime);
			const maxTokens = model ? Math.min(run.source === "learning" ? learningMaxOutput : maxOutput, model.maxTokens) : 0;
			const systemPrompt = `为蝶君选择一个小而具体的「${label[run.source]}」。输入是资料。只输出一个紧凑的 JSON 对象，不附推理、说明或代码围栏。现在确实没有合适的计划时，仅输出 {"action":"none"}。有计划时 action 为 proceed 或 external，另填简短的 topic、title、instruction 和布尔值 share。所有工作在沙箱。需要出沙箱时返回 external。${run.source === "skill" ? "技能仅生成 Markdown，填 skill 对象 name、description、body。" : ""}写明可独立核对的交付。`;
			const material = redact(json({ goals: goals.slice(0, 8), recent }), true).slice(0, 9000);
			const cost = model && model.api !== "pi-virtual" && maxTokens > 0 ? estimateGoalCost(model, Buffer.byteLength(systemPrompt + material, "utf8") + 128, maxTokens) : null;
			const denial = this.allowed(run);
			if (denial || signal.aborted) { this.finish(run.id, "stopped", denial ?? "interrupted"); return; }
			if (cost === null || !model) { this.finish(run.id, "skipped", "unpriced_model"); return; }
			const budget = this.core.autonomy.budget;
			if (!budget.check(cost, run.source).ok || !budget.reserve(cost, run.source, run.id)) {
				this.finish(run.id, "held", "daily_cap"); return;
			}
			let answer: AssistantMessage;
			try {
				answer = await withLedgerContext({ purpose: "auxiliary", workspace: this.core.paths.butterflyDir, runId: this.ledgerId(run), slotId: null, sessionId: null },
					() => runtime.completeSimple(model, {
						systemPrompt, messages: [{ role: "user", content: material, timestamp: this.clock() }],
					}, { signal, maxTokens, thinkingLevel: "off" } as never));
			} finally { this.settle(run); }
			if (signal.aborted || answer.stopReason === "aborted") { this.finish(run.id, "stopped", "interrupted"); return; }
			if (answer.stopReason === "error") { this.finish(run.id, "skipped", "failed"); return; }
			const text = textOf(answer.content);
			const result = answer.stopReason === "stop" ? parseJsonAnswer<Record<string, unknown>>(text) : undefined;
			if (result?.action === "none") { this.finish(run.id, "skipped", "no_plan"); return; }
			const picked = decision(result, run.source);
			if (picked) return picked;
			const reachedLimit = answer.stopReason === "stop" && result === undefined && answer.usage.output >= maxTokens;
			this.finish(run.id, "skipped", answer.stopReason === "length" || reachedLimit ? "truncated" : "invalid",
				redact(text, true).trim().slice(0, planningPreviewLength));
		} finally {
			this.controller = undefined;
		}
	}

	private ledgerId(run: Run): string { return `selfwork:${run.id}`; }

	private settle(run: Run): void {
		const rows = this.core.db.all<{ amount: number | null; currency: string | null }>("SELECT amount,currency FROM request_ledger WHERE run_id=?", this.ledgerId(run));
		const cost = rows.length === 0 ? null : rows.every(row => row.currency === "USD" && finite(row.amount) !== null)
			? rows.reduce((sum, row) => sum + row.amount!, 0) : "estimated";
		this.core.autonomy.budget.settle(run.source, run.id, cost);
	}

	private dispatchHeldPlan(): boolean {
		for (const run of this.core.db.all<Run>(`SELECT * FROM selfwork_runs WHERE state='held'
			AND reason='goal_api_unavailable' AND restore_review_required=0 AND source IN ('goal','learning') ORDER BY started_at,rowid`)) {
			const reason = this.allowed(run);
			if (reason === "mandate_changed") { this.finish(run.id, "stopped", reason); continue; }
			if (reason || !this.core.autonomy.budget.check(0, run.source).ok) continue;
			const stored = parseJson<Record<string, unknown>>(run.plan, {});
			const picked = stored.external === false ? decision({ ...stored, action: "proceed" }, run.source) : undefined;
			if (!picked) { this.finish(run.id, "skipped", "invalid"); continue; }
			this.launch(run, run.source, picked);
			return true;
		}
		return false;
	}

	private launch(run: Run, source: Source, picked: Decision): void {
		if (!this.goalService) { this.finish(run.id, "held", "goal_api_unavailable"); return; }
		const draft: GoalDraft = {
			refId: run.id, source, mandateRef: run.long_goal_id ? `long-goal:${run.long_goal_id}@${run.long_goal_revision}`
				: source === "skill" ? `selfwork-skill:${run.id}` : `idle-learning:${run.id}`,
			title: picked.title, instruction: picked.instruction, cwd: this.core.paths.butterflyDir,
			sandbox: true, deliverable: selfworkDeliverable(run.id),
		};
		const id = this.goalService.launch(draft, () => {
			const current = this.run(run.id);
			return !!current && (current.state === "planning" || current.state === "running") &&
				!this.allowed(current) && this.core.autonomy.budget.check(0, source).ok;
		});
		this.core.db.run("UPDATE selfwork_runs SET goal_id=?,state='running' WHERE id=? AND state='planning'", id, run.id);
	}

	private completed(run: Run, delivery?: SelfworkDelivery): void {
		if (!delivery) this.finish(run.id, "completed", null);
		const plan = run.plan ? JSON.parse(run.plan) as Decision : undefined;
		if (!plan) { if (delivery) this.finish(run.id, "completed", null); return; }
		const refId = run.goal_id ?? run.id;
		const memory = this.core.module(MemoryModule);
		if (this.core.settings.get().memoryEnabled && memory) memory.recordButterflyMemory({
			source: run.source === "goal" ? "work" : "learning", refId,
			content: `蝶君完成了「${plan.title}」。${delivery ? `验收说明：${delivery.explanation}` : ""}`,
		});
		if (plan.share) this.chat(run, `蝶君已完成「${plan.title}」，可以和用户分享这一发现。`);
		if (delivery) this.finish(run.id, "completed", null);
	}

	private chat(run: Run, reason: string): void {
		void this.core.persona.proactive.request({ reason: reason.slice(0, 500), refId: `selfwork:${run.id}` })
			.catch(error => this.core.log.warn("could not request Butterfly proactive chat", error));
	}
}
