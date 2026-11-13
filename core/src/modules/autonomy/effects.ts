import { json, type Db } from "../../db.ts";

export type EffectKind = "accept" | "start" | "copy" | "notify" | "deliver" | "chat_delivery" | "chat_control";
export type EffectState = "planned" | "running" | "completed" | "failed" | "uncertain";
export interface Effect {
	key: string;
	mandate_id: string;
	kind: EffectKind;
	state: EffectState;
	payload: string;
	receipt: string | null;
}

export class AutonomyEffects {
	private readonly db: Db;
	constructor(db: Db) { this.db = db; }

	plan(key: string, mandateId: string, kind: EffectKind, payload: object): void {
		const at = Date.now();
		this.db.run(`INSERT INTO autonomy_effects(key,mandate_id,kind,state,payload,at,updated_at)
			VALUES(?,?,?,'planned',?,?,?) ON CONFLICT(key) DO NOTHING`, key, mandateId, kind, json(payload), at, at);
	}

	get(key: string): Effect | undefined {
		return this.db.get<Effect>("SELECT * FROM autonomy_effects WHERE key=?", key);
	}

	list(state: EffectState): Effect[] {
		return this.db.all<Effect>("SELECT * FROM autonomy_effects WHERE state=? ORDER BY at,rowid", state);
	}

	claim(key: string): boolean {
		return !!this.db.run("UPDATE autonomy_effects SET state='running',updated_at=? WHERE key=? AND state='planned'", Date.now(), key).changes;
	}

	returnToPlan(key: string): void {
		this.db.run("UPDATE autonomy_effects SET state='planned',updated_at=? WHERE key=? AND state='running'", Date.now(), key);
	}

	finish(key: string, state: "completed" | "failed" | "uncertain", receipt: string): void {
		this.db.run("UPDATE autonomy_effects SET state=?,receipt=?,updated_at=? WHERE key=? AND state='running'",
			state, receipt, Date.now(), key);
	}
}
