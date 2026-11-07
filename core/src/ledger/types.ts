import { AsyncLocalStorage } from "node:async_hooks";
export type Purpose = "conversation" | "subagent" | "memory" | "compaction" | "auto_title" | "vision" | "web_search" | "web_fetch" | "auxiliary";
export const PURPOSES: Purpose[] = ["conversation", "subagent", "memory", "compaction", "auto_title", "vision", "web_search", "web_fetch", "auxiliary"];
export interface LedgerContext { purpose?: Purpose; workspace?: string | null; sessionId?: string | null; runId?: string | null; slotId?: string | null; }
const contexts = new AsyncLocalStorage<LedgerContext>();
export function withLedgerContext<T>(context: LedgerContext, action: () => T): T { return contexts.run({ ...contexts.getStore(), ...context }, action); }
export function ledgerContext(): LedgerContext { return contexts.getStore() ?? {}; }
export const REQUEST_LEDGER_ID = Symbol("DreamFlutter request ledger id");
export interface LedgerRow {
	id: string; requested_at: number; completed_at: number | null; state: string; channel: string | null; provider: string; model: string;
	purpose: Purpose; workspace: string | null; session_id: string | null; run_id: string | null; slot_id: string | null;
	success: number | null; input: number | null; output: number | null; cache_read: number | null; cache_write: number | null; reasoning: number | null;
	amount: number | null; currency: string | null; amount_source: string; price_version: string; price_snapshot: string | null;
	allowance: number | null; allowance_unit: string | null; allowance_source: string | null; billing_source: string | null;
	ttft_ms: number | null; duration_ms: number | null; origin: string; message_key: string | null; error_code: string | null;
}
export interface QueryOptions { since?: number; until?: number; period?: "day" | "month" | "all"; groupBy?: "channel" | "model" | "purpose" | "workspace" | "session" | "all"; timeZone?: string; }
export function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
