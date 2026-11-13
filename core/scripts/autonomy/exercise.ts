import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Core } from "../../src/core.ts";
import type { LedgerRow } from "../../src/ledger/types.ts";
import { ButterflyModule } from "../../src/modules/butterfly.ts";
import { GoalsModule } from "../../src/modules/goals.ts";
import { SelfworkModule } from "../../src/modules/selfwork/index.ts";
import { PERSONAS } from "../../src/modules/persona/presets.ts";
import { isProactiveTerminal } from "../../src/modules/persona/proactive.ts";
import { selfworkDeliverable } from "../../src/modules/goals/selfwork.ts";
import { textOf } from "../../src/runs.ts";
import { redact } from "../../src/security/redaction.ts";
import type { Rule } from "../../src/modules/autonomy/rules.ts";
import type { TestCore } from "../../test/harness.ts";
import type { ChatInput } from "../../src/modules/goals/chat-task.ts";
import { sessionTrace } from "../longtask/live-evidence.ts";
import type { TransportReceipt } from "../longtask/request-evidence.ts";

export interface Profile {
	core: Core;
	local(path: string): string;
	notices: { title: string; body: string }[];
	faux?: TestCore;
	idle(): Promise<void>;
	restart(): Promise<void>;
	startMeter(): void;
	stopReason?(): string | undefined;
	progress?(text: string): void;
	meter(): { transportRequests: number; reservedOrEstimatedUsd: number; fakeModelRequests?: number; pending?: number;
		missingFinalUsage?: number; transportReceipts?: readonly TransportReceipt[] };
}

const explain = "已核对两份记录，结果与原始数据一致。";
const demo = "两份独立记录合计 7 项，差异为 1 项。\n";
const sourceA = "/workspace/inbox/t118-a.txt", sourceB = "/workspace/inbox/t118-b.txt";
const attachments = [{ path: sourceA, kind: "file" }, { path: sourceB, kind: "file" }] satisfies ChatInput["attachments"];
const taskText = "在沙箱里先读取本次交办的两份附件副本，再核对两份记录的合计与差异，最后交付 report.md。用 goal_report 的 done 和 note 留下验收说明。";
const selfworkPlan = { action: "proceed", title: "核对学习样例", topic: "小批数据的差异核对", instruction: "在约定路径记录两份合成材料的核对方法和结果。", share: true, external: false };
const learningContext = "聊一聊沙箱里 /workspace/inbox/t118-a.txt 和 /workspace/inbox/t118-b.txt 这两份小样本的差异核对。我想学一个可复用的核对方法。有值得记录的发现，请主动告诉我。";
const personas = Object.keys(PERSONAS) as (keyof typeof PERSONAS)[];
const personaInputs = [
	{ id: "progress", label: "进度", text: "两份资料都整理好了，还有一项需要我明天确认。现在的进度怎么样？" },
	{ id: "tired", label: "疲惫", text: "我今天好累。" },
	{ id: "opinion", label: "方案", text: "我打算先用一周给新流程做个小试点，再根据使用反馈决定要不要推广。这个方案你怎么看？" },
] as const;
export type TrialCase = "B2" | "B3" | "B4" | "B5" | "B6";
type ChatTask = { goalId: string; inputs: string[]; deliverables: string[]; delivery: null | { explanation: string } };
type Evidence = Record<string, unknown>;

function scheduler(profile: Profile) { return profile.core.module(GoalsModule)!.scheduler; }
function programDone() { return fauxAssistantMessage([fauxToolCall("goal_report", { status: "done", note: explain })]); }

function put(profile: Profile, path: string, value: string) {
	const local = profile.local(path);
	mkdirSync(dirname(local), { recursive: true });
	writeFileSync(local, value);
}

async function until<T>(p: Profile, description: string, read: () => T | undefined | false, timeout = 120_000): Promise<T> {
	const limit = Date.now() + timeout;
	do {
		const stop = p.stopReason?.();
		if (stop) throw new Error(stop);
		const value = read();
		if (value !== false && value !== undefined) return value;
		await delay(100);
	} while (Date.now() < limit);
	throw new Error(description + "超时");
}

async function chat(profile: Profile, sessionFile?: string) {
	const { core } = profile;
	let settled = 0;
	const failedPrompts = new Map<string, string>();
	const client = core.addClient(message => {
		if (message.event !== "slot.record") return;
		const record = message.record as { type?: string; id?: string; success?: boolean; error?: string };
		if (record.type === "agent_settled") settled++;
		if (record.type === "response" && record.id && record.success === false) failedPrompts.set(record.id, record.error ?? "发送聊天失败");
	});
	const slot = await core.openSlot({ client, sandbox: true, cwd: core.paths.butterflyDir, sessionFile }).catch(error => {
		core.removeClient(client);
		throw error;
	});
	const file = slot.session.sessionFile!;
	return {
		slot, file, settled: () => settled, failedPrompts,
		send: (id: string, message: string, files?: ChatInput["attachments"]) => core.call("slot.send", { slotId: slot.slotId,
			record: { type: "prompt", id, operationId: id, message, ...(files && { chatInput: { text: message, attachments: files } }) } }, client),
		tasks: () => core.call("butterfly.chat.tasks", { sessionFile: file }) as Promise<ChatTask[]>,
		async close() {
			try { await core.closeSlot(slot.slotId); }
			finally { core.removeClient(client); }
		},
	};
}

function goalDone(profile: Profile, id: string) {
	return until(profile, "目标 " + id, () => {
		const goal = scheduler(profile).get(id);
		if (goal?.status === "completed") return scheduler(profile).detail(id);
		if (goal && ["failed", "cancelled", "blocked", "paused", "waiting_user"].includes(goal.status))
			throw new Error("目标停止在 " + goal.status + "：" + (goal.reason ?? "无原因"));
	});
}

function countedRuns(core: Core, rowid: number): number {
	return core.db.get<{ n: number }>("SELECT count(DISTINCT run_id) n FROM request_ledger WHERE rowid>? AND run_id IS NOT NULL", rowid)?.n ?? 0;
}

const receiptCursor = (core: Core) => core.db.get<{ n: number }>("SELECT coalesce(max(rowid),0) n FROM request_ledger")!.n;

async function personaReply(p: Profile, c: Awaited<ReturnType<typeof chat>>, id: string, prompt: string) {
	const before = c.slot.session.messages.length, settled = c.settled();
	await c.send(id, prompt);
	return until(p, "聊天回复", () => {
		const failure = c.failedPrompts.get(id);
		if (failure) throw new Error(failure);
		if (c.settled() === settled) return undefined;
		const last = c.slot.session.messages.slice(before).findLast(message => message.role === "assistant");
		if (last?.role !== "assistant") throw new Error("聊天已结束，没有助手回复");
		if (last.stopReason === "error" || last.stopReason === "aborted") throw new Error(last.errorMessage ?? "聊天请求中断");
		const raw = last.content.flatMap(block => block.type === "text" ? [block.text] : []).join("");
		if (!raw.trim()) throw new Error("聊天已结束，没有可见正文");
		return { text: raw, truncated: last.stopReason === "length" };
	});
}

function verifyCopies(p: Profile, task: ChatTask) {
	if (task.inputs.length !== attachments.length || existsSync(p.local("/workspace/inbox/tasks/.prepare-" + task.goalId)))
		throw new Error("交办附件未完整发布，或仍有临时目录");
	return task.inputs.map((path, index) => {
		const source = attachments[index]!.path;
		const copy = readFileSync(p.local(path)), original = readFileSync(p.local(source));
		if (!path.startsWith("/workspace/inbox/tasks/" + task.goalId + "/") || !original.equals(copy))
			throw new Error("附件副本内容或位置不符");
		return { source, path, bytes: copy.length, sha256: createHash("sha256").update(copy).digest("hex") };
	});
}

async function attachmentCleanup(p: Profile) {
	const c = await chat(p), butterfly = p.core.module(ButterflyModule)!;
	const before = receiptCursor(p.core);
	const original = readFileSync(p.local(sourceB));
	const moved = p.local(sourceB + ".t118-interrupted");
	const prepare = butterfly.prepareChatInputs.bind(butterfly);
	let injected = false, stagedFirst = false;
	const checkPath = p.core.autonomy.sandboxFile.bind(p.core.autonomy);
	butterfly.prepareChatInputs = (goalId, input, prior, save, active) => prepare(goalId, input, prior, manifest => {
		save(manifest);
		renameSync(p.local(sourceB), moved);
		injected = true;
	}, () => {
		if (existsSync(p.local("/workspace/inbox/tasks/.prepare-" + goalId + "/1/t118-a.txt"))) stagedFirst = true;
		active();
	});
	try {
		await c.send("t118-attachment-failure", taskText, attachments);
	} finally {
		butterfly.prepareChatInputs = prepare;
		if (injected) renameSync(moved, p.local(sourceB));
	}
	const row = p.core.db.get<{ goal_id: string; cleanup_pending: number; state: string; manifest: string | null }>(
		"SELECT goal_id,cleanup_pending,state,manifest FROM butterfly_chat_preparations ORDER BY rowid DESC LIMIT 1");
	if (!injected || !stagedFirst || !row || row.state !== "retry" || row.cleanup_pending !== 0 ||
		!row.manifest || (await c.tasks()).length || receiptCursor(p.core) !== before)
		throw new Error("未核对到失败复制的准备记录或零模型请求");
	const root = "/workspace/inbox/tasks/";
	const stagingGone = !existsSync(await checkPath(root + ".prepare-" + row.goal_id));
	const noPublishedCopy = !existsSync(await checkPath(root + row.goal_id));
	if (!stagingGone || !noPublishedCopy || !readFileSync(p.local(sourceB)).equals(original) ||
		readFileSync(p.local(sourceA), "utf8") !== "甲：4 项\n")
		throw new Error("失败后附件残留或原件改变");
	await c.close();
	return { stagedFirst, stagingGone, noPublishedCopy, originalsIntact: true, requests: 0 };
}

async function sandboxTask(p: Profile): Promise<Evidence> {
	const failedCopyCleanup = await attachmentCleanup(p);
	const c = await chat(p);
	const module = p.core.module(GoalsModule)!;
	module.executor.stop();
	await c.send("t118-task", taskText, attachments);
	const [task] = await c.tasks();
	if (!task) throw new Error("交办未创建目标");
	const publishedAttachments = verifyCopies(p, task);
	await until(p, "交办入队", () => scheduler(p).get(task.goalId));
	if (p.faux) {
		put(p, task.deliverables[0]!, demo);
		p.faux.respond(programDone(), fauxAssistantMessage("已核对。"));
	}
	module.executor.start();
	const evidence = { goalId: task.goalId, publishedAttachments, failedCopyCleanup };
	try {
		await goalDone(p, task.goalId);
		await until(p, "交付回执", () => p.core.autonomy.effects.get("chat-delivery:" + task.goalId)?.state === "completed");
		const [completed] = await c.tasks();
		const artifact = await p.core.call("butterfly.chat.artifact", { goalId: task.goalId, name: "report.md" }) as { path: string };
		const output = readFileSync(artifact.path), bytes = output.length;
		if (!bytes || !completed?.delivery?.explanation) throw new Error("缺少交付文件或验收说明");
		await c.close();
		return { ...evidence, bytes, explanation: completed.delivery.explanation, report: output.toString("utf8"),
			sessionFile: c.file, artifact: task.deliverables[0] };
	} catch (error) {
		const failure = redact(error instanceof Error ? error.message : String(error), true).slice(0, 350);
		const pauseReason = scheduler(p).get(task.goalId)?.resumeWhen;
		return { ...evidence, failure, pauseReason: pauseReason && redact(pauseReason, true).slice(0, 350) };
	}
}

export function blockedGoalTools(core: Core, goalId: string) {
	return sessionTrace(core, goalId).flatMap(session => session.text.split(/\r?\n/).flatMap(line => {
		try {
			const entry = JSON.parse(line) as { message?: { role?: string; isError?: boolean; toolName?: string; content?: unknown } };
			const result = entry.message;
			if (result?.role !== "toolResult" || !result.isError || typeof result.toolName !== "string") return [];
			const reason = textOf(result.content);
			return /授权|超出.*范围|沙箱.*离线|未获批准|安全策略|不允许|访问受限/.test(reason)
				? [{ tool: result.toolName, reason: redact(reason, true).slice(0, 350) }] : [];
		} catch { return []; }
	}));
}

async function rules(p: Profile): Promise<Evidence> {
	const file = "/workspace/outbox/t118-rule/report.md";
	const input = { name: "核对合成记录", source: "schedule", filter: { scheduleId: "t118-rule" },
		task: "读取 /workspace/inbox/t118-a.txt 和 /workspace/inbox/t118-b.txt，核对总数，写入 " + file + "，然后用 goal_report 的 done 和 note 提交验收说明。",
		actions: ["read", "write", "notify"], delivery: "/workspace/outbox/t118-rule", assess: true };
	const observed = await p.core.call("autonomy.rules.save", { rule: input, mode: "observe" }) as Rule;
	const fire = (triggerKey: string) => p.core.autonomy.scheduleFired({ scheduleId: "t118-rule", triggerKey, at: Date.now(), createdBy: "user" });
	p.faux?.respond(fauxAssistantMessage('{"match":true}'));
	const observation = fire("observe");
	const hit = await until(p, "观察评估", () => {
		const row = p.core.db.get<{ reason: string }>("SELECT reason FROM autonomy_hits WHERE event_id=?", observation);
		return row && row.reason !== "评估进行中" && row;
	});
	if (!hit.reason.startsWith("本来会接")) throw new Error("观察未命中：" + hit.reason);
	await p.core.call("autonomy.rules.save", { id: observed.id, rule: { ...input, assess: false }, mode: "auto" });
	const before = p.notices.length;
	const event = fire("auto");
	if (p.faux) {
		put(p, file, demo);
		p.faux.respond(programDone(), fauxAssistantMessage("已核对。"), context => {
			const last = context.messages.at(-1);
			const material = JSON.parse(last?.role === "user" ? textOf(last.content) : "{}") as { revision: number; evidence_version: number };
			return fauxAssistantMessage(JSON.stringify({ verdict: "done", missing: [], next: "", questions: [],
				revision: material.revision, evidence_version: material.evidence_version }));
		});
	}
	const id = await until(p, "规则立项", () => p.core.db.get<{ id: string }>(
		"SELECT g.id FROM goals g JOIN autonomy_mandates m ON g.mandate_ref='rule:autonomy-'||m.id||'@1' WHERE m.event_id=?", event)?.id);
	await goalDone(p, id);
	await until(p, "规则送达", () => p.core.db.get("SELECT 1 FROM notification_receipts WHERE object_ref=? AND category='done' AND state='sent'", id));
	fire("auto");
	await p.core.autonomy.tick();
	const count = p.notices.length - before;
	const bytes = existsSync(p.local(file)) ? readFileSync(p.local(file)).length : 0;
	if (!bytes || count !== 1) throw new Error("规则缺交付，或通知次数为 " + count);
	return { observed: hit.reason, goalId: id, bytes, notifications: count };
}

async function learning(p: Profile): Promise<Evidence> {
	const c = await chat(p);
	try {
		// Seed a recent user message in the trial session. The planner reads it through the normal session index.
		c.slot.session.sessionManager.appendMessage({ role: "user", content: learningContext, timestamp: Date.now() });
		c.slot.session.refreshContext();
		p.core.settings.update({ butterflyProactivity: "high", butterflyPersona: "lively" });
		await p.idle();
		p.faux?.respond(context => {
			if (!context.messages.some(message => message.role === "user" && textOf(message.content).includes(learningContext)))
				throw new Error("空闲学习规划未读取试跑会话素材");
			return fauxAssistantMessage(JSON.stringify(selfworkPlan));
		}, () => {
			const run = p.core.db.get<{ id: string }>("SELECT id FROM selfwork_runs WHERE source='learning'")!;
			put(p, selfworkDeliverable(run.id), demo);
			return programDone();
		}, fauxAssistantMessage("验收已保存。"), async () => {
			await delay(350);
			const run = p.core.db.get<{ id: string }>("SELECT id FROM selfwork_runs WHERE source='learning' ORDER BY rowid DESC LIMIT 1");
			const row = p.core.db.get<{ state: string }>("SELECT state FROM butterfly_proactive WHERE ref_id=?", "selfwork:" + run?.id);
			if (row?.state !== "generating" || p.core.settings.get().butterflyProactivity !== "high")
				throw new Error("试跑没有等主动聊天生成结束");
			return fauxAssistantMessage("两批记录的差异已经核对好了。");
		});
		const selfwork = p.core.module(SelfworkModule)!;
		await selfwork.tick();
		const run = p.core.db.get<{ id: string; goal_id: string | null; state: string; reason: string | null; plan: string | null }>(
			"SELECT id,goal_id,state,reason,plan FROM selfwork_runs WHERE source='learning' ORDER BY rowid DESC LIMIT 1");
		if (!run?.goal_id) throw new Error("学习未立项：" + (run?.reason ?? run?.state ?? "无规划记录"));
		const goal = await goalDone(p, run.goal_id);
		const memory = await until(p, "学习来源记忆", () => p.core.db.get("SELECT 1 FROM memory_sources WHERE ref=? AND kind='learning'", run.goal_id));
		const plan = JSON.parse(run.plan ?? "{}") as { share?: boolean };
		const proactive = plan.share ? await until(p, "学习主动聊天", () => {
			const row = p.core.db.get<{ state: string; reason: string | null }>("SELECT state,reason FROM butterfly_proactive WHERE ref_id=?", "selfwork:" + run.id);
			return row && isProactiveTerminal(row.state) ? row : undefined;
		}) : { state: "未申请", reason: "学习计划的 share 未开启" };
		return { contextSeededWithoutRequest: true, goalId: run.goal_id, planId: run.id, memory: !!memory, delivery: goal.selfwork?.delivery,
			proactive, failure: proactive.state === "sent" ? undefined : "主动聊天未送达：" + (proactive.reason ?? proactive.state) };
	} finally {
		p.core.settings.update({ butterflyProactivity: "low" });
		await c.close();
	}
}

async function personalities(p: Profile): Promise<Evidence> {
	const replies: Record<string, Record<string, string>> = {}, errors: Record<string, string> = {};
	const evidence = () => ({ inputs: personaInputs, replies, errors,
		failure: Object.keys(errors).length || Object.values(replies).some(row => Object.keys(row).length !== personaInputs.length)
			? "性格原始回复未收齐或被截断" : undefined,
		humanReview: p.faux ? "空跑样例" : "待人工判断语气差异" });
	for (const persona of personas) {
		p.core.settings.update({ butterflyPersona: persona });
		const row: Record<string, string> = {};
		replies[persona] = row;
		for (const input of personaInputs) {
			const id = persona + "-" + input.id;
			const stopped = p.stopReason?.();
			if (stopped) { errors[id] = stopped; return evidence(); }
			p.progress?.(`B5 ${PERSONAS[persona].name} · ${input.label} 正在请求`);
			let c: Awaited<ReturnType<typeof chat>> | undefined;
			try {
				c = await chat(p);
				p.faux?.respond(fauxAssistantMessage(input.id === "progress" ? PERSONAS[persona].example
					: input.id === "tired" ? "今天辛苦了。先休息一下，手上的事等缓过来再处理。"
					: "先做一周试点可行。开始前定好试点范围和收集反馈的办法。"));
				const result = await personaReply(p, c, "t118-persona-" + id, input.text);
				row[input.id] = result.text;
				if (result.truncated) errors[id] = "回复达到输出上限";
			} catch (error) {
				errors[id] = redact(error instanceof Error ? error.message : String(error), true);
			} finally { await c?.close(); }
		}
	}
	return evidence();
}

async function recovery(p: Profile, task: Evidence): Promise<Evidence> {
	const file = String(task.sessionFile), artifact = p.local(String(task.artifact)), id = String(task.goalId);
	const before = readFileSync(artifact);
	const c = await chat(p, file);
	p.core.module(GoalsModule)!.executor.stop();
	await c.send("t118-recovery", taskText.replace("report.md", "resume.md"), attachments);
	const queued = (await c.tasks()).find(row => row.goalId !== id);
	if (!queued) throw new Error("未建立重启检查目标");
	const publishedAttachments = verifyCopies(p, queued);
	await until(p, "重启目标入队", () => p.core.db.get("SELECT 1 FROM goal_intents WHERE goal_id=? AND action='run' AND status='pending'", queued.goalId));
	await p.restart();
	const after = scheduler(p).detail(queued.goalId);
	if (after.reason !== "restart_check" || !before.equals(readFileSync(artifact))) throw new Error("重启核对状态或已有产物不一致");
	const reloaded = await chat(p, file);
	await reloaded.send("t118-recovery", taskText.replace("report.md", "resume.md"), attachments);
	if ((await reloaded.tasks()).length !== 2) throw new Error("重连重发重复立项");
	if (p.faux) {
		put(p, queued.deliverables[0]!, demo);
		p.faux.respond(programDone(), fauxAssistantMessage("重启后核对完成。"));
	}
	await p.core.call("goals.control", { id: queued.goalId, action: "resume" });
	await goalDone(p, queued.goalId);
	await until(p, "恢复后的交付回执", () => p.core.autonomy.effects.get("chat-delivery:" + queued.goalId)?.state === "completed");
	if (!readFileSync(p.local(queued.deliverables[0]!)).length || !before.equals(readFileSync(artifact)))
		throw new Error("续跑缺交付文件，或修改了先前产物");
	const deliveries = readFileSync(file, "utf8").split(/\r?\n/).filter(line => line.includes('"dfChatTaskMessage":"chat-delivery:' + id + '"')).length;
	if (deliveries !== 1) throw new Error("重启交付回执次数为 " + deliveries);
	await reloaded.close();
	return { goalId: queued.goalId, statusAfterRestart: after.status, reasonAfterRestart: after.reason, preservedDelivery: deliveries, resumed: true, publishedAttachments,
		deliveryBytes: readFileSync(p.local(queued.deliverables[0]!)).length };
}

type Billing = Pick<LedgerRow, "id" | "purpose" | "slot_id" | "state" | "success" | "requested_at" | "amount" | "currency" | "amount_source" | "price_snapshot" |
	"allowance" | "allowance_unit" | "allowance_source" | "billing_source" | "input" | "output" | "cache_read" | "cache_write" | "error_code">;

function goAllowance(row: Billing) {
	if (row.allowance_source === "provider" && row.allowance_unit === "USD" && row.allowance !== null)
		return { usd: row.allowance, source: "provider" };
	if (row.input === null || row.output === null || row.cache_read === null || row.cache_write !== 0) return null;
	const at = new Date(row.requested_at), day = at.getUTCDay(), hour = at.getUTCHours();
	const peak = day > 0 && day < 6 && (hour >= 1 && hour < 4 || hour >= 6 && hour < 10);
	const usd = (row.input * 0.15 + row.output * 0.60 + row.cache_read * 0.003) * (peak ? 2 : 1) / 1e6;
	return { usd, source: peak ? "public_peak_estimate" : "public_off_peak_estimate" };
}

async function endCase(p: Profile, failed: boolean) {
	if (failed) {
		const { core } = p;
		core.settings.update({ butterflyProactivity: "low" });
		const goals = core.module(GoalsModule)!;
		goals.executor.stop();
		for (const item of goals.scheduler.list(undefined, 100)) {
			if (item.kind === "goal" && !["completed", "failed", "cancelled"].includes(item.status)) goals.scheduler.control(item.id, "cancel");
		}
		await Promise.allSettled(core.sessionSlots().map(slot => core.closeSlot(slot.slotId)));
		if (!p.stopReason?.()) goals.executor.start();
	}
	const deadline = Date.now() + 5_000;
	while (p.meter().pending && Date.now() < deadline) await delay(50);
}

export async function exercise(p: Profile, selected?: readonly TrialCase[]) {
	put(p, sourceA, "甲：4 项\n");
	put(p, sourceB, "乙：3 项\n");
	const results: { name: string; passed: boolean; error?: string; [field: string]: unknown }[] = [];
	let task: Evidence | undefined;
	const cases: [TrialCase, string, () => Promise<Evidence>][] = [
		["B2", "对话交办", async () => {
			const result = await sandboxTask(p);
			if (!result.failure) task = result;
			return result;
		}],
		["B3", "规则观察与自动交付", () => rules(p)],
		["B4", "空闲学习、记忆和主动聊天", () => learning(p)],
		["B5", "四种性格", () => personalities(p)],
		["B6", "报价与重启", () => recovery(p, task!)],
	];
	let halt: string | undefined;
	for (const [id, label, run] of cases) {
		if (selected && !selected.includes(id)) continue;
		const name = id + " " + label;
		const stop = halt ?? p.stopReason?.() ?? (name.startsWith("B6") && !task ? "需要 B2 的交付回执" : undefined);
		if (stop) {
			results.push({ name, passed: false, skipped: true, error: stop, requests: 0, rounds: 0, transportRequests: 0 });
			continue;
		}
		p.startMeter();
		const rowid = receiptCursor(p.core);
		const spendingRow = p.core.db.get<{ n: number }>("SELECT coalesce(max(rowid),0) n FROM autonomy_spending")!.n;
		const started = Date.now();
		p.progress?.(name + " 开始");
		let evidence: Evidence | undefined, error: string | undefined;
		try {
			evidence = await run();
			if (typeof evidence.failure === "string") error = evidence.failure;
		} catch (cause) {
			error = redact(cause instanceof Error ? cause.message : String(cause), true).slice(0, 350);
		}
		try { await endCase(p, !!error); }
		catch (cause) { halt = redact(cause instanceof Error ? cause.message : String(cause), true).slice(0, 350); error ??= halt; }
		if (id === "B4" && error) {
			const proactive = p.core.db.get<{ state: string }>(`SELECT p.state FROM butterfly_proactive p
				JOIN selfwork_runs r ON p.ref_id='selfwork:' || r.id WHERE r.source='learning' ORDER BY r.rowid DESC LIMIT 1`);
			if (proactive && !isProactiveTerminal(proactive.state)) halt = "学习主动聊天尚未结束，停止后续场景";
		}
		if (name.startsWith("B2") && error && evidence && typeof evidence.goalId === "string")
			evidence.blockedTools = blockedGoalTools(p.core, evidence.goalId);
		const bills = p.core.db.all<Billing>(
			"SELECT id,purpose,slot_id,state,success,requested_at,amount,currency,amount_source,price_snapshot,allowance,allowance_unit,allowance_source,billing_source,input,output,cache_read,cache_write,error_code FROM request_ledger WHERE rowid>? ORDER BY rowid", rowid);
		const meter = p.meter();
		if (meter.pending) { halt = "仍有渠道请求未结算，停止后续项目"; error ??= halt; }
		const sentIds = new Set(meter.transportReceipts?.filter(row => row.transport).map(row => row.ledgerId));
		const channelBills = p.faux ? bills : bills.filter(row => sentIds.has(row.id));
		const ledgerOnly = p.faux ? [] : bills.filter(row => !sentIds.has(row.id)).map(row => row.id);
		const unmatchedTransmissions = p.faux ? 0 : meter.transportRequests - channelBills.length;
		const usd = channelBills.reduce((sum, row) => sum + (row.currency === "USD" ? row.amount ?? 0 : 0), 0);
		const reported = unmatchedTransmissions === 0 && channelBills.every(row => row.amount !== null && row.currency === "USD" &&
			["provider_actual", "plan_occupancy"].includes(row.amount_source));
		const allowance = p.faux ? [] : channelBills.map(goAllowance);
		const allowanceUsd = allowance.reduce((sum, row) => sum + (row?.usd ?? 0), 0);
		const autonomous = p.core.db.all<{ source: string; usd: number }>("SELECT source,total(cost_usd) usd FROM autonomy_spending WHERE rowid>? GROUP BY source", spendingRow);
		const goal = p.core.db.get<{ usd: number }>(
			"SELECT total(g.cost) usd FROM goal_ledger g JOIN request_ledger r ON r.id=g.request_id WHERE r.rowid>? AND g.state='settled'", rowid)!.usd;
		results.push({ name, passed: !error, evidence: evidence && Object.fromEntries(Object.entries(evidence)
			.filter(([key]) => key !== "sessionFile")), error, elapsedMs: Date.now() - started,
			rounds: countedRuns(p.core, rowid), requests: bills.length, ...meter,
			reportedCostUsd: p.faux ? 0 : reported ? usd : null, knownLedgerUsd: usd,
			goAllowanceUsd: !unmatchedTransmissions && allowance.length && allowance.every(Boolean) ? allowanceUsd : null,
			knownGoAllowanceUsd: allowanceUsd, missingGoAllowance: unmatchedTransmissions + allowance.filter(row => !row).length,
			goAllowanceSources: [...new Set(allowance.flatMap(row => row ? [row.source] : []))],
			unknownPrice: unmatchedTransmissions + channelBills.filter(row => row.price_snapshot === null).length,
			missingAmount: unmatchedTransmissions + channelBills.filter(row => row.amount === null).length,
			amountSources: [...new Set(channelBills.map(row => row.amount_source))],
			requestReconciliation: { ledgerOnly, unmatchedTransmissions },
			applicationBudget: { goalUsd: goal, autonomous }, billing: bills });
		p.progress?.(name + " " + (error ? "未通过（" + error + "）" : "完成") + "，真实渠道请求 " + meter.transportRequests +
			"，试跑预算计入 USD " + meter.reservedOrEstimatedUsd.toFixed(6));
	}
	return results;
}

export function configureProfile(p: Profile): void {
	p.core.settings.update({ butterflyProactivity: "low", patrolQuietEnabled: false, notifications: true,
		sandboxOnline: false, autoTitle: false, memoryAutoExtract: false, memoryEnabled: true, goalProposalEnabled: false });
	if (p.faux) {
		p.core.sandboxProvider = () => ({ distro: "DF-T118-dry", ready: async () => {}, online: () => false });
		p.core.autonomy.sandboxFile = async path => p.local(path);
		p.core.module(ButterflyModule)!.local = path => p.local(path);
		const resolve = p.core.resolveModel;
		p.core.resolveModel = model => {
			const chosen = resolve(model);
			return chosen.provider === "faux" ? { ...chosen, cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 } } : chosen;
		};
	}
}
