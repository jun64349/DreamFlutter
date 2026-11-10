import { randomUUID } from "node:crypto";
import { Core, RpcError, requireStr, str, type CoreModule } from "../core.ts";
import { parseJson } from "../db.ts";
import { redact } from "../security/redaction.ts";
import { MemoryModule } from "./memory.ts";
import { TasksModule } from "./tasks.ts";

export interface AttentionItem {
	id: string; kind: string; group: "now" | "later"; title: string; reason: string;
	origin: { role: "workbench" | "butterfly"; sessionName: string | null; sessionFile: string | null; slotId: string | null; cwd: string | null };
	target: { page: string; sessionFile: string | null; slotId: string | null; itemId: string };
	actions: string[]; data: Record<string, unknown>;
}
export interface ActionReceipt {
	id: string; itemId: string; status: "pending" | "applied" | "cancelled" | "failed";
	undoable: boolean; undoUntil: number | null; remainingMs: number; result?: unknown; error?: string;
}
interface Action {
	receipt: ActionReceipt; action: string; response?: Record<string, unknown>;
	timer?: NodeJS.Timeout; executing?: Promise<void>;
}
const SOURCE_EVENTS = new Set(["confirm.changed", "notices.changed", "proposals.changed", "memory.changed", "schedules.changed", "tasks.changed", "run.finished", "runs.changed"]);

/** A projection over owner queues. Only the short cancellation window is owned here. */
export class AttentionModule implements CoreModule {
	private readonly core: Core;
	private readonly tasks: TasksModule;
	private readonly actions = new Map<string, Action>();
	private closing = false;
	private queued = false;
	private unsubscribe: (() => void) | undefined;
	constructor(core: Core, tasks: TasksModule) {
		this.core = core; this.tasks = tasks;
		core.register("attention.list", () => this.list());
		core.register("attention.resolve", p => this.resolve(requireStr(p.id, "id"), requireStr(p.action, "action"), p.response as Record<string, unknown> | undefined));
		core.register("attention.undo", p => this.undo(requireStr(p.id, "id")));
		core.register("attention.receipt", p => this.receipt(requireStr(p.id, "id")));
		core.beforeShutdown(() => this.flush());
	}
	start(): void {
		this.unsubscribe = this.core.onBroadcast(message => {
			if (!SOURCE_EVENTS.has(String(message.event))) return;
			if (message.event === "notices.changed" && message.notice) {
				const n = message.notice as Record<string, unknown>, slot = this.core.slots.get(String(n.slotId));
				// The original notice owner still delivers its legacy toast; do not deliver it twice.
				if (slot?.sandboxed) this.core.notifications.publish("butterfly.waiting", { title: "蝶君有件事等你决定", body: String(n.title), target: { page: "attention", slotId: slot.slotId, sessionFile: slot.info().sessionFile, itemId: String(n.id), runId: slot.currentRun?.id } }, { legacyFallback: false });
			}
			if (!this.queued && !this.closing) {
				this.queued = true;
				queueMicrotask(() => { this.queued = false; if (!this.closing) this.changed(); });
			}
		});
	}
	stop(): void { this.unsubscribe?.(); }

	private sourceItems(): Record<string, unknown>[] {
		const rows = this.tasks.inbox();
		// The old window capped dialogs/notices. The unified inbox must include every pending row.
		const keyed = new Map(rows.map(r => [`${r.kind}:${r.id}`, r]));
		for (const c of this.core.confirmations.list({ status: "pending", limit: 2_147_483_647 })) {
			const kind = c.kind === "approval" ? "approval" : c.kind === "trust" ? "trust" : "question";
			keyed.set(`${kind}:${c.id}`, { kind, id: c.id, title: c.title, createdAt: c.createdAt, cwd: c.cwd, sessionFile: c.sessionFile, slotId: c.slotId, data: c.request });
		}
		for (const n of this.core.db.all<Record<string, unknown>>("SELECT * FROM notices WHERE status='pending'")) {
			keyed.set(`limit:${n.id}`, { kind: "limit", id: n.id, title: n.title, body: n.body, createdAt: n.created_at, cwd: n.cwd, sessionFile: n.session_file, slotId: n.slot_id, data: { kind: n.kind } });
		}
		for (const r of this.core.db.all<{id: string}>("SELECT id FROM runs WHERE status='interrupted' AND acknowledged=0")) {
			const run = this.core.runs.get(r.id)!;
			keyed.set(`interrupted:${r.id}`, { kind: "interrupted", id: r.id, title: run.prompt ?? "被中断的任务", createdAt: run.startedAt, cwd: run.cwd, sessionFile: run.sessionFile, data: run });
		}
		return [...keyed.values()].sort((a,b) => Number(b.createdAt) - Number(a.createdAt));
	}
	private items(): AttentionItem[] {
		return this.sourceItems().map(row => {
			const kind = String(row.kind), id = String(row.id);
			let data = (row.data ?? {}) as Record<string, unknown>;
			let title = String(row.title ?? "");
			let sessionFile = str(row.sessionFile) ?? null;
			let reason = str(row.body) ?? str(data.message) ?? "";
			if (kind === "approval") {
				title = title.split(/\n\s*\n/).slice(1).join("\n").split("\n")[0] || title;
				reason ||= "这项操作需要你批准";
			} else if (kind === "question") reason ||= "需要你的回答才能继续";
			else if (kind === "trust") reason ||= "工作区的项目配置需要你确认信任";
			else if (kind === "interrupted") reason ||= "上次运行中断，尚未选择继续或结束";
			if (kind === "proposal") {
				const proposal = this.core.db.get<{payload: string; source_session: string | null; kind: string}>("SELECT payload,source_session,kind FROM proposals WHERE id=?", id);
				const payload = parseJson<Record<string, unknown>>(proposal?.payload, {});
				reason = str(payload.reason) ?? (proposal?.kind === "mcp" ? "连接此服务需要你确认" : "采用此技能需要你确认");
				sessionFile = proposal?.source_session ?? null;
				data = { proposalKind: proposal?.kind, payload };
			} else if (kind === "memory") {
				const pending = this.core.module(MemoryModule)?.store.getPending(id);
				if (pending) { data = { ...pending }; reason = pending.reason ?? (pending.why === "promote_global" ? "这条记忆将用于其他项目" : "这条记忆需要你确认"); sessionFile = pending.sessionRef; }
			}
			const slotId = str(row.slotId) ?? null;
			const slot = slotId ? this.core.sessionSlots().find(s => s.slotId === slotId) : sessionFile ? this.core.findSlotByFile(sessionFile) : undefined;
			const indexed = sessionFile ? this.core.db.get<{name:string|null;first_message:string|null;cwd:string|null}>("SELECT name,first_message,cwd FROM session_meta WHERE path=?",sessionFile) : undefined;
			const cwd = str(row.cwd) ?? slot?.cwd ?? indexed?.cwd ?? null;
			const sessionName = slot?.info().sessionName ?? indexed?.name ?? indexed?.first_message?.slice(0,80) ?? null;
			const role = (slot?.sandboxed || cwd && this.core.paths.butterflyDir.toLowerCase() === cwd.toLowerCase()) ? "butterfly" as const : "workbench" as const;
			const group = ["memory", "proposal", "schedule"].includes(kind) ? "later" as const : "now" as const;
			const actions = ["memory", "proposal", "schedule"].includes(kind) ? ["allow", "reject"] : ["limit", "interrupted"].includes(kind) ? ["continue", "end"] : data.method === "confirm" ? ["allow", "reject"] : ["approval", "trust"].includes(kind) ? ["allow", "reject", "answer"] : ["answer", "reject"];
			return { id: `${kind}:${id}`, kind, group, title: title.split("\n")[0]!.slice(0,180), reason, origin: { role, sessionName, sessionFile, slotId, cwd }, target: { page: kind === "memory" ? "memory" : kind === "proposal" ? "library" : "chat", sessionFile, slotId, itemId: id }, actions, data };
		});
	}
	list() {
		const hidden = new Set([...this.actions.values()].filter(a => a.receipt.status === "pending").map(a => a.receipt.itemId));
		const items = this.items().filter(i => !hidden.has(i.id));
		const now = items.filter(i => i.group === "now"), later = items.filter(i => i.group === "later");
		return { now, later, counts: { now: now.length, later: later.length, total: items.length }, pending: [...this.actions.values()].filter(a => a.receipt.status === "pending").map(a => this.view(a)) };
	}
	private view(a: Action): ActionReceipt {
		const remainingMs = a.receipt.status !== "pending" || a.executing || a.receipt.undoUntil === null ? 0 : Math.max(0, a.receipt.undoUntil - Date.now());
		return { ...a.receipt, remainingMs, undoable: a.receipt.status === "pending" && !a.executing && remainingMs > 0 };
	}
	receipt(id: string): ActionReceipt { const a = this.actions.get(id); if (!a) throw new RpcError("not_found", "没有这次处理记录"); return this.view(a); }
	async resolve(id: string, action: string, response?: Record<string, unknown>): Promise<ActionReceipt> {
		if (this.closing) throw new RpcError("unavailable", "后台正在退出");
		if ([...this.actions.values()].some(a => a.receipt.itemId === id && a.receipt.status === "pending")) throw new RpcError("conflict", "这项正在处理");
		const item = this.items().find(i => i.id === id);
		if (!item) throw new RpcError("gone", "这项已经处理过了");
		if (!item.actions.includes(action)) throw new RpcError("bad_request", "这项不支持这个操作");
		if (response !== undefined && (!response || typeof response !== "object" || Array.isArray(response))) throw new RpcError("bad_request", "回答格式无效");
		if (action === "answer" && (typeof response?.value !== "string" || item.data.method === "select" && !(item.data.options as unknown[] | undefined)?.includes(response.value))) throw new RpcError("bad_request", "请提供有效回答");
		const a: Action = { receipt: { id: randomUUID(), itemId: id, status: "pending", undoable: item.group === "later", undoUntil: item.group === "later" ? Date.now() + 5000 : null, remainingMs: item.group === "later" ? 5000 : 0 }, action, response: response ? structuredClone(response) : undefined };
		this.actions.set(a.receipt.id, a);
		this.emit(a); this.changed();
		if (item.group === "later") a.timer = setTimeout(() => void this.execute(a), 5000);
		else await this.execute(a);
		this.prune();
		return this.view(a);
	}
	undo(id: string): ActionReceipt {
		const a = this.actions.get(id);
		if (!a || !this.view(a).undoable) throw new RpcError("gone", "这次处理已经生效，不能撤销");
		clearTimeout(a.timer); a.receipt.status = "cancelled";
		this.emit(a); this.changed(); return this.view(a);
	}
	private async apply(item: AttentionItem, a: Action): Promise<unknown> {
		const id = item.target.itemId, allow = a.action === "allow";
		switch (item.kind) {
			case "approval": case "question": case "trust":
				return this.core.call("confirm.answer", { id, response: item.data.method === "confirm" ? { confirmed: allow } : a.action === "answer" ? { value: a.response!.value } : allow && item.data.method === "select" ? { value: (item.data.options as string[])[0] } : { cancelled: true } });
			case "limit": return this.core.call("notices.resolve", { id, action: a.action === "continue" ? "continue" : "stop" });
			case "memory": return this.core.call(allow ? "memory.acceptPending" : "memory.rejectPending", { id });
			case "proposal": return this.core.call(allow ? "proposals.accept" : "proposals.reject", { id });
			case "schedule": return this.core.call("schedules.setStatus", { id, status: allow ? "active" : "rejected" });
			case "interrupted": {
				if (a.action === "continue") {
					if (!item.origin.sessionFile || !item.origin.cwd) throw new RpcError("gone", "这个任务的对话已经不在了");
					const slot = await this.core.openSlot({ sessionFile: item.origin.sessionFile, cwd: item.origin.cwd });
					await slot.prompt("请从刚才停下的地方继续，完成剩下的部分。");
				}
				this.core.runs.acknowledge(id); this.core.broadcast({ event: "runs.changed" }); return { ok: true };
			}
			default: throw new RpcError("bad_request", "尚不支持处理这项");
		}
	}
	private execute(a: Action): Promise<void> {
		if (a.executing) return a.executing;
		if (a.receipt.status !== "pending") return Promise.resolve();
		clearTimeout(a.timer);
		a.executing = (async () => {
			try {
				const item = this.items().find(i => i.id === a.receipt.itemId);
				if (!item) throw new RpcError("gone", "这项已经由其他入口处理或失效");
				a.receipt.result = await this.apply(item, a); a.receipt.status = "applied";
			} catch (error) {
				a.receipt.status = "failed"; a.receipt.error = redact(error instanceof Error ? error.message : String(error), true);
				this.core.log.warn(`attention action ${a.receipt.id} failed`, error);
			}
			this.emit(a); this.changed(); this.prune();
		})();
		return a.executing;
	}
	private changed(): void { if (!this.closing) this.core.broadcast({ event: "attention.changed", counts: this.list().counts }); }
	private emit(a: Action): void { this.core.broadcast({ event: "attention.action", receipt: this.view(a) }); }
	private prune(): void { for (const [id,a] of this.actions) { if (this.actions.size <= 500) break; if (a.receipt.status !== "pending") this.actions.delete(id); } }
	private async flush(): Promise<void> {
		this.closing = true;
		for (const a of this.actions.values()) if (a.receipt.status === "pending" && a.receipt.undoUntil !== null) {
			this.core.log.info(`attention: shutdown applies confirmed action ${a.receipt.id} (${a.receipt.itemId})`);
			await this.execute(a);
		}
	}
}
