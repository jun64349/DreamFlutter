import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { LedgerContext } from "../ledger/types.ts";
import { DshEvents } from "./events.ts";
import { DshWorkbenchHooks } from "./session-pi-hooks.ts";
import { bindWorkbenchTools } from "./session-tools.ts";
import { bindToolProgress } from "./tool-progress.ts";
import type { DshSessions } from "./session.ts";

/** Executes a role in a fresh official AgentLoop, using the existing wrapped host tools. */
export async function runDshSubagent(
	services: DshSessions,
	pi: AgentSession,
	options: {
		cwd: string;
		prompt: string;
		maxTurns: number;
		signal: AbortSignal;
		ledgerContext(): LedgerContext;
		onEvent(event: AgentSessionEvent): void;
		onStep(): boolean;
		onAbort(): void;
	},
): Promise<void> {
	const { model, thinkingLevel, sessionId: id } = pi;
	if (!model) throw new Error("请先为子 Agent 选择模型");
	const workbench = new DshWorkbenchHooks(pi, () => false, () => Promise.resolve());
	const content = services.createContentStore(true);
	const allowedTools = pi.getActiveToolNames();
	let completedSteps = 0;
	const reporting = () => completedSteps + 1 >= options.maxTurns;
	const stream = new DshEvents({
		model: () => pi.model,
		messages: () => pi.messages.filter(message => message.role === "user" || message.role === "assistant" || message.role === "toolResult"),
		content: (blocks) => content.fromDsh(blocks),
		persist(message) {
			pi.sessionManager.appendMessage(message);
			pi.refreshContext();
		},
		emit: options.onEvent,
	});
	try {
		if (options.signal.aborted) { options.onAbort(); return; }
		await services.refreshModels();
		await workbench.prepare(options.prompt);
		if (options.signal.aborted) { options.onAbort(); return; }
		const session = await services.open({
			id, cwd: options.cwd, resume: false, content,
			model: { provider: model.provider, model: model.id, ...(thinkingLevel !== "off" && { reasoningEffort: ReasoningEffortId(thinkingLevel) }) },
			ledgerContext: options.ledgerContext,
			modelRuntime: () => pi.modelRuntime,
			setup(ctx, agent) {
				workbench.bind(ctx);
				bindWorkbenchTools(ctx, pi, content, options.onEvent, allowedTools, () => !reporting());
				bindToolProgress(ctx, agent);
				ctx.systemPrompt.section({ name: "dreamflutter-subagent-report", order: 100, interpolate: false, text: () => reporting()
					? "This is your final request. Report what you verified or completed and what remains unresolved. Include key paths or evidence you already have. Do not call any more tools or invent findings."
					: "" });
				ctx.on("session/event", (source, event) => {
					if (source !== agent.session || event.type !== "step/end") return;
					completedSteps++;
					if (options.onStep()) agent.cancel({ kind: "user" });
				});
			},
			onEvent: event => stream.event(event),
			onStream: frame => stream.stream(frame),
			onStatus: status => stream.status(status),
		});
		const stop = () => { options.onAbort(); session.agent.cancel({ kind: "user" }); };
		options.signal.addEventListener("abort", stop, { once: true });
		try {
			if (options.signal.aborted) stop();
			else {
				session.send([{ type: "text", text: options.prompt }], false);
				await session.agent.whenIdle();
			}
		} finally {
			options.signal.removeEventListener("abort", stop);
			await session.dispose();
		}
	} finally { content.clear(); }
}
