import type { Context } from "@deepseek-ai/cordis";
import { normalizeBinding } from "@deepseek-ai/dsh-client-shortcuts/protocol";

declare module "@deepseek-ai/cordis" {
	interface Context {
		dfWindowShortcuts: readonly WindowShortcut[];
	}
}

interface WindowShortcut {
	command: "spending.open";
	key: string;
	control: boolean;
	shift: boolean;
}

export const name = "dreamflutter-window-shortcuts";
export const inject: string[] = [];

export function apply(ctx: Context): void {
	const binding = normalizeBinding({ code: "KeyU", modifiers: ["control", "shift"] }, "windows");
	ctx.provide("dfWindowShortcuts", [{
		command: "spending.open", key: binding.code,
		control: binding.modifiers.includes("control"), shift: binding.modifiers.includes("shift"),
	}] satisfies WindowShortcut[]);
}
