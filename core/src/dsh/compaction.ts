import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { toolPairingBalancedBefore, type CompactionResult } from "@deepseek-ai/dsh-compaction";
import BasicCompaction from "@deepseek-ai/dsh-compaction-basic";
import { BlockAssembler, CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, type Message, type TokenUsage } from "@deepseek-ai/dsh-llm";
import type { Session, SessionSeq } from "@deepseek-ai/dsh-session";
import { estimateContent, ROLE_OVERHEAD } from "@deepseek-ai/dsh-token-meter/estimate";
import type { Model } from "@earendil-works/pi-ai";
import { fingerprint, type CompactionRecord } from "../agent/background-compaction.ts";
import { CONTEXT_RULES, MEMORY_SUMMARY_NOTE } from "../agent/harness.ts";
import { COMPACTION, COMPACTION_INSTRUCTION, frameSummary } from "../agent/dsh-text.ts";
import { replayLedgerId } from "./transport.ts";

export type AutomaticCompaction = {
	reason: "threshold" | "overflow";
	run(): Promise<CompactionResult | null>;
};

export interface DshCompactionHooks {
	pressure(): { threshold: number; retain: number } | undefined;
	summaryModel(): Promise<Model<never> | undefined>;
	invalidatedFacts(): string | undefined;
	baseSystemPrompt(): string | undefined;
	automatic(request: AutomaticCompaction): Promise<boolean>;
	background?: {
		enabled(): boolean;
		allowed(): boolean;
		lead(): number;
		model(): Promise<Model<never> | undefined>;
		charge(usage: TokenUsage, writer: Model<never>, receipt?: string): number;
	};
	record?(entry: CompactionRecord): void;
}

export interface DshSummaryRequest {
	focus?: string;
	originals?: ReadonlyMap<string, readonly Message[]>;
}

type SummaryInput = Parameters<BasicCompaction["summarize"]>[0];
type SummaryResult = Awaited<ReturnType<BasicCompaction["summarize"]>>;
type PricedNodes = ReturnType<Context["tokenMeter"]["measure"]>["nodes"];
type PressureRange = { start: SessionSeq; end: SessionSeq };

interface Candidate {
	range: PressureRange;
	fingerprint: string;
	result: SummaryResult;
}

interface BackgroundState {
	cycle?: number;
	writing?: { controller: AbortController; task: Promise<void> };
	candidate?: Candidate;
	approved?: Candidate;
}

/** DreamFlutter chooses when and how to request a summary. DSH owns the compaction transaction. */
export class DreamFlutterCompaction extends BasicCompaction {
	private readonly hooks = new WeakMap<Session, DshCompactionHooks>();
	private readonly instructions = new WeakMap<Session, DshSummaryRequest>();
	private readonly receipts = new WeakMap<Session, string>();
	private readonly background = new WeakMap<Session, BackgroundState>();

	contextTokens(agent: Agent): number {
		return this.ctx.tokenMeter.measure(agent.session).totalTokens;
	}

	takeLedgerReceipt(agent: Agent): string | undefined {
		const receipt = this.receipts.get(agent.session);
		this.receipts.delete(agent.session);
		return receipt;
	}

	bind(ctx: Context, agent: Agent, hooks: DshCompactionHooks): void {
		const session = agent.session;
		const background: BackgroundState = {};
		this.hooks.set(session, hooks);
		this.background.set(session, background);
		ctx.effect(() => async () => {
			background.writing?.controller.abort();
			await background.writing?.task;
			this.hooks.delete(session);
			this.background.delete(session);
		});
		ctx.on("agent/status", ({ agent: source, status }) => {
			if (source === agent && status === "idle") this.prepareCandidate(agent, hooks, background);
		});
		ctx.on("agent/pre-step", async ({ agent: source, signal }, next) => {
			if (source === agent && !signal.aborted) {
				const policy = hooks.pressure();
				if (policy && agent.session.requestHeader()) {
					const measurement = this.ctx.tokenMeter.measure(session);
					if (measurement.totalTokens >= policy.threshold) {
						const candidateRange = await this.useCandidate(agent, hooks, background, measurement, policy.threshold);
						const range = candidateRange ?? this.pressureRange(session, measurement.nodes, policy.retain);
						const candidate = background.approved;
						try {
							if (range) {
								const done = await hooks.automatic({ reason: "threshold", run: () => this.compactRegion(range.start, range.end, agent, signal) });
								if (candidate) hooks.record?.({ kind: "background", outcome: done ? "used" : "dropped", cost: 0,
									...(!done && { reason: "commit_failed" }), model: `${candidate.result.provider}/${candidate.result.model}` });
							}
						} finally { background.approved = undefined; }
					}
				}
			}
			return next();
		});
		let overflowTurn: number | undefined;
		ctx.on("agent/request-error", async ({ agent: source, turn, failure, signal }, next) => {
			if (source !== agent || signal.aborted || !hooks.pressure() || overflowTurn === turn || failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next();
			overflowTurn = turn;
			this.dropCandidate(hooks, background, "overflow");
			const recovered = await hooks.automatic({ reason: "overflow", run: () => this.compactIfNeeded(agent, "context-overflow", signal) });
			return recovered && !signal.aborted ? { kind: "retry" } : next();
		});
	}

	private pressureRange(session: Session, nodes: PricedNodes, retain: number): PressureRange | undefined {
		const first = nodes[0] && session.eventAt(nodes[0].seq)?.type === "system/message" ? 1 : 0;
		let keep = nodes.length;
		let retained = 0;
		while (keep > first && (retained < retain || keep === nodes.length)) retained += nodes[--keep]!.tokens;
		while (keep > first && !toolPairingBalancedBefore(session, nodes[keep]!.seq)) keep--;
		return keep > first ? { start: nodes[first]!.seq, end: nodes[keep - 1]!.seq } : undefined;
	}

	async manual(agent: Agent, signal: AbortSignal, request: DshSummaryRequest): Promise<CompactionResult | null> {
		const background = this.background.get(agent.session);
		if (background) this.dropCandidate(this.hooks.get(agent.session), background, "manual");
		this.instructions.set(agent.session, request);
		try { return await this.compactNow(agent, signal); }
		finally { this.instructions.delete(agent.session); }
	}

	protected override async summarize(input: SummaryInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
		const hooks = this.hooks.get(agent.session);
		if (!hooks) return super.summarize(input, agent, signal);
		this.receipts.delete(agent.session);
		const background = this.background.get(agent.session);
		const candidate = background?.approved;
		if (background && candidate) {
			background.approved = undefined;
			return { summary: candidate.result.summary, provider: candidate.result.provider, model: candidate.result.model };
		}
		const writer = await hooks.summaryModel();
		const { result, receipt } = await this.writeSummary(input, agent, hooks, writer, this.instructions.get(agent.session), signal);
		if (receipt) this.receipts.set(agent.session, receipt);
		return result;
	}

	private prepareCandidate(agent: Agent, hooks: DshCompactionHooks, state: BackgroundState): void {
		const background = hooks.background;
		const pressure = hooks.pressure();
		if (!background?.enabled() || !pressure || state.writing || state.candidate) return;
		const session = agent.session;
		const measurement = this.ctx.tokenMeter.measure(session);
		const tokens = measurement.totalTokens;
		if (tokens < pressure.threshold * background.lead() || tokens >= pressure.threshold || state.cycle === session.surface.replaceGeneration) return;
		state.cycle = session.surface.replaceGeneration;
		if (!background.allowed()) {
			hooks.record?.({ kind: "background", outcome: "dropped", reason: "budget" });
			return;
		}
		const range = this.pressureRange(session, measurement.nodes, pressure.retain);
		if (!range) {
			hooks.record?.({ kind: "background", outcome: "dropped", reason: "no_cut" });
			return;
		}
		const input = this.candidateInput(session, range);
		const controller = new AbortController();
		const began = Date.now();
		const task = (async () => {
			const writer = await background.model();
			controller.signal.throwIfAborted();
			if (!writer) throw new Error("没有可用于压缩的模型");
			const key = this.candidateFingerprint(input, hooks, writer);
			const { result, receipt } = await this.writeSummary(input, agent, hooks, writer, undefined, controller.signal);
			const cost = result.usage ? background.charge(result.usage, writer, receipt) : 0;
			if (controller.signal.aborted) return;
			state.candidate = { range, fingerprint: key, result };
			hooks.record?.({ kind: "background", outcome: "made", waitMs: Date.now() - began, tokensBefore: tokens, cost,
				model: `${writer.provider}/${writer.id}` });
		})().catch(error => {
			if (!controller.signal.aborted) hooks.record?.({ kind: "background", outcome: "failed", reason: error instanceof Error ? error.message : String(error) });
		}).finally(() => { state.writing = undefined; });
		state.writing = { controller, task };
	}

	private candidateInput(session: Session, range: PressureRange): SummaryInput {
		const nodes = session.surface.nodes;
		const head = nodes[0] === undefined ? undefined : session.eventAt(nodes[0]);
		const seqs = nodes.slice(nodes.indexOf(range.start), nodes.indexOf(range.end) + 1);
		if (head?.type === "system/message") seqs.unshift(head.seq);
		const messages = seqs.flatMap(seq => {
			const event = session.eventAt(seq);
			const message = event && session.deriveEventMessage(event);
			return message ? [message] : [];
		});
		return { tools: session.requestHeader()?.tools, messages };
	}

	private candidateFingerprint(input: SummaryInput, hooks: DshCompactionHooks, writer: Model<never>): string {
		return fingerprint(JSON.stringify([writer.provider, writer.id, input.tools, this.summaryMessages(input, hooks), hooks.invalidatedFacts()]));
	}

	private async useCandidate(agent: Agent, hooks: DshCompactionHooks, state: BackgroundState,
		measurement: ReturnType<Context["tokenMeter"]["measure"]>, threshold: number): Promise<PressureRange | undefined> {
		if (!state.candidate) {
			this.dropCandidate(hooks, state, "still_writing");
			return;
		}
		const candidate = state.candidate;
		const nodes = measurement.nodes;
		const start = nodes.findIndex(node => node.seq === candidate.range.start);
		const end = nodes.findIndex(node => node.seq === candidate.range.end);
		const covered = nodes.slice(start, end + 1).reduce((total, node) => total + node.tokens, 0);
		const writer = await hooks.background?.model();
		const summary = candidate.result.summary.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
		const replacement = estimateContent([{ type: "text", text: frameSummary(summary) }]) + ROLE_OVERHEAD;
		const reason = !hooks.background?.enabled() || !writer ? "disabled"
			: start < 0 || end < start ? "changed_prefix"
			: this.candidateFingerprint(this.candidateInput(agent.session, candidate.range), hooks, writer) !== candidate.fingerprint ? "changed_instructions"
			: measurement.totalTokens - covered + replacement >= threshold ? "too_small"
			: undefined;
		if (reason) {
			this.dropCandidate(hooks, state, reason);
			return;
		}
		state.candidate = undefined;
		state.approved = candidate;
		return candidate.range;
	}

	private dropCandidate(hooks: DshCompactionHooks | undefined, state: BackgroundState, reason: string): void {
		if (!state.writing && !state.candidate) return;
		state.writing?.controller.abort();
		state.candidate = undefined;
		hooks?.record?.({ kind: "background", outcome: "dropped", reason });
	}

	private summaryMessages(input: SummaryInput, hooks: DshCompactionHooks, request?: DshSummaryRequest): readonly Message[] {
		const baseSystemPrompt = hooks.baseSystemPrompt();
		return input.messages.flatMap(message => {
			if (message.role === "system" && baseSystemPrompt !== undefined) return [{ ...message, content: [{ type: "text" as const, text: baseSystemPrompt }] }];
			if (message.role === "user" && message.source.kind === "compact-checkpoint") return request?.originals?.get(message.id) ?? [message];
			return [message];
		});
	}

	private async writeSummary(input: SummaryInput, agent: Agent, hooks: DshCompactionHooks, writer: Model<never> | undefined,
		request: DshSummaryRequest | undefined, signal?: AbortSignal): Promise<{ result: SummaryResult; receipt?: string }> {
		const header = agent.session.requestHeader()?.config;
		const provider = writer?.provider ?? header?.provider ?? agent.options.provider;
		const model = writer?.id ?? header?.model ?? agent.options.model;
		if (!provider || !model) throw new Error("没有可用于压缩的模型");
		const invalidated = hooks.invalidatedFacts();
		const prompt = [COMPACTION_INSTRUCTION, CONTEXT_RULES, MEMORY_SUMMARY_NOTE, invalidated, request?.focus].filter(Boolean).join("\n\n");
		const messages = this.summaryMessages(input, hooks, request);
		const maxTokens = Math.min(COMPACTION.summaryMaxTokens, writer?.maxTokens || COMPACTION.summaryMaxTokens);
		const assembler = new BlockAssembler();
		for await (const chunk of this.ctx.llm.stream({
			provider, model, purpose: "compaction", maxTokens, signal, sessionId: agent.session.id,
			toolHistory: agent.session.toolHistory(), ...(input.tools && { tools: [...input.tools] }),
			messages: [...messages, { role: "user", content: [{ type: "text", text: prompt }] }],
		})) assembler.push(chunk);
		const finish = assembler.finish;
		if (finish.kind === "error" || finish.kind === "aborted") throw LlmError.fromFailure(finish.failure);
		if (finish.kind === "max-tokens") throw new Error("摘要达到输出上限，未生成完整检查点");
		const rawOutput = assembler.blocks();
		if (rawOutput.some(block => block.type === "image")) throw new Error("摘要应为文本");
		const summary = rawOutput.filter(block => block.type === "text");
		if (!summary.some(block => block.text.trim())) throw new Error("模型没有生成文本摘要");
		return { receipt: replayLedgerId(assembler.replayState), result: {
			summary, rawOutput, llmStreamCall: true, provider, model, maxTokens, ...(assembler.usage && { usage: assembler.usage }),
		} };
	}
}
