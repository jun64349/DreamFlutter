import { isSideFile } from "../pi/session-metadata.ts";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { Core } from "../core.ts";
import type { Db } from "../db.ts";
import type { Llm } from "../modules/llm.ts";
import { textOf } from "../runs.ts";
import { type AgentRun, runMemoryAgent, waitForMemory } from "./agent.ts";
import { type JobOutcome, type MemoryJob, MemoryJobInterrupted, MemoryJobs, PRIORITY } from "./jobs.ts";
import { activeTokens, CALENDAR, DAY, expire, FORGET_WHY_LABEL, forgetCandidates, failedOutput, mentions, PERIOD_LABEL, type Period, periodStart, possibleConflicts, promotable, refutedBy, toolIdentifiers } from "./lifecycle.ts";
import { homeScope, type ScopeSet, visibleIn, type Workspaces } from "./scopes.ts";
import { scanMemoryText } from "./safety.ts";
import { lineCost, type Material, materialCost } from "./snapshot.ts";
import { localDay, type MemoryStore } from "./store.ts";
import { nearDuplicate, saysMore } from "./text.ts";
import { ITEM_KINDS, type ItemKind, type ItemScope, type ItemStatus, type Level, LIVE_STATUSES, type MemoryItem, type MemoryOp, type SourceInput } from "./types.ts";

export { lastMonday3am } from "./lifecycle.ts";

/** Where the memory agent's model calls go in the usage records (one ledger, 「一本账」). */
export const MEMORY_LEDGER = "dreamflutter:memory";
export const MEMORY_SHUTDOWN_TIMEOUT_MS = 15_000;
/** §3: level 1 is managed closely for 14 days; after that the weekly tidy decides. */
const LEVEL1_DAYS = 14;
/** §12 item 2: at most three progress notes per task. */
const PROGRESS_PER_TASK = 3;
const TIDY_FLAG = "memory_tidy_l1:";
const REVIEW_FLAG = "memory_review:";
/** Batches whose changes are a review's own work: not a reason for the next review. */
const REVIEW_BATCHES = ["tidy", "review", "capacity", "soft_forget"];
/** Batches that never start a contradiction check (the check's own, undoing, the program's sweeps, migration). */
const NO_CONFLICT_CHECK = new Set(["conflict", "undo", "expire", "refute", "migration"]);
/** At most this many possible contradictions of one item go to one check. */
const CONFLICTS_PER_ITEM = 3;
const MATERIAL_FLAG = "memory_materials:";
const CAPACITY_FLAG = "memory_capacity:";
/** 「真正满额」 = over the capacity, and still above this share of it after a full consolidation (§12 item 4). */
const TRULY_FULL = 0.9;
/** At most this many items go to one consolidation call (oldest first; the rest wait for the next round). */
const CAPACITY_ITEMS = 250;
/** Below this many items a partition's snapshot is short anyway: no materials (no model call). */
const MATERIAL_MIN_ITEMS = 6;

type Action = "add" | "update" | "set_status" | "combine" | "keep" | "promote" | "demote" | "conflict" | "material";

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
	/** Items this job may soft-forget (the program's candidates when a partition is truly full, §12 item 5). */
	forgettable?: Set<string>;
	/** A snapshot preparation: the materials it wrote, and the job they belong to. */
	materials?: { jobId: string; ids: string[]; covered: Set<string> };
}

const EXTRACT_SYSTEM = [
	"你是 DreamFlutter 的记忆整理 Agent。一段对话刚结束，你从里面找出值得长期记住的内容，用 memory_propose_ops 提交，程序会检查后生效并记入用户的记忆日志（用户可以修改、撤销）。你只能读写记忆，没有别的工具。",
	"要记的：用户稳定的偏好、个人或工作背景、定下的决定和约定、经确认有效的做事经验；还有这次任务做完了什么、定了什么、下一步是什么（kind=progress，最多 3 条，每条一句）。",
	"对话里的「助手」是 DreamFlutter 里的 Agent（用户可能叫它「蝶君」等名字）；助手的名字、身份、能力和它说过的话都不是用户的信息。用户给 Agent 定的设定（名字、称呼、角色）用 kind=persona，写成「用户称 Agent 为……」。",
	"不要记：缺软件、没装好、路径不对、没配凭据造成的失败（要记的是怎么修好的）；重试就好了的临时错误；没有解决的失败（试了不行的做法不能写成推荐做法）；一次性的任务经过；闲聊；助手自己的话；技能、工作区规则文件、工具说明里已经有的。",
	"一条只写一件事，以「用户」为主语，用用户的语言。对工具、环境、外部服务的判断（「某工具在这台电脑上用不了」「某网站要代理」）用 kind=observation，写出工具或网站的名字和条件；没写 valid_until 的程序默认 30 天后到期，之后那个工具成功运行了，程序会自动把它标为被推翻。时间限定的安排写 valid_until。",
	"先看已有记忆：意思相同或相近的不要再加（换个说法也算重复；用户这次又亲口说了一遍的，照样 add 并设 said=true，程序会把它记成又一个来源而不重复保存）；比已有的更完整或有修正就 update（带上版本）；已有的被对话明确推翻就 set_status=refuted；两条已有记忆互相矛盾又判断不了哪条对，用 conflict。用户亲口说的 said=true，你的推测 said=false。",
	"没有值得记的就不提交。最后用一两句话说明你做了什么。",
].join("\n");

const DECISIONS = [
	"- 几条说的是同一件事或可以提炼成一条：combine（retire_as=archived 表示提炼，原条目保留但退出日常使用；纯重复用 superseded）；",
	"- 已经结束的安排、做完的事的零碎记录：set_status=ended；",
	"- 错的、过时的：set_status=outdated；被新证据推翻的：set_status=refuted；拿不准的：set_status=review；",
	"- 两条互相矛盾、判断不了哪条对：conflict（id 是要复核的那条，with 是和它矛盾的那条）；能判断的就直接改或标状态；",
	"- 标着「可以升到 N 级」的，证据已经够了：确实长期有用就 promote，否则 keep；升级只能一次一级，程序会再查一遍证据；",
	"- 仍然有用、保持原样：keep（只记一次「核对过」）。",
];

const TIDY_SYSTEM = [
	"你是 DreamFlutter 的记忆整理 Agent，现在做每周的一级（近期）记忆整理。你只能读写记忆，没有别的工具；你提交的改动由程序检查后生效，记入用户的记忆日志，用户可以撤销。",
	"对每条一级记忆做一个决定：",
	...DECISIONS,
	"超过 14 天的一级记忆必须有决定。一条只写一件事，以「用户」为主语。最后用一两句话说明你做了什么。",
].join("\n");

function reviewSystem(level: Level, period: Period, light: boolean): string {
	const what = level === 2 ? "二级（阶段）记忆：这个阶段持续有用的事" : "三级（长期）记忆：一般不遗忘，只在有新证据、用户纠正、环境变化时核对";
	return [
		`你是 DreamFlutter 的记忆整理 Agent，现在做${PERIOD_LABEL[period]}的${what}${light ? "（轻量复查：只看列出的有新增、改动、冲突或到了复查时间的条目）" : "（完整回顾）"}。你只能读写记忆，没有别的工具；你提交的改动由程序检查后生效，记入用户的记忆日志，用户可以撤销。`,
		"对列出的每条记忆做一个决定：",
		...DECISIONS,
		"- 只在这个阶段有用、已经不常用的：demote（降一级）。",
		level === 3 ? "三级记忆没有问题就 keep；只有新证据才改。用户锁定的记忆你改不了，有问题就 set_status=review，程序会交给用户。" : "用户锁定的记忆你改不了，有问题就 set_status=review，程序会交给用户。",
		"没被用到、时间久了都不是改动的理由。一条只写一件事，以「用户」为主语。最后用一两句话说明你做了什么。",
	].join("\n");
}

const MATERIAL_SYSTEM = [
	"你是 DreamFlutter 的记忆整理 Agent，现在做「快照准备」：把下面的记忆按主题合成几段简短的快照素材。以后每个任务开始时，程序会挑和任务相关的素材放进主 Agent 的上下文，代替逐条列出，省 token。你只能读写记忆，没有别的工具；你不改记忆本身。",
	"规则：",
	"- 每段素材把 2 条以上说同一主题的记忆合成一两句话，用 action=material 提交，from 列出覆盖的条目和版本；",
	"- 不能丢任何限定：版本、范围、否定、条件、有效期、「尚未确认」都要保留；不加记忆里没有的内容；以「用户」为主语；",
	"- 句末用（#id、#id）标出这段覆盖的每一条，不要提别的条目；",
	"- 一条记忆只放进一段素材；和别的都不相关的单独条目不用写；",
	"- 素材要比把这些条目分开列出更短，否则不用写。",
	"写完用一两句话说明你写了几段。",
].join("\n");

const CAPACITY_SYSTEM = [
	"你是 DreamFlutter 的记忆整理 Agent。这个分区的活跃记忆超过了容量上限，现在做一次完整的提炼合并，腾出空间。你只能读写记忆，没有别的工具；你提交的改动由程序检查后生效，记入用户的记忆日志，用户可以撤销。",
	"能做的：几条说同一件事的 combine（retire_as=archived 是提炼：原条目保留、退出日常使用；纯重复用 superseded）；已经结束的安排、做完的事的零碎记录 set_status=ended；错的、过时的 set_status=outdated；啰嗦的 update 成更短的说法（不丢限定）；仍然有用的 keep。",
	"不要删内容、不要软遗忘（那一步由程序在合并之后另外判断）。一条只写一件事，以「用户」为主语。最后用一两句话说明你做了什么。",
].join("\n");

const FORGET_SYSTEM = [
	"你是 DreamFlutter 的记忆整理 Agent。这个分区的活跃记忆在完整的提炼合并之后仍然超过容量，现在要软遗忘一部分（软遗忘的条目退出日常使用，保留来源，用户可以在记忆日志里一键恢复）。你只能读写记忆，没有别的工具。",
	"程序已经按顺序列出了可以软遗忘的候选（有完整替代的 → 被更新的说法覆盖了的细节 → 已结束事项的零碎记录 → 能从原对话找回的）；三级、锁定、常驻、Agent 设定、用户确认过的决定不在里面，也不能软遗忘。",
	"按候选的顺序挑，挑到腾出要求的 token 数就停；仍然重要的跳过。用 set_status=forgotten，每条写理由。最后用一两句话说明你做了什么。",
].join("\n");

const CONFLICT_SYSTEM = [
	"你是 DreamFlutter 的记忆整理 Agent。程序发现下面的记忆可能和别的内容矛盾（只是字面上的初筛，不一定真矛盾）。你只能读写记忆，没有别的工具；你提交的改动由程序检查后生效，记入用户的记忆日志，用户可以撤销。",
	"先判断是不是真的矛盾：",
	"- 不矛盾（说的是不同情况，或只是说法不同）：keep；如果是适用条件不同，update 补上 conditions；",
	"- 矛盾，而且能判断哪条对（用户最新亲口说的、工具结果、更具体的优先）：把错的那条 set_status=refuted（被推翻）或 outdated（过时），必要时 update 对的那条；",
	"- 矛盾但判断不了：conflict（id 是要复核的那条，with 是和它矛盾的那条），交给用户看。",
	"用户锁定的记忆你改不了，有问题就 set_status=review。最后用一两句话说明你做了什么。",
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
	private readonly shutdown = new AbortController();
	private readonly stopWaiting = new AbortController();
	private stopping: Promise<void> | undefined;
	private readonly boundaryCalls = new Set<Promise<unknown>>();

	constructor(core: Core, store: MemoryStore, workspaces: Workspaces, llm: Llm, scopesFor: (cwd: string) => ScopeSet, now: () => number) {
		this.core = core;
		this.db = core.db;
		this.store = store;
		this.workspaces = workspaces;
		this.llm = llm;
		this.scopesFor = scopesFor;
		this.now = now;
		this.jobs = new MemoryJobs(core.db, now, {
			run: async (job) => {
				try { return await this.run(job); }
				catch (error) {
					if (this.shutdown.signal.aborted) throw new MemoryJobInterrupted((error as { costUsd?: number })?.costUsd ?? 0);
					throw error;
				}
			},
			budgetLeft: () => this.core.settings.get().memoryDailyBudgetUsd - this.spentToday(),
			paused: () => this.core.settings.get().memoryPaused || this.stopped,
			nextBudgetAt: () => startOfDay(this.now()) + DAY,
			onChange: (job) => core.broadcast({ event: "memory.jobs.changed", job }),
		});
		store.onChange((batchId) => {
			if (batchId) this.checkWritten(batchId);
		});
	}

	private get background(): boolean {
		const settings = this.core.settings.get();
		return settings.memoryEnabled && settings.memoryAutoExtract;
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

	stop(): Promise<void> {
		return this.stopping ??= this.stopWork();
	}

	private async stopWork(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		const stopping = this.jobs.stop();
		this.shutdown.abort();
		const timer = setTimeout(() => {
			this.core.log.warn("memory: shutdown exceeded 15 seconds; detaching model calls, late usage will not be available");
			this.stopWaiting.abort(new Error("记忆退出等待超时"));
		}, MEMORY_SHUTDOWN_TIMEOUT_MS);
		try {
			// The deadline releases the waits inside jobs, rather than abandoning
			// their DB writers. Accounting and queue recovery still finish before close.
			await stopping;
			await Promise.allSettled(this.boundaryCalls);
		} finally { clearTimeout(timer); }
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

	/** A possible contradiction to look at (17.4, 17.6): queued only after the program's prefilter found one. */
	queueConflict(input: { items: MemoryItem[]; trigger: "write" | "recall"; excerpt?: string; sessionRef?: string | null; cwd?: string | null }): MemoryJob {
		const ids = input.items.map((m) => m.id);
		const scopeKey = input.cwd ? this.scopesFor(input.cwd).key : keyOf(input.items[0]!);
		return this.jobs.enqueue({
			kind: "conflict",
			scopeKey,
			payload: { itemIds: ids, versions: Object.fromEntries(input.items.map((m) => [m.id, m.version])), trigger: input.trigger, excerpt: input.excerpt ?? null, sessionRef: input.sessionRef ?? null, cwd: input.cwd ?? null },
			priority: PRIORITY.conflict,
			dedupeKey: `conflict:${input.trigger}:${[...ids].sort().join(",")}`,
		});
	}

	/**
	 * New text in the store (an item added, or its text changed): compared with
	 * the items next to it; a likely contradiction goes to the memory agent
	 * (17.6). No match, no model call.
	 */
	private checkWritten(batchId: string): void {
		if (!this.background) return;
		const changes = this.store.batchChanges(batchId);
		if (!changes.length || NO_CONFLICT_CHECK.has(changes[0]!.batchKind) || changes[0]!.actor === "migration") return;
		for (const change of changes) {
			if (!change.newText) continue;
			const item = this.store.get(change.itemId);
			if (!item || !LIVE_STATUSES.includes(item.status)) continue;
			const linked = new Set(this.store.links(item.id).filter((l) => l.kind === "conflicts").map((l) => (l.from === item.id ? l.to : l.from)));
			const near = this.store.list({ set: this.setFor(keyOf(item)) }).filter((m) => m.id !== item.id && !linked.has(m.id));
			const hits = possibleConflicts(item.content, near).slice(0, CONFLICTS_PER_ITEM);
			if (hits.length) this.queueConflict({ items: [item, ...hits], trigger: "write" });
		}
	}

	/**
	 * Items of a task's snapshot that what the user said this time may
	 * contradict (17.4 回想时再巩固): each goes to the memory agent once, with
	 * the sentence. Being used without anything new changes nothing.
	 */
	checkRecalled(input: { shown: MemoryItem[]; said: string[]; sessionRef: string | null; cwd: string }): MemoryJob | undefined {
		if (!this.background || !input.shown.length) return undefined;
		const hits = new Map<string, { item: MemoryItem; sentence: string }>();
		for (const sentence of input.said) {
			for (const item of possibleConflicts(sentence, input.shown)) if (!hits.has(item.id)) hits.set(item.id, { item, sentence });
		}
		if (!hits.size) return undefined;
		const found = [...hits.values()];
		return this.queueConflict({ items: found.map((h) => h.item), trigger: "recall", excerpt: [...new Set(found.map((h) => h.sentence))].join("\n"), sessionRef: input.sessionRef, cwd: input.cwd });
	}

	/**
	 * A tool call succeeded: observations that said it does not work are
	 * refuted at once, with the call as their evidence (17.3: 「遇到反例就失效」).
	 * A locked one is only marked for review and handed to the user (the gate).
	 */
	refuteByTool(input: { cwd: string; toolName: string; args: unknown; output: string; sessionRef: string | null }): string[] {
		if (!this.core.settings.get().memoryEnabled || failedOutput(input.output)) return [];
		const ids = toolIdentifiers(input.toolName, input.args);
		const items = refutedBy(this.store, this.scopesFor(input.cwd), ids);
		if (!items.length) return [];
		const args = (input.args ?? {}) as Record<string, unknown>;
		const what = typeof args.command === "string" ? args.command : typeof args.url === "string" ? args.url : input.toolName;
		const ops: MemoryOp[] = items.map((m) => {
			const id = ids.find((x) => mentions(m.content, x)) ?? input.toolName;
			return { kind: "status", id: m.id, baseVersion: m.version, status: "refuted", sources: [{ kind: "tool", ref: input.sessionRef, excerpt: `${input.toolName}：${what}`.slice(0, 300) }], reason: `「${id}」刚刚成功运行了，这条判断被推翻` };
		});
		const result = this.store.commit({ actor: "system", ops, batchKind: "refute", sessionRef: input.sessionRef, reason: "工具成功运行，推翻了相反的判断" });
		return result.applied.map((a) => a.itemId);
	}

	// ---- active capacity (§9, §12 items 4–5) --------------------------------------------------

	/** Every partition with live items. */
	private partitions(): string[] {
		const keys = new Set<string>();
		for (const level of [1, 2, 3] as Level[]) for (const key of this.scopeKeys(level)) keys.add(key);
		return [...keys];
	}

	/**
	 * Partitions over their capacity get one consolidation job; again only
	 * once something new was written since the last one (it does not run
	 * every ten minutes on a partition it could not bring down).
	 */
	checkCapacity(): string[] {
		if (!this.background) return [];
		const cap = this.core.settings.get().memoryCapacityTokens;
		const out: string[] = [];
		for (const key of this.partitions()) {
			const items = this.itemsOf(key);
			if (activeTokens(items) <= cap) continue;
			const last = Number(this.db.get<{ value: string }>("SELECT value FROM app_flags WHERE key = ?", CAPACITY_FLAG + key)?.value ?? 0);
			if (last && !items.some((m) => m.createdAt > last)) continue;
			this.jobs.enqueue({ kind: "capacity", scopeKey: key, priority: PRIORITY.periodic, dedupeKey: `capacity:${key}` });
			out.push(`capacity:${key}`);
		}
		return out;
	}

	/**
	 * A partition over its capacity: first a full consolidation; only if it is
	 * still above 90% after that (「真正满额」) the agent soft-forgets from the
	 * program's candidates, in order, until there is room (§12 items 4–5).
	 * Each step is its own batch in the memory log, undone in one go.
	 */
	private async capacity(job: MemoryJob): Promise<JobOutcome> {
		const key = job.scopeKey;
		const cap = this.core.settings.get().memoryCapacityTokens;
		const start = this.now();
		this.db.run("INSERT OR REPLACE INTO app_flags(key, value, at) VALUES(?, ?, ?)", CAPACITY_FLAG + key, String(start), start);
		const before = activeTokens(this.itemsOf(key));
		if (before <= cap) return { status: "skipped", result: { why: "没有超过容量" } };
		const set = this.setFor(key);
		const workspace = key.startsWith("workspace:") ? this.workspaces.get(key.slice(10))?.path : undefined;
		const base = { set, scopeKey: key, sessionRef: null, progressLeft: 0, added: [], batches: [] as string[] };
		const open = this.itemsOf(key)
			.filter((m) => m.level < 3 && m.retention === "normal")
			.sort((a, b) => a.createdAt - b.createdAt)
			.slice(0, CAPACITY_ITEMS);
		const consolidate: Policy = { ...base, actions: new Set(["update", "set_status", "combine", "keep"]), statuses: new Set(["ended", "archived", "outdated", "superseded", "review"]) };
		const first = await this.agent(job, CAPACITY_SYSTEM, [`「${scopeLabel(key)}」的活跃记忆约 ${before} token，上限 ${cap}。下面是可以整理的条目（三级和锁定的不在里面），最早的在前：`, ...open.map(line)].join("\n"), consolidate, workspace ?? null, "capacity", "容量超了，提炼合并");
		let cost = first.usage.cost;
		const after = activeTokens(this.itemsOf(key));
		if (after <= cap * TRULY_FULL) return { status: "done", costUsd: cost, result: { before, after, step: "consolidated", batches: consolidate.batches } };
		const candidates = forgetCandidates(this.store, this.itemsOf(key), this.now());
		if (!candidates.length) {
			this.core.broadcast({ event: "memory.notice", kind: "capacity_full", scopeKey: key, tokens: after, capacity: cap });
			return { status: "done", costUsd: cost, result: { before, after, step: "nothing_to_forget", batches: consolidate.batches } };
		}
		const need = Math.ceil(after - cap * TRULY_FULL);
		const forget: Policy = { ...base, batches: [], actions: new Set(["set_status"]), statuses: new Set(["forgotten"]), forgettable: new Set(candidates.map((c) => c.item.id)) };
		const input = [`提炼合并之后「${scopeLabel(key)}」仍有约 ${after} token，上限 ${cap}，要腾出至少 ${need} token。可以软遗忘的候选（按顺序）：`, ...candidates.map((c) => `${line(c.item)}（${FORGET_WHY_LABEL[c.why]}，约 ${activeTokens([c.item])} token）`)].join("\n");
		const second = await this.agent(job, FORGET_SYSTEM, input, forget, workspace ?? null, "soft_forget", "真正满额，软遗忘");
		cost += second.usage.cost;
		const left = activeTokens(this.itemsOf(key));
		if (left > cap) this.core.broadcast({ event: "memory.notice", kind: "capacity_full", scopeKey: key, tokens: left, capacity: cap });
		return { status: "done", costUsd: cost, result: { before, after: left, step: "soft_forget", batches: [...consolidate.batches, ...forget.batches] } };
	}

	// ---- snapshot materials (§2.2, §6.2) -----------------------------------------------------

	/** Partitions a session with [set] reads materials from. */
	private materialKeys(set: ScopeSet): string[] {
		return [...new Set(["global", set.key])];
	}

	/** Items of [key] a material may stand for: active, not pinned (they have their own section), not the agent's persona (its own section too). */
	private materialItems(key: string): MemoryItem[] {
		return this.itemsOf(key).filter((m) => m.status === "active" && !m.pinned && m.kind !== "persona");
	}

	/**
	 * Fresh materials [set] may use: every item still there, active and at the
	 * version the text was written from. One found out of date is marked stale
	 * and never used again (its items are shown one by one until the next
	 * preparation).
	 */
	materialsFor(set: ScopeSet): Material[] {
		const keys = this.materialKeys(set);
		const rows = this.db.all<{ id: string; scope_key: string; item_versions: string; text: string }>(
			`SELECT id, scope_key, item_versions, text FROM memory_materials WHERE stale = 0 AND scope_key IN (${keys.map(() => "?").join(",")}) ORDER BY built_at, rowid`,
			...keys,
		);
		const out: Material[] = [];
		for (const row of rows) {
			const versions = parseVersions(row.item_versions);
			const items = Object.keys(versions).map((id) => this.store.get(id));
			const fresh = items.every((m) => m && m.status === "active" && !m.pinned && m.kind !== "persona" && m.version === versions[m.id] && keyOf(m) === row.scope_key) && !scanMemoryText(row.text);
			if (!fresh) {
				this.db.run("UPDATE memory_materials SET stale = 1 WHERE id = ?", row.id);
				continue;
			}
			const list = items as MemoryItem[];
			if (list.every((m) => visibleIn(m, set))) out.push({ id: row.id, scopeKey: row.scope_key, text: row.text, items: list });
		}
		return out;
	}

	/**
	 * Partitions of [set] whose materials should be (re)written: enough items
	 * to be worth it, and something changed since the last preparation (or a
	 * material went stale). Reading only; nothing is queued.
	 */
	materialNeeds(set: ScopeSet): string[] {
		const out: string[] = [];
		for (const key of this.materialKeys(set)) {
			const items = this.materialItems(key);
			if (items.length < MATERIAL_MIN_ITEMS) continue;
			const last = Number(this.db.get<{ value: string }>("SELECT value FROM app_flags WHERE key = ?", MATERIAL_FLAG + key)?.value ?? 0);
			const stale = this.db.get("SELECT 1 FROM memory_materials WHERE scope_key = ? AND stale = 1 LIMIT 1", key);
			if (stale || items.some((m) => m.updatedAt > last)) out.push(key);
		}
		return out;
	}

	/** A 「快照准备」 job for each partition in [keys], for the next task (this one does not wait: §6.2, §12 item 9). */
	queueMaterials(keys: string[]): MemoryJob[] {
		if (!this.background) return [];
		return keys.map((key) => this.jobs.enqueue({ kind: "snapshot", scopeKey: key, priority: PRIORITY.snapshot, dedupeKey: `snapshot:${key}` }));
	}

	/** Writes the snapshot materials of one partition (the memory agent groups related items into short texts). */
	private async prepare(job: MemoryJob): Promise<JobOutcome> {
		const key = job.scopeKey;
		const start = this.now();
		this.db.run("INSERT OR REPLACE INTO app_flags(key, value, at) VALUES(?, ?, ?)", MATERIAL_FLAG + key, String(start), start);
		const items = this.materialItems(key);
		if (items.length < MATERIAL_MIN_ITEMS) {
			this.db.run("DELETE FROM memory_materials WHERE scope_key = ?", key);
			return { status: "skipped", result: { why: "条目太少，不用写素材" } };
		}
		const input = [`这是「${scopeLabel(key)}」里会进快照的 ${items.length} 条记忆：`, ...items.map(line)].join("\n");
		const policy: Policy = {
			actions: new Set(["material"]),
			statuses: new Set(),
			set: this.setFor(key),
			scopeKey: key,
			sessionRef: null,
			progressLeft: 0,
			added: [],
			batches: [],
			materials: { jobId: job.id, ids: [], covered: new Set() },
		};
		const workspace = key.startsWith("workspace:") ? this.workspaces.get(key.slice(10))?.path : undefined;
		const run = await this.agent(job, MATERIAL_SYSTEM, input, policy, workspace ?? null, "snapshot", "快照准备");
		const written = policy.materials!.ids;
		// The new set replaces the old one; with nothing new, only what went out of date goes.
		if (written.length) this.db.run(`DELETE FROM memory_materials WHERE scope_key = ? AND id NOT IN (${written.map(() => "?").join(",")})`, key, ...written);
		else this.materialsFor(this.setFor(key));
		this.db.run("DELETE FROM memory_materials WHERE scope_key = ? AND stale = 1", key);
		return { status: "done", costUsd: run.usage.cost, result: { turns: run.turns, summary: run.summary, materials: written.length } };
	}

	/** The agent's `material` action: checked by the program, then stored (not a change of memory: no version, no log line). */
	private material(p: Record<string, unknown>, policy: Policy, content: string, target: (id: unknown, version: unknown) => MemoryItem | string): { ops: MemoryOp[]; note?: string } | string {
		const state = policy.materials;
		if (!state || !policy.scopeKey) return "这次整理不能写素材";
		const from = Array.isArray(p.from) ? (p.from as { id?: unknown; version?: unknown }[]) : [];
		if (from.length < 2) return "一段素材至少覆盖 2 条记忆（只有一条的不用写素材）";
		if (!content) return "素材内容是空的";
		const items: MemoryItem[] = [];
		for (const f of from) {
			const item = target(f.id, f.version);
			if (typeof item === "string") return item;
			if (item.status !== "active" || item.pinned || item.kind === "persona") return `#${item.id} 不进素材（待复核、常驻和 Agent 设定都单独列出）`;
			if (state.covered.has(item.id) || items.includes(item)) return `#${item.id} 已经写进别的素材了，一条记忆只放进一段素材`;
			items.push(item);
		}
		const missing = items.filter((m) => !content.includes(`#${m.id}`));
		if (missing.length) return `素材里要用 #id 标出它覆盖的每一条（缺 ${missing.map((m) => `#${m.id}`).join("、")}）`;
		const strays = [...content.matchAll(/#(m_[0-9a-z]+)/gi)].map((x) => x[1]!).filter((id) => !items.some((m) => m.id === id));
		if (strays.length) return `素材里提到了没有列在 from 里的条目：${strays.map((id) => `#${id}`).join("、")}`;
		const hazard = scanMemoryText(content);
		if (hazard) return `素材不能用：${hazard.detail}`;
		const tokens = materialCost({ text: content });
		const separate = items.reduce((sum, m) => sum + lineCost(m), 0);
		if (tokens >= separate) return `素材（约 ${tokens} token）没有比分开列出（约 ${separate} token）更短，不用写`;
		const id = `mt_${this.store.newId().slice(2)}`;
		this.db.run(
			"INSERT INTO memory_materials(id, scope_key, item_ids, item_versions, text, tokens, job_id, built_at, stale) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0)",
			id,
			policy.scopeKey,
			JSON.stringify(items.map((m) => m.id)),
			JSON.stringify(Object.fromEntries(items.map((m) => [m.id, m.version]))),
			content,
			tokens,
			state.jobId,
			this.now(),
		);
		state.ids.push(id);
		for (const m of items) state.covered.add(m.id);
		return { ops: [], note: `已写成素材（覆盖 ${items.length} 条，约 ${tokens} token，分开列出约 ${separate} token）` };
	}

	/** The program's sweep (no model): validity that ran out (17.3). */
	sweep(): ReturnType<typeof expire> {
		const out = expire(this.store, this.now());
		if (out.review.length) this.core.broadcast({ event: "memory.notice", kind: "expired_protected", itemIds: out.review });
		return out;
	}

	/**
	 * The review calendar (§12 item 1): level 1 weekly; level 2 weekly (light),
	 * monthly, quarterly; level 3 monthly (light), quarterly, yearly — after
	 * 03:00 on the day, or at the next start (once). The largest review due
	 * covers the smaller ones of the same day. A partition with nothing new,
	 * changed, conflicting, promotable or due for review (level 1: nothing
	 * past 14 days) is passed over without calling a model.
	 */
	checkSchedule(): { queued: string[]; skipped: string[] } {
		const out = { queued: [] as string[], skipped: [] as string[] };
		if (!this.core.settings.get().memoryEnabled) return out;
		const now = this.now();
		this.sweep();
		out.queued.push(...this.checkCapacity());
		for (const level of [1, 2, 3] as Level[]) {
			for (const key of this.scopeKeys(level)) {
				const due = this.due(level, key, now);
				if (!due) continue;
				const label = `L${level}:${due.period}:${key}`;
				const flagged = this.reasonsToLook(level, key, due.since, now);
				if (!flagged.size) {
					out.skipped.push(label);
					continue;
				}
				const boundary = periodStart(due.period, now);
				if (level === 1) this.jobs.enqueue({ kind: "tidy_l1", scopeKey: key, payload: { level, period: due.period, light: false, since: due.since, flagged: [...flagged] }, priority: PRIORITY.periodic, dedupeKey: `tidy_l1:${key}:${boundary}` });
				else this.jobs.enqueue({ kind: "review", scopeKey: key, payload: { level, period: due.period, light: due.light, since: due.since, flagged: [...flagged] }, priority: PRIORITY.periodic, dedupeKey: `review:${level}:${due.period}:${key}:${boundary}` });
				out.queued.push(label);
			}
		}
		return out;
	}

	/** The largest review of [level] due for [key], and when it last ran; marks every review due now as done. */
	private due(level: Level, key: string, now: number): { period: Period; light: boolean; since: number } | undefined {
		let chosen: { period: Period; light: boolean; since: number } | undefined;
		for (const entry of CALENDAR[level]) {
			const flagKey = level === 1 ? TIDY_FLAG + key : `${REVIEW_FLAG}${level}:${entry.period}:${key}`;
			const last = Number(this.db.get<{ value: string }>("SELECT value FROM app_flags WHERE key = ?", flagKey)?.value ?? NaN);
			const mark = () => this.db.run("INSERT OR REPLACE INTO app_flags(key, value, at) VALUES(?, ?, ?)", flagKey, String(now), now);
			if (!Number.isFinite(last)) {
				mark(); // first time: start counting from now
				continue;
			}
			if (last >= periodStart(entry.period, now)) continue;
			chosen ??= { ...entry, since: last };
			mark();
		}
		return chosen;
	}

	/** Items of [level] in [key] worth a model's look since [since]; empty = no call. */
	private reasonsToLook(level: Level, key: string, since: number, now: number): Set<string> {
		const items = this.itemsOf(key).filter((m) => m.level === level);
		const out = new Set<string>();
		if (!items.length) return out;
		const ids = new Set(items.map((m) => m.id));
		const changed = this.store.changedSince(since, REVIEW_BATCHES);
		for (const m of items) {
			if (changed.has(m.id)) out.add(m.id);
			if (m.nextReviewAt !== null && m.nextReviewAt <= now) out.add(m.id);
			if (level === 1 && m.createdAt <= now - LEVEL1_DAYS * DAY && (m.lastVerifiedAt ?? 0) <= since) out.add(m.id);
		}
		for (const c of this.store.conflictsSince(since)) {
			if (ids.has(c.from)) out.add(c.from);
			if (ids.has(c.to)) out.add(c.to);
		}
		if (level < 3) for (const id of promotable(this.store, items.filter((m) => (m.lastVerifiedAt ?? 0) <= since), now)) out.add(id);
		return out;
	}

	private scopeKeys(level: Level): string[] {
		const keys = new Set<string>();
		for (const row of this.db.all<{ scope: string; workspace_id: string | null }>("SELECT DISTINCT scope, workspace_id FROM memory_items WHERE status IN ('active', 'review') AND level = ?", level)) {
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
			case "review":
				return this.review(job);
			case "conflict":
				return this.conflict(job);
			case "snapshot":
				return this.prepare(job);
			case "capacity":
				return this.capacity(job);
		}
	}

	private async extract(job: MemoryJob): Promise<JobOutcome> {
		const { sessionFile, sessionId, cwd } = job.payload as { sessionFile: string; sessionId: string; cwd: string };
		if (!sessionFile || !existsSync(sessionFile)) return { status: "skipped", result: { why: "会话文件不在了" } };
		if (isSideFile(sessionFile)) return { status: "skipped", result: { why: "侧边对话不提取记忆" } };
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
		const policy: Policy = { actions: new Set(["add", "update", "set_status", "conflict"]), statuses: new Set(["review", "outdated", "refuted"]), set, sessionRef: sessionFile, progressLeft: PROGRESS_PER_TASK, added: [], batches: [] };
		const run = await this.agent(job, EXTRACT_SYSTEM, input, policy, cwd, "extract", "对话结束后的整理");
		advance();
		return { status: "done", costUsd: run.usage.cost, result: { turns: run.turns, summary: run.summary, batches: policy.batches } };
	}

	/** A periodic review of one level in one partition (level 1: the weekly tidy). */
	private async review(job: MemoryJob): Promise<JobOutcome> {
		const level = (Number(job.payload.level) || 1) as Level;
		const period = (job.payload.period as Period | undefined) ?? "week";
		const light = job.payload.light === true;
		const all = this.itemsOf(job.scopeKey).filter((m) => m.level === level);
		if (!all.length) return { status: "skipped", result: { why: `没有${level}级记忆` } };
		const now = this.now();
		const since = Number(job.payload.since ?? 0);
		const flagged = new Set(Array.isArray(job.payload.flagged) ? (job.payload.flagged as string[]) : []);
		const items = light ? all.filter((m) => flagged.has(m.id)) : all;
		if (!items.length) return { status: "skipped", result: { why: "列出的条目都已经不在了" } };
		const changed = this.store.changedSince(since, REVIEW_BATCHES);
		const up = level < 3 ? promotable(this.store, items, now) : new Set<string>();
		const partners = new Map<string, string[]>();
		for (const m of items) {
			const other = this.store.links(m.id).filter((l) => l.kind === "conflicts").map((l) => (l.from === m.id ? l.to : l.from));
			if (other.length) partners.set(m.id, other);
		}
		const notes = (m: MemoryItem) =>
			[
				`${Math.floor((now - m.createdAt) / DAY)} 天前记下`,
				changed.has(m.id) ? (period === "week" ? "本周有改动" : "上次回顾后有改动") : "",
				up.has(m.id) ? `可以升到 ${m.level + 1} 级` : "",
				partners.has(m.id) ? `和 ${partners.get(m.id)!.map((id) => `#${id}`).join("、")} 有冲突` : "",
				m.nextReviewAt !== null && m.nextReviewAt <= now ? "到了复查时间" : "",
			]
				.filter(Boolean)
				.join("，");
		const rows = items.map((m) => `${line(m)}（${notes(m)}）`);
		const others = [...new Set([...partners.values()].flat())].filter((id) => !items.some((m) => m.id === id)).flatMap((id) => {
			const m = this.store.get(id);
			return m ? [line(m)] : [];
		});
		const label = level === 1 ? "一级" : level === 2 ? "二级" : "三级";
		const input = [
			`今天是 ${localDay(now)}。这是「${scopeLabel(job.scopeKey)}」的${label}记忆${light ? `里要看的 ${items.length} 条（共 ${all.length} 条）` : `，共 ${items.length} 条`}：`,
			...rows,
			...(others.length ? ["", "和上面冲突的条目（供对照）：", ...others] : []),
		].join("\n");
		const actions: Action[] = ["update", "set_status", "combine", "keep", "conflict"];
		if (level < 3) actions.push("promote");
		if (level > 1) actions.push("demote");
		const policy: Policy = {
			actions: new Set(actions),
			statuses: new Set(["ended", "archived", "outdated", "review", "superseded", "refuted"]),
			set: this.setFor(job.scopeKey),
			scopeKey: job.scopeKey,
			sessionRef: null,
			progressLeft: 0,
			added: [],
			batches: [],
		};
		const workspace = job.scopeKey.startsWith("workspace:") ? this.workspaces.get(job.scopeKey.slice(10))?.path : undefined;
		const system = level === 1 ? TIDY_SYSTEM : reviewSystem(level, period, light);
		const run = await this.agent(job, system, input, policy, workspace ?? null, level === 1 ? "tidy" : "review", `${PERIOD_LABEL[period]}整理${label}记忆`);
		return { status: "done", costUsd: run.usage.cost, result: { turns: run.turns, summary: run.summary, batches: policy.batches } };
	}

	/** A possible contradiction the prefilter found (17.4, 17.6): the memory agent decides whether it is one. */
	private async conflict(job: MemoryJob): Promise<JobOutcome> {
		const p = job.payload as { itemIds?: string[]; versions?: Record<string, number>; trigger?: string; excerpt?: string | null; sessionRef?: string | null; cwd?: string | null };
		const items = (p.itemIds ?? []).map((id) => this.store.get(id)).filter((m): m is MemoryItem => !!m && LIVE_STATUSES.includes(m.status));
		const recall = p.trigger === "recall";
		// Something already dealt with it (the extraction after the task runs first and sees the same conversation).
		const fresh = items.filter((m) => !recall || m.version === p.versions?.[m.id]);
		if (recall ? !fresh.length : items.length < 2 || items[0]!.id !== p.itemIds?.[0]) return { status: "skipped", result: { why: "已经处理过了" } };
		const now = this.now();
		const input = recall
			? [`今天是 ${localDay(now)}。这次任务用到了下面的记忆，而用户在这次对话里说了：`, `「${p.excerpt ?? ""}」`, "", "用到的记忆：", ...fresh.map(line)].join("\n")
			: [`今天是 ${localDay(now)}。刚写入（或刚改过）的这条记忆：`, line(items[0]!), "", "可能和它矛盾的已有记忆：", ...items.slice(1).map(line)].join("\n");
		const set = p.cwd ? this.scopesFor(p.cwd) : this.setFor(job.scopeKey);
		const policy: Policy = { actions: new Set(["update", "set_status", "keep", "conflict", "demote"]), statuses: new Set(["outdated", "refuted", "superseded", "review"]), set, sessionRef: p.sessionRef ?? null, progressLeft: 0, added: [], batches: [] };
		const run = await this.agent(job, CONFLICT_SYSTEM, input, policy, p.cwd ?? null, "conflict", recall ? "用到的记忆和这次对话可能矛盾" : "新写入的记忆和已有的可能矛盾");
		return { status: "done", costUsd: run.usage.cost, result: { turns: run.turns, summary: run.summary, batches: policy.batches } };
	}

	/** Runs the agent for [job]; its model calls go in the ledger whatever happens. */
	private async agent(job: MemoryJob, system: string, input: string, policy: Policy, cwd: string | null, batchKind: string, why: string): Promise<AgentRun> {
		const runtime = await waitForMemory(() => this.llm.runtime(this.stopWaiting.signal), this.stopWaiting.signal);
		this.shutdown.signal.throwIfAborted();
		const model = await waitForMemory(() => this.model(runtime), this.stopWaiting.signal);
		if (!model) throw new Error("没有可用的模型");
		const run = await runMemoryAgent({
			runtime,
			model,
			system,
			input,
			now: this.now,
			signal: this.shutdown.signal,
			waitSignal: this.stopWaiting.signal,
			handlers: { query: (args) => this.query(args, policy), propose: (args) => this.propose(args, policy, batchKind, `${why}（${model.id}）`) },
		});
		// Attempts do not increase on shutdown. A separate invocation id prevents
		// the next interrupted execution from overwriting an earlier usage record.
		const invocation = randomUUID();
		run.calls.forEach((call, i) => {
			this.db.run(
				"INSERT OR REPLACE INTO usage_records(path, entry_id, at, cwd, provider, model, input, output, cache_read, cache_write, cost) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				MEMORY_LEDGER,
				`${job.id}:${invocation}:${i}`,
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
			this.stopWaiting.signal.throwIfAborted();
			const model = available.find((m) => m.provider === wanted.slice(0, slash) && m.id === wanted.slice(slash + 1));
			if (model) return model;
		}
		return this.llm.auxModel(runtime);
	}

	/**
	 * The light check at a possible task boundary (16.2): one short
	 * classification call, not a memory agent run, paid from the memory
	 * budget. Anything unclear (no model, budget spent, an error, a slow
	 * answer) is 「same task」.
	 */
	classifyBoundary(input: { taskPrompt: string; recent: string; prompt: string; cwd: string | null }): Promise<{ newTask: boolean; confidence: number } | undefined> {
		const pending = this.classifyBoundaryNow(input);
		this.boundaryCalls.add(pending);
		void pending.then(() => this.boundaryCalls.delete(pending), () => this.boundaryCalls.delete(pending));
		return pending;
	}

	private async classifyBoundaryNow(input: { taskPrompt: string; recent: string; prompt: string; cwd: string | null }): Promise<{ newTask: boolean; confidence: number } | undefined> {
		if (this.stopped) return undefined;
		const settings = this.core.settings.get();
		if (settings.memoryPaused || settings.memoryDailyBudgetUsd - this.spentToday() <= 0) return undefined;
		try {
			const runtime = await waitForMemory(() => this.llm.runtime(this.stopWaiting.signal), this.stopWaiting.signal);
			if (this.stopped) return undefined;
			const model = await waitForMemory(() => this.model(runtime), this.stopWaiting.signal);
			if (!model || this.stopped) return undefined;
			const text = [
				`这个对话当前的任务从这句话开始：「${input.taskPrompt.slice(0, 600)}」`,
				input.recent ? `最近的几句：${input.recent.slice(-800)}` : "",
				`用户刚发来：「${input.prompt.slice(0, 800)}」`,
				"这条新消息是在继续当前的任务，还是开始了一件新的、无关的事？只回答一行 JSON：{\"new_task\": true 或 false, \"confidence\": 0 到 1}。拿不准就回答 false。",
			]
				.filter(Boolean)
				.join("\n");
			const timeout = new AbortController();
			const signal = AbortSignal.any([this.shutdown.signal, timeout.signal]);
			// Account for a response even if it arrives after our decision deadline.
			// stop() waits for these writes before Core closes the database.
			const request = waitForMemory(() => runtime.completeSimple(model, { systemPrompt: "你只做一件事：判断对话里是不是换了任务。只输出 JSON。", messages: [{ role: "user", content: [{ type: "text", text }], timestamp: this.now() }] } as never, { maxTokens: 60, signal } as never), this.stopWaiting.signal).then((answer) => {
				const u = answer.usage ?? {};
				this.db.run(
					"INSERT OR REPLACE INTO usage_records(path, entry_id, at, cwd, provider, model, input, output, cache_read, cache_write, cost) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					MEMORY_LEDGER,
					`boundary:${this.now()}:${Math.random().toString(36).slice(2, 8)}`,
					this.now(),
					input.cwd,
					answer.provider ?? model.provider,
					answer.model ?? model.id,
					u.input ?? 0,
					u.output ?? 0,
					u.cacheRead ?? 0,
					u.cacheWrite ?? 0,
					u.cost?.total ?? 0,
				);
				return answer;
			});
			this.boundaryCalls.add(request);
			void request.then(() => this.boundaryCalls.delete(request), () => this.boundaryCalls.delete(request));
			let timer: NodeJS.Timeout | undefined;
			const deadline = new Promise<undefined>((resolve) => {
				timer = setTimeout(() => { timeout.abort(); resolve(undefined); }, 8_000);
				timer.unref();
			});
			let answer: Awaited<typeof request> | undefined;
			try { answer = await Promise.race([request, deadline]); }
			finally { if (timer) clearTimeout(timer); }
			if (!answer || signal.aborted) return undefined;
			if (answer.stopReason === "error" || answer.stopReason === "aborted") return undefined;
			const raw = (answer.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
			const json = raw.match(/\{[^{}]*\}/)?.[0];
			if (!json) return undefined;
			const parsed = JSON.parse(json) as { new_task?: unknown; confidence?: unknown };
			const confidence = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0;
			return { newTask: parsed.new_task === true, confidence };
		} catch (error) {
			this.core.log.warn("memory: the task boundary check failed", error);
			return undefined;
		}
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
	private propose(args: Record<string, unknown>, policy: Policy, batchKind: string, reason: string): string {
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
			? this.store.commit({ actor: "memory_agent", ops, allowed: policy.set, sessionRef: policy.sessionRef, batchKind, reason })
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
				if (twin && !saysMore(content, twin.content)) {
					// The user said it again in another conversation: one more independent source (what a level rises on, §3), not a second item.
					const existing = this.store.get((twin as { id: string }).id);
					if (existing && p.said === true && policy.sessionRef && !this.store.sources(existing.id).some((s) => s.kind === "session" && s.ref === policy.sessionRef)) {
						return { ops: [{ kind: "edit", id: existing.id, baseVersion: existing.version, patch: { lastVerifiedAt: this.now() }, sources, reason: `用户在另一次对话里又说了一遍：${reason}` }], note: `和 #${existing.id} 意思相同，没有重复保存，记下了这次也是来源` };
					}
					return `和 #${(twin as { id: string }).id} 意思相同，没有重复保存`;
				}
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
			case "material":
				return this.material(p, policy, content, target);
			case "promote":
			case "demote": {
				const item = target(p.id, p.version);
				if (typeof item === "string") return item;
				const to = item.level + (action === "promote" ? 1 : -1);
				if (to < 1 || to > 3) return action === "promote" ? "已经是三级了" : "已经是一级了";
				// Whether the evidence is enough is the program's call (the store's gate checks it, §3).
				return { ops: [{ kind: "edit", id: item.id, baseVersion: p.version as number, patch: { level: to as Level }, reason }] };
			}
			case "conflict": {
				const item = target(p.id, p.version);
				if (typeof item === "string") return item;
				if (typeof p.with !== "string") return "conflict 要用 with 指明和它矛盾的那条";
				const other = this.store.get(p.with.replace(/^#/, ""));
				if (!other || other.id === item.id) return `没有 #${String(p.with)}`;
				if (!this.store.list({ set: policy.set, statuses: [other.status] }).some((m) => m.id === other.id)) return `#${other.id} 不在这次允许的范围里`;
				if (item.status === "review") {
					this.store.link(item.id, other.id, "conflicts");
					return { ops: [], note: `#${item.id} 已经在待复核里，记下了它和 #${other.id} 的冲突` };
				}
				return { ops: [{ kind: "status", id: item.id, baseVersion: p.version as number, status: "review", links: [{ to: other.id, kind: "conflicts" }], sources, reason }] };
			}
			case "set_status": {
				const status = p.status as ItemStatus;
				if (!policy.statuses.has(status)) return `这次整理不能把状态改成「${String(p.status)}」`;
				const item = target(p.id, p.version);
				if (typeof item === "string") return item;
				// Soft forgetting only from the program's candidates (§12 item 5).
				if (status === "forgotten" && !policy.forgettable?.has(item.id)) return `#${item.id} 不在可以软遗忘的候选里（三级、锁定、常驻、Agent 设定、用户确认过的决定不能软遗忘）`;
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
	return `#${m.id} v${m.version} L${m.level} ${m.kind} ${m.status} ${m.confidence}${m.retention === "locked" ? " 锁定" : ""} ${localDay(m.createdAt)}${m.validUntil !== null ? ` 有效到${localDay(m.validUntil)}` : ""}：${m.content}${m.conditions ? `［条件：${m.conditions}］` : ""}`;
}

function keyOf(m: Pick<MemoryItem, "scope" | "workspaceId">): string {
	return m.scope === "workspace" ? `workspace:${m.workspaceId}` : m.scope === "butterfly" ? "butterfly" : m.scope === "global" ? "global" : `group`;
}

function parseVersions(text: string): Record<string, number> {
	try {
		const value = JSON.parse(text) as unknown;
		return value && typeof value === "object" ? (value as Record<string, number>) : {};
	} catch {
		return {};
	}
}

function scopeLabel(key: string): string {
	return key === "global" ? "全局" : key === "butterfly" ? "蝶君" : "这个工作区";
}

function startOfDay(at: number): number {
	const d = new Date(at);
	d.setHours(0, 0, 0, 0);
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

