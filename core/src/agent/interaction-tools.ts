import { readFile } from "node:fs/promises";
import { stripFrontmatter, type ExtensionContext, type Skill, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { INFO_TITLE } from "../pi/dialogs.ts";
import { skillContent } from "./dsh-text.ts";
import { skillNameErrors } from "../modules/skill-name.ts";
import type { HarnessState, TodoItem } from "./state.ts";

/**
 * dsh's collaboration tools: todo_write (packages/todo/tool-todo),
 * ask_user_question (packages/interaction/tool-ask-user), exit_plan_mode
 * (packages/plan/plan-mode) and skill (packages/skill/tool-skill). Questions
 * reach the user through the window's ordinary choice dialogs.
 */

export const QUESTION_TITLE = `${INFO_TITLE}：`;
export const PLAN_REVIEW_TITLE = "请审阅 Agent 的计划";
export const PLAN_APPROVE = "批准，开始执行";
export const PLAN_KEEP = "继续修改计划";
const SKIP = "跳过这个问题";
const OWN_ANSWER = "自己回答…";

const STATUSES = ["pending", "in_progress", "completed"] as const;

export function todoTool(state: HarnessState, changed: (todos: TodoItem[]) => void): ToolDefinition {
	return {
		name: "todo_write",
		label: "待办",
		description:
			"Record and update a task list to plan multi-step work and show progress; skip it for trivial " +
			"single-step tasks. Add one todo per concrete step before you start. " +
			"While work remains, keep the todos being worked on `in_progress`, several only when work runs in parallel. " +
			"Mark each todo `completed` as soon as it is done.",
		parameters: {
			type: "object",
			properties: {
				todos: {
					type: "array",
					description: "The COMPLETE task list, replacing any previous list.",
					items: {
						type: "object",
						properties: {
							content: { type: "string", description: "What the task is — a short imperative line." },
							status: { type: "string", enum: [...STATUSES], description: "pending (not started) | in_progress (now) | completed (done)." },
						},
						additionalProperties: false,
						required: ["content", "status"],
					},
				},
			},
			required: ["todos"],
		} as never,
		async execute(_id, params: { todos: { content: string; status: string }[] }) {
			const todos: TodoItem[] = [];
			const seen = new Set<string>();
			for (const item of params.todos) {
				const content = item.content.trim();
				if (content.length === 0) throw new Error("invalid todo: `content` must be a non-empty string");
				if (seen.has(content)) throw new Error(`invalid todos: duplicate content ${JSON.stringify(content)}`);
				seen.add(content);
				todos.push({ content, status: item.status as TodoItem["status"] });
			}
			state.todos = todos;
			changed(todos);
			const count = (s: TodoItem["status"]) => todos.filter((t) => t.status === s).length;
			return {
				content: [{ type: "text", text: `Updated todo list: ${count("pending")} pending, ${count("in_progress")} in progress, ${count("completed")} completed.` }],
				details: { todos },
			};
		},
	};
}

interface Question {
	id: string;
	question: string;
	header?: string;
	options?: { label: string; description?: string }[];
	multi_select?: boolean;
}

interface Answer {
	id: string;
	selected: string[];
	custom?: string;
	/** Nobody answered in time: the recommended option (or a skip) was taken. */
	timedOut?: true;
}

/** The option the model recommended (first marked one), else the first. */
export function recommendedOption(options: { label: string }[]): { label: string } | undefined {
	return options.find((o) => /\((recommended)\)|（推荐）|\(推荐\)/i.test(o.label)) ?? options[0];
}

/**
 * Asks one question with the window's choice dialog; undefined when dismissed.
 * With [timeoutMs], an unanswered question takes the recommended option
 * (a free-text one is skipped) so a run does not stall while the user is
 * away (extra test 12). Approvals never time out into a yes; only questions do.
 */
async function ask(ctx: ExtensionContext, question: Question, timeoutMs: number, now: () => number): Promise<Answer | undefined> {
	const options = question.options ?? [];
	const labels = options.map((o) => (o.description ? `${o.label} — ${o.description}` : o.label));
	const title = `${QUESTION_TITLE}${question.header ? `${question.header}\n\n` : "\n\n"}${question.question}`;
	const timeout = timeoutMs > 0 ? timeoutMs : undefined;
	const started = now();
	// The bridge settles a timed-out dialog like a dismissed one; the clock tells them apart.
	const timedOut = () => timeout !== undefined && now() - started >= timeout - 50 && !ctx.signal?.aborted;
	if (labels.length === 0) {
		const typed = await ctx.ui.input(`${title}\n\n（请直接输入回答）`, "", { signal: ctx.signal, timeout });
		if (typed === undefined) return timedOut() ? { id: question.id, selected: [], timedOut: true } : undefined;
		return typed.trim() === "" ? { id: question.id, selected: [] } : { id: question.id, selected: [], custom: typed };
	}
	const choice = await ctx.ui.select(title, [...labels, OWN_ANSWER, SKIP], { signal: ctx.signal, timeout });
	if (choice === undefined && timedOut()) return { id: question.id, selected: [recommendedOption(options)!.label], timedOut: true };
	if (choice === undefined) return undefined;
	if (choice === SKIP) return { id: question.id, selected: [] };
	if (choice === OWN_ANSWER) {
		// Typing an answer is the user at work: no timer.
		const typed = await ctx.ui.input(title, "", { signal: ctx.signal });
		if (typed === undefined) return undefined;
		return typed.trim() === "" ? { id: question.id, selected: [] } : { id: question.id, selected: [], custom: typed };
	}
	return { id: question.id, selected: [options[labels.indexOf(choice)]!.label] };
}

export function askUserTool(timeoutMs: () => number = () => 0, now: () => number = Date.now): ToolDefinition {
	return {
		name: "ask_user_question",
		label: "提问",
		description:
			"Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. " +
			"An answer item with empty selected and no custom means the user skipped that question: " +
			"continue without it, do not ask it again, and do not treat the skip as permission.",
		parameters: {
			type: "object",
			properties: {
				questions: {
					type: "array",
					description: "Questions to ask the user before continuing.",
					items: {
						type: "object",
						properties: {
							id: { type: "string", description: "Stable id for this question; echoed in the answer." },
							question: { type: "string", description: "The specific question to ask the user." },
							header: { type: "string", description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".' },
							options: {
								type: "array",
								description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
								items: {
									type: "object",
									properties: {
										label: { type: "string", description: "Short user-facing option label." },
										description: { type: "string", description: "One sentence explaining the tradeoff or impact." },
									},
									additionalProperties: true,
									required: ["label"],
								},
							},
							multi_select: { type: "boolean", description: "Whether the user may select more than one option. Defaults to false." },
						},
						additionalProperties: true,
						required: ["id", "question"],
					},
				},
			},
			required: ["questions"],
		} as never,
		async execute(_id, params: { questions: Question[] }, _signal, _update, ctx) {
			if (!ctx.hasUI) throw new Error("no user-questions channel is available");
			const answers: Answer[] = [];
			const limit = timeoutMs();
			for (const question of params.questions) {
				const answer = await ask(ctx, question, limit, now);
				if (!answer) throw new Error("the user dismissed the question");
				answers.push(answer);
			}
			const auto = answers.filter((a) => a.timedOut);
			const note =
				auto.length === 0
					? ""
					: `\nThe user did not answer within ${Math.round(limit / 1000)} seconds (they may be away), so ${auto.length === answers.length ? "every answer was" : "the answers marked timedOut were"} taken automatically: the recommended option, or a skip for open questions. Say so briefly in your reply and keep going; they can correct you later.`;
			return { content: [{ type: "text", text: JSON.stringify({ answers }) + note }], details: { answers } };
		},
	};
}

export function exitPlanModeTool(state: HarnessState, planModeChanged: (on: boolean) => void): ToolDefinition {
	return {
		name: "exit_plan_mode",
		label: "提交计划",
		description:
			"Use only in plan mode. Present your plan for the user's review and, on approval, leave plan mode. " +
			"The user may approve (carry out the plan from your next step) or keep " +
			"planning — their feedback comes back in the tool result; revise and present again.",
		parameters: {
			type: "object",
			properties: {
				plan: { type: "string", description: "The complete plan, as markdown, starting with a # heading that names it." },
			},
			required: ["plan"],
		} as never,
		async execute(_id, params: { plan: string }, _signal, _update, ctx) {
			if (!state.planMode) throw new Error("exit_plan_mode is only available in plan mode");
			if (!/^#\s+\S/.test(params.plan.trim())) throw new Error("exit_plan_mode requires a non-empty markdown plan starting with a # heading");
			if (!ctx.hasUI) throw new Error("no user-questions channel is available to review the plan; ask the user to switch the session mode instead");
			const choice = await ctx.ui.select(`${PLAN_REVIEW_TITLE}\n\n${params.plan}`, [PLAN_APPROVE, PLAN_KEEP], { signal: ctx.signal });
			if (choice === undefined) {
				return {
					content: [{ type: "text", text: "The user dismissed the plan review to reply in their own words; plan mode remains active." }],
					details: { approved: false, plan: params.plan },
					terminate: true,
				};
			}
			if (choice !== PLAN_APPROVE) {
				const feedback = (await ctx.ui.input("对计划的修改意见（可以留空）", "", { signal: ctx.signal }))?.trim() ?? "";
				throw new Error(feedback === "" ? "The user chose to keep planning; revise the plan and present it again." : `The user chose to keep planning; their feedback: ${feedback}`);
			}
			state.planMode = false;
			// The model learns about the switch from this result, not from a narration.
			state.planModeTold = false;
			planModeChanged(false);
			return {
				content: [{ type: "text", text: "Plan approved — plan mode exited; carry out the plan starting with your next step." }],
				details: { approved: true, plan: params.plan },
			};
		},
	};
}

export function skillTool(skills: () => Skill[], state?: HarnessState): ToolDefinition {
	return {
		name: "skill",
		label: "技能",
		description: "Load the full instructions for a skill. Call it before acting on a task that names or clearly matches a skill in the session skill catalog.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "The exact skill name from the available skills list." },
			},
			required: ["name"],
		} as never,
		async execute(_id, params: { name: string }) {
			const nameDiagnostics = skillNameErrors(params.name);
			const skill = skills().find((s) => s.name === params.name);
			if (!skill) throw new Error(`skill "${params.name}" is unknown or no longer available${nameDiagnostics.length ? `: ${nameDiagnostics.join("; ")}` : ""}`);
			if (skill.disableModelInvocation) throw new Error(`skill "${params.name}" is not available for model invocation`);
			await state?.security?.authorize(skill.filePath, "skill");
			const raw = await readFile(skill.filePath, "utf8");
			const content = stripFrontmatter(state?.security ? await state.security.read(skill.filePath, raw) : raw).trim();
			return { content: [{ type: "text", text: skillContent(skill.name, skill.baseDir, content) }], details: { name: skill.name, path: skill.filePath, nameDiagnostics } };
		},
	};
}
