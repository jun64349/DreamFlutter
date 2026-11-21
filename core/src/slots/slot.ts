import { createAssistantMessageEventStream, getSupportedThinkingLevels, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import { estimateMessage } from "@deepseek-ai/dsh-token-meter/estimate";
import type { CompactionResult as NativeCompactionResult } from "@deepseek-ai/dsh-compaction";
import { randomUUID } from "node:crypto";
import { mkdirSync, openSync, closeSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { inheritedIds, sideConversation } from "../pi/session-metadata.ts";
import { SessionManager, type AgentSession, type AgentSessionEvent, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { AGENT_MODES, type AgentMode, dshCompactionSettings, recordedMode } from "../agent/harness.ts";
import { MINIMAL_PERSONA, workingDirectoryContext } from "../agent/dsh-text.ts";
import type { TodoItem } from "../agent/state.ts";
import type { Db } from "../db.ts";
import { now } from "../db.ts";
import { DshEvents, projectUsage } from "../dsh/events.ts";
import { bindToolProgress } from "../dsh/tool-progress.ts";
import type { AutomaticCompaction, DshSummaryRequest } from "../dsh/compaction.ts";
import { readWireImages, type DshSlotContent } from "../dsh/session-content.ts";
import { buildLegacyDshSeed, DSH_ENTRY, DSH_LEGACY_ENTRY, LEGACY_SOURCE_ENTRY, readLegacySession } from "../dsh/session-legacy.ts";
import { DshWorkbenchHooks } from "../dsh/session-pi-hooks.ts";
import { bindWorkbenchTools } from "../dsh/session-tools.ts";
import type { DshHistoryRef, DshSession } from "../dsh/session.ts";
import { createSessionRuntime, type OpenTarget, type PiHostConfig, recordedSandbox } from "../pi/host.ts";
import { toJsonEvent } from "../pi/json-event.ts";
import { UiBridge, type DialogOutcome, type UiRequest, type UiResponse } from "../pi/ui-bridge.ts";
import { RunRecorder, type Run } from "../runs.ts";
import { exportMarkdown } from "./export.ts";

export interface SlotInfo {
	slotId: string;
	cwd: string;
	sessionFile: string | null;
	sessionId: string | null;
	sessionName: string | null;
	running: boolean;
	compacting: boolean;
	pendingDialogs: number;
	lastActivity: number;
	createdAt: number;
	taskId: string | null;
	/** Opened by the core itself (scheduler) rather than a window. */
	unattended: boolean;
	/** Temporary chat: in memory only, no memory read or write. */
	incognito: boolean;
	/** Side conversation source. Excluded from top-level reattachment even when saved. */
	forkOf: string | null;
	sessionType: "ordinary" | "side";
	willPersist: boolean;
	/** Runs in 蝶君's sandbox. */
	sandbox: boolean;
	model: string | null;
	/** Agent mode of the open session (null while starting). */
	agentMode: AgentMode | null;
	/** Standard mode: plan mode is on. */
	planMode: boolean;
	readOnly?: true;
}

export interface SlotHooks {
	resolveModel?(model: Model<Api>): Model<Api>;
	modelWindow?(model: Model<Api>): number | null;
	/** A record in Pi RPC wire format (event, response or extension UI request). */
	record(slotId: string, record: Record<string, unknown>): void;
	/** Slot state changed (running, dialogs, session file, name…). */
	changed(slot: Slot): void;
	dialogOpened?(slot: Slot, request: UiRequest): void;
	dialogClosed?(slot: Slot, id: string, outcome: DialogOutcome, response?: UiResponse): void;
	runStarted?(slot: Slot, run: Run): void;
	runFinished?(slot: Slot, run: Run): void;
	/** Raw session events for core services (indexing, memory extraction…). */
	event?(slot: Slot, event: AgentSessionEvent): void;
	sessionReplaced?(slot: Slot): void;
	/** A blank session was started in place (`new_session`); apply defaults. */
	sessionCreated?(slot: Slot): Promise<void>;
	/** Another slot has [file] open, or is opening it (one runtime per session file). */
	fileTaken?(slot: Slot, file: string): boolean;
	/** The task a run belongs to when the slot has none yet (chat sessions are tasks too). */
	resolveTaskId?(slot: Slot): string | null;
}

export interface SlotOptions {
	slotId: string;
	target: OpenTarget;
	taskId?: string | null;
	unattended?: boolean;
	/** Mode for new sessions started in this slot. */
	agentMode: AgentMode;
}

type Command = { id?: string; type: string } & Record<string, unknown>;

const DSH_BRANCH_ENTRY = "df.dshBranch";

interface DshBranch {
	owner: string;
	id: string;
	fork?: DshHistoryRef;
	seedProjection?: true;
	summaryIds?: string[];
	summaryId?: string;
}

function dshEntryReference(entry: ReturnType<SessionManager["getEntries"]>[number]): DshHistoryRef | undefined {
	if (entry.type === "message") return dshReference(entry.message);
	return entry.type === "compaction" && entry.details && typeof entry.details === "object" ? dshReference(entry.details) : undefined;
}

export interface DshTaskOptions {
	scopeId: string;
	setupDsh?(ctx: Context): void | Promise<void>;
	dshSystemPrompt?: string;
	dshTools?: readonly string[];
}

/**
 * One live Pi session runtime hosted by the core: the in-process equivalent
 * of a `pi --mode rpc` child. It accepts the same command records and emits
 * the same event/response records, plus a few DreamFlutter extensions
 * (df_* commands) that RPC mode lacks.
 */
export class Slot {
	readonly slotId: string;
	readonly createdAt = now();
	readonly ui: UiBridge;
	readonly unattended: boolean;
	readonly incognito: boolean;
	private readonly initialParent: string | null;
	private firstSend: Promise<string> | undefined;
	private closing = false;
	private readonly acceptedPrompts = new Map<string, string>();
	private readonly sandboxRequested: boolean;
	private boundTaskId: string | null = null;
	private readonly db: Db;
	get taskId(): string | null { return this.isSideConversation ? null : this.boundTaskId; }
	set taskId(value: string | null) {
		if (value && this.isSideConversation) throw new Error("侧边对话不能绑定任务");
		this.boundTaskId = value;
	}
	lastActivity = now();
	/** Text of the last prompt sent (the goal of a chat task). */
	lastPrompt: string | null = null;
	running = false;
	compacting = false;
	/** Mode the next new session in this slot starts in. */
	newSessionMode: AgentMode;
	/** The harness's todo list and plan mode, as last reported. */
	agentState: { todos: TodoItem[] | null; planMode: boolean } = { todos: null, planMode: false };
	private config: PiHostConfig | undefined;
	private legacyPath: string | undefined;
	private runtime!: AgentSessionRuntime;
	private dsh: { session: DshSession; events: DshEvents; content: DshSlotContent; workbench?: DshWorkbenchHooks; id: string; task?: DshTaskOptions } | undefined;
	private dshOpening: Promise<NonNullable<Slot["dsh"]>> | undefined;
	private taskDsh: DshTaskOptions | undefined;
	private dshNavigating = false;
	private appendingProactive = false;
	private dshSendGeneration = 0;
	private dshCompactionAbort?: AbortController;
	private readonly hooks: SlotHooks;
	private readonly recorder: RunRecorder;
	private unsubscribe: (() => void) | undefined;
	private disposed = false;
	private readonly fallbackCwd: string;

	private constructor(db: Db, options: SlotOptions, hooks: SlotHooks) {
		this.slotId = options.slotId;
		this.db = db;
		this.unattended = options.unattended ?? false;
		this.incognito = options.target.inMemory === true;
		this.initialParent = options.target.forkOf ?? null;
		this.taskId = options.taskId ?? null;
		this.sandboxRequested = options.target.sandbox === true;
		this.hooks = hooks;
		this.fallbackCwd = options.target.cwd;
		this.newSessionMode = options.agentMode;
		this.ui = new UiBridge({
			emit: (record) => this.emit(record),
			dialogOpened: (request) => {
				this.hooks.dialogOpened?.(this, request);
				this.hooks.changed(this);
			},
			dialogClosed: (id, outcome, response) => {
				this.hooks.dialogClosed?.(this, id, outcome, response);
				if (!this.disposed) this.hooks.changed(this);
			},
		});
		this.recorder = new RunRecorder(
			db,
			{
				slotId: this.slotId,
				cwd: this.fallbackCwd,
				sessionFile: () => this.sessionOrUndefined?.sessionFile,
				sessionId: () => this.sessionOrUndefined?.sessionId,
				taskId: () => this.isSideConversation ? null : this.taskId ?? (this.taskId = this.hooks.resolveTaskId?.(this) ?? null),
			},
			{
				runStarted: (run) => this.hooks.runStarted?.(this, run),
				runFinished: (run) => this.hooks.runFinished?.(this, run),
			},
		);
	}

	/**
	 * Creates the slot; [start] then creates the Pi runtime. The two steps are
	 * separate so the host can route dialog answers (the trust prompt) to a
	 * slot whose runtime is still starting.
	 */
	static prepare(db: Db, options: SlotOptions, hooks: SlotHooks): Slot {
		return new Slot(db, options, hooks);
	}

	get started(): boolean {
		return (this.runtime as AgentSessionRuntime | undefined) !== undefined;
	}

	async start(config: PiHostConfig, target: OpenTarget): Promise<void> {
		this.config = config;
		try {
			let legacyLeaf: string | null | undefined;
			if (target.sessionFile && config.dshWorkbench?.()) {
				const legacySnapshot = readLegacySession(target.sessionFile);
				if (legacySnapshot) {
					this.legacyPath = target.sessionFile;
					legacyLeaf = legacySnapshot.getLeafId();
					target = { ...target, legacySnapshot };
				}
			}
			this.runtime = await createSessionRuntime(config, { slotId: this.slotId }, this.ui, target);
			if (legacyLeaf !== undefined) {
				if (legacyLeaf === null) this.session.sessionManager.resetLeaf();
				else this.session.sessionManager.branch(legacyLeaf);
				this.session.refreshContext();
			}
		} catch (error) {
			this.ui.cancelAll();
			throw error;
		}
		if (this.isSideConversation && this.boundTaskId) {
			await this.runtime.dispose();
			throw new Error("侧边对话不能绑定任务");
		}
		this.runtime.setRebindSession(async () => {
			this.taskId = null;
			await this.rebind();
			this.hooks.sessionReplaced?.(this);
		});
		await this.rebind();
	}

	get session(): AgentSession {
		return this.runtime.session;
	}

	get readOnlyLegacy(): string | undefined { return this.legacyPath; }

	get nativeSession() { return this.incognito ? undefined : this.dsh?.session.agent.session; }

	get isSideConversation(): boolean {
		return this.started ? !!sideConversation(this.session.sessionManager) : this.initialParent !== null;
	}

	get forkOf(): string | null {
		return this.isSideConversation ? this.sessionOrUndefined?.sessionManager.getHeader()?.parentSession ?? this.initialParent : null;
	}

	/** The session, or undefined while the runtime is still being created. */
	private get sessionOrUndefined(): AgentSession | undefined {
		return (this.runtime as AgentSessionRuntime | undefined)?.session;
	}

	/** A 蝶君 session: its tools run in the sandbox, without approval. */
	get sandboxed(): boolean {
		const session = this.sessionOrUndefined;
		return session ? recordedSandbox(session.sessionManager) : this.sandboxRequested;
	}

	get cwd(): string {
		return this.sessionOrUndefined?.sessionManager.getCwd() ?? this.fallbackCwd;
	}

	get currentRun(): Run | undefined {
		return this.recorder.current;
	}

	/** Counts a subagent's usage and files toward the run in progress. */
	absorbSubagent(usage: Parameters<RunRecorder["absorb"]>[0], files: Iterable<string>): void {
		this.recorder.absorb(usage, files);
	}

	info(): SlotInfo {
		const session = this.sessionOrUndefined;
		const model = session?.model;
		return {
			slotId: this.slotId,
			cwd: this.cwd,
			sessionFile: this.legacyPath ?? session?.sessionFile ?? null,
			sessionId: session?.sessionId ?? null,
			sessionName: session?.sessionName ?? null,
			running: this.running,
			compacting: this.compacting,
			pendingDialogs: this.ui.pendingCount,
			lastActivity: this.lastActivity,
			createdAt: this.createdAt,
			taskId: this.taskId,
			unattended: this.unattended,
			incognito: this.incognito,
			forkOf: this.forkOf,
			sessionType: this.isSideConversation ? "side" : "ordinary",
			willPersist: !this.incognito && !this.legacyPath,
			...(this.legacyPath && { readOnly: true }),
			sandbox: this.sandboxed,
			model: model ? `${model.provider}/${model.id}` : null,
			agentMode: session ? (recordedMode(session.sessionManager) ?? "standard") : null,
			planMode: this.agentState.planMode,
		};
	}

	/** The harness reported a new todo list or plan mode. */
	setAgentState(state: { todos: TodoItem[] | null; planMode: boolean }): void {
		const planChanged = state.planMode !== this.agentState.planMode;
		this.agentState = state;
		this.emit({ type: "df_agent_state", ...state });
		if (planChanged) this.hooks.changed(this);
	}

	/**
	 * Records that bring a client attaching mid-run up to date after it loaded
	 * the completed history: the run start and the partial assistant message.
	 */
	liveSnapshot(): Record<string, unknown>[] {
		if (!this.started || !this.running) return [];
		const records: Record<string, unknown>[] = [{ type: "agent_start" }];
		const partial = this.dsh?.events.streamingMessage ?? this.session.agent.state.streamingMessage;
		if (partial) records.push({ type: "message_start", message: partial });
		return records;
	}

	private emit(record: Record<string, unknown>): void {
		if (this.disposed) return;
		this.hooks.record(this.slotId, record);
	}

	private async bind(runtime: AgentSessionRuntime): Promise<void> {
		const session = runtime.session;
		await session.bindExtensions({
			uiContext: this.ui.context(),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => runtime.newSession(options),
				fork: async (entryId, options) => {
					const result = await runtime.fork(entryId, options);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = runtime === this.runtime && this.hasDshHistory()
						? await this.navigateDshTree(targetId, options) : await runtime.session.navigateTree(targetId, options);
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					if (this.config?.dshWorkbench?.() && readLegacySession(sessionPath)) throw new Error("请单独打开旧会话");
					return runtime.switchSession(sessionPath, options);
				},
				reload: async () => {
					await runtime.session.reload();
				},
			},
			shutdownHandler: () => {},
			onError: (err) => this.emit({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error }),
		});
	}

	private async rebind(): Promise<void> {
		if (this.dsh && this.dsh.id !== this.session.sessionId) {
			await this.dsh.session.dispose();
			this.dsh.content.clear();
			this.dsh = undefined;
			this.taskDsh = undefined;
		}
		await this.bind(this.runtime);
		const session = this.session;
		this.unsubscribe?.();
		this.unsubscribe = session.subscribe((event) => this.onEvent(event));
		this.hooks.changed(this);
	}

	private onEvent(event: AgentSessionEvent): void {
		this.lastActivity = now();
		if (!this.incognito) this.recorder.handle(event);
		let changed = false;
		switch (event.type) {
			case "agent_start":
				changed = !this.running;
				this.running = true;
				break;
			case "agent_settled":
				changed = true;
				this.running = false;
				break;
			case "compaction_start":
				this.compacting = true;
				changed = true;
				break;
			case "compaction_end":
				this.compacting = false;
				changed = true;
				break;
			case "session_info_changed":
				changed = true;
				break;
		}
		this.hooks.event?.(this, event);
		this.emit(toJsonEvent(event));
		// A DSH turn can contain several model requests and long tool batches.
		if (event.type === "message_end" && event.message.role === "assistant" && (!this.dsh || event.message.stopReason !== "error"))
			this.emitContextUsage();
		else if (event.type === "compaction_end" && event.result) this.emitContextUsage();
		if (changed) this.hooks.changed(this);
	}

	private emitContextUsage(): void {
		this.emit({ type: "df_context_usage_changed", contextUsage: this.contextUsage() });
	}

	/** Compacts now (dsh's compactNow: nothing recent kept back), with an optional focus for the summary. */
	async compactNow(customInstructions?: string, regenerateEntryId?: string): Promise<unknown> {
		if (this.legacyPath) throw new Error("旧会话只读，请先选择「继续」");
		if (this.dsh || this.hasDshHistory()) return this.compactDsh(customInstructions, regenerateEntryId);
		await this.refreshModelConfig();
		if (this.closing || this.compacting) throw new Error("会话正在关闭或压缩");
		if (regenerateEntryId && this.running) throw new Error("请等待当前回复结束后重新生成摘要");
		const manager = this.session.sessionManager;
		const checkpoint = regenerateEntryId ? manager.getLeafEntry() : undefined;
		// Pi 1.4.0 cannot compact a branch ending in a compaction. Move to its
		// exact parent BEFORE invoking the public compaction API. branch() does
		// not rewrite entries (unlike navigating to a user message, it keeps it).
		// If later messages exist, retain the existing regeneration path so those
		// messages are not abandoned when fixing the immediate-regeneration case.
		const branchFrom = checkpoint?.type === "compaction" && checkpoint.id === regenerateEntryId ? checkpoint.parentId : undefined;
		if (branchFrom === null) throw new Error("压缩检查点没有可重新生成的原文分支");
		if (branchFrom !== undefined) manager.branch(branchFrom);
		this.compacting = true;
		this.config?.manualCompactions?.add(this.slotId);
		try {
			return await this.session.compact(customInstructions);
		} catch (error) {
			// A failed/cancelled summary appended nothing: restore the previous
			// branch and public finalized context, leaving its checkpoint retryable.
			if (branchFrom !== undefined && manager.getLeafId() === branchFrom) {
				manager.branch(checkpoint!.id);
				this.session.refreshContext();
			}
			throw error;
		} finally {
			this.config?.manualCompactions?.delete(this.slotId);
			this.compacting = false;
			this.hooks.changed(this);
		}
	}

	private async compactDsh(customInstructions?: string, regenerateEntryId?: string): Promise<unknown> {
		if (this.running || this.closing || this.compacting || this.dshOpening || this.dshNavigating) throw new Error("请等待当前会话操作结束");
		this.dshSendGeneration++;
		const controller = new AbortController();
		this.dshCompactionAbort = controller;
		const hooks = this.config?.compaction?.(this);
		const regenerate = regenerateEntryId ? hooks?.takeRegenerate?.() : undefined;
		const kind = regenerateEntryId ? "regenerate" : "manual";
		const began = Date.now();
		this.onEvent({ type: "compaction_start", reason: "manual" });
		let fork: DshBranch | undefined;
		try {
			await this.refreshModelConfig();
			let projection = await this.openDsh();
			const request: DshSummaryRequest = {};
			let note: string | undefined;
			if (regenerateEntryId) {
				const previous = await this.dshRegeneration(projection.session, regenerateEntryId);
				if (previous.branch) {
					fork = previous.branch;
					projection = await this.openDsh(fork);
				}
				request.originals = previous.originals;
				const source = previous.branch || previous.originals ? "original" : "previous_summary";
				hooks?.regenerated?.(source);
				note = `The user reported the previous checkpoint as wrong: ${regenerate?.note ?? "摘要有误"}\n${source === "original" ? "Rebuild it from the original conversation." : "Correct the previous summary using the conversation available above."}`;
			}
			request.focus = [customInstructions?.trim() && `The user asked this checkpoint to focus on: ${customInstructions.trim()}`, note].filter(Boolean).join("\n\n");
			const tokensBefore = projection.session.contextTokens;
			const native = await projection.session.compact(controller.signal, request);
			if (!native) throw new Error("没有可压缩的会话内容");
			if (fork && regenerateEntryId) {
				const manager = this.session.sessionManager;
				const replaced = manager.getEntry(regenerateEntryId);
				if (replaced?.parentId) manager.branch(replaced.parentId);
				manager.appendCustomEntry(DSH_BRANCH_ENTRY, fork);
			}
			const result = this.projectDshCompaction(projection.session, projection.events, native, kind, tokensBefore, began);
			this.onEvent({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (fork && this.dsh?.session.agent.id === fork.id) {
				const failed = this.dsh;
				this.dsh = undefined;
				await failed.session.dispose();
				failed.content.clear();
			}
			hooks?.record?.({ kind, outcome: "failed", reason: message, waitMs: Date.now() - began });
			this.onEvent({ type: "compaction_end", reason: "manual", result: undefined, aborted: controller.signal.aborted, willRetry: false, errorMessage: message });
			throw error;
		} finally {
			this.dshCompactionAbort = undefined;
		}
	}

	private async dshRegeneration(session: DshSession, entryId: string): Promise<{ branch?: DshBranch; originals?: DshSummaryRequest["originals"] }> {
		const manager = this.session.sessionManager;
		const checkpoint = manager.getEntry(entryId);
		const ref = checkpoint && dshEntryReference(checkpoint);
		const native = session.agent.session;
		const end = ref && native.eventAt(SessionSeq(ref.seq));
		if (!end || end.type !== "compaction/end" || end.data.error) return {};
		const id = end.data.compactionId;
		const events = native.snapshotEvents();
		const start = events.find(event => event.type === "compaction/start" && event.data.compactionId === id);
		const summary = events.find(event => event.type === "compaction/summary" && event.data.compactionId === id);
		if (!summary || summary.type !== "compaction/summary") return {};
		const replacement = native.eventAt(SessionSeq(summary.seq + 1));
		if (replacement?.type !== "user/message") return {};
		const messages = summary.data.shadowedSeqs.flatMap(seq => {
			const source = native.eventAt(seq);
			const message = source && native.deriveEventMessage(source);
			return message ? [message] : [];
		});
		const writer = await this.dshSummaryModel();
		const limit = (writer?.contextWindow || 128_000) * 0.7;
		if (!messages.length || session.contextTokens + messages.reduce((total, message) => total + estimateMessage(message), 0) > limit) return {};
		if (!this.incognito && manager.getLeafId() === entryId && start?.type === "compaction/start" && start.data.turn === null && start.seq > 0) {
			return { branch: { owner: this.session.sessionId, id: randomUUID(), fork: { id: native.id, seq: start.seq - 1 } } };
		}
		return { originals: new Map([[replacement.data.id, messages]]) };
	}

	private async dshSummaryModel(): Promise<Model<never> | undefined> {
		const model = this.session.model as Model<never> | undefined;
		return model && (await this.config?.compaction?.(this)?.summaryModel?.(model) ?? model);
	}

	private dshCompactionPressure() {
		const model = this.session.model;
		const window = model && (this.hooks.modelWindow ? this.hooks.modelWindow(model) : model.contextWindow);
		if (!this.config?.autoCompaction() || !model || !window) return;
		const forWindow = { contextWindow: window, maxTokens: model.maxTokens };
		const base = dshCompactionSettings(forWindow, true);
		const settings = this.config.compaction?.(this)?.settings?.(forWindow, base) ?? base;
		return { threshold: window - settings.reserveTokens, retain: settings.keepRecentTokens };
	}

	private async autoCompactDsh(request: AutomaticCompaction, events: DshEvents): Promise<boolean> {
		const session = this.dsh?.session;
		if (!session || this.compacting || this.closing) return false;
		const began = Date.now();
		const tokensBefore = session.contextTokens;
		this.onEvent({ type: "compaction_start", reason: request.reason });
		try {
			const native = await request.run();
			const result = native ? this.projectDshCompaction(session, events, native, "normal", tokensBefore, began) : undefined;
			this.onEvent({ type: "compaction_end", reason: request.reason, result, aborted: false, willRetry: !!result && request.reason === "overflow" });
			return !!result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.config?.compaction?.(this)?.record?.({ kind: "normal", outcome: "failed", reason: message, waitMs: Date.now() - began });
			this.onEvent({ type: "compaction_end", reason: request.reason, result: undefined, aborted: false, willRetry: false, errorMessage: message });
			return false;
		}
	}

	private projectDshCompaction(session: DshSession, events: DshEvents, native: NativeCompactionResult,
		kind: "normal" | "manual" | "regenerate", tokensBefore: number, began: number) {
		const summary = native.summary.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
		const manager = this.session.sessionManager;
		const retainedSeqs = new Set<number>(session.agent.session.surface.nodes);
		const imported = this.dshImportedEntries();
		const retained = manager.getBranch().find(entry => {
			if (entry.type !== "message") return false;
			return retainedSeqs.has(dshReference(entry.message)?.seq ?? imported.get(entry.id)?.seq ?? -1);
		});
		const written = session.agent.session.eventAt(native.summarySeq);
		const data = written?.type === "compaction/summary" ? written.data : undefined;
		const writer = data && this.session.modelRuntime.getModel(data.provider, data.model);
		const receipt = session.takeSummaryLedgerReceipt();
		const usage = data?.usage ? events.usage(data.usage, writer, receipt) : undefined;
		const record = manager.appendCompaction(summary, retained?.id ?? null, tokensBefore, { dfDsh: { id: session.agent.id, seq: native.endSeq } }, false, usage);
		this.session.refreshContext();
		const entry = manager.getEntry(record);
		if (entry) this.onEvent({ type: "entry_appended", entry });
		const estimatedTokensAfter = session.contextTokens;
		this.config?.compaction?.(this)?.record?.({ kind, outcome: "done", tokensBefore, tokensAfter: estimatedTokensAfter, waitMs: Date.now() - began,
			cost: usage?.cost.total, model: data && `${data.provider}/${data.model}` });
		return { summary, firstKeptEntryId: retained?.id ?? "", tokensBefore, estimatedTokensAfter, usage };
	}

	/** Handles one inbound record: a command or an extension UI response. */
	async handle(record: Command, requestScope = "core"): Promise<void> {
		this.lastActivity = now();
		if (record.type === "extension_ui_response") {
			this.ui.answer(record as unknown as UiResponse);
			return;
		}
		if (!this.started) {
			this.emit(failure(record.id, record.type, "会话还在启动中"));
			return;
		}
		try {
			const response = await this.command(record, requestScope);
			if (response) this.emit(response);
		} catch (error) {
			this.emit(failure(record.id, record.type, error instanceof Error ? error.message : String(error)));
		}
	}

	/** Resolves on acceptance, not completion of the model response. */
	private submit(session: AgentSession, message: string, options: Record<string, unknown>): Promise<string> {
		return new Promise((resolve, reject) => {
			let accepted = false;
			session
				.prompt(message, {
					...options,
					source: "rpc",
					preflightResult: (disposition) => {
						accepted = true;
						resolve(disposition);
					},
				})
				.catch((error) => {
					if (!accepted) reject(error);
				});
		});
	}

	private async sendPrompt(message: string, options: Record<string, unknown> = {}): Promise<string> {
		if (this.legacyPath) throw new Error("旧会话只读，请先选择「继续」");
		await this.refreshModelConfig();
		if (this.closing) throw new Error("会话正在关闭");
		if (this.firstSend) throw new Error("侧边对话正在保存并发送，请等待结果");
		this.lastActivity = now();
		this.lastPrompt = message;
		if (!this.isSideConversation || this.incognito || this.session.sessionFile) return this.useDsh()
			? this.sendDsh(message, options.images, typeof options.streamingBehavior === "string" ? options.streamingBehavior : undefined)
			: this.submit(this.session, message, options);
		const operation = this.persistAndSend(message, options);
		this.firstSend = operation;
		try { return await operation; }
		finally { this.firstSend = undefined; }
	}

	private useDsh(): boolean {
		if (process.platform === "win32" && this.sandboxed && !this.unattended && this.config?.dshWorkbench?.()) return true;
		const { sessionManager } = this.session;
		const mode = recordedMode(sessionManager);
		return this.hasDshHistory() || !!this.taskDsh || !!(this.config?.dshWorkbench?.() && !this.sandboxed && !this.unattended &&
			(mode === "minimal" || mode === "standard" && this.config.dshStandardWorkbench?.()) &&
			(this.incognito || this.isSideConversation || !sessionManager.getEntries().some((entry) => entry.type === "message" && entry.message.role !== "system")));
	}

	hasDshHistory(): boolean {
		return this.dshHistoryKind() !== undefined;
	}

	private selectedDshBranch(): DshBranch | undefined {
		const entry = this.session.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === DSH_BRANCH_ENTRY &&
			(entry.data as DshBranch | undefined)?.owner === this.session.sessionId);
		return entry?.type === "custom" ? entry.data as DshBranch : undefined;
	}

	private dshImportedEntries(): Map<string, DshHistoryRef> {
		const { sessionManager, sessionId } = this.session;
		const references = new Map<string, DshHistoryRef>();
		for (const entry of sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== DSH_LEGACY_ENTRY) continue;
			const data = entry.data as { owner?: string; id: string; references: Record<string, number> } | undefined;
			if (!data || (data.owner ?? data.id) !== sessionId) continue;
			for (const [entryId, seq] of Object.entries(data.references)) references.set(entryId, { id: data.id, seq });
		}
		return references;
	}

	private dshHistoryKind(): "workbench" | "task" | undefined {
		const marker = this.dshHistoryMarker();
		return marker ? marker.kind === "task" ? "task" : "workbench" : undefined;
	}

	private dshHistoryMarker(): { kind?: string; needsSeed?: boolean } | undefined {
		const { sessionManager, sessionId } = this.session;
		const entry = sessionManager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === DSH_ENTRY &&
			(entry.data as { id?: string } | undefined)?.id === sessionId);
		return entry?.type === "custom" ? entry.data as { kind?: string; needsSeed?: boolean } : undefined;
	}

	prepareDshTask(options: DshTaskOptions): boolean {
		if (!this.config?.dshWorkbench?.() || this.incognito || this.isSideConversation || this.closing || this.legacyPath) return false;
		if (this.sandboxed && !this.config.sandbox?.()?.appContainer) return false;
		if (this.taskDsh?.scopeId === options.scopeId) return true;
		if (this.taskDsh || this.running || this.compacting || this.dshOpening || this.dshNavigating || this.session.isStreaming ||
			(this.dsh && this.dsh.session.agent.status !== "idle")) return false;
		if (!this.hasDshHistory() && this.session.sessionManager.getEntries().some(entry => entry.type === "message" && entry.message.role !== "system")) return false;
		this.taskDsh = options;
		this.dshSendGeneration++;
		return true;
	}

	releaseDshTask(scopeId: string): void {
		if (this.taskDsh?.scopeId !== scopeId) return;
		this.taskDsh = undefined;
		this.dshSendGeneration++;
	}

	private dshModel() {
		const { model, thinkingLevel } = this.session;
		if (!model) throw new Error("请先为会话选择模型");
		return { provider: model.provider, model: model.id,
			...(thinkingLevel !== "off" ? { reasoningEffort: ReasoningEffortId(thinkingLevel) } : {}) };
	}

	private async openDsh(overrideBranch?: DshBranch): Promise<NonNullable<Slot["dsh"]>> {
		const task = this.taskDsh;
		if (!task && this.dshHistoryKind() === "task") throw new Error("这个会话由后台任务管理，请从对应任务继续");
		const nativeWorkspace = this.sandboxed ? this.config?.sandbox?.()?.workspaceDir : undefined;
		if (this.sandboxed && (!nativeWorkspace || !this.config?.sandbox?.()?.appContainer)) throw new Error("蝶君的 Windows 工作区还没准备好");
		if (this.dsh && this.dsh.task === task && !overrideBranch) return this.dsh;
		if (this.dshOpening) return this.dshOpening;
		const previous = this.dsh;
		if (previous && previous.session.agent.status !== "idle") throw new Error("请等待当前会话操作结束");
		const root = this.config?.dsh?.();
		const services = this.incognito ? root?.temporary : root;
		if (!services) throw new Error("会话后台没有准备好，请重启 DreamFlutter 后重试");
		const pi = this.session;
		const model = this.dshModel();
		const branch = this.incognito ? undefined : overrideBranch ?? this.selectedDshBranch();
		const id = branch?.id ?? pi.sessionId;
		const hasHistory = this.hasDshHistory();
		const legacy = this.dshHistoryMarker()?.needsSeed === true;
		const resume = !this.incognito && hasHistory && !legacy && (!branch || pi.sessionManager.getBranch().some(entry => dshEntryReference(entry)?.id === id));
		const seedHistory = legacy || !hasHistory && this.isSideConversation || this.incognito || branch?.seedProjection && !resume;
		const standard = !task && recordedMode(pi.sessionManager) === "standard";
		const workbench = standard ? new DshWorkbenchHooks(pi, () => !this.incognito && !this.isSideConversation && this.config?.memoryAvailable?.() !== false,
			(id, prompt) => this.config?.prepareDshInput?.({ slotId: this.slotId }, id, prompt) ?? Promise.resolve()) : undefined;
		const content = services.createContentStore(this.incognito);
		const compactionHooks = () => this.config?.compaction?.(this);
		const events = new DshEvents({
			model: () => pi.model,
			messages: () => pi.messages.filter((message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult"),
			content: (blocks) => content.fromDsh(blocks),
			persist: (message, seq, messageId) => {
				const projected = { ...message, dfDsh: { id, seq, ...(messageId && { messageId }) } };
				const entryId = pi.sessionManager.appendMessage(projected);
				pi.refreshContext();
				const entry = pi.sessionManager.getEntry(entryId);
				if (entry) this.onEvent({ type: "entry_appended", entry });
			},
			emit: (event) => this.onEvent(event),
		});
		this.dshOpening = (async () => {
			// Task tools are installed on the owning Agent scope. A context change
			// reopens the same durable DSH branch with a fresh scope and releases
			// the old registrations before admitting another request.
			if (previous) {
				await previous.session.dispose();
				previous.content.clear();
				if (this.dsh === previous) this.dsh = undefined;
			}
			await services.refreshModels();
			const imported = seedHistory ? await buildLegacyDshSeed(pi.sessionManager, content) : undefined;
			const summaries = (branch?.summaryIds ?? (branch?.summaryId ? [branch.summaryId] : [])).flatMap(id => {
				const entry = pi.sessionManager.getEntry(id);
				return entry?.type === "branch_summary" ? [{ text: entry.summary, time: Date.parse(entry.timestamp) }] : [];
			});
			const session = await services.open({ id, cwd: this.cwd, resume, branch: !!branch, fork: branch?.fork, seed: imported?.events, model, content,
				branchSummaries: summaries,
				ledgerContext: () => ({ ...this.config?.ledgerContext?.({ slotId: this.slotId }), sessionId: pi.sessionId, workspace: this.cwd }),
				modelRuntime: () => pi.modelRuntime,
				compaction: {
					pressure: () => this.dshCompactionPressure(),
					summaryModel: () => this.dshSummaryModel(),
					invalidatedFacts: () => compactionHooks()?.invalidatedFacts?.(),
					baseSystemPrompt: () => workbench?.compactionSystemPrompt,
					automatic: request => this.autoCompactDsh(request, events),
					record: entry => compactionHooks()?.record?.(entry),
					background: {
						enabled: () => compactionHooks()?.background?.enabled() ?? false,
						lead: () => compactionHooks()?.background?.lead() ?? 0.85,
						allowed: () => compactionHooks()?.background?.allowed() ?? false,
						model: async () => {
							const selected = this.session.model as Model<never> | undefined;
							return selected && (await compactionHooks()?.background?.model(selected) ?? selected);
						},
						charge: (usage, writer, receipt) => {
							const billed = events.usage(usage, writer, receipt);
							compactionHooks()?.background?.charge(billed, writer);
							return billed.cost.total;
						},
					},
				},
				setup: async (ctx, agent) => {
					if (workbench) workbench.bind(ctx);
					else ctx.systemPrompt.section({ name: "dreamflutter-workbench", order: 0, interpolate: false, complete: true,
						text: () => {
							const cwd = pi.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "df.cwd");
							const selected = cwd?.type === "custom" ? (cwd.data as { cwd?: string } | undefined)?.cwd : undefined;
							return `${task?.dshSystemPrompt ?? MINIMAL_PERSONA}\n\n${workingDirectoryContext(selected ?? nativeWorkspace ?? this.cwd)}`;
						} });
					bindWorkbenchTools(ctx, pi, content, event => this.onEvent(event), task ? task.dshTools ?? [] :
						standard ? pi.getAllTools().map(tool => tool.name) : undefined, () => this.taskDsh === task);
					bindToolProgress(ctx, agent);
					await task?.setupDsh?.(ctx);
					for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) await content.restore(message.content);
				},
				onEvent: (event) => {
					if (this.appendingProactive) return;
					events.event(event);
					if (event.type === "assistant/attempt") this.emitContextUsage();
				}, onStream: (frame) => events.stream(frame), onStatus: (status) => events.status(status),
				onQueue: (agent) => this.onEvent({ type: "queue_update", ...dshQueue(agent) }), onDiscard: (blocks) => content.release(blocks) });
			if (this.closing || this.session !== pi || this.taskDsh !== task) {
				await session.dispose();
				throw new Error("会话已关闭，未发送消息");
			}
			if (imported) pi.sessionManager.appendCustomEntry(DSH_LEGACY_ENTRY, { owner: pi.sessionId, id, references: imported.references });
			if (!hasHistory || legacy) pi.sessionManager.appendCustomEntry(DSH_ENTRY, { id: pi.sessionId, kind: task ? "task" : "workbench" });
			return this.dsh = { session, events, content, workbench, id: pi.sessionId, task };
		})();
		try { return await this.dshOpening; }
		finally { this.dshOpening = undefined; }
	}

	/** The proactive sender presents one window message. Keep its native history in the same branch. */
	async appendProactiveMessage(message: AssistantMessage & { dfProactiveRef: string }, beginDelivery: () => void): Promise<string> {
		const pi = this.session, manager = pi.sessionManager, leaf = manager.getLeafId();
		if (this.legacyPath) throw new Error("旧会话只读");
		const native = this.useDsh() ? await this.openDsh() : undefined;
		if (this.closing || this.running || this.compacting || this.dshNavigating || this.session !== pi || manager.getLeafId() !== leaf)
			throw new Error("会话已经发生变化");
		this.appendingProactive = true;
		try {
			beginDelivery();
			const ref = native?.session.appendProactive(message);
			const projected = ref ? { ...message, dfDsh: ref } : message;
			const entryId = manager.appendMessage(projected);
			pi.refreshContext();
			return entryId;
		} finally { this.appendingProactive = false; }
	}

	private async sendDsh(message: string, images: unknown, streamingBehavior?: string): Promise<string> {
		if (this.dshNavigating || this.compacting) throw new Error("请等待当前会话操作结束");
		const suppliedImages = readWireImages(images);
		if (!message.trim() && !suppliedImages?.length) throw new Error("消息不能为空");
		const previous = this.session;
		const generation = this.dshSendGeneration;
		const { session, content, workbench } = await this.openDsh();
		const behavior = streamingBehavior === "steer" || streamingBehavior === "followUp" ? streamingBehavior : undefined;
		const input = workbench ? await workbench.input(message, suppliedImages, behavior) : { text: message, images: suppliedImages };
		if (!input) return "handled";
		const blocks = await content.admit(input.text, input.images);
		await this.config?.dsh?.()?.refreshModels();
		try {
			if (this.closing || this.session !== previous) throw new Error("会话已关闭，未发送消息");
			const running = session.agent.status === "running";
			if (running && !behavior) throw new Error("请等待当前回复结束");
			if (!running) await workbench?.prepare(input.text, input.images);
			if (this.dshNavigating || this.compacting || generation !== this.dshSendGeneration || this.dsh?.session !== session) throw new Error("消息发送已取消");
			session.agent.model.select(this.dshModel());
			session.send(blocks, behavior === "steer");
			return running ? "queued" : "started";
		} catch (error) {
			content.release(blocks);
			throw error;
		}
	}

	/** F-01: retain the original runtime until the replacement accepts the first message. */
	private async persistAndSend(message: string, options: Record<string, unknown>): Promise<string> {
		const config = this.config!;
		const original = this.runtime;
		const manager = original.session.sessionManager;
		const dir = SessionManager.create(this.cwd, config.sessionDir).getSessionDir();
		const path = join(dir, `${manager.getHeader()!.timestamp.replace(/[:.]/g, "-")}_${manager.getSessionId()}.jsonl`);
		const key = resolve(path).toLowerCase();
		const controls = new Map(config.harnessControls);
		let candidate: AgentSessionRuntime | undefined;
		let created = false;
		let active = false;
		config.pendingSessionFiles?.add(key);
		try {
			mkdirSync(dir, { recursive: true });
			const fd = openSync(path, "wx");
			created = true;
			try { writeFileSync(fd, [manager.getHeader(), ...manager.getEntries()].map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8"); }
			finally { closeSync(fd); }
			candidate = await createSessionRuntime({ ...config, harnessControls: controls, agentStateChanged: (slot, state) => {
				if (active) config.agentStateChanged?.(slot, state);
			} }, { slotId: this.slotId }, this.ui, { cwd: this.cwd, sessionFile: path, unattended: this.unattended });
			await this.bind(candidate);
			if (this.closing) throw new Error("会话已关闭，未发送消息");
			this.unsubscribe?.();
			this.runtime = candidate;
			this.unsubscribe = candidate.session.subscribe((event) => this.onEvent(event));
			active = true;
			const disposition = await (this.useDsh() ? this.sendDsh(message, options.images) : this.submit(candidate.session, message, options));
			const control = controls.get(this.slotId);
			if (control) config.harnessControls?.set(this.slotId, control);
			// This is not a new conversation: no sessionCreated/sessionReplaced hook.
			candidate.setRebindSession(async () => { this.taskId = null; await this.rebind(); this.hooks.sessionReplaced?.(this); });
			await original.dispose().catch(() => {});
			return disposition;
		} catch (error) {
			active = false;
			this.unsubscribe?.();
			await candidate?.dispose().catch(() => {});
			this.runtime = original;
			this.unsubscribe = original.session.subscribe((event) => this.onEvent(event));
			if (created) rmSync(path, { force: true });
			throw error;
		} finally {
			config.pendingSessionFiles?.delete(key);
			this.hooks.changed(this);
		}
	}

	async prompt(message: string, options: { images?: unknown[] } = {}): Promise<void> {
		await this.sendPrompt(message, { images: options.images, streamingBehavior: this.running || this.session.isStreaming ? "followUp" : undefined });
	}

	async abortActive(): Promise<void> {
		this.dshSendGeneration++;
		if (this.dshNavigating) this.session.abortBranchSummary();
		this.dshCompactionAbort?.abort();
		if (this.dsh) {
			const stopped = this.dsh.session.abort();
			this.ui.cancelAll();
			await stopped;
		}
		else await this.session.abort();
	}

	clearActiveQueue(): ReturnType<AgentSession["clearQueue"]> {
		if (!this.dsh) return this.session.clearQueue();
		const { agent } = this.dsh.session;
		const result = dshQueue(agent);
		agent.inbox.clear();
		return result;
	}

	private async navigateDshTree(entryId: string, options: Parameters<AgentSession["navigateTree"]>[1]): Promise<Awaited<ReturnType<AgentSession["navigateTree"]>>> {
		if (this.running || this.compacting || this.dshOpening || this.dshNavigating) throw new Error("请等待当前会话操作结束");
		const services = this.config?.dsh?.();
		if (!services) throw new Error("会话后台没有准备好");
		this.dshNavigating = true;
		this.dshSendGeneration++;
		const session = this.session;
		const manager = session.sessionManager;
		const oldLeaf = manager.getLeafId();
		const originalStream = session.agent.streamFunction;
		try {
			if (options?.summarize) {
				const complete = this.config?.completeDshBranchSummary;
				if (!complete) throw new Error("分支摘要后台没有准备好");
				session.agent.streamFunction = (model, context, request) => {
					const stream = createAssistantMessageEventStream();
					void complete({ slotId: this.slotId }, session, model, context, { signal: request?.signal, maxTokens: request?.maxTokens }).then(message => {
						const reason = message.stopReason;
						if (reason === "error" || reason === "aborted") stream.push({ type: "error", reason, error: message });
						else if (reason === "pending") stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: "摘要模型没有完成回复" } });
						else {
							stream.push({ type: "start", partial: message });
							stream.push({ type: "done", reason, message });
						}
					}, error => {
						const reason = request?.signal?.aborted ? "aborted" : "error";
						stream.push({ type: "error", reason, error: { role: "assistant", content: [], api: model.api, provider: model.provider,
							model: model.id, usage: projectUsage(undefined, model), stopReason: reason, timestamp: now(),
							errorMessage: error instanceof Error ? error.message : String(error) } });
					});
					return stream;
				};
			}
			const result = await session.navigateTree(entryId, options);
			if (result.cancelled || oldLeaf === manager.getLeafId()) return result;
			if (this.incognito) {
				await this.dsh?.session.dispose();
				this.dsh?.content.clear();
				this.dsh = undefined;
				return result;
			}
			const imported = this.dshImportedEntries();
			const branch = manager.getBranch();
			const anchor = branch.findLast(entry => dshEntryReference(entry) !== undefined || imported.has(entry.id));
			const ref = anchor ? dshEntryReference(anchor) ?? imported.get(anchor.id) : undefined;
			// A summary is a new piece of history. Fork even at the tip so revisiting
			// the old branch does not inherit the summary of the branch being left.
			const afterAnchor = anchor ? branch.slice(branch.indexOf(anchor) + 1) : branch;
			const entries = manager.getEntries();
			const legacyBoundary = entries.findIndex(entry => entry.type === "custom" && entry.customType === LEGACY_SOURCE_ENTRY &&
				(entry.data as { sessionId?: string } | undefined)?.sessionId === session.sessionId);
			const legacySummaries = new Set(legacyBoundary === -1 ? [] : entries.slice(0, legacyBoundary).filter(entry => entry.type === "branch_summary").map(entry => entry.id));
			const summaryIds = afterAnchor.filter(entry => entry.type === "branch_summary" && !legacySummaries.has(entry.id)).map(entry => entry.id);
			const seedProjection = !ref && legacyBoundary !== -1 && branch.some(entry => entry.type === "message" && entry.message.role === "user");
			const next: DshBranch = !summaryIds.length && ref && await services.latestVisibleMessage(ref)
				? { owner: this.session.sessionId, id: ref.id }
				: { owner: this.session.sessionId, id: randomUUID(), ...(ref && { fork: ref }), ...(summaryIds.length && { summaryIds }), ...(seedProjection && { seedProjection: true }) };
			await this.dsh?.session.dispose();
			this.dsh = undefined;
			manager.appendCustomEntry(DSH_BRANCH_ENTRY, next);
			return result;
		} catch (error) {
			if (oldLeaf === null) manager.resetLeaf();
			else manager.branch(oldLeaf);
			this.session.refreshContext();
			throw error;
		} finally {
			session.agent.streamFunction = originalStream;
			this.dshNavigating = false;
		}
	}

	private async replaceAndRebind<T extends { cancelled: boolean }>(operation: () => Promise<T>): Promise<T> {
		if (this.dshOpening || this.dshNavigating || (this.dsh && (this.running || this.compacting))) throw new Error("请等待当前回复结束");
		const sourceFile = this.hasDshHistory() ? this.session.sessionFile : undefined;
		const result = await operation();
		if (!result.cancelled) {
			const manager = this.session.sessionManager;
			if (sourceFile && manager.getHeader()?.parentSession === sourceFile && !this.hasDshHistory()) {
				manager.appendCustomEntry(DSH_ENTRY, { id: this.session.sessionId, kind: "workbench", needsSeed: true });
			}
			// Another session now: its task is looked up (or created) at its next run.
			this.taskId = null;
			await this.rebind();
			this.hooks.sessionReplaced?.(this);
		}
		return result;
	}

	resetPromptRequests(requestScope = "core"): void {
		for (const key of this.acceptedPrompts.keys()) if (key.startsWith(`${requestScope}:`)) this.acceptedPrompts.delete(key);
	}

	/** Apply window/metadata edits while idle; keep a running request's model stable. */
	async refreshModelConfig(): Promise<void> {
		if (!this.started || this.running || this.compacting) return;
		const current = this.session.model;
		if (!current) return;
		const registered = this.session.modelRuntime.getAvailableSnapshot().find((m) => m.provider === current.provider && m.id === current.id);
		if (!registered) return;
		const effective = this.hooks.resolveModel?.(registered) ?? registered;
		if (current.contextWindow !== effective.contextWindow || current.reasoning !== effective.reasoning || JSON.stringify(current.thinkingLevelMap) !== JSON.stringify(effective.thinkingLevelMap)) {
			const thinking = this.session.thinkingLevel;
			await this.session.setModel(effective);
			this.session.setThinkingLevel(thinking);
		}
	}

	private presentModel(model: Model<Api>): Record<string, unknown> {
		const contextWindow = this.hooks.modelWindow ? this.hooks.modelWindow(model) : model.contextWindow;
		return { ...model, contextWindow, thinkingLevels: getSupportedThinkingLevels(model) };
	}

	contextUsage(): ReturnType<AgentSession["getContextUsage"]> | null {
		if (this.dsh && this.session.model) {
			const contextWindow = this.hooks.modelWindow ? this.hooks.modelWindow(this.session.model) ?? 0 : this.session.model.contextWindow;
			const tokens = this.dsh.session.contextTokens;
			return { tokens, contextWindow, percent: contextWindow ? tokens / contextWindow * 100 : 0 };
		}
		const usage = this.session.getContextUsage();
		if (!usage) return null;
		if (this.session.model && this.hooks.modelWindow?.(this.session.model) === null) return { ...usage, contextWindow: 0, percent: 0 };
		return usage;
	}

	private async command(command: Command, requestScope: string): Promise<Record<string, unknown> | undefined> {
		if (this.firstSend && command.type !== "prompt" && !command.type.startsWith("get_")) throw new Error("侧边对话正在保存并发送，请等待结果");
		const id = command.id;
		const session = this.session;
		const str = (key: string) => (typeof command[key] === "string" ? (command[key] as string) : undefined);
		if (this.legacyPath && !command.type.startsWith("get_") && !["df_agent_state", "df_context_usage", "df_tree", "df_branches", "df_navigate_tree"].includes(command.type))
			throw new Error("旧会话只读，请先选择「继续」");
		switch (command.type) {
			case "prompt": {
				const key = `${requestScope}:${JSON.stringify([session.sessionId, id, command.message, command.images])}`;
				if (id && this.acceptedPrompts.has(key)) return ok(id, "prompt", { disposition: this.acceptedPrompts.get(key) });
				const first = this.isSideConversation && !this.incognito && !session.sessionFile;
				const disposition = await this.sendPrompt(String(command.message ?? ""), { images: command.images, streamingBehavior: command.streamingBehavior });
				if (id && first) this.acceptedPrompts.set(key, disposition);
				return ok(id, "prompt", { disposition });
			}
			case "steer":
				if (this.isSideConversation && !this.incognito && !session.sessionFile) throw new Error("请先发送第一条消息");
				if (this.useDsh()) return ok(id, "steer", { disposition: await this.sendDsh(String(command.message ?? ""), command.images, "steer") });
				return ok(id, "steer", { disposition: await session.steer(String(command.message ?? ""), command.images as never, { source: "rpc" }) });
			case "follow_up":
				if (this.isSideConversation && !this.incognito && !session.sessionFile) throw new Error("请先发送第一条消息");
				if (this.useDsh()) return ok(id, "follow_up", { disposition: await this.sendDsh(String(command.message ?? ""), command.images, "followUp") });
				return ok(id, "follow_up", { disposition: await session.followUp(String(command.message ?? ""), command.images as never, { source: "rpc" }) });
			case "abort":
				await this.abortActive();
				return ok(id, "abort");
			case "clear_queue":
				return ok(id, "clear_queue", this.clearActiveQueue());
			case "new_session": {
				const parentSession = str("parentSession");
				const mode = str("agentMode");
				if (mode && AGENT_MODES.includes(mode as AgentMode)) this.newSessionMode = mode as AgentMode;
				const result = await this.replaceAndRebind(() => this.runtime.newSession(parentSession ? { parentSession } : undefined));
				if (!result.cancelled) await this.hooks.sessionCreated?.(this);
				return ok(id, "new_session", result);
			}
			case "get_state":
				await this.refreshModelConfig();
				return ok(id, "get_state", {
					model: session.model ? this.presentModel(session.model) : undefined,
					thinkingLevel: session.thinkingLevel,
					isStreaming: this.running || session.isStreaming,
					isCompacting: this.compacting || session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: this.legacyPath ?? session.sessionFile,
					...(this.legacyPath && { readOnly: true }),
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: this.dsh ? this.dsh.session.agent.inbox.nextStep.length + this.dsh.session.agent.inbox.nextTurn.length : session.pendingMessageCount,
				});
			case "set_model": {
				const model = session.modelRuntime.getAvailableSnapshot().find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) return failure(id, "set_model", `Model not found: ${String(command.provider)}/${String(command.modelId)}`);
				await session.setModel(this.hooks.resolveModel?.(model) ?? model);
				this.hooks.changed(this);
				return ok(id, "set_model", this.presentModel(session.model!));
			}
			case "cycle_model": {
				const result = await session.cycleModel();
				await this.refreshModelConfig();
				return ok(id, "cycle_model", result ? { ...result, model: this.presentModel(session.model!) } : null);
			}
			case "get_available_models": {
				const order = new Map(this.db.all<{id: string}>("SELECT id FROM gateway_groups ORDER BY sort, created_at").map((g, i) => [g.id, i]));
				const models = session.modelRuntime.getAvailableSnapshot().map((m) => this.hooks.resolveModel?.(m) ?? m);
				const groups = models.filter((m) => m.provider === "dreamflutter").sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
				let groupIndex = 0;
				// Each model carries its own thinking levels, so the window can list them for a model that is not the session's (settings' default model).
				return ok(id, "get_available_models", {
					models: models.map((m) => this.presentModel(m.provider === "dreamflutter" ? groups[groupIndex++]! : m)),
				});
			}
			case "set_thinking_level":
				session.setThinkingLevel(command.level as never);
				return ok(id, "set_thinking_level");
			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				return ok(id, "cycle_thinking_level", level ? { level } : null);
			}
			case "get_available_thinking_levels":
				return ok(id, "get_available_thinking_levels", { levels: session.getAvailableThinkingLevels() });
			case "set_steering_mode":
				session.setSteeringMode(command.mode as never);
				return ok(id, "set_steering_mode");
			case "set_follow_up_mode":
				session.setFollowUpMode(command.mode as never);
				return ok(id, "set_follow_up_mode");
			case "compact":
				return ok(id, "compact", await this.compactNow(str("customInstructions")));
			case "set_auto_compaction":
				// Automatic compaction is the core setting autoCompaction (settings.update), not a Pi setting.
				return ok(id, "set_auto_compaction");
			case "set_auto_retry":
				session.setAutoRetryEnabled(command.enabled === true);
				return ok(id, "set_auto_retry");
			case "abort_retry":
				session.abortRetry();
				return ok(id, "abort_retry");
			case "bash": {
				const text = String(command.command ?? "");
				const excludeFromContext = command.excludeFromContext === true;
				const eventResult = await session.extensionRunner.emitUserBash({
					type: "user_bash",
					command: text,
					excludeFromContext,
					cwd: session.sessionManager.getCwd(),
				});
				if (eventResult?.result) {
					session.recordBashResult(text, eventResult.result, { excludeFromContext });
					return ok(id, "bash", eventResult.result);
				}
				const result = await session.executeBash(text, undefined, { excludeFromContext, id, operations: eventResult?.operations });
				return ok(id, "bash", result);
			}
			case "abort_bash":
				session.abortBash();
				return ok(id, "abort_bash");
			case "get_session_stats": {
				const stats = session.getSessionStats();
				const manager = session.sessionManager;
				const entries = manager.getEntries();
				const header = manager.getHeader()!;
				const inherited = inheritedIds(entries, manager.getSessionId(), header.parentSession ?? null, header.timestamp, this.db);
				for (const entry of entries) {
					if (!inherited.has(entry.id)) continue;
					const usage = entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage
						: entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult") ? entry.message.usage : undefined;
					if (!usage) continue;
					for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) stats.tokens[key] = Math.max(0, stats.tokens[key] - usage[key]);
					stats.cost = Math.max(0, stats.cost - usage.cost.total);
				}
				stats.tokens.total = stats.tokens.input + stats.tokens.output + stats.tokens.cacheRead + stats.tokens.cacheWrite;
				return ok(id, "get_session_stats", this.dsh ? { ...stats, contextUsage: this.contextUsage() } : stats);
			}
			case "export_html":
				return ok(id, "export_html", { path: await session.exportToHtml(str("outputPath")) });
			case "switch_session": {
				if (this.hooks.fileTaken?.(this, String(command.sessionPath ?? ""))) return failure(id, "switch_session", "这个会话已经在别处打开了");
				if (this.config?.dshWorkbench?.() && readLegacySession(String(command.sessionPath ?? ""))) return failure(id, "switch_session", "请单独打开旧会话");
				const result = await this.replaceAndRebind(() => this.runtime.switchSession(String(command.sessionPath ?? "")));
				return ok(id, "switch_session", result);
			}
			case "fork": {
				const result = await this.replaceAndRebind(() => this.runtime.fork(String(command.entryId ?? "")));
				return ok(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}
			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) return failure(id, "clone", "Cannot clone session: no current entry selected");
				const result = await this.replaceAndRebind(() => this.runtime.fork(leafId, { position: "at" }));
				return ok(id, "clone", { cancelled: result.cancelled });
			}
			case "get_fork_messages":
				return ok(id, "get_fork_messages", { messages: session.getUserMessagesForForking() });
			case "get_entries": {
				let entries = session.sessionManager.getEntries();
				const since = str("since");
				if (since !== undefined) {
					const index = entries.findIndex((entry) => entry.id === since);
					if (index === -1) return failure(id, "get_entries", `Entry not found: ${since}`);
					entries = entries.slice(index + 1);
				}
				return ok(id, "get_entries", { entries, leafId: session.sessionManager.getLeafId() });
			}
			case "get_tree":
				return ok(id, "get_tree", { tree: session.sessionManager.getTree(), leafId: session.sessionManager.getLeafId() });
			case "get_last_assistant_text":
				return ok(id, "get_last_assistant_text", { text: session.getLastAssistantText() });
			case "set_session_name": {
				const name = String(command.name ?? "").trim();
				if (!name) return failure(id, "set_session_name", "Session name cannot be empty");
				session.setSessionName(name);
				this.hooks.changed(this);
				return ok(id, "set_session_name");
			}
			case "get_messages":
				return ok(id, "get_messages", { messages: session.messages });
			case "get_commands": {
				const commands: Record<string, unknown>[] = [];
				for (const registered of session.extensionRunner.getRegisteredCommands()) {
					commands.push({ name: registered.invocationName, description: registered.description, source: "extension", sourceInfo: registered.sourceInfo });
				}
				for (const template of session.promptTemplates) {
					commands.push({ name: template.name, description: template.description, source: "prompt", sourceInfo: template.sourceInfo });
				}
				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({ name: `skill:${skill.name}`, description: skill.description, source: "skill", sourceInfo: skill.sourceInfo });
				}
				return ok(id, "get_commands", { commands });
			}

			// ---- DreamFlutter extensions ------------------------------------------------
			case "df_navigate_tree": {
				const entryId = String(command.entryId ?? "");
				if (this.legacyPath) {
					if (command.summarize || !session.sessionManager.getEntry(entryId)) throw new Error("找不到所选分支");
					session.sessionManager.branch(entryId);
					session.refreshContext();
					return ok(id, "df_navigate_tree", { cancelled: false, editorText: null });
				}
				const nativeHistory = this.hasDshHistory();
				const options = {
					summarize: command.summarize === true,
					customInstructions: str("customInstructions"),
				};
				const result = nativeHistory ? await this.navigateDshTree(entryId, options) : await session.navigateTree(entryId, options);
				return ok(id, "df_navigate_tree", { cancelled: result.cancelled, editorText: result.editorText ?? null });
			}
			case "df_branches":
				return ok(id, "df_branches", { branches: userBranches(session), leafId: session.sessionManager.getLeafId() });
			case "df_tree":
				return ok(id, "df_tree", { nodes: questionTree(session) });
			case "df_set_label":
				session.sessionManager.appendLabelChange(String(command.entryId ?? ""), str("label"));
				return ok(id, "df_set_label");
			case "df_export": {
				const format = str("format") ?? "markdown";
				const outputPath = str("outputPath");
				if (format === "html") return ok(id, "df_export", { path: await session.exportToHtml(outputPath) });
				if (format === "jsonl") return ok(id, "df_export", { path: session.exportToJsonl(outputPath) });
				return ok(id, "df_export", { path: exportMarkdown(session, outputPath) });
			}
			case "df_reload":
				await session.reload();
				return ok(id, "df_reload");
			case "df_agent_state":
				return ok(id, "df_agent_state", { agentMode: recordedMode(session.sessionManager) ?? "standard", ...this.agentState });
			case "df_set_plan_mode": {
				const control = this.config?.harnessControls?.get(this.slotId);
				if (!control?.setPlanMode) return failure(id, "df_set_plan_mode", "计划模式只在标准模式里可用");
				control.setPlanMode(command.on === true);
				return ok(id, "df_set_plan_mode", this.agentState);
			}
			case "df_context_usage":
				await this.refreshModelConfig();
				return ok(id, "df_context_usage", this.contextUsage());
			default:
				return failure(id, command.type, `Unknown command: ${command.type}`);
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.closing = true;
		this.dshCompactionAbort?.abort();
		this.ui.cancelAll();
		await this.firstSend?.catch(() => {});
		await this.dshOpening?.catch(() => {});
		await this.dsh?.session.dispose().catch(() => {});
		this.dsh?.content.clear();
		this.disposed = true;
		this.recorder.interrupt();
		this.unsubscribe?.();
		try {
			await this.runtime?.dispose();
		} catch {
			// Disposal errors are not actionable.
		}
	}
}

export interface UserBranch {
	/** The user message entry on the active branch. */
	entryId: string;
	/** Its position among sibling user messages (edited resends), oldest first. */
	index: number;
	total: number;
	/** For each sibling: the entry to navigate to (its latest continuation). */
	targets: string[];
}

type TreeEntry = { id: string; parentId: string | null; type: string; timestamp?: string; message?: { role?: string } };

/**
 * Branch info for each user message on the active path, oldest first: an
 * edited and resent message is a sibling of the original under the same
 * parent, so "‹ 2/3 ›" can switch between the versions in place.
 */
export function userBranches(session: AgentSession): UserBranch[] {
	const manager = session.sessionManager;
	const isUser = (e: TreeEntry) => e.type === "message" && e.message?.role === "user";
	const byTime = (a: TreeEntry, b: TreeEntry) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? ""));
	const latestLeaf = (id: string): string => {
		let current = id;
		for (;;) {
			const children = (manager.getChildren(current) as unknown as TreeEntry[]).slice().sort(byTime);
			if (children.length === 0) return current;
			current = children.at(-1)!.id;
		}
	};
	// Versions of a question share the message before them. Bookkeeping in
	// between (a title arriving while the user edits, a model change, mode
	// markers) does not make an edited question a new one.
	const entries = manager.getEntries() as unknown as TreeEntry[];
	const byId = new Map(entries.map((e) => [e.id, e]));
	const anchorOf = (entry: TreeEntry): string | null => {
		let parent = entry.parentId ? byId.get(entry.parentId) : undefined;
		while (parent && parent.type !== "message") parent = parent.parentId ? byId.get(parent.parentId) : undefined;
		return parent?.id ?? null;
	};
	const questions = entries.filter(isUser);
	const out: UserBranch[] = [];
	for (const entry of manager.getBranch() as unknown as TreeEntry[]) {
		if (!isUser(entry)) continue;
		const anchor = anchorOf(entry);
		const siblings = questions.filter((q) => anchorOf(q) === anchor).sort(byTime);
		out.push({
			entryId: entry.id,
			index: Math.max(0, siblings.findIndex((s) => s.id === entry.id)),
			total: siblings.length,
			targets: siblings.length > 1 ? siblings.map((s) => latestLeaf(s.id)) : [],
		});
	}
	return out;
}

export interface QuestionNode {
	entryId: string;
	/** The nearest earlier question, or null for a first question. */
	parentId: string | null;
	/** The question's text, shortened. */
	text: string;
	timestamp: string;
	/** On the branch shown now. */
	active: boolean;
	/** Where to navigate to show this question's branch (its latest continuation). */
	target: string;
}

/**
 * Every question in the session tree, linked to the question before it, so
 * the window can draw where the conversation branched. Oldest first.
 */
export function questionTree(session: AgentSession): QuestionNode[] {
	const manager = session.sessionManager;
	const entries = manager.getEntries() as unknown as (TreeEntry & { message?: { role?: string; content?: unknown } })[];
	const byId = new Map(entries.map((e) => [e.id, e]));
	const isUser = (e: TreeEntry) => e.type === "message" && e.message?.role === "user";
	const byTime = (a: TreeEntry, b: TreeEntry) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? ""));
	const active = new Set((manager.getBranch() as unknown as TreeEntry[]).map((e) => e.id));
	const latestLeaf = (id: string): string => {
		let current = id;
		for (;;) {
			const children = (manager.getChildren(current) as unknown as TreeEntry[]).slice().sort(byTime);
			if (children.length === 0) return current;
			current = children.at(-1)!.id;
		}
	};
	const textOf = (content: unknown): string => {
		const raw = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join(" ") : "";
		// Attached desk material is not part of the question.
		const plain = raw.replace(/<资料>[\s\S]*?<\/资料>\s*(需要时用工具读取上面列出的文件或文件夹。)?/g, "").replace(/<写笺[^>]*>[\s\S]*?<\/写笺>/g, "");
		const oneLine = plain.replace(/\s+/g, " ").trim();
		return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
	};
	const out: QuestionNode[] = [];
	for (const entry of entries.filter(isUser).sort(byTime)) {
		let parent = entry.parentId ? byId.get(entry.parentId) : undefined;
		while (parent && !isUser(parent)) parent = parent.parentId ? byId.get(parent.parentId) : undefined;
		out.push({
			entryId: entry.id,
			parentId: parent?.id ?? null,
			text: textOf(entry.message?.content) || "（图片）",
			timestamp: String(entry.timestamp ?? ""),
			active: active.has(entry.id),
			target: latestLeaf(entry.id),
		});
	}
	return out;
}

function ok(id: string | undefined, command: string, data?: unknown): Record<string, unknown> {
	return data === undefined ? { id, type: "response", command, success: true } : { id, type: "response", command, success: true, data };
}

function dshReference(message: object): DshHistoryRef | undefined {
	const ref = (message as { dfDsh?: DshHistoryRef }).dfDsh;
	return ref && typeof ref.id === "string" && Number.isSafeInteger(ref.seq) && ref.seq >= 0 ? ref : undefined;
}

function dshQueue(agent: Agent): { steering: string[]; followUp: string[] } {
	const text = (messages: typeof agent.inbox.nextStep) => messages.map((message) => message.content.map((block) => block.type === "text" ? block.text : "").join(""));
	return { steering: text(agent.inbox.nextStep), followUp: text(agent.inbox.nextTurn) };
}

function failure(id: string | undefined, command: string, message: string): Record<string, unknown> {
	return { id, type: "response", command, success: false, error: message };
}
