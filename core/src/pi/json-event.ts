import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * Wire form of a session event, matching Pi's RPC/JSON mode (`toJsonEvent`,
 * which the package does not export): `message_update` drops the growing
 * partial message and carries only the delta plus current usage.
 */
export function toJsonEvent(event: AgentSessionEvent): Record<string, unknown> {
	if (event.type !== "message_update") return event as unknown as Record<string, unknown>;
	const message = event.message as { role?: string; usage?: unknown };
	const delta = event.assistantMessageEvent as Record<string, unknown> & { type: string; contentIndex?: number; partial?: { content?: unknown[] } };
	let assistantMessageEvent: Record<string, unknown> = delta;
	if (delta.type === "toolcall_start") {
		const toolCall = delta.partial?.content?.[delta.contentIndex ?? -1] as { type?: string; id?: string; name?: string } | undefined;
		const { partial: _partial, ...rest } = delta;
		assistantMessageEvent = { ...rest, id: toolCall?.id, toolName: toolCall?.name };
	} else if ("partial" in delta) {
		const { partial: _partial, ...rest } = delta;
		assistantMessageEvent = rest;
	}
	return { type: "message_update", usage: message.role === "assistant" ? message.usage : undefined, assistantMessageEvent };
}
