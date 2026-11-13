import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, posix } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { RpcError, requireStr, type Core } from "../../core.ts";
import { parseJson } from "../../db.ts";
import { recordedSandbox } from "../../pi/host.ts";
import type { Slot } from "../../slots/slot.ts";
import { stableId } from "../autonomy/folders.ts";
import type { Effect } from "../autonomy/effects.ts";
import { SANDBOX_TOOLS } from "../autonomy/rules.ts";
import { GoalsModule } from "../goals.ts";
import { SessionIndex } from "../session-index.ts";
import { chatTask, classifyChatText, deliveryDirectory, goalIdForChat, legacyChatInput, promisedFiles, type ChatInput, type ChatTaskRow } from "./chat-task.ts";
import { isTerminal } from "./types.ts";

const STOP = /^(?:请)?(?:先停(?:一下|下)?|停(?:下来|止|了|吧|一下)?|算了|取消(?:任务)?|别做了)[。！!\s]*$/;
const PROGRESS = /^(?:请问)?(?:现在)?(?:做到哪(?:里|儿)?了|进度(?:怎么样|如何)?|任务怎么样了|还要多久)[？?。\s]*$/;
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
type Command = Record<string, unknown> & { type: string };
type TaskMessage = Message & { dfChatTaskMessage?: string };
type Delivery = { goalId: string; files: string[]; explanation: string; external?: boolean };
type Control = { goalId: string; user: string; reply: string };

export type ChatManifest = { name: string; hash: string; source?: string }[];
type AttachmentStore = {
	prepare(goalId: string, input: ChatInput, prior: ChatManifest | null,
		save: (manifest: ChatManifest) => void, active: () => void): Promise<string[]>;
	discard(goalId: string, manifest: ChatManifest | null, cancelled: boolean): Promise<void>;
};
type Preparation = {
	goal_id: string; session_id: string; session_file: string; input_key: string;
	state: "preparing" | "retry" | "cancelled"; manifest: string | null; cleanup_pending: number;
	created_at: number; stop_key: string | null; stop_text: string | null;
};

export class ButterflyChatWorkflow {
	private readonly core: Core;
	private readonly attachments: AttachmentStore;
	private readonly routing = new Map<string, string>();
	private readonly routes = new Set<Promise<boolean>>();
	private readonly cleanups = new Map<string, Promise<void>>();
	private publisher?: Promise<void>;
	private closing = false;

	constructor(core: Core, attachments: AttachmentStore) {
		this.core = core;
		this.attachments = attachments;
		core.declareBackup({ id: "butterfly-chat-tasks", title: "蝶君对话交办", tables: ["butterfly_chat_tasks", "butterfly_chat_preparations"],
			paths: { butterfly_chat_tasks: { session_file: "path", inputs: "json", deliverables: "json" },
				butterfly_chat_preparations: { session_file: "path", manifest: "json" } },
			onStage(db) { db.run("UPDATE butterfly_chat_preparations SET state='retry' WHERE state='preparing'"); } });
		this.db.run("UPDATE butterfly_chat_preparations SET state='retry' WHERE state='preparing'");
		core.register("butterfly.chat.tasks", p => this.list(requireStr(p.sessionFile, "sessionFile")));
		core.register("butterfly.chat.artifact", p => this.artifact(requireStr(p.goalId, "goalId"), requireStr(p.name, "name")));
	}

	private get db() { return this.core.db; }
	private get scheduler() { return this.core.module(GoalsModule)!.scheduler; }

	route(slot: Slot, command: Command, clientId = "core", structured?: ChatInput): Promise<boolean> {
		const work = this.routePrompt(slot, command, clientId, structured);
		this.routes.add(work);
		return work.finally(() => this.routes.delete(work));
	}

	private async routePrompt(slot: Slot, command: Command, clientId: string, structured?: ChatInput): Promise<boolean> {
		if (this.closing || command.type !== "prompt" || !slot.started || !slot.sandboxed || slot.incognito || slot.unattended ||
			slot.isSideConversation || typeof command.message !== "string") return false;
		const raw = command.message, session = slot.session, manager = session.sessionManager;
		const sessionId = session.sessionId, file = session.sessionFile;
		if (!file) return false;
		const input = structured ?? legacyChatInput(raw);
		if (!input) return false;
		const text = input.text.trim();
		const unadorned = !input.attachments.length && !input.materials.length;
		const stop = unadorned && STOP.test(text), progress = unadorned && PROGRESS.test(text);
		const current = (stop || progress) ? this.current(sessionId, stop) : undefined;
		const preparing = stop ? this.db.get<Preparation>(
			"SELECT * FROM butterfly_chat_preparations WHERE session_id=? AND state='preparing' ORDER BY created_at DESC,rowid DESC LIMIT 1", sessionId) : undefined;
		const idle = this.canAppend(slot, manager);
		const request = !stop && !progress && this.core.settings.get().autonomySources.conversation ? classifyChatText(text) : null;
		if (!stop && !current && !request) return false;
		// Explicit operation IDs survive reconnects. Transport IDs are only local to this connection.
		const messageId = typeof command.operationId === "string" && command.operationId.length > 0 && command.operationId.length <= 256
			? stableId("operation", command.operationId)
			: stableId("transport", clientId, slot.slotId, typeof command.id === "string" ? command.id : Date.now(), raw);
		const ref = stableId("conversation", sessionId, messageId);
		const userKey = "task-user:" + ref, responseKey = "task-answer:" + ref;
		const controlKey = "chat-control:" + ref;
		if (hasMessage(manager, responseKey) || this.routing.get(sessionId) === ref ||
			stop && (this.core.autonomy.effects.get(controlKey) ||
				this.db.get("SELECT 1 FROM butterfly_chat_preparations WHERE stop_key=?", ref))) return true;
		// This session can only register one assignment at a time. An active
		// preparation is newer than any registered task, even if the clock moved.
		if (stop && preparing) {
			this.db.run("UPDATE butterfly_chat_preparations SET state='cancelled',stop_key=?,stop_text=? WHERE goal_id=? AND state='preparing'",
				ref, text, preparing.goal_id);
			if (idle) this.writePreparationStop(this.preparation(preparing.goal_id)!, manager, slot);
			return true;
		}
		if (!current && !request || !idle && (!stop || !current) ||
			Array.isArray(command.images) && command.images.length && !current) return false;
		if (stop && current && (!idle || this.routing.has(sessionId))) {
			const reply = this.stop(current, ref);
			this.core.autonomy.effects.plan(controlKey, current.mandate_id, "chat_control", { goalId: current.goal_id, user: raw, reply });
			return true;
		}
		if (this.routing.has(sessionId)) throw new RpcError("busy", "正在登记这段对话里的交办，请稍后再发");
		this.routing.set(sessionId, ref);
		try {
			if (current) {
				this.appendUser(slot, raw, userKey);
				this.appendAssistant(manager, stop ? this.stop(current, ref) : this.progress(current), responseKey, slot);
				return true;
			}
			if (!request) return false;
			if (request.kind === "needs_scope" || !this.core.sandboxProvider?.()) {
				this.appendUser(slot, raw, userKey);
				this.appendAssistant(manager, request.kind === "needs_scope"
					? "这件事涉及沙箱外的操作。请明确一个本机普通文件的完整路径和要做的动作，我会请你确认。"
					: "蝶君的沙箱还没准备好。准备好后可以再交办。", responseKey, slot);
				return true;
			}
			const goalId = goalIdForChat(stableId("direct", ref));
			const prior = chatTask(this.db, goalId);
			let inputs: string[] = [];
			if (!prior && request.kind === "sandbox") {
				const inputKey = stableId(request.text, JSON.stringify(input.attachments), JSON.stringify(input.materials));
				const previous = this.preparation(goalId);
				if (previous?.input_key && previous.input_key !== inputKey)
					throw new RpcError("conflict", "交办编号已用于另一份内容");
				if (previous?.state === "cancelled") return true;
				this.db.run("INSERT INTO butterfly_chat_preparations(goal_id,session_id,session_file,input_key,state,created_at) VALUES(?,?,?,?,'preparing',?) " +
					"ON CONFLICT(goal_id) DO UPDATE SET state='preparing',cleanup_pending=1,created_at=excluded.created_at",
					goalId, sessionId, file, inputKey, Date.now());
				this.appendUser(slot, raw, userKey);
				try {
					const active = () => this.checkPreparation(goalId);
					await this.cleanups.get(goalId);
					active();
					inputs = await this.attachments.prepare(goalId, input, parseJson<ChatManifest | null>(previous?.manifest, null), manifest => {
						active();
						this.db.run("UPDATE butterfly_chat_preparations SET manifest=? WHERE goal_id=?", JSON.stringify(manifest), goalId);
					}, active);
					active();
					if (!this.canAppend(slot, manager)) throw new Error("交办会话已变化");
					this.registerTask(goalId, sessionId, file, messageId, request, inputs);
				} catch {
					this.db.run("UPDATE butterfly_chat_preparations SET state='retry' WHERE goal_id=? AND state='preparing'", goalId);
					const interrupted = this.preparation(goalId);
					if (interrupted) await this.cleanup(interrupted).catch(error => this.core.log.warn("无法清理交办附件准备目录", error));
					if (interrupted?.state !== "cancelled" && !this.closing && this.canAppend(slot, manager))
						this.appendAssistant(manager, "资料副本没有准备好。这件事还没开工，请重新添加资料后再发。", "task-prepare-failed:" + ref, slot);
					return true;
				}
			} else {
				this.appendUser(slot, raw, userKey);
				if (!prior) this.registerTask(goalId, sessionId, file, messageId, request, inputs);
			}
			this.appendAssistant(manager, request.kind === "external"
				? "交办编号 " + goalId + "。这件事需要操作你指定的本机文件，请先在「等你处理」里确认。"
				: this.startedLine(goalId, request.files), responseKey, slot);
			return true;
		} finally { this.routing.delete(sessionId); }
	}

	private registerTask(goalId: string, sessionId: string, file: string, messageId: string,
		request: NonNullable<ReturnType<typeof classifyChatText>>, inputs: string[]): void {
		if (request.kind === "sandbox") this.checkPreparation(goalId);
		const eventId = this.core.autonomy.conversation({ sessionId, messageId, text: request.text, actor: "user" });
		this.core.autonomy.acceptConversation(eventId, {
			name: request.text.split(/[。！？\n]/)[0]!.slice(0, 140),
			task: request.text.slice(0, 8000),
			scope: request.kind === "external" ? { kind: "external", path: request.path } : { kind: "sandbox" },
			actions: request.kind === "external"
				? request.action === "edit" || request.action === "write" && /覆盖/.test(request.text) ? ["read", request.action] : [request.action]
				: SANDBOX_TOOLS,
		}, { sessionId, sessionFile: file, inputs, files: request.files,
			requiredAction: request.kind === "external" ? request.action : null });
		this.db.run("DELETE FROM butterfly_chat_preparations WHERE goal_id=?", goalId);
	}

	private preparation(goalId: string): Preparation | undefined {
		return this.db.get<Preparation>("SELECT * FROM butterfly_chat_preparations WHERE goal_id=?", goalId);
	}

	private checkPreparation(goalId: string): void {
		if (this.closing || this.core.maintenance || this.preparation(goalId)?.state !== "preparing")
			throw new Error("交办准备已停止");
	}

	private cleanup(row: Preparation): Promise<void> {
		const existing = this.cleanups.get(row.goal_id);
		if (existing) return existing;
		const work = this.attachments.discard(row.goal_id, parseJson<ChatManifest | null>(row.manifest, null), row.state === "cancelled")
			.then(() => { this.db.run("UPDATE butterfly_chat_preparations SET cleanup_pending=0 WHERE goal_id=? AND state=?", row.goal_id, row.state); })
			.finally(() => this.cleanups.delete(row.goal_id));
		this.cleanups.set(row.goal_id, work);
		return work;
	}

	private writePreparationStop(row: Preparation, manager: SessionManager, slot?: Slot): void {
		if (!row.stop_key || row.stop_text === null) return;
		this.writeUser(manager, row.stop_text, "task-user:" + row.stop_key, slot);
		this.appendAssistant(manager, "已停止准备交办。", "task-answer:" + row.stop_key, slot);
		this.db.run("UPDATE butterfly_chat_preparations SET stop_text=NULL WHERE goal_id=?", row.goal_id);
	}

	private async recoverPreparations(): Promise<boolean> {
		let updated = false;
		for (const row of this.db.all<Preparation>(
			"SELECT * FROM butterfly_chat_preparations WHERE state<>'preparing' AND (cleanup_pending=1 OR stop_text IS NOT NULL)")) {
			if (this.routing.has(row.session_id)) continue;
			if (chatTask(this.db, row.goal_id)) {
				this.db.run("DELETE FROM butterfly_chat_preparations WHERE goal_id=?", row.goal_id);
				continue;
			}
			if (row.cleanup_pending && this.core.sandboxProvider?.())
				await this.cleanup(row).catch(error => this.core.log.warn("无法核对交办附件准备目录", error));
			if (!row.stop_text || this.routing.has(row.session_id) || !existsSync(row.session_file)) continue;
			try {
				const slot = this.core.findSlotByFile(row.session_file);
				const manager = slot?.session.sessionManager ?? SessionManager.open(row.session_file);
				if (slot && !this.canAppend(slot, manager)) continue;
				if (manager.getSessionId() !== row.session_id || !recordedSandbox(manager)) continue;
				this.writePreparationStop(row, manager, slot);
				updated = true;
			} catch (error) { this.core.log.warn("无法补记交办准备的停止回执", error); }
		}
		return updated;
	}

	private canAppend(slot: Slot, manager: SessionManager): boolean {
		return this.core.slots.get(slot.slotId) === slot && !this.core.isSlotClosing(slot.slotId) &&
			!slot.running && !slot.compacting && !slot.session.isStreaming && slot.session.sessionManager === manager;
	}

	private startedLine(goalId: string, files: string[]): string {
		const tone = this.core.settings.get().butterflyPersona;
		const first = { quiet: "开始了，随时能停。", warm: "我开始做了，想停时告诉我就好。",
			crisp: "已开始。说「停」即可停止。", lively: "开工了，想停就喊一声。" };
		return `${first[tone]} 目标 ${goalId}，交付 ${files.join("、")}。`;
	}

	private current(sessionId: string, active: boolean): ChatTaskRow | undefined {
		return this.db.get<ChatTaskRow>(`SELECT c.* FROM butterfly_chat_tasks c LEFT JOIN goals g ON g.id=c.goal_id
			JOIN autonomy_effects e ON e.key='accept:' || c.mandate_id WHERE c.session_id=?
			AND (?=0 OR (c.stopped_at IS NULL AND (g.status NOT IN ('completed','failed','cancelled') OR g.id IS NULL AND e.state IN ('planned','running'))))
			ORDER BY c.created_at DESC,c.rowid DESC LIMIT 1`, sessionId, Number(active));
	}

	private list(file: string) {
		return this.db.all<ChatTaskRow>("SELECT * FROM butterfly_chat_tasks WHERE lower(session_file)=lower(?) ORDER BY created_at DESC,rowid DESC", file)
			.map(row => this.view(row));
	}

	private view(row: ChatTaskRow) {
		const goal = this.scheduler.get(row.goal_id);
		const receipt = this.core.autonomy.effects.get(`chat-delivery:${row.goal_id}`);
		const delivery = parseJson<Delivery | null>(receipt?.payload, null);
		const effect = this.core.autonomy.effects.get(`accept:${row.mandate_id}`);
		const mandate = this.db.get<{ approval_id: string | null; definition: string }>("SELECT approval_id,definition FROM autonomy_mandates WHERE id=?", row.mandate_id);
		const definition = parseJson<{ name?: string; task?: string }>(mandate?.definition, {});
		return {
			goalId: row.goal_id, status: goal?.status ?? (row.stopped_at ? "cancelled" :
				effect?.state === "failed" || effect?.state === "uncertain" ? effect.state :
				mandate?.approval_id && this.core.confirmations.get(mandate.approval_id)?.status === "pending" ? "waiting_user" : "queued"),
			reason: goal?.resumeWhen ?? (effect?.state === "failed" || effect?.state === "uncertain" ? effect.receipt : null),
			title: goal?.title ?? definition.name ?? null,
			plan: goal?.spec.objective ?? definition.task ?? null, inputs: parseJson<string[]>(row.inputs, []),
			deliverables: promisedFiles(row), createdAt: row.created_at,
			delivery: delivery ? { ...delivery, state: receipt!.state, receipt: receipt!.receipt } : null,
		};
	}

	private progress(row: ChatTaskRow): string {
		const state = this.view(row);
		const label: Record<string, string> = { queued: "排队中", running: "进行中", reviewing: "正在核对交付", waiting_dependency: "正在等待依赖",
			waiting_user: "等你确认或补充信息", completed: "已交付", paused: "已暂停", blocked: "遇到阻塞", failed: "未能完成", uncertain: "结果待核对", cancelled: "已停止" };
		const phase = state.status === "completed" && state.delivery?.state !== "completed"
			? "验收通过，交付回执待核对" : label[state.status] ?? state.status;
		return [`目标 ${row.goal_id}，${phase}。`, state.plan && `计划：${state.plan}`,
			`约定交付：${state.deliverables.join("、")}`, state.reason && state.reason !== row.goal_id && state.reason].filter(Boolean).join("\n");
	}

	private stop(row: ChatTaskRow, ref: string): string {
		const goal = this.scheduler.get(row.goal_id);
		if (goal && !isTerminal(goal.status)) this.scheduler.control(row.goal_id, "cancel", `butterfly-chat:${ref}`);
		this.db.run("UPDATE butterfly_chat_tasks SET stopped_at=? WHERE mandate_id=? AND stopped_at IS NULL", Date.now(), row.mandate_id);
		const approval = this.db.get<{ approval_id: string | null }>("SELECT approval_id FROM autonomy_mandates WHERE id=?", row.mandate_id)?.approval_id;
		if (approval && this.core.confirmations.get(approval)?.status === "pending") {
			this.core.confirmations.closed(approval, "cancelled");
			this.core.broadcast({ event: "confirm.changed", confirmation: this.core.confirmations.get(approval) });
		}
		return `目标 ${row.goal_id} 已停止。`;
	}

	private appendUser(slot: Slot, raw: string, key: string): void {
		this.writeUser(slot.session.sessionManager, raw, key, slot);
	}

	private writeUser(manager: SessionManager, raw: string, key: string, slot?: Slot): void {
		const message: TaskMessage = { role: "user", content: raw, timestamp: Date.now(), dfChatTaskMessage: key };
		this.append(manager, message, key, slot);
	}

	private appendAssistant(manager: SessionManager, text: string, key: string, slot?: Slot): void {
		const message: AssistantMessage & { dfChatTaskMessage: string } = {
			role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "dreamflutter-system",
			model: "butterfly-task-receipt", usage: ZERO, stopReason: "stop", timestamp: Date.now(), dfChatTaskMessage: key,
		};
		this.append(manager, message, key, slot);
	}

	private append(manager: SessionManager, message: TaskMessage, key: string, slot?: Slot): void {
		if (hasMessage(manager, key)) return;
		const entryId = manager.appendMessage(message);
		if (!slot) return;
		slot.session.agent.state.messages = manager.buildSessionProjection().messages;
		slot.lastActivity = Date.now();
		for (const client of this.core.clients) if (client.attached.has(slot.slotId)) {
			try { client.send({ event: "slot.record", slotId: slot.slotId, record: { type: "message_end", message, entryId } }); }
			catch (error) { this.core.log.warn("无法发送交办会话记录", error); }
		}
	}

	publishDeliveries(): Promise<void> {
		return this.publisher ??= this.publish().finally(() => { this.publisher = undefined; });
	}

	async drain(): Promise<void> {
		this.closing = true;
		await Promise.allSettled(this.routes);
		await this.publisher;
	}

	private async publish(): Promise<void> {
		if (this.closing || this.core.maintenance) return;
		let updated = await this.recoverPreparations();
		for (const effect of this.db.all<Effect>("SELECT * FROM autonomy_effects WHERE kind IN ('chat_delivery','chat_control') AND state IN ('planned','running') ORDER BY at,rowid")) {
			const data = parseJson<Delivery | Control>(effect.payload, null as never);
			const row = chatTask(this.db, data.goalId);
			if (!row) continue;
			let slot = this.core.findSlotByFile(row.session_file);
			if (slot && !this.canAppend(slot, slot.session.sessionManager)) continue;
			if ("external" in data && data.external && !this.core.sandboxProvider?.()) continue;
			if (effect.state === "planned" && !this.core.autonomy.effects.claim(effect.key)) continue;
			try {
				if (!existsSync(row.session_file)) throw new Error("交办会话文件已不存在");
				let manager = slot?.session.sessionManager ?? SessionManager.open(row.session_file);
				if (manager.getSessionId() !== row.session_id || !recordedSandbox(manager)) throw new Error("交办会话已改变");
				if ("reply" in data) {
					this.writeUser(manager, data.user, `${effect.key}:user`, slot);
					this.appendAssistant(manager, data.reply, effect.key, slot);
				} else if (!hasMessage(manager, effect.key)) {
					const goal = this.scheduler.get(data.goalId);
					const auth = goal && this.core.autonomy.checkGoal(goal);
					if (!auth?.ok) {
						this.core.autonomy.effects.finish(effect.key, "failed", auth?.reason ?? "交办目标不存在");
						continue;
					}
					if (data.external) {
						await this.writeExternalReceipt(data, () => this.core.autonomy.checkGoal(goal!).ok);
						if (this.core.maintenance || !this.core.autonomy.checkGoal(goal!).ok) continue;
						slot = this.core.findSlotByFile(row.session_file);
						if (slot && !this.canAppend(slot, slot.session.sessionManager)) continue;
						manager = slot?.session.sessionManager ?? SessionManager.open(row.session_file);
						if (manager.getSessionId() !== row.session_id || !recordedSandbox(manager)) throw new Error("交办会话已改变");
					}
					const lines = [`目标 ${data.goalId} 已交付。`, ...data.files,
						`验收说明：${data.explanation}`];
					this.appendAssistant(manager, lines.join("\n"), effect.key, slot);
				}
				this.core.autonomy.effects.finish(effect.key, "completed", "会话已写入回执");
				updated = true;
			} catch {
				this.core.autonomy.effects.finish(effect.key, "uncertain", "交办会话无法核对");
			}
		}
		if (updated) await this.refresh();
	}

	private async writeExternalReceipt(data: Delivery, authorize: () => boolean): Promise<void> {
		const logical = `${deliveryDirectory(data.goalId)}/交付说明.md`;
		const path = await this.core.autonomy.sandboxFile(logical);
		const content = `目标 ${data.goalId}\n\n已核对授权的本机文件和操作回执。\n\n验收说明：${data.explanation}\n`;
		await mkdir(dirname(path), { recursive: true });
		await this.core.autonomy.sandboxFile(logical);
		if (!authorize()) throw new Error("交付授权已收回");
		try { await writeFile(path, content, { encoding: "utf8", flag: "wx" }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const info = await lstat(path);
			if (!info.isFile() || info.nlink !== 1 || info.size !== Buffer.byteLength(content) ||
				await readFile(path, "utf8") !== content) throw new Error("无法核对已存在的交付说明");
		}
	}

	async refresh(): Promise<void> {
		await this.core.module(SessionIndex)?.refresh();
		this.core.broadcast({ event: "sessions.changed" });
	}

	private async artifact(goalId: string, name: string) {
		const row = chatTask(this.db, goalId);
		const goal = row && this.scheduler.get(goalId);
		const logical = posix.join(deliveryDirectory(goalId), name);
		const effect = this.core.autonomy.effects.get(`chat-delivery:${goalId}`);
		const delivered = parseJson<Delivery | null>(effect?.payload, null);
		if (goal?.status !== "completed" || !delivered?.files.includes(logical) ||
			name !== posix.basename(name)) throw new RpcError("not_found", "找不到这项交付文件");
		const path = await this.core.autonomy.sandboxFile(logical);
		const file = await lstat(path);
		if (!file.isFile() || !file.size || file.nlink !== 1) throw new RpcError("not_found", "交付文件已不可用");
		return { name, path, size: file.size };
	}
}

function hasMessage(manager: SessionManager, key: string): boolean {
	return manager.getEntries().some(entry => entry.type === "message" && (entry.message as TaskMessage).dfChatTaskMessage === key);
}
