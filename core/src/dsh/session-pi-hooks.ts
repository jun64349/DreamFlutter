import type { Context } from "@deepseek-ai/cordis";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { MEMORY_MESSAGE_TYPE } from "../memory/types.ts";
import { HISTORICAL_DISPLAY } from "./session-legacy.ts";

const WORKBENCH_PROMPT = "dreamflutter-workbench";

/** Adapt the installed workbench's preflight and current context to official DSH assembly. */
export class DshWorkbenchHooks {
	private systemPrompt: string;
	private readonly session: AgentSession;
	private readonly memoryAvailable: () => boolean;
	private readonly prepareInput: (id: string, prompt: string) => Promise<void>;
	private readonly claimed: { id: string; prompt: string }[] = [];

	constructor(session: AgentSession, memoryAvailable: () => boolean, prepareInput: (id: string, prompt: string) => Promise<void>) {
		this.session = session;
		this.memoryAvailable = memoryAvailable;
		this.prepareInput = prepareInput;
		this.systemPrompt = session.systemPrompt;
	}

	get compactionSystemPrompt(): string {
		return this.systemPrompt;
	}

	async input(text: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp") {
		const runner = this.session.extensionRunner;
		if (text.startsWith("/")) {
			const trimmed = text.trimEnd();
			const separator = trimmed.search(/\s/);
			const name = trimmed.slice(1, separator < 0 ? undefined : separator);
			const command = runner.getRegisteredCommands().find(command => command.invocationName === name);
			if (command) {
				await command.handler(separator < 0 ? "" : trimmed.slice(separator).trimStart(), runner.createCommandContext());
				return undefined;
			}
		}
		const result = await runner.emitInput(text, images, "rpc", streamingBehavior);
		if (result.action === "handled") return undefined;
		return result.action === "transform" ? { text: result.text, images: result.images ?? images } : { text, images };
	}

	async prepare(text: string, images?: ImageContent[]): Promise<void> {
		const session = this.session;
		const baseTools = session.getActiveToolNames();
		const start = await session.extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: text, images }, {
			cwd: session.sessionManager.getCwd(), selectedTools: baseTools, forceSystemPrompt: session.systemPrompt,
		});
		this.systemPrompt = start.systemPromptOptions.forceSystemPrompt ?? session.systemPrompt;
		const selected = start.systemPromptOptions.selectedTools;
		if (selected.length !== baseTools.length || selected.some((tool, index) => tool !== baseTools[index])) session.setActiveToolsByName(selected);
		for (const message of start.messages) {
			session.sessionManager.appendCustomMessageEntry(message.customType, message.content ?? [], message.display, message.details);
		}
		if (start.messages.length) session.refreshContext();
	}

	bind(ctx: Context): void {
		ctx.systemPrompt.section({ name: WORKBENCH_PROMPT, order: 0, interpolate: false, text: () => this.systemPrompt });
		ctx.on("agent/inbox/claimed", ({ message }) => {
			if (message.source.kind !== "user") return;
			const prompt = message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
			this.claimed.push({ id: message.id, prompt });
		});
		ctx.on("system-prompt/assemble", async (_assembly, _subject, next) => {
			const assembly = await next();
			const claimed = this.claimed.splice(0);
			if (this.memoryAvailable() && claimed.length) {
				for (const input of claimed) await this.prepareInput(input.id, input.prompt);
				this.session.refreshContext();
			}
			const input = this.session.messages.filter(message => this.memoryAvailable() || message.role !== "custom" || message.customType !== MEMORY_MESSAGE_TYPE);
			const current = await this.session.extensionRunner.emitContext(input);
			const contexts = new Map<string, string>();
			for (const message of current) {
				if (message.role !== "custom" || (message.customType === MEMORY_MESSAGE_TYPE && !this.memoryAvailable()) ||
					(message.details as Record<string, unknown> | undefined)?.[HISTORICAL_DISPLAY] === true) continue;
				const text = typeof message.content === "string" ? message.content : message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
				contexts.set(message.customType, text);
			}
			return { ...assembly, sections: assembly.sections.map(section => section.name === WORKBENCH_PROMPT
				? { ...section, text: [section.text, ...contexts.values()].filter(Boolean).join("\n\n") }
				: section) };
		});
	}
}
