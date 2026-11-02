import type { AgentSessionEvent, ExtensionAPI, ExtensionFactory, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { BUILT_IN_ROLES, type RoleCard, roleById, roleTools } from "../agent/roles.ts";
import type { Core, CoreModule } from "../core.ts";
import { APPROVAL_TITLE } from "../pi/dialogs.ts";

/**
 * The `agent` tool: the main agent sends a role card off with a task; the
 * subagent works in its own in-memory Pi session (fresh context, the parent's
 * approval rules, channel models) and hands back its final reply. Several
 * calls in one turn run side by side. See docs/v0.3-design.md.
 */

/** Subagents running at once across the core; more wait their turn. */
export const MAX_PARALLEL_SUBAGENTS = 4;

const FILE_TOOLS = new Set(["write", "edit"]);

export interface SubagentDetails {
	role: string;
	roleName: string;
	description: string;
	status: "waiting" | "running" | "done" | "stopped" | "failed";
	/** What it is doing now (running), e.g. "grep: TODO". */
	activity: string | null;
	turns: number;
	toolCalls: number;
	tools: Record<string, number>;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	model: string | null;
	/** Why it stopped early: the turn cap or the user. */
	stoppedBy?: "maxTurns" | "aborted";
	error?: string;
}

function brief(toolName: string, args: Record<string, unknown>): string {
	const value = args.file_path ?? args.path ?? args.pattern ?? args.command ?? args.url ?? args.query ?? "";
	const text = String(value).replace(/\s+/g, " ").trim();
	return text ? `${toolName}: ${text.length > 80 ? `${text.slice(0, 80)}…` : text}` : toolName;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export class SubagentsModule implements CoreModule {
	readonly modelFacing = true;
	private readonly core: Core;
	private running = 0;
	private readonly waiting: (() => void)[] = [];
	private counter = 0;

	constructor(core: Core) {
		this.core = core;
		// Sending one off changes nothing; each of its own tool calls is approved on its way.
		core.exemptFromApproval("agent");
	}

	private async acquire(signal: AbortSignal | undefined): Promise<void> {
		if (this.running < MAX_PARALLEL_SUBAGENTS) {
			this.running++;
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const go = () => {
				signal?.removeEventListener("abort", stop);
				this.running++;
				resolve();
			};
			const stop = () => {
				const i = this.waiting.indexOf(go);
				if (i >= 0) this.waiting.splice(i, 1);
				reject(new Error("stopped before the subagent started"));
			};
			signal?.addEventListener("abort", stop, { once: true });
			this.waiting.push(go);
		});
	}

	private release(): void {
		this.running--;
		this.waiting.shift()?.();
	}

	extensions(slot: { slotId: string }): ExtensionFactory[] {
		const module = this;
		const roles = BUILT_IN_ROLES.map((r) => `- ${r.id} (${r.name}): ${r.description}`).join("\n");
		return [
			(pi: ExtensionAPI) => {
				pi.registerTool({
					name: "agent",
					label: "子 Agent",
					description:
						"Send a subagent off to do a self-contained task in its own fresh context and get its final report back. " +
						"Use it to keep your own context small (broad searches, reading many files or pages) or to do independent pieces of work side by side: " +
						"call it several times in one turn and they run at the same time. " +
						"The subagent cannot see this conversation and cannot ask the user, so the prompt must carry everything it needs: the goal, relevant paths and facts, constraints, and what to hand back. " +
						"Do not use it for a single quick lookup you can do yourself.\n\nRoles:\n" +
						roles,
					parameters: {
						type: "object",
						properties: {
							role: { type: "string", enum: BUILT_IN_ROLES.map((r) => r.id), description: "Which role card to send (default general)." },
							description: { type: "string", description: "A 3–8 word title for the task, shown to the user." },
							prompt: { type: "string", description: "The complete task for the subagent." },
						},
						required: ["description", "prompt"],
					} as never,
					executionMode: "parallel",
					async execute(toolCallId, params: { role?: string; description: string; prompt: string }, signal, onUpdate, ctx) {
						const role = roleById(params.role);
						if (!role) throw new Error(`unknown role ${JSON.stringify(params.role)}; use one of ${BUILT_IN_ROLES.map((r) => r.id).join(", ")}`);
						if (!params.prompt?.trim()) throw new Error("prompt must describe the task");
						return module.run(slot.slotId, `${toolCallId}`, role, params.description?.trim() || role.name, params.prompt, ctx.cwd, ctx.model, signal, onUpdate);
					},
				});
			},
		];
	}

	async run(
		parentSlotId: string,
		callId: string,
		role: RoleCard,
		description: string,
		prompt: string,
		cwd: string,
		parentModel: { provider: string; id: string } | undefined,
		signal: AbortSignal | undefined,
		onUpdate: ((result: { content: { type: "text"; text: string }[]; details: SubagentDetails }) => void) | undefined,
	): Promise<{ content: { type: "text"; text: string }[]; details: SubagentDetails }> {
		const parent = this.core.slot(parentSlotId);
		const details: SubagentDetails = {
			role: role.id,
			roleName: role.name,
			description,
			status: "waiting",
			activity: null,
			turns: 0,
			toolCalls: 0,
			tools: {},
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
			model: null,
		};
		const files = new Set<string>();
		const update = () => onUpdate?.({ content: [{ type: "text", text: details.activity ?? "" }], details: { ...details, tools: { ...details.tools } } });
		update();
		await this.acquire(signal);
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		let runtime: Awaited<ReturnType<Core["openSubagentRuntime"]>> | undefined;
		try {
			details.status = "running";
			update();
			runtime = await this.core.openSubagentRuntime(parentSlotId, `${parentSlotId}/agent-${++this.counter}`, cwd, parent.ui, parent.sandboxed);
			const session = runtime.session;
			await session.bindExtensions({
				uiContext: labelApprovals(parent.ui.context(), `${role.name} · ${description}`),
				mode: "rpc",
				commandContextActions: {
					waitForIdle: () => session.waitForIdle(),
					newSession: async () => ({ cancelled: true }),
					fork: async () => ({ cancelled: true }),
					navigateTree: async () => ({ cancelled: true }),
					switchSession: async () => ({ cancelled: true }),
					reload: async () => {},
				},
				shutdownHandler: () => {},
				onError: () => {},
			});

			const wanted = role.model ?? (parentModel ? `${parentModel.provider}/${parentModel.id}` : null);
			if (wanted) {
				const slash = wanted.indexOf("/");
				const model = session.modelRuntime.getAvailableSnapshot().find((m) => m.provider === wanted.slice(0, slash) && m.id === wanted.slice(slash + 1));
				if (model) await session.setModel(model);
			}
			session.setThinkingLevel(parent.session.thinkingLevel);
			details.model = session.model ? `${session.model.provider}/${session.model.id}` : null;
			session.setActiveToolsByName(roleTools(role, session.getAllTools().map((t) => t.name)));

			const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
				const e = event as AgentSessionEvent & Record<string, unknown>;
				if (e.type === "tool_execution_start") {
					const name = String(e.toolName);
					const args = (e.args ?? {}) as Record<string, unknown>;
					details.toolCalls++;
					details.tools[name] = (details.tools[name] ?? 0) + 1;
					details.activity = brief(name, args);
					const path = args.file_path ?? args.path;
					if (FILE_TOOLS.has(name) && typeof path === "string") files.add(path);
					update();
				} else if (e.type === "turn_end") {
					details.turns++;
					if (details.turns >= role.maxTurns && !details.stoppedBy) {
						details.stoppedBy = "maxTurns";
						void session.abort();
					}
					update();
				} else if (e.type === "message_end") {
					const message = e.message as Record<string, unknown>;
					if (message.role !== "assistant") return;
					const u = (message.usage ?? {}) as Record<string, unknown>;
					usage.input += num(u.input);
					usage.output += num(u.output);
					usage.cacheRead += num(u.cacheRead);
					usage.cacheWrite += num(u.cacheWrite);
					usage.cost += num((u.cost as Record<string, unknown> | undefined)?.total);
					details.inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
					details.outputTokens = usage.output;
					details.cost = usage.cost;
					if (message.stopReason === "error") details.error = typeof message.errorMessage === "string" ? message.errorMessage : "模型返回错误";
				}
			});
			const stop = () => {
				if (!details.stoppedBy) details.stoppedBy = "aborted";
				void session.abort();
			};
			signal?.addEventListener("abort", stop, { once: true });
			try {
				await session.prompt(`${role.instructions}\n\n## Task\n\n${prompt}`, { source: "rpc" });
				await session.waitForIdle();
			} finally {
				signal?.removeEventListener("abort", stop);
				unsubscribe();
			}

			const reply = session.getLastAssistantText()?.trim() ?? "";
			details.activity = null;
			details.status = details.stoppedBy ? "stopped" : details.error && !reply ? "failed" : "done";
			update();
			const note =
				details.stoppedBy === "maxTurns"
					? `\n\n[The subagent reached its limit of ${role.maxTurns} turns and stopped; the reply above may be incomplete.]`
					: details.stoppedBy === "aborted"
						? "\n\n[The user stopped the subagent.]"
						: "";
			if (details.status === "failed") throw new Error(`the subagent failed: ${details.error}`);
			return { content: [{ type: "text", text: (reply || "(the subagent gave no final reply)") + note }], details };
		} finally {
			parent.absorbSubagent(usage, files);
			await runtime?.dispose().catch(() => {});
			this.release();
		}
	}
}

/** Approval dialogs from a subagent say which one asks (they appear in the parent conversation). */
function labelApprovals(ui: ExtensionUIContext, who: string): ExtensionUIContext {
	return {
		...ui,
		select: (title, options, opts) => ui.select(title.startsWith(APPROVAL_TITLE) ? `${title}\n\n（来自子 Agent「${who}」）` : title, options, opts),
	};
}
