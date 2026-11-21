import type { Context } from "@deepseek-ai/cordis";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const GOAL_TOOLS = ["goal_status", "goal_update", "goal_report", "goal_wait"];

type ToolAction = (name: string, args: Record<string, unknown>) => { line: string; data?: unknown };
const str = { type: "string" };
const obj = { type: "object", additionalProperties: true };
const strings = { type: "array", items: str };

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
	return { name, description, parameters: { type: "object" as const, properties, required } };
}

const goalDefinitions = [
	tool("goal_status", "Read the goal, pending acceptance checks, jobs and remaining budget.", {}, []),
	tool("goal_update", "Propose a revision requested in the user's latest message. Expanding authority requires user approval.", { spec: obj, scope: obj, why: str }, []),
	tool("goal_report", "Signal that the goal looks complete, blocked, or needs user input. The scheduler decides after verification.",
		{ status: { type: "string", enum: ["done", "blocked", "needs_user"] }, note: str, questions: strings }, ["status"]),
	tool("goal_wait", "Register a real job ID, a named external event or linked schedule, or the concrete questions to ask the user.",
		{ kind: { type: "string", enum: ["compute", "external", "user"] }, jobId: str, event: str, ref: str, label: str, deadline: { type: "number" }, questions: strings }, ["kind"]),
];
const proposeDefinition = tool("goal_propose", "Offer an optional goal card for this explicit multi-stage request with a named deliverable and scope. Continue replying and working normally.",
	{ title: str, boundary: str, allowedPaths: strings, spec: obj, budget: obj }, ["title", "boundary", "spec"]);

export function registerGoalTools(pi: ExtensionAPI, run: ToolAction, propose: ToolAction): void {
	for (const definition of [...goalDefinitions, proposeDefinition]) pi.registerTool({
		...definition, label: definition.name, parameters: definition.parameters as never,
		async execute(_id, args) {
			const invoke = definition === proposeDefinition ? propose : run;
			const result = invoke(definition.name, args as Record<string, unknown>);
			return { content: [{ type: "text", text: result.data === undefined ? result.line : JSON.stringify(result.data) }], details: { line: result.line } };
		},
	});
}

/** Goal control lives in the scheduler. Both runtimes expose the same tool schema. */
export function registerDshGoalTools(ctx: Context, enabled: () => boolean,
	invoke: (name: string, args: Record<string, unknown>, callId: string) => ReturnType<ToolAction>): void {
	for (const definition of goalDefinitions) {
		ctx.tools.register({
			name: definition.name, description: definition.description,
			parameters: JSON.parse(JSON.stringify(definition.parameters)),
			output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
			async execute(args, execution) {
				const result = invoke(definition.name, args as Record<string, unknown>, execution.callId);
				return result.data === undefined ? result.line : JSON.stringify(result.data);
			},
		}, { when: enabled });
	}
}
