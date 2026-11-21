import { Context } from "@deepseek-ai/cordis";
import AgentRegistry, { type Agent, type AgentHandle, type AssistantStreamFrame, type ModelSelection } from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LocalAttachments from "@deepseek-ai/dsh-attachment-local";
import { createAssistantMessage, createSystemMessage, createUserMessage, type ContentBlock } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId, SessionLogOffset, SessionSeq, type SessionEvent } from "@deepseek-ai/dsh-session";
import { buildForkSeed } from "@deepseek-ai/dsh-session/fork";
import * as checkpoints from "@deepseek-ai/dsh-session-checkpoint-policy";
import * as sessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import SessionProjections from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import * as nativeTools from "@deepseek-ai/dsh-tool-executor-native";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import Tools from "@deepseek-ai/dsh-tools";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { recordedAssistantStream, replayEnvelope, toDshAssistantBlocks } from "./transport.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { LedgerContext } from "../ledger/types.ts";
import type {} from "./models.ts";
import { DshMemoryAttachments, DshSlotContent } from "./session-content.ts";
import { DreamFlutterCompaction, type DshCompactionHooks, type DshSummaryRequest } from "./compaction.ts";

declare module "@deepseek-ai/dsh-llm" {
	interface MessageSourceMap {
		"dreamflutter-branch-summary": { kind: "dreamflutter-branch-summary" };
	}
}

export interface DshSessionOptions {
	id: string;
	cwd: string;
	resume: boolean;
	branch?: boolean;
	fork?: DshHistoryRef;
	branchSummaries?: readonly { text: string; time: number }[];
	seed?: readonly SessionEvent[];
	content?: DshSlotContent;
	model: ModelSelection;
	ledgerContext?(): LedgerContext;
	modelRuntime?(): ModelRuntime;
	setup?(ctx: Context, agent: Agent): void | Promise<void>;
	compaction?: DshCompactionHooks;
	onEvent(event: SessionEvent): void;
	onStream(frame: AssistantStreamFrame): void;
	onStatus(status: Agent["status"]): void;
	onQueue?(agent: Agent): void;
	onDiscard?(content: readonly ContentBlock[]): void;
}

export interface DshHistoryRef { id: string; seq: number; }

/** Released DSH formats require a protected system head before any model-visible seed. */
export function seedSystemHead(seq: number, time: number): SessionEvent<"system/message"> {
	return { type: "system/message", seq: SessionSeq(seq), time, surfaceOp: "append", data: { turn: 1, step: 1, message: createSystemMessage("") } };
}

/** The runtime is composed by DreamFlutter, independently of CLI profiles and user plugin discovery. */
export async function installDshSessions(ctx: Context, options: { root: string; setupTemporary?(ctx: Context): Promise<void> }): Promise<DshSessions> {
	await installAgentServices(ctx, options.root);
	const local = ctx.attachments as LocalAttachments;
	const sessions = new DshSessions(ctx, local);
	if (options.setupTemporary) {
		// A separate Cordis tree keeps global durability hooks out of private turns.
		const memory = new Context();
		ctx.effect(() => () => memory.fiber.dispose());
		await options.setupTemporary(memory);
		await installAgentServices(memory);
		sessions.temporary = new DshSessions(memory, local);
	}
	return sessions;
}

async function installAgentServices(ctx: Context, root?: string): Promise<void> {
	await ctx.plugin(SessionProjections);
	await ctx.plugin(SessionStore);
	if (root) {
		await ctx.plugin(sessionPersistence, { root, compression: "none" });
		await ctx.plugin(LocalAttachments, { dshHome: root });
	}
	await ctx.plugin(Tools);
	await ctx.plugin(nativeTools);
	await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
	await ctx.plugin(AgentRegistry);
	if (root) await ctx.plugin(checkpoints);
	await ctx.plugin(TokenMeter);
	await ctx.plugin(DreamFlutterCompaction, { auto: false });
	await ctx.plugin(AgentLoop, { agents: [] });
}

export class DshSessions {
	private readonly ctx: Context;
	private readonly attachmentPolicy: LocalAttachments;
	temporary?: DshSessions;

	constructor(ctx: Context, attachmentPolicy: LocalAttachments) {
		this.ctx = ctx;
		this.attachmentPolicy = attachmentPolicy;
	}

	async open(options: DshSessionOptions): Promise<DshSession> {
		const ctx = this.ctx;
		const id = SessionId(options.id);
		const compaction = ctx.compaction as DreamFlutterCompaction;
		const setup = async (agentCtx: Context, agent: Agent) => {
			const models = ctx.get("dreamflutterModels");
			if (models && options.ledgerContext) {
				const unbind = models.bindSession(id, options.ledgerContext, options.modelRuntime, options.content?.attachmentStore);
				agentCtx.effect(() => unbind);
			}
			await options.setup?.(agentCtx, agent);
			if (options.compaction) compaction.bind(agentCtx, agent, options.compaction);
			agentCtx.on("session/event", (session, event) => {
				if (session !== agent.session) return;
				options.onEvent(event);
				if (event.type === "agent/inbox/spliced") options.onQueue?.(agent);
			});
			agentCtx.on("agent/assistant-stream", ({ agent: source, frame }) => {
				if (source === agent) options.onStream(frame);
			});
			agentCtx.on("agent/status", ({ agent: source, status }) => {
				if (source === agent) options.onStatus(status);
			});
			agentCtx.on("agent/inbox/discarded", ({ agent: source, message }) => {
				if (source === agent) options.onDiscard?.(message.content);
			});
		};
		const existing = options.resume || !!((options.branch || options.seed) && await ctx.sessionPersistence?.stat(id));
		const fork = options.fork && !existing ? await this.forkSeed(options.fork) : undefined;
		let seed = fork?.seed ?? options.seed;
		if (options.branchSummaries?.length && !existing) {
			const time = options.branchSummaries[0]!.time;
			const events: SessionEvent[] = seed?.length ? [...seed] : [
				{ type: "turn/start", seq: SessionSeq(0), time, data: { turn: 1 } },
				{ type: "step/start", seq: SessionSeq(1), time, data: { turn: 1, step: 1 } },
				seedSystemHead(2, time),
				{ type: "step/end", seq: SessionSeq(3), time, data: { turn: 1, step: 1 } },
				{ type: "turn/end", seq: SessionSeq(4), time, data: { turn: 1, reason: { kind: "completed" } } },
			];
			for (const summary of options.branchSummaries) {
				const content = [{ type: "text" as const, text: "[分支摘要]\n" + summary.text }];
				events.push({ type: "user/message", time: summary.time, seq: SessionSeq(events.length),
					surfaceOp: "append", data: createUserMessage({ content, source: { kind: "dreamflutter-branch-summary" } }) });
			}
			seed = events;
		}
		const handle = existing
			? await ctx.agents.resume({ resumeSessionId: id, setup })
			: await ctx.agents.create({ sessionId: id, meta: { cwd: options.cwd, ...(fork && { isSeeded: true, parentSession: SessionId(options.fork!.id) }) },
				seed, inheritedEventCount: fork?.inheritedEventCount, agentOptions: options.model, setup });
		return new DshSession(handle, compaction);
	}

	refreshModels(): Promise<void> {
		return this.ctx.get("dreamflutterModels")?.refresh() ?? Promise.resolve();
	}

	createContentStore(ephemeral = false): DshSlotContent {
		return new DshSlotContent(ephemeral ? new DshMemoryAttachments(this.ctx.isolate("attachments"), this.attachmentPolicy) : this.attachmentPolicy);
	}

	async latestVisibleMessage(ref: DshHistoryRef): Promise<boolean> {
		const events = await this.readEvents(ref.id);
		return events.findLast(event => event.type === "assistant/message" || event.type === "tool/result" ||
			(event.type === "user/message" && event.data.source.kind === "user") ||
			(event.type === "compaction/end" && !event.data.error) ||
			(event.type === "turn/end" && ["error", "blocked"].includes(event.data.reason.kind)))?.seq === ref.seq;
	}

	private async forkSeed(ref: DshHistoryRef) {
		const events = await this.readEvents(ref.id);
		const boundary = SessionSeq(ref.seq);
		if (events[boundary]?.seq !== boundary) throw new Error("找不到所选分支的历史记录");
		return { seed: buildForkSeed(events, boundary), inheritedEventCount: SessionLogOffset(boundary + 1) };
	}

	private async readEvents(id: string): Promise<readonly SessionEvent[]> {
		const nativeId = SessionId(id);
		const live = this.ctx.sessions.get(nativeId);
		if (live) return live.snapshotEvents();
		const persistence = this.ctx.sessionPersistence;
		if (!persistence) throw new Error("会话存储没有准备好");
		const stored = await persistence.open(nativeId, "read");
		try { return (await stored.read(0)).events; }
		finally { await stored.close(); }
	}
}

export class DshSession {
	private readonly handle: AgentHandle;
	private readonly compaction: DreamFlutterCompaction;

	constructor(handle: AgentHandle, compaction: DreamFlutterCompaction) {
		this.handle = handle;
		this.compaction = compaction;
	}

	get agent(): Agent { return this.handle.agent; }

	send(content: ContentBlock[], steering: boolean): void {
		const message = createUserMessage({ content, source: { kind: "user" } });
		if (steering) this.agent.steer(message);
		else this.agent.followup(message);
	}

	/** Record an already-generated, budgeted message without starting another inference. */
	appendProactive(message: AssistantMessage) {
		const agent = this.agent;
		const session = agent.session;
		const boundary = agent.ctx.agents.turnBoundaryOf(session);
		if (agent.status !== "idle" || boundary.openTurnStartSeq !== null || !session.requestHeader()) throw new Error("会话还不能接收主动消息");
		const turn = boundary.lastTurn + 1, step = 1;
		const blocks = toDshAssistantBlocks(message.content);
		const replayState = replayEnvelope(message);
		const { stream, tokens } = recordedAssistantStream(message, blocks, { kind: "stop" }, replayState);
		const nativeMessage = createAssistantMessage({ content: blocks, source: { provider: message.provider, model: message.model, replayState } });
		const events = session.append([
			["turn/start", { turn }], ["step/start", { turn, step }],
			["assistant/message", { turn, step, message: nativeMessage, stream, ...(tokens && { usage: tokens }) }, { surfaceOp: "append" }],
			["step/end", { turn, step }], ["turn/end", { turn, reason: { kind: "completed" } }],
		]);
		return { id: session.id, seq: events[2]!.seq, messageId: nativeMessage.id };
	}

	async abort(): Promise<void> {
		this.agent.cancel({ kind: "user" });
		await this.agent.whenIdle();
	}

	compact(signal: AbortSignal, request: DshSummaryRequest) {
		return this.compaction.manual(this.agent, signal, request);
	}

	get contextTokens(): number {
		return this.compaction.contextTokens(this.agent);
	}

	takeSummaryLedgerReceipt(): string | undefined {
		return this.compaction.takeLedgerReceipt(this.agent);
	}

	dispose(): Promise<void> {
		return this.handle.dispose();
	}
}
