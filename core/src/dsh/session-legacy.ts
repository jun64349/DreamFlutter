import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId, type ContentBlock, type FinishReason } from "@deepseek-ai/dsh-llm";
import { SessionSeq, type SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionManager, type SessionEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MODE_ENTRY } from "../agent/harness.ts";
import { PYTHON_BACKGROUND_RESULT } from "../agent/python-kernel.ts";
import { MEMORY_MESSAGE_TYPE } from "../memory/types.ts";
import { HISTORY_ENTRY, readSessionEntries } from "../pi/session-metadata.ts";
import type { DshSlotContent } from "./session-content.ts";
import { seedSystemHead } from "./session.ts";
import { replayEnvelope, toDshAssistantBlocks, recordedAssistantStream } from "./transport.ts";

export const DSH_ENTRY = "df.dshSession";
export const DSH_LEGACY_ENTRY = "df.dshImportedEntries";
export const LEGACY_SOURCE_ENTRY = "df.legacyContinuation";
export const HISTORICAL_DISPLAY = "dfHistoricalDisplay";

function recallTool(name: string | undefined) { return name?.startsWith("memory_") || name === "session_search"; }

/** Pi's regular file opener can repair the final newline and migrate the log. */
export function readSessionSnapshot(path: string): SessionManager {
	const entries = readSessionEntries(path) as (SessionHeader | SessionEntry)[];
	const header = entries[0];
	if (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") throw new Error("找不到可读的旧会话");
	return SessionManager.inMemory(header.cwd, undefined, entries);
}

export function readLegacySession(path: string): SessionManager | undefined {
	const snapshot = readSessionSnapshot(path);
	const id = snapshot.getSessionId();
	return snapshot.getEntries().some(entry => entry.type === "custom" && entry.customType === DSH_ENTRY && (entry.data as { id?: string } | undefined)?.id === id)
		? undefined : snapshot;
}

export function createLegacyProjection(sourcePath: string, source: SessionManager, sourceEntryId: string | null, cwd: string, sessionDir?: string): string {
	const branch = sourceEntryId === null ? [] : source.getBranch(sourceEntryId);
	const retained = branch.filter(entry => (entry.type !== "custom_message" || entry.display && entry.customType !== MEMORY_MESSAGE_TYPE) &&
		(entry.type !== "custom" || [MODE_ENTRY, "df.sandbox"].includes(entry.customType)) &&
		(entry.type !== "message" || entry.message.role === "user" || entry.message.role === "assistant" ||
			entry.message.role === "toolResult" && !recallTool(entry.message.toolName)));
	const retainedIds = new Set(retained.map(entry => entry.id));
	const positions = new Map(branch.map((entry, index) => [entry.id, index]));
	const entries = retained.map((entry, index) => {
		const parentId = retained[index - 1]?.id ?? null;
		if (entry.type === "custom_message") return { ...entry, parentId, details: { [HISTORICAL_DISPLAY]: true, original: entry.details } };
		if (entry.type === "message" && entry.message.role === "assistant") return { ...entry, parentId,
			message: { ...entry.message, content: (entry.message.content ?? []).filter(block => block.type !== "toolCall" || !recallTool(block.name)) } };
		if (entry.type === "compaction" && !retainedIds.has(entry.firstKeptEntryId)) {
			const start = positions.get(entry.firstKeptEntryId);
			const firstKeptEntryId = start === undefined ? entry.id : branch.slice(start).find(item => retainedIds.has(item.id))?.id ?? entry.id;
			return { ...entry, parentId, firstKeptEntryId };
		}
		return { ...entry, parentId };
	});
	const manager = SessionManager.create(cwd, sessionDir);
	const path = manager.newSession({ parentSession: sourcePath })!;
	const snapshot = SessionManager.inMemory(cwd, undefined, [manager.getHeader()!, ...entries]);
	const sessionId = snapshot.getSessionId();
	snapshot.appendCustomEntry(HISTORY_ENTRY, { sessionId, lastEntryId: snapshot.getLeafId() });
	snapshot.appendCustomEntry(LEGACY_SOURCE_ENTRY, { sessionId, sourceSessionId: source.getSessionId(), sourceEntryId });
	snapshot.appendCustomEntry(DSH_ENTRY, { id: sessionId, kind: "workbench", needsSeed: true });
	mkdirSync(dirname(path), { recursive: true });
	const fd = openSync(path, "wx");
	try {
		try { writeFileSync(fd, [snapshot.getHeader(), ...snapshot.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n"); }
		finally { closeSync(fd); }
	} catch (error) {
		rmSync(path, { force: true });
		throw error;
	}
	return path;
}

/** Shape the selected, compaction-aware branch into the official session seed. */
export async function buildLegacyDshSeed(manager: SessionManager, content: DshSlotContent) {
	const events: SessionEvent[] = [];
	const references: Record<string, number> = {};
	const history = manager.buildSessionProjection().entries.flatMap(entry => entry.messages.map(message => ({ entry: entry.sourceEntry, message })));
	const eligibleResults = new Set(history.flatMap(({ message }) => message.role === "toolResult" && !recallTool(message.toolName) ? [message.toolCallId] : []));
	const calls = new Set<string>();
	const branchIds = new Set(manager.getBranch().map(entry => entry.id));
	const seq = () => SessionSeq(events.length);
	let turn = 0;
	let step = 0;
	const closeTurn = (time: number) => {
		if (!step) return;
		events.push({ type: "step/end", seq: seq(), time, data: { turn, step } });
		events.push({ type: "turn/end", seq: seq(), time, data: { turn, reason: { kind: "completed" } } });
		step = 0;
	};
	const startStep = (time: number) => {
		if (step) events.push({ type: "step/end", seq: seq(), time, data: { turn, step } });
		else events.push({ type: "turn/start", seq: seq(), time, data: { turn: ++turn } });
		events.push({ type: "step/start", seq: seq(), time, data: { turn, step: ++step } });
		if (turn === 1 && step === 1) events.push(seedSystemHead(seq(), time));
	};
	const blocksFor = async (value: string | (TextContent | ImageContent)[]) => {
		const blocks = await content.toDsh(typeof value === "string" ? [{ type: "text", text: value }] : value);
		content.release(blocks);
		return blocks;
	};
	const addHistoricalContext = (entryId: string, time: number, blocks: ContentBlock[]) => {
		closeTurn(time);
		startStep(time);
		references[entryId] = seq();
		events.push({ type: "user/message", seq: seq(), time, surfaceOp: "append", data: createUserMessage({ content: blocks, source: { kind: "user" } }) });
	};
	for (const { entry, message } of history) {
		const time = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp);
		const pythonResult = message.role === "custom" && message.customType === PYTHON_BACKGROUND_RESULT && message.display;
		if (message.role === "user" || (entry.type === "compaction" && message.role !== "system") ||
			(entry.type === "branch_summary" && branchIds.has(entry.fromId)) || pythonResult) {
			const input = message.role === "user" || pythonResult ? message.content : `[旧会话${entry.type === "compaction" ? "压缩" : "分支"}摘要 · ${entry.id}]\n${entry.type === "compaction" || entry.type === "branch_summary" ? entry.summary : ""}`;
			addHistoricalContext(entry.id, time, await blocksFor(input));
		} else if (message.role === "assistant") {
			if (!step || events.at(-1)?.type !== "user/message") startStep(time);
			const retained = message.content.filter(block => block.type !== "toolCall" || !recallTool(block.name) && eligibleResults.has(block.id));
			const blocks = toDshAssistantBlocks(retained);
			const tools = blocks.filter(block => block.type === "tool-call");
			const stop: FinishReason = { kind: tools.length ? "tool-calls" : message.stopReason === "length" ? "max-tokens" : "stop" };
			const replayState = replayEnvelope({ ...message, content: retained });
			const { stream, tokens } = recordedAssistantStream(message, blocks, stop, replayState);
			references[entry.id] = seq();
			events.push({ type: "assistant/message", seq: seq(), time, surfaceOp: "append", data: { turn, step, stream,
				message: createAssistantMessage({ content: blocks, source: { provider: message.provider, model: message.model, replayState } }),
				...(tokens && { usage: tokens }) } });
			for (const tool of tools) {
				calls.add(tool.id);
				events.push({ type: "tool/call", seq: seq(), time, data: { turn, step, callId: tool.id, name: tool.name, arguments: tool.arguments } });
			}
		} else if (message.role === "toolResult" && !recallTool(message.toolName)) {
			const blocks = await blocksFor(message.content);
			if (calls.delete(message.toolCallId)) {
				references[entry.id] = seq();
				events.push({ type: "tool/result", seq: seq(), time, surfaceOp: "append", data: { turn, step,
					message: createToolResultMessage({ callId: ToolCallId(message.toolCallId), content: blocks, isError: message.isError }),
				} });
			} else {
				// A compaction may have retained a result but cut its requesting tool call.
				addHistoricalContext(entry.id, time, [{ type: "text", text: `[旧工具结果 · ${message.toolName} · ${entry.id}]` }, ...blocks]);
			}
		}
	}
	closeTurn(events.at(-1)?.time ?? Date.now());
	return { events, references };
}
