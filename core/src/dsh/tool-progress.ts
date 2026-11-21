import { createHash } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

declare module "@deepseek-ai/dsh-llm" {
	interface MessageSourceMap {
		"dreamflutter-tool-progress": { kind: "dreamflutter-tool-progress" };
	}
}

const READ_TOOLS = new Set(["read", "read_document", "grep", "glob", "find", "ls"]);
const REPEATED_STEPS = 3;
const REDIRECT = "The last three tool steps repeated the same read-only calls and returned identical results. Use what is already in the conversation. Continue with a different check if it can add evidence, or report what you verified and what remains open.";

/** Detect only consecutive, unchanged read batches. A long or varied task keeps its usual budget. */
export function bindToolProgress(ctx: Context, agent: Agent): void {
	const calls = new Map<string, { key: string; digest?: string }>();
	let readOnly = true;
	let previous: string | undefined;
	let repeated = 0;
	const reset = () => { previous = undefined; repeated = 0; };
	ctx.on("session/event", (session, event) => {
		if (session !== agent.session) return;
		switch (event.type) {
			case "turn/start":
				reset();
				break;
			case "step/start":
				calls.clear();
				readOnly = true;
				break;
			case "tool/call":
				if (READ_TOOLS.has(event.data.name)) {
					calls.set(event.data.callId, { key: JSON.stringify([event.data.name, event.data.arguments]) });
				} else {
					readOnly = false;
				}
				break;
			case "tool/result": {
				if (!readOnly) break;
				const { message } = event.data;
				const call = calls.get(message.toolCallId);
				if (!call || !message.content.every(block => block.type === "text")) {
					readOnly = false;
					break;
				}
				call.digest = createHash("sha256").update(JSON.stringify([call.key, message.isError, message.content])).digest("hex");
				break;
			}
			case "step/end": {
				const digests = [...calls.values()].flatMap(call => call.digest ?? []);
				if (!readOnly || digests.length === 0 || digests.length !== calls.size) {
					reset();
					break;
				}
				const signature = digests.sort().join(":");
				repeated = signature === previous ? repeated + 1 : 1;
				previous = signature;
				break;
			}
		}
	});
	ctx.on("agent/pre-step", async ({ agent: source, messages }, next) => {
		if (source !== agent) return next();
		if (messages.some(message => message.source.kind === "user")) reset();
		const decision = await next();
		if (decision.kind !== "enter" || repeated !== REPEATED_STEPS) return decision;
		return { ...decision, messages: [
			...decision.messages,
			createUserMessage({ content: [{ type: "text", text: REDIRECT }], source: { kind: "dreamflutter-tool-progress" } }),
		] };
	});
}
