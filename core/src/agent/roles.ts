/**
 * Role cards: agents the main agent can send off to work (docs/v0.3-design.md).
 * Subagents now; the memory agent (0.5) and 蝶君 (3.5) become role cards too.
 */

export interface RoleCard {
	id: string;
	/** What the window shows. */
	name: string;
	/** For the main agent: when to send this one. */
	description: string;
	/** For the subagent: its job and how to hand back. */
	instructions: string;
	/** Tools it may use (standard-mode names); null = every standard tool a subagent may have. */
	tools: string[] | null;
	/** provider/id or a model group; null = the main agent's model. */
	model: string | null;
	/** Turns before it stops and hands back what it has. */
	maxTurns: number;
}

/** Never given to a subagent: no nesting, nobody to ask, no plan or todo of its own. */
export const SUBAGENT_EXCLUDED_TOOLS = new Set(["agent", "ask_user_question", "exit_plan_mode", "todo_write"]);

const HAND_BACK =
	"You are a subagent: the main agent sent you this task and only sees your final reply, not your steps. " +
	"You cannot ask the user anything; when something is unclear, make a reasonable choice and say which. " +
	"End with a final reply that stands on its own: what you found or did, with file paths and the key facts the main agent needs. " +
	"Keep it short; put long material in a file and give its path.";

export const BUILT_IN_ROLES: RoleCard[] = [
	{
		id: "general",
		name: "通用",
		description: "Carries out a complete subtask on its own (research, writing, editing files, running commands) and reports back.",
		instructions: HAND_BACK,
		tools: null,
		model: null,
		maxTurns: 40,
	},
	{
		id: "explore",
		name: "调研员",
		description: "Read-only: searches and reads files, documents and web pages to answer a question. Changes nothing. Use it to look things up without filling your own context.",
		instructions: `${HAND_BACK} You only read: do not change files or run commands that change anything.`,
		tools: ["read", "glob", "grep", "web_fetch", "read_document", "read_image", "working_directory", "skill"],
		model: null,
		maxTurns: 30,
	},
];

export function roleById(id: string | undefined): RoleCard | undefined {
	return BUILT_IN_ROLES.find((r) => r.id === (id ?? "general"));
}

/** The tools [role] gets out of those the session has. */
export function roleTools(role: RoleCard, available: string[]): string[] {
	return available.filter((name) => !SUBAGENT_EXCLUDED_TOOLS.has(name) && (role.tools === null || role.tools.includes(name)));
}
