import type { Core, CoreModule } from "../core.ts";
import type { Run } from "../runs.ts";
import { textOf } from "../runs.ts";
import type { Slot } from "../slots/slot.ts";
import type { Llm } from "./llm.ts";

const SYSTEM = "你为对话生成简短标题。只输出标题本身：不超过 14 个字，不要引号、标点结尾或解释。用对话所用的语言。";

/**
 * Names a session after its first exchange, with the auxiliary model, unless
 * the user (or Pi) already named it. The name is Pi's own session name, so
 * the CLI shows it too.
 */
export class AutoTitle implements CoreModule {
	private readonly core: Core;
	private readonly llm: Llm;
	private readonly pending = new Set<string>();

	constructor(core: Core, llm: Llm) {
		this.core = core;
		this.llm = llm;
	}

	onRunFinished(slot: Slot, run: Run): void {
		if (run.status !== "done" || !this.core.settings.get().autoTitle) return;
		void this.title(slot).catch((error) => this.core.log.warn("auto title failed", error));
	}

	async title(slot: Slot): Promise<string | undefined> {
		if (slot.isSideConversation) return undefined;
		const session = slot.session;
		if (session.sessionName || this.pending.has(slot.slotId)) return undefined;
		const messages = session.messages as unknown as { role: string; content: unknown }[];
		const user = messages.find((m) => m.role === "user");
		const answer = messages.find((m) => m.role === "assistant" && textOf(m.content));
		if (!user || !answer) return undefined;
		this.pending.add(slot.slotId);
		try {
			const raw = await this.llm.complete(`用户：${textOf(user.content).slice(0, 1500)}\n\n助手：${textOf(answer.content).slice(0, 1500)}`, {
				context: { purpose: "auto_title", workspace: slot.info().cwd, sessionId: session.sessionManager.getSessionId(), runId: slot.currentRun?.id, slotId: slot.slotId },
				system: SYSTEM,
				maxTokens: 64,
				sessionModel: slot.info().model,
				timeoutMs: 30_000,
			});
			const title = cleanTitle(raw);
			// The user may have renamed it meanwhile, or the slot moved on.
			if (!title || slot.session !== session || session.sessionName) return undefined;
			session.setSessionName(title);
			return title;
		} finally {
			this.pending.delete(slot.slotId);
		}
	}
}

export function cleanTitle(raw: string): string {
	const line = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
	return line
		.replace(/^(标题|title)\s*[:：]\s*/i, "")
		.replace(/^["'“”‘’《「【]+|["'“”‘’》」】。.!！]+$/g, "")
		.trim()
		.slice(0, 24);
}
