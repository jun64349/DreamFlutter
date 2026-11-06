import type { AssistantMessage, Message, Model, Tool } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * The memory agent (docs/memory-design.md §5): a role whose limits the
 * program sets, not its prompt. It runs as a small loop in the background
 * process: no Pi session, no shell, files, network or search, no execution
 * environment at all; its only tools read the memory store in the scope it
 * was given and propose changes, which the store's gate checks.
 */

export const MEMORY_ROLE = {
	id: "memory",
	name: "记忆整理",
	/** Turns before it stops (§5). */
	maxTurns: 20,
	tools: ["memory_query", "memory_propose_ops"],
} as const;

export interface MemoryToolHandlers {
	/** Answers memory_query; returns text for the model. */
	query(args: Record<string, unknown>): string;
	/** Applies memory_propose_ops through the gate; returns what happened, item by item. */
	propose(args: Record<string, unknown>): string;
}

export interface AgentRun {
	turns: number;
	/** The final text (a short account of what it did). */
	summary: string;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	calls: { provider: string; model: string; at: number; usage: AgentRun["usage"] }[];
	stoppedBy?: "maxTurns" | "error";
	error?: string;
}

export const QUERY_TOOL: Tool = {
	name: "memory_query",
	description: "Look up memory items in the scope of this job: by words, ids, level, kind or status. Returns id, version, level, kind, status, confidence, dates and text.",
	parameters: {
		type: "object",
		properties: {
			query: { type: "string", description: "Words to look for" },
			ids: { type: "array", items: { type: "string" } },
			level: { type: "integer", enum: [1, 2, 3] },
			kind: { type: "string" },
			status: { type: "string", description: "active (default), review, archived, superseded, outdated, ended…" },
		},
	} as never,
};

export const PROPOSE_TOOL: Tool = {
	name: "memory_propose_ops",
	description:
		"Propose changes to memory. Each op is checked by the program (scope, version, what this job may do) and applied, sent to the user, or refused with a reason; you get the result per op. " +
		"Every op needs a reason. Changing an existing item needs the version you read (memory_query). One fact per item, about the user in the third person.",
	parameters: {
		type: "object",
		properties: {
			ops: {
				type: "array",
				items: {
					type: "object",
					properties: {
						action: {
							type: "string",
							enum: ["add", "update", "set_status", "combine", "keep", "promote", "demote", "conflict", "material"],
							description:
								"add a new item; update an item's text or details; set_status of an item; combine several items into one new item (they are retired); keep = still right as it is (records the check); promote / demote = one level up or down (the program checks the evidence for promote); conflict = the item (id) contradicts another (with) and you cannot tell which is right: it is marked for review; material = a short snapshot text (content) standing for several items (from), marked with their #ids. Which actions a job allows is said in its instructions.",
						},
						id: { type: "string", description: "update / set_status / keep / promote / demote / conflict: the item" },
						version: { type: "integer", description: "the version of [id] you read" },
						with: { type: "string", description: "conflict: the item it contradicts" },
						from: { type: "array", items: { type: "object", properties: { id: { type: "string" }, version: { type: "integer" } } }, description: "combine: the items it replaces; material: the items the text stands for" },
						retire_as: { type: "string", enum: ["archived", "superseded"], description: "combine: archived = distilled into the new item (kept, out of daily use); superseded = plain duplicates" },
						content: { type: "string" },
						kind: { type: "string", enum: ["preference", "background", "experience", "decision", "progress", "agreement", "observation", "persona"] },
						scope: { type: "string", enum: ["global", "here"], description: "add / combine: global = applies everywhere; here = this workspace (or 蝶君's partition). When unsure, here." },
						said: { type: "boolean", description: "add: the user said it themselves (false = your inference)" },
						status: { type: "string", enum: ["review", "outdated", "archived", "ended", "refuted", "superseded", "active"], description: "set_status" },
						conditions: { type: "string", description: "When it applies (version, project, situation)" },
						valid_until: { type: "string", description: "YYYY-MM-DD when it stops being true, if known" },
						evidence: { type: "string", description: "Short quote or fact it rests on" },
						reason: { type: "string" },
					},
					required: ["action", "reason"],
				},
			},
		},
		required: ["ops"],
	} as never,
};

/**
 * Runs the memory agent on [input] until it answers without calling a tool,
 * reaches the turn cap, or fails. Tool calls are answered by [handlers].
 */
export async function runMemoryAgent(options: {
	runtime: ModelRuntime;
	model: Model<never>;
	system: string;
	input: string;
	handlers: MemoryToolHandlers;
	maxTurns?: number;
	signal?: AbortSignal;
	now?: () => number;
}): Promise<AgentRun> {
	const now = options.now ?? Date.now;
	const run: AgentRun = { turns: 0, summary: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, calls: [] };
	const messages: Message[] = [{ role: "user", content: [{ type: "text", text: options.input }], timestamp: now() } as Message];
	const maxTurns = options.maxTurns ?? MEMORY_ROLE.maxTurns;
	for (;;) {
		if (run.turns >= maxTurns) {
			run.stoppedBy = "maxTurns";
			return run;
		}
		const answer = (await options.runtime.completeSimple(options.model, { systemPrompt: options.system, messages, tools: [QUERY_TOOL, PROPOSE_TOOL] }, { maxTokens: 4096, signal: options.signal } as never)) as AssistantMessage;
		run.turns++;
		const u = answer.usage;
		const usage = { input: u?.input ?? 0, output: u?.output ?? 0, cacheRead: u?.cacheRead ?? 0, cacheWrite: u?.cacheWrite ?? 0, cost: u?.cost?.total ?? 0 };
		run.calls.push({ provider: answer.provider ?? options.model.provider, model: answer.model ?? options.model.id, at: now(), usage });
		for (const key of Object.keys(usage) as (keyof typeof usage)[]) run.usage[key] += usage[key];
		if (answer.stopReason === "error" || answer.stopReason === "aborted") {
			run.stoppedBy = "error";
			run.error = answer.errorMessage ?? "模型调用失败";
			return run;
		}
		messages.push(answer as Message);
		const calls = answer.content.filter((c) => c.type === "toolCall");
		if (!calls.length) {
			run.summary = answer.content
				.filter((c) => c.type === "text")
				.map((c) => (c as { text: string }).text)
				.join("")
				.trim();
			return run;
		}
		for (const call of calls) {
			const args = (call.arguments ?? {}) as Record<string, unknown>;
			let text: string;
			let isError = false;
			try {
				if (call.name === "memory_query") text = options.handlers.query(args);
				else if (call.name === "memory_propose_ops") text = options.handlers.propose(args);
				else {
					// Only two tools exist for it: anything else is refused, whatever the model asks.
					text = `没有这个工具：${call.name}。只能用 memory_query 和 memory_propose_ops。`;
					isError = true;
				}
			} catch (error) {
				text = error instanceof Error ? error.message : String(error);
				isError = true;
			}
			messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError, timestamp: now() } as Message);
		}
	}
}
