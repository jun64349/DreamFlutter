import { requireStr, RpcError, type Core, type CoreModule } from "../../core.ts";
import { PERSONAS, personaPrompt } from "./presets.ts";
import { ProactiveChat } from "./proactive.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Slot } from "../../slots/slot.ts";

export type AutonomyKind = "rule" | "goal_self" | "learning" | "skill" | "chat";
const requiredLevel: Record<AutonomyKind, number> = { rule: 0, goal_self: 1, chat: 1, learning: 2, skill: 2 };
const levels = { low: 0, mid: 1, high: 2 };

export class PersonaModule implements CoreModule {
	private readonly core: Core;
	private unlisten?: () => void;
	readonly proactive: ProactiveChat;

	constructor(core: Core, clock: () => number = Date.now) {
		this.core = core;
		this.proactive = new ProactiveChat(core, () => this.allows("chat"), clock);
		core.register("persona.presets", () => Object.entries(PERSONAS).map(([id, { name, description, example }]) =>
			({ id, name, description, example })));
		core.register("persona.proactivity.allows", p => {
			const kind = requireStr(p.kind, "kind");
			if (!Object.hasOwn(requiredLevel, kind)) throw new RpcError("bad_request", "未知的蝶君自主行动类型");
			return this.allows(kind as AutonomyKind);
		});
	}

	allows(kind: AutonomyKind): boolean {
		return levels[this.core.settings.get().butterflyProactivity] >= requiredLevel[kind];
	}

	prompt(): string {
		return personaPrompt(this.core.settings.get().butterflyPersona);
	}

	start(): void {
		this.proactive.recover();
		this.unlisten = this.core.onBroadcast(message => {
			if (message.event === "sessions.changed" && message.batchId) this.proactive.reconcileDeletedMessages();
		});
	}

	onSlotEvent(slot: Slot, event: AgentSessionEvent): void {
		this.proactive.onSlotEvent(slot, event);
	}

	stop(): Promise<void> {
		this.unlisten?.();
		return this.proactive.stop();
	}
}
