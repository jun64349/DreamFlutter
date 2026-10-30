import type { AgentSession, AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { AGENT_MODES, type AgentMode, recordedMode } from "../agent/harness.ts";
import type { TodoItem } from "../agent/state.ts";
import type { Db } from "../db.ts";
import { now } from "../db.ts";
import { createSessionRuntime, type OpenTarget, type PiHostConfig } from "../pi/host.ts";
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
	model: string | null;
	/** Agent mode of the open session (null while starting). */
	agentMode: AgentMode | null;
	/** Standard mode: plan mode is on. */
	planMode: boolean;
}

export interface SlotHooks {
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
	taskId: string | null;
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
	private runtime!: AgentSessionRuntime;
	private readonly hooks: SlotHooks;
	private readonly recorder: RunRecorder;
	private unsubscribe: (() => void) | undefined;
	private disposed = false;
	private readonly fallbackCwd: string;

	private constructor(db: Db, options: SlotOptions, hooks: SlotHooks) {
		this.slotId = options.slotId;
		this.taskId = options.taskId ?? null;
		this.unattended = options.unattended ?? false;
		this.incognito = options.target.inMemory === true;
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
				taskId: () => this.taskId ?? (this.taskId = this.hooks.resolveTaskId?.(this) ?? null),
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
			this.runtime = await createSessionRuntime(config, { slotId: this.slotId }, this.ui, target);
		} catch (error) {
			this.ui.cancelAll();
			throw error;
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

	/** The session, or undefined while the runtime is still being created. */
	private get sessionOrUndefined(): AgentSession | undefined {
		return (this.runtime as AgentSessionRuntime | undefined)?.session;
	}

	get cwd(): string {
		return this.sessionOrUndefined?.sessionManager.getCwd() ?? this.fallbackCwd;
	}

	get currentRun(): Run | undefined {
		return this.recorder.current;
	}

	info(): SlotInfo {
		const session = this.sessionOrUndefined;
		const model = session?.model;
		return {
			slotId: this.slotId,
			cwd: this.cwd,
			sessionFile: session?.sessionFile ?? null,
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
		const partial = this.session.agent.state.streamingMessage;
		if (partial) records.push({ type: "message_start", message: partial });
		return records;
	}

	private emit(record: Record<string, unknown>): void {
		if (this.disposed) return;
		this.hooks.record(this.slotId, record);
	}

	private async rebind(): Promise<void> {
		const session = this.runtime.session;
		await session.bindExtensions({
			uiContext: this.ui.context(),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => this.runtime.newSession(options),
				fork: async (entryId, options) => {
					const result = await this.runtime.fork(entryId, options);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await this.runtime.session.navigateTree(targetId, options);
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => this.runtime.switchSession(sessionPath, options),
				reload: async () => {
					await this.runtime.session.reload();
				},
			},
			shutdownHandler: () => {},
			onError: (err) => this.emit({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error }),
		});
		this.unsubscribe?.();
		this.unsubscribe = session.subscribe((event) => this.onEvent(event));
		this.hooks.changed(this);
	}

	private onEvent(event: AgentSessionEvent): void {
		this.lastActivity = now();
		this.recorder.handle(event);
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
		if (changed) this.hooks.changed(this);
	}

	/** Handles one inbound record: a command or an extension UI response. */
	async handle(record: Command): Promise<void> {
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
			const response = await this.command(record);
			if (response) this.emit(response);
		} catch (error) {
			this.emit(failure(record.id, record.type, error instanceof Error ? error.message : String(error)));
		}
	}

	/** Sends a prompt on behalf of the core (tasks, schedules) and resolves when accepted. */
	async prompt(message: string, options: { images?: unknown[] } = {}): Promise<void> {
		this.lastActivity = now();
		this.lastPrompt = message;
		await new Promise<void>((resolve, reject) => {
			let accepted = false;
			this.session
				.prompt(message, {
					images: options.images as never,
					streamingBehavior: this.session.isStreaming ? "followUp" : undefined,
					source: "rpc",
					preflightResult: () => {
						accepted = true;
						resolve();
					},
				})
				.catch((error) => {
					if (!accepted) reject(error);
				});
		});
	}

	private async replaceAndRebind<T extends { cancelled: boolean }>(operation: () => Promise<T>): Promise<T> {
		const result = await operation();
		if (!result.cancelled) {
			// Another session now: its task is looked up (or created) at its next run.
			this.taskId = null;
			await this.rebind();
			this.hooks.sessionReplaced?.(this);
		}
		return result;
	}

	private async command(command: Command): Promise<Record<string, unknown> | undefined> {
		const id = command.id;
		const session = this.session;
		const str = (key: string) => (typeof command[key] === "string" ? (command[key] as string) : undefined);
		switch (command.type) {
			case "prompt": {
				let accepted = false;
				this.lastPrompt = String(command.message ?? "");
				void session
					.prompt(String(command.message ?? ""), {
						images: command.images as never,
						streamingBehavior: command.streamingBehavior as never,
						source: "rpc",
						preflightResult: (disposition) => {
							accepted = true;
							this.emit(ok(id, "prompt", { disposition }));
						},
					})
					.catch((error: unknown) => {
						if (!accepted) this.emit(failure(id, "prompt", error instanceof Error ? error.message : String(error)));
					});
				return undefined;
			}
			case "steer":
				return ok(id, "steer", { disposition: await session.steer(String(command.message ?? ""), command.images as never, { source: "rpc" }) });
			case "follow_up":
				return ok(id, "follow_up", { disposition: await session.followUp(String(command.message ?? ""), command.images as never, { source: "rpc" }) });
			case "abort":
				await session.abort();
				return ok(id, "abort");
			case "clear_queue":
				return ok(id, "clear_queue", session.clearQueue());
			case "new_session": {
				const parentSession = str("parentSession");
				const mode = str("agentMode");
				if (mode && AGENT_MODES.includes(mode as AgentMode)) this.newSessionMode = mode as AgentMode;
				const result = await this.replaceAndRebind(() => this.runtime.newSession(parentSession ? { parentSession } : undefined));
				if (!result.cancelled) await this.hooks.sessionCreated?.(this);
				return ok(id, "new_session", result);
			}
			case "get_state":
				return ok(id, "get_state", {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
				});
			case "set_model": {
				const model = session.modelRuntime.getAvailableSnapshot().find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) return failure(id, "set_model", `Model not found: ${String(command.provider)}/${String(command.modelId)}`);
				await session.setModel(model);
				this.hooks.changed(this);
				return ok(id, "set_model", model);
			}
			case "cycle_model":
				return ok(id, "cycle_model", (await session.cycleModel()) ?? null);
			case "get_available_models":
				return ok(id, "get_available_models", { models: session.modelRuntime.getAvailableSnapshot() });
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
			case "compact": {
				this.config?.manualCompactions?.add(this.slotId);
				try {
					return ok(id, "compact", await session.compact(str("customInstructions")));
				} finally {
					this.config?.manualCompactions?.delete(this.slotId);
				}
			}
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
			case "get_session_stats":
				return ok(id, "get_session_stats", session.getSessionStats());
			case "export_html":
				return ok(id, "export_html", { path: await session.exportToHtml(str("outputPath")) });
			case "switch_session": {
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
				const result = await session.navigateTree(entryId, {
					summarize: command.summarize === true,
					customInstructions: str("customInstructions"),
				});
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
				return ok(id, "df_context_usage", session.getContextUsage() ?? null);
			default:
				return failure(id, command.type, `Unknown command: ${command.type}`);
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.ui.cancelAll();
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
	const out: UserBranch[] = [];
	for (const entry of manager.getBranch() as unknown as TreeEntry[]) {
		if (!isUser(entry)) continue;
		const siblings = entry.parentId ? (manager.getChildren(entry.parentId) as unknown as TreeEntry[]).filter(isUser).sort(byTime) : [entry];
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

function failure(id: string | undefined, command: string, message: string): Record<string, unknown> {
	return { id, type: "response", command, success: false, error: message };
}
