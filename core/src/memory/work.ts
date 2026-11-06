import { existsSync, readFileSync } from "node:fs";
import type { Model } from "@earendil-works/pi-ai";
import type { Core } from "../core.ts";
import type { Db } from "../db.ts";
import type { Llm } from "../modules/llm.ts";
import { textOf } from "../runs.ts";
import { type AgentRun, MEMORY_ROLE, runMemoryAgent } from "./agent.ts";
import { type JobOutcome, type MemoryJob, MemoryJobs, PRIORITY } from "./jobs.ts";
import { homeScope, type ScopeSet, type Workspaces } from "./scopes.ts";
import { localDay, type MemoryStore } from "./store.ts";
import { nearDuplicate, saysMore } from "./text.ts";
import { ITEM_KINDS, type ItemKind, type ItemScope, type ItemStatus, LIVE_STATUSES, type MemoryItem, type MemoryOp, type SourceInput } from "./types.ts";

/** Where the memory agent's model calls go in the usage records (one ledger, 「一本账」). */
export const MEMORY_LEDGER = "dreamflutter:memory";
const DAY = 86_400_000;
/** §3: level 1 is managed closely for 14 days; after that the weekly tidy decides. */
const LEVEL1_DAYS = 14;
/** §12 item 2: at most three progress notes per task. */
const PROGRESS_PER_TASK = 3;
const TIDY_FLAG = "memory_tidy_l1:";

type Action = "add" | "update" | "set_status" | "combine" | "keep";

/** What one job may do (§5: 「本次允许的操作种类」). */
interface Policy {
	actions: Set<Action>;
	statuses: Set<ItemStatus>;
	set: ScopeSet;
	/** Only items of exactly this scope (a tidy works on one partition). */
	scopeKey?: string;
	sessionRef: string | null;
	progressLeft: number;
	added: { id: string; content: string; version: number }[];
	batches: string[];
}

const EXTRACT_SYSTEM = [
	"你是 DreamFlutter 的记忆整理 Agent。一段对话刚结束，你从里面找出值得长期记住的内容，用 memory_propose_ops 提交，程序会检查后生效并记入用户的记忆日志（用户可以修改、撤销）。你只能读写记忆，没有别的工具。",
	"要记的：用户稳定的偏好、个人或工作背景、定下的决定和约定、经确认有效的做事经验；还有这次任务做完了什么、定了什么、下一步是什么（kind=progress，最多 3 条，每条一句）。",
	"对话里的「助手」是 DreamFlutter 里的 Agent（用户可能叫它「蝶君」等名字）；助手的名字、身份、能力和它说过的话都不是用户的信息。用户给 Agent 定的设定（名字、称呼、角色）用 kind=persona，写成「用户称 Agent 为……」。",
	"不要记：缺软件、没装好、路径不对、没配凭据造成的失败（要记的是怎么修好的）；重试就好了的临时错误；没有解决的失败（试了不行的做法不能写成推荐做法）；一次性的任务经过；闲聊；助手自己的话；技能、工作区规则文件、工具说明里已经有的。",
	"一条只写一件事，以「用户」为主语，用用户的语言。对工具、环境、外部服务的判断（尤其是「某工具用不了」这类否定的）要写明条件。时间限定的安排写 valid_until。",
	"先看已有记忆：意思相同或相近的不要再加（换个说法也算重复）；比已有的更完整或有修正就 update（带上版本）；已有的被对话明确推翻就 set_status=refuted。用户亲口说的 said=true，你的推测 said=false。",
	"没有值得记的就不提交。最后用一两句话说明你做了什么。",
].join("\n");

const TIDY_SYSTEM = [
	"你是 DreamFlutter 的记忆整理 Agent，现在做每周的一级（近期）记忆整理。你只能读写记忆，没有别的工具；你提交的改动由程序检查后生效，记入用户的记忆日志，用户可以撤销。",
	"对每条一级记忆做一个决定：",
	"- 几条说的是同一件事或可以提炼成一条：combine（retire_as=archived 表示提炼，原条目保留但退出日常使用；纯重复用 superseded）；",
	"- 已经结束的安排、做完的事的零碎记录：set_status=ended；",
	"- 错的、过时的：set_status=outdated；拿不准的：set_status=review；",
	"- 仍然有用、保持原样：keep（只记一次「核对过」）。",
	"超过 14 天的一级记忆必须有决定。不要升级层级（升级由程序按规则另外处理）。一条只写一件事，以「用户」为主语。最后用一两句话说明你做了什么。",
].join("\n");

/**
 * The memory agent's work: what is queued, how each kind of job runs, the
 * weekly schedule, and the ledger and budget (docs/memory-design.md §5, §7).
 */
export class MemoryWork {
	private readonly core: Core;
	private readonly db: Db;
	private readonly store: MemoryStore;
	private readonly workspaces: Workspaces;
	private readonly llm: Llm;
	private readonly scopesFor: (cwd: string) => ScopeSet;
	private readonly now: () => number;
	readonly jobs: MemoryJobs;
	private timer: NodeJS.Timeout | undefined;
	private stopped = false;

	constructor(core: Core, store: MemoryStore, workspaces: Workspaces, llm: Llm, scopesFor: (cwd: string) => ScopeSet, now: () => number) {
		this.core = core;
		this.db = core.db;
		this.store = store;
		this.workspaces = workspaces;
		this.llm = llm;
		this.scopesFor = scopesFor;
		this.now = now;
		this.jobs = new MemoryJobs(core.db, now, {
			run: (job) => this.run(job),
			budgetLeft: () => this.core.settings.get().memoryDailyBudgetUsd - this.spentToday(),
			paused: () => this.core.settings.get().memoryPaused || this.stopped,
			nextBudgetAt: () => startOfDay(this.now()) + DAY,
			onChange: (job) => core.broadcast({ event: "memory.jobs.changed", job }),
		});
	}

	start(): void {
		this.jobs.recoverInterrupted();
		this.checkSchedule();
		void this.drain();
		this.timer = setInterval(() => {
			this.checkSchedule();
			void this.drain();
		}, 10 * 60_000);
		this.timer.unref();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		// Let a job in progress finish writing before the database closes.
		await Promise.race([this.jobs.drain(), new Promise((resolve) => setTimeout(resolve, 3_000))]);
	}

	drain(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		return this.jobs.drain().catch((error) => this.core.log.warn("memory jobs failed", error));
	}

	// ---- queueing --------------------------------------------------------------------------

	/** After a task: extract from what was said since the last extraction (§7: only when there is something new). */
	queueExtraction(input: { sessionFile: string; sessionId: string; cwd: string }): MemoryJob {
		const set = this.scopesFor(input.cwd);
		return this.jobs.enqueue({ kind: "extract", scopeKey: set.key, payload: input, priority: PRIORITY.extract, dedupeKey: `extract:${input.sessionId}` });
	}

	/**
	 * The weekly level-1 tidy (§12 item 1): due after Monday 03:00 (or at the
	 * next start, once); a partition with no change and nothing past 14 days
	 * is passed over without calling a model.
	 */
	checkSchedule(): { queued: string[]; skipped: string[] } {
		const out = { queued: [] as string[], skipped: [] as string[] };
		if (!this.core.settings.get().memoryEnabled) return out;
		const now = this.now();
		const boundary = lastMonday3am(now);
		for (const key of this.scopeKeys()) {
			const flagKey = TIDY_FLAG + key;
			const last = Number(this.db.get<{ value: string }>("SELECT value FROM app_flags WHERE key = ?", flagKey)?.value ?? NaN);
			const mark = () => this.db.run("INSERT OR REPLACE INTO app_flags(key, value, at) VALUES(?, ?, ?)", flagKey, String(now), now);
			if (!Number.isFinite(last)) {
				mark(); // first time: start counting from now
				continue;
			}
			if (last >= boundary) continue;
			const items = this.itemsOf(key).filter((m) => m.level === 1);
			const changed = items.some((m) => m.updatedAt > last);
			const old = items.some((m) => m.createdAt <= now - LEVEL1_DAYS * DAY && (m.lastVerifiedAt ?? 0) <= last);
			mark();
			if (!changed && !old) {
				out.skipped.push(key);
				continue;
			}
			this.jobs.enqueue({ kind: "tidy_l1", scopeKey: key, payload: { since: last }, priority: PRIORITY.periodic, dedupeKey: `tidy_l1:${key}:${boundary}` });
			out.queued.push(key);
		}
		return out;
	}

	private scopeKeys(): string[] {
		const keys = new Set<string>();
		for (const row of this.db.all<{ scope: string; workspace_id: string | null }>("SELECT DISTINCT scope, workspace_id FROM memory_items WHERE status IN ('active', 'review') AND level = 1")) {
			if (row.scope === "global") keys.add("global");
			else if (row.scope === "butterfly") keys.add("butterfly");
			else if (row.scope === "workspace" && row.workspace_id) keys.add(`workspace:${row.workspace_id}`);
		}
		return [...keys];
	}

	/** The scopes a job on [key] works in. */
	private setFor(key: string): ScopeSet {
		if (key === "butterfly") return { workspaceId: null, groupIds: [], butterfly: true, globalBackground: true, key };
		if (key.startsWith("workspace:")) {
			const workspaceId = key.slice("workspace:".length);
			return { workspaceId, groupIds: this.workspaces.groupsOf(workspaceId), butterfly: false, globalBackground: true, key };
		}
		return { workspaceId: null, groupIds: [], butterfly: false, globalBackground: true, key: "global" };
	}

	/** Live items of exactly partition [key]. */
	private itemsOf(key: string): MemoryItem[] {
		return this.store.list({ set: this.setFor(key) }).filter((m) => keyOf(m) === key);
	}

	// ---- running -----------------------------------------------------------------------------

	private async run(job: MemoryJob): Promise<JobOutcome> {
		if (!this.core.settings.get().memoryEnabled) return { status: "skipped", result: { why: "记忆已关闭" } };
		switch (job.kind) {
			case "extract":
				return this.extract(job);
			case "tidy_l1":
				return this.tidy(job);
		}
	}

	private async extract(job: MemoryJob): Promise<JobOutcome> {
		const { sessionFile, sessionId, cwd } = job.payload as { sessionFile: string; sessionId: string; cwd: string };
		if (!sessionFile || !existsSync(sessionFile)) return { status: "skipped", result: { why: "会话文件不在了" } };
		const cursor = this.db.get<{ last_entry_id: string | null }>("SELECT last_entry_id FROM memory_extraction WHERE session_id = ?", sessionId)?.last_entry_id ?? null;
		const entries = readMessages(sessionFile);
		const start = cursor ? entries.findIndex((e) => e.id === cursor) + 1 : 0;
		const fresh = entries.slice(start);
		const last = entries.at(-1)?.id ?? cursor;
		const advance = () =>
			this.db.run(
				"INSERT INTO memory_extraction(session_id, message_count, updated_at, last_entry_id) VALUES(?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET message_count = excluded.message_count, updated_at = excluded.updated_at, last_entry_id = excluded.last_entry_id",
				sessionId,
				entries.length,
				this.now(),
				last,
			);
		const userText = fresh.filter((m) => m.role === "user").map((m) => m.text).join("\n");
		if (userText.trim().length < 12) {
			advance();
			return { status: "skipped", result: { why: "没有新内容" } };
		}
		const set = this.scopesFor(cwd);
		const shown = this.store.list({ set, limit: 80 });
		const transcript = fresh
			.map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.text.slice(0, 1500)}`)
			.join("\n\n")
			.slice(-8000);
		const input = `今天是 ${localDay(this.now())}。\n\n已有的记忆（#id v版本）：\n${shown.map(line).join("\n") || "（无）"}\n\n刚结束的对话：\n${transcript}`;
		const policy: Policy = { actions: new Set(["add", "update", "set_status"]), statuses: new Set(["review", "outdated", "refuted"]), set, sessionRef: sessionFile, progressLeft: PROGRESS_PER_TASK, added: [], batches: [] };
		const run = await this.agent(job, EXTRACT_SYSTEM, input, policy, cwd);
		advance();
		return { status: "done", costUsd: run.usage.cost, result: { turns: run.turns, summary: run.summary, batches: policy.batches } };
	}

	private async tidy(job: MemoryJob): Promise<JobOutcome> {
		const items = this.itemsOf(job.scopeKey).filter((m) => m.level === 1);
		if (!items.length) return { status: "skipped", result: { why: "没有一级记忆" } };
		const now = this.now();
		const since = Number(job.payload.since ?? 0);
		const rows = items.map((m) => `${line(m)}（${Math.floor((now - m.createdAt) / DAY)} 天前记下${m.updatedAt > since ? "，本周有改动" : ""}）`);
		const input = `今天是 ${localDay(now)}。这是「${scopeLabel(job.scopeKey)}」的一级记忆，共 ${items.length} 条：\n${rows.join("\n")}`;
		const set = this.setFor(job.scopeKey);
		const policy: Policy = { actions: new Set(["update", "set_status", "combine", "keep"]), statuses: new Set(["ended", "archived", "outdated", "review"]), set, scopeKey: job.scopeKey, sessionRef: null, progressLeft: 0, added: [], batches: [] };
		const workspace = job.scopeKey.startsWith("workspace:") ? this.workspaces.get(job.scopeKey.slice(10))?.path : undefined;
		const run = await this.agent(job, TIDY_SYSTEM, input, policy, workspace ?? null);
		return { status: "done", costUsd: run.usage.cost, result: { turns: run.turns, summary: run.summary, batches: policy.batches } };
	}

	/** Runs the agent for [job]; its model calls go in the ledger whatever happens. */
	private async agent(job: MemoryJob, system: string, input: string, policy: Policy, cwd: string | null): Promise<AgentRun> {
		const runtime = await this.llm.runtime();
		const model = await this.model(runtime);
		if (!model) throw new Error("没有可用的模型");
		const run = await runMemoryAgent({
			runtime,
			model,
			system,
			input,
			now: this.now,
			handlers: { query: (args) => this.query(args, policy), propose: (args) => this.propose(args, policy, job, model) },
		});
		run.calls.forEach((call, i) => {
			this.db.run(
				"INSERT OR REPLACE INTO usage_records(path, entry_id, at, cwd, provider, model, input, output, cache_read, cache_write, cost) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				MEMORY_LEDGER,
				`${job.id}:${job.attempts}:${i}`,
				call.at,
				cwd,
				call.provider,
				call.model,
				call.usage.input,
				call.usage.output,
				call.usage.cacheRead,
				call.usage.cacheWrite,
				call.usage.cost,
			);
		});
		if (run.stoppedBy === "error") throw Object.assign(new Error(run.error ?? "模型调用失败"), { costUsd: run.usage.cost });
		return run;
	}

	private async model(runtime: Awaited<ReturnType<Llm["runtime"]>>): Promise<Model<never> | undefined> {
		const wanted = this.core.settings.get().memoryModel;
		if (wanted) {
			const slash = wanted.indexOf("/");
			const available = (await runtime.getAvailable()) as Model<never>[];
			const model = available.find((m) => m.provider === wanted.slice(0, slash) && m.id === wanted.slice(slash + 1));
			if (model) return model;
		}
		return this.llm.auxModel(runtime);
	}

	/** USD the memory agent spent today. */
	spentToday(): number {
		return this.db.get<{ cost: number | null }>("SELECT SUM(cost) AS cost FROM usage_records WHERE path = ? AND at >= ?", MEMORY_LEDGER, startOfDay(this.now()))?.cost ?? 0;
	}

	// ---- the agent's two tools ------------------------------------------------------------------

	private query(args: Record<string, unknown>, policy: Policy): string {
		const statuses = typeof args.status === "string" ? [args.status as ItemStatus] : LIVE_STATUSES;
		let items = this.store.list({ set: policy.set, statuses, query: typeof args.query === "string" ? args.query : undefined, level: typeof args.level === "number" ? args.level : undefined, limit: 200 });
		if (policy.scopeKey) items = items.filter((m) => keyOf(m) === policy.scopeKey);
		if (Array.isArray(args.ids)) items = items.filter((m) => (args.ids as string[]).map((id) => id.replace(/^#/, "")).includes(m.id));
		if (typeof args.kind === "string") items = items.filter((m) => m.kind === args.kind);
		if (!items.length) return "没有找到。";
		return items.slice(0, 40).map(line).join("\n") + (items.length > 40 ? `\n（还有 ${items.length - 40} 条，缩小范围再查）` : "");
	}

	/** Turns the agent's proposals into ops, through the gate in one batch; tells it what happened to each. */
	private propose(args: Record<string, unknown>, policy: Policy, job: MemoryJob, model: Model<never>): string {
		const proposals = Array.isArray(args.ops) ? (args.ops as Record<string, unknown>[]) : [];
		if (!proposals.length) return "没有收到任何操作（ops 是空的）。";
		const ops: MemoryOp[] = [];
		const owner: number[] = [];
		const notes: (string | undefined)[] = proposals.map(() => undefined);
		proposals.forEach((p, i) => {
			const converted = this.convert(p, policy);
			if (typeof converted === "string") notes[i] = `被拒绝：${converted}`;
			else {
				for (const op of converted.ops) {
					ops.push(op);
					owner.push(i);
				}
				if (converted.note) notes[i] = converted.note;
			}
		});
		const result = ops.length
			? this.store.commit({ actor: "memory_agent", ops, allowed: policy.set, sessionRef: policy.sessionRef, batchKind: job.kind === "extract" ? "extract" : "tidy", reason: `${job.kind === "extract" ? "对话结束后的整理" : "每周整理"}（${model.id}）` })
			: undefined;
		if (result?.batchId) policy.batches.push(result.batchId);
		const outcome = proposals.map((_, i) => {
			if (notes[i]?.startsWith("被拒绝")) return notes[i]!;
			const mine = <T extends { index: number }>(list: T[] | undefined): T[] => (list ?? []).filter((x) => owner[x.index] === i);
			const rejected = mine(result?.rejected);
			const pending = mine(result?.pending);
			const applied = mine(result?.applied);
			const parts: string[] = [];
			if (pending.length) parts.push(`交给用户确认（${pending[0]!.why === "locked" ? "用户锁定的记忆" : pending[0]!.why === "promote_global" ? "工作区记忆提升为全局" : "用户要求写入前确认"}），还没生效${pending[0]!.why === "locked" ? "；这条已标为待复核" : ""}`);
			else if (applied.length) parts.push(`已生效（${[...new Set(applied.map((a) => `#${a.itemId}`))].join("、")}）`);
			if (rejected.length) parts.push(`被拒绝：${rejected.map((r) => r.reason).join("；")}`);
			for (const a of applied) {
				const added = this.store.get(a.itemId);
				if (added && added.createdBy === "memory_agent" && added.version === 1) policy.added.push({ id: added.id, content: added.content, version: added.version });
			}
			if (notes[i]) parts.push(notes[i]!);
			return parts.join("；") || "没有变化";
		});
		return outcome.map((text, i) => `${i + 1}. ${text}`).join("\n");
	}

	private convert(p: Record<string, unknown>, policy: Policy): { ops: MemoryOp[]; note?: string } | string {
		const action = p.action as Action;
		if (!policy.actions.has(action)) return `这次整理不能做「${String(p.action)}」`;
		const reason = typeof p.reason === "string" && p.reason.trim() ? p.reason.trim() : undefined;
		if (!reason) return "每个操作都要写理由（reason）";
		const evidence = typeof p.evidence === "string" ? p.evidence : null;
		const sources: SourceInput[] = policy.sessionRef ? [{ kind: "session", ref: policy.sessionRef, excerpt: evidence ?? reason }] : [];
		const validUntil = typeof p.valid_until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.valid_until) ? new Date(`${p.valid_until}T23:59:59`).getTime() : undefined;
		const kind = ITEM_KINDS.includes(p.kind as ItemKind) ? (p.kind as ItemKind) : undefined;
		const content = typeof p.content === "string" ? p.content.trim() : "";
		const target = (id: unknown, version: unknown): MemoryItem | string => {
			if (typeof id !== "string") return "缺少 id";
			if (typeof version !== "number") return "缺少版本号（version），先用 memory_query 读一下";
			const item = this.store.get(id.replace(/^#/, ""));
			if (!item) return `没有 #${id}`;
			if (policy.scopeKey && keyOf(item) !== policy.scopeKey) return `#${item.id} 不在这次整理的范围里`;
			if (item.version !== version) return `#${item.id} 已经有更新（现在是第 ${item.version} 版），先用 memory_query 重新读`;
			return item;
		};
		switch (action) {
			case "add": {
				if (!content) return "内容是空的";
				const k = kind ?? "background";
				if (k === "progress" && policy.progressLeft-- <= 0) return `一个任务最多记 ${PROGRESS_PER_TASK} 条进展`;
				// The model still repeats now and then: a near repeat is not added; a fuller one updates the old one.
				const twin = nearDuplicate(content, [...this.store.list({ set: policy.set }), ...policy.added]);
				if (twin && !saysMore(content, twin.content)) return `和 #${(twin as { id: string }).id} 意思相同，没有重复保存`;
				if (twin) {
					const t = twin as MemoryItem;
					return { ops: [{ kind: "edit", id: t.id, baseVersion: t.version, patch: { content }, sources, reason }], note: `和 #${t.id} 相近，改成了更完整的说法` };
				}
				const where = p.scope === "global" ? { scope: "global" as ItemScope, workspaceId: null } : homeScope(policy.set);
				const id = this.store.newId();
				return { ops: [{ kind: "add", item: { id, content, kind: k, level: 1, ...where, confidence: p.said === true ? "user_reported" : "agent_inferred", conditions: typeof p.conditions === "string" ? p.conditions : null, validUntil: validUntil ?? null }, sources, reason }] };
			}
			case "update": {
				const item = target(p.id, p.version);
				if (typeof item === "string") return item;
				const patch: Record<string, unknown> = {};
				if (content) patch.content = content;
				if (kind) patch.kind = kind;
				if (typeof p.conditions === "string") patch.conditions = p.conditions;
				if (validUntil !== undefined) patch.validUntil = validUntil;
				if (p.scope === "global") patch.scope = "global";
				if (!Object.keys(patch).length) return "没有要改的内容";
				return { ops: [{ kind: "edit", id: item.id, baseVersion: p.version as number, patch, sources, reason }] };
			}
			case "keep": {
				const item = target(p.id, p.version);
				if (typeof item === "string") return item;
				return { ops: [{ kind: "edit", id: item.id, baseVersion: p.version as number, patch: { lastVerifiedAt: this.now() }, reason }] };
			}
			case "set_status": {
				const status = p.status as ItemStatus;
				if (!policy.statuses.has(status)) return `这次整理不能把状态改成「${String(p.status)}」`;
				const item = target(p.id, p.version);
				if (typeof item === "string") return item;
				return { ops: [{ kind: "status", id: item.id, baseVersion: p.version as number, status, sources, reason }] };
			}
			case "combine": {
				const from = Array.isArray(p.from) ? (p.from as { id?: unknown; version?: unknown }[]) : [];
				if (!from.length) return "combine 要列出被合并的条目（from）";
				if (!content) return "合并后的内容是空的";
				const items: MemoryItem[] = [];
				for (const f of from) {
					const item = target(f.id, f.version);
					if (typeof item === "string") return item;
					items.push(item);
				}
				const retire: ItemStatus = p.retire_as === "superseded" ? "superseded" : "archived";
				const first = items[0]!;
				const sameScope = items.every((m) => m.scope === first.scope && m.workspaceId === first.workspaceId);
				const where = p.scope === "global" ? { scope: "global" as ItemScope, workspaceId: null } : sameScope ? { scope: first.scope, workspaceId: first.workspaceId } : homeScope(policy.set);
				const id = this.store.newId();
				const inferred = items.some((m) => m.confidence === "agent_inferred");
				const ops: MemoryOp[] = [
					{
						kind: "add",
						item: { id, content, kind: kind ?? first.kind, level: Math.max(...items.map((m) => m.level)) as 1 | 2 | 3, ...where, confidence: inferred ? "agent_inferred" : first.confidence, conditions: typeof p.conditions === "string" ? p.conditions : null },
						links: items.map((m) => ({ to: m.id, kind: retire === "archived" ? ("derived_from" as const) : ("supersedes" as const) })),
						sources,
						reason,
					},
					...items.map((m, i): MemoryOp => ({ kind: "status", id: m.id, baseVersion: from[i]!.version as number, status: retire, reason: `并入 #${id}：${reason}` })),
				];
				return { ops };
			}
		}
		return `未知的操作：${String(p.action)}`;
	}
}

/** One item as the agent reads it. */
function line(m: MemoryItem): string {
	return `#${m.id} v${m.version} L${m.level} ${m.kind} ${m.status}${m.status === "active" ? "" : ""} ${m.confidence}${m.retention === "locked" ? " 锁定" : ""} ${localDay(m.createdAt)}：${m.content}`;
}

function keyOf(m: Pick<MemoryItem, "scope" | "workspaceId">): string {
	return m.scope === "workspace" ? `workspace:${m.workspaceId}` : m.scope === "butterfly" ? "butterfly" : m.scope === "global" ? "global" : `group`;
}

function scopeLabel(key: string): string {
	return key === "global" ? "全局" : key === "butterfly" ? "蝶君" : "这个工作区";
}

function startOfDay(at: number): number {
	const d = new Date(at);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/** The latest Monday 03:00 (local) at or before [at]. */
export function lastMonday3am(at: number): number {
	const d = new Date(at);
	d.setHours(3, 0, 0, 0);
	const back = (d.getDay() + 6) % 7; // days since Monday
	d.setDate(d.getDate() - back);
	if (d.getTime() > at) d.setDate(d.getDate() - 7);
	return d.getTime();
}

/** User and assistant messages of a session file, in order, with their entry ids. */
export function readMessages(path: string): { id: string; role: "user" | "assistant"; text: string }[] {
	const out: { id: string; role: "user" | "assistant"; text: string }[] = [];
	for (const raw of readFileSync(path, "utf8").split("\n")) {
		if (!raw.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(raw);
		} catch {
			continue;
		}
		if (entry.type !== "message") continue;
		const message = (entry.message ?? {}) as Record<string, unknown>;
		const role = message.role;
		if (role !== "user" && role !== "assistant") continue;
		out.push({ id: String(entry.id ?? ""), role, text: textOf(message.content) });
	}
	return out;
}

