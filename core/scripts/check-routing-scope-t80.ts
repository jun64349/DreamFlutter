/** Free preflight: real session plumbing must preserve per-prompt budget scope across simultaneous model/tool turns. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RoutingPromptScopes } from "./routing-scope-t80.ts";
import { ledgerContext } from "../src/ledger/types.ts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { startTestCore, settledCount } from "../test/harness.ts";
import { textOf } from "../src/runs.ts";

const t = await startTestCore(), scopes = new RoutingPromptScopes(), seen: string[] = [];
try {
	t.core.sandboxProvider = () => ({ distro: "df-t80-free-scope-only", ready: async () => {}, online: () => false });
	const respond = (context: import("@earendil-works/pi-ai").Context) => {
		const user = context.messages.filter(m => m.role === "user").map(m => textOf(m.content)).join("\n"), id = user.match(/scope-s?[abc]/)?.[0];
		assert.ok(id); assert.equal(scopes.find(context, ledgerContext().slotId), id); scopes.increment(id); seen.push(id);
		return context.messages.some(m => m.role === "toolResult") ? fauxAssistantMessage("done") : fauxAssistantMessage([fauxToolCall("working_directory", {})], { stopReason: "toolUse" });
	};
	for (const sandbox of [false, true]) {
		const ids = ["a", "b", "c"].map(letter => `scope-${sandbox ? "s" : ""}${letter}`);
		for (const id of ids) { const cwd = join(t.workspace, id); mkdirSync(cwd); scopes.start(id, cwd); await t.core.call("slot.open", { slotId: id, cwd, sandbox }, t.client); }
		t.respond(...Array.from({length:6}, () => respond));
		const results = await Promise.allSettled(ids.map(id => t.send(id, { type: "prompt", message: `Check per-prompt request scope ${id}` })));
		for (const result of results) assert.equal(result.status, "fulfilled");
		await t.waitFor(() => ids.every(id => settledCount(t.records(id)) === 1));
	}
	if (!seen.length) console.log(JSON.stringify({ assistantErrors: t.messages.filter(m => m.event === "slot.record").map(m => m.record as Record<string, any>).filter(r => r.type === "message_end" && r.message?.role === "assistant").map(r => r.message.errorMessage) }));
	assert.deepEqual(seen.sort(), ["scope-a", "scope-a", "scope-b", "scope-b", "scope-c", "scope-c", "scope-sa", "scope-sa", "scope-sb", "scope-sb", "scope-sc", "scope-sc"]);
	console.log(JSON.stringify({ passed: true, simultaneousPromptsPerMode: 3, modes: ["host", "sandbox"], modelTurns: seen.length, paidRequests: 0, wslCalls: 0, scopePreserved: true }));
} finally { await t.cleanup(); }
