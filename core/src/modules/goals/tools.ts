import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

export const GOAL_TOOLS = ["goal_status", "goal_update", "goal_report", "goal_wait"];

type ToolAction = (name: string, args: Record<string, unknown>) => { line: string; data?: unknown };
const str = { type: "string" };
const obj = { type: "object", additionalProperties: true };
const strings = { type: "array", items: str };

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], run: ToolAction): ToolDefinition {
	return {
		name, label: name, description,
		parameters: { type: "object", properties, required } as never,
		async execute(_id, args) {
			const result = run(name, args as Record<string, unknown>);
			return { content: [{ type: "text", text: result.data === undefined ? result.line : JSON.stringify(result.data) }], details: { line: result.line } };
		},
	};
}

export function registerGoalTools(pi: ExtensionAPI, run: ToolAction, propose: ToolAction): void {
	for (const entry of [
		tool("goal_status", "Read the goal, pending acceptance checks, jobs and remaining budget.", {}, [], run),
		tool("goal_update", "Propose a revision requested in the user's latest message. Expanding authority requires user approval.", { spec: obj, scope: obj, why: str }, [], run),
		tool("goal_report", "Signal that the goal looks complete, blocked, or needs user input. The scheduler decides after verification.",
			{ status: { type: "string", enum: ["done", "blocked", "needs_user"] }, note: str, questions: strings }, ["status"], run),
		tool("goal_wait", "Register a real job ID, a named external event or linked schedule, or the concrete questions to ask the user.",
			{ kind: { type: "string", enum: ["compute", "external", "user"] }, jobId: str, event: str, ref: str, label: str, deadline: { type: "number" }, questions: strings }, ["kind"], run),
		tool("goal_propose", "Offer an optional goal card for this explicit multi-stage request with a named deliverable and scope. Continue replying and working normally.",
			{ title: str, boundary: str, allowedPaths: strings, spec: obj, budget: obj }, ["title", "boundary", "spec"], propose),
	]) pi.registerTool(entry);
}
