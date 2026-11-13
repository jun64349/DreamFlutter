import type { Db } from "../../db.ts";

export type AutonomyBudgetSource = "observe" | "goal" | "learning" | "skill" | "chat";

export class AutonomyBudget {
	private readonly db: Db;
	private readonly dailyCap: () => number;
	private readonly clock: () => number;

	constructor(db: Db, dailyCap: () => number, clock: () => number = Date.now) {
		this.db = db;
		this.dailyCap = dailyCap;
		this.clock = clock;
	}

	check(estimateUsd: number, _source: AutonomyBudgetSource): { ok: true } | { ok: false; reason: "daily_cap" } {
		const cap = this.dailyCap();
		const spent = this.spentToday() + this.db.get<{ total: number }>(
			"SELECT total(estimate_usd) AS total FROM autonomy_budget_holds WHERE day=?", localDay(this.clock()))!.total;
		const remaining = cap - spent;
		const tolerance = Number.EPSILON * Math.max(cap, spent, estimateUsd) * 4;
		return Number.isFinite(estimateUsd) && estimateUsd >= 0 &&
			remaining > tolerance && estimateUsd <= remaining + tolerance
			? { ok: true } : { ok: false, reason: "daily_cap" };
	}

	/** One ref per billable operation. Retrying the same receipt does not double count. */
	record(costUsd: number, source: AutonomyBudgetSource, refId: string): void {
		if (!Number.isFinite(costUsd) || costUsd < 0 || !refId) throw new Error("Invalid autonomy spending receipt");
		const at = this.clock();
		this.db.run(`INSERT INTO autonomy_spending (source, ref_id, day, at, cost_usd)
			VALUES (?, ?, ?, ?, ?) ON CONFLICT(source, ref_id) DO NOTHING`,
		source, refId, localDay(at), at, costUsd);
	}

	spentToday(): number {
		return this.db.get<{ total: number }>(`SELECT COALESCE(SUM(cost_usd), 0) AS total
			FROM autonomy_spending WHERE day=?`, localDay(this.clock()))!.total;
	}

	day(): string { return localDay(this.clock()); }

	reserve(estimateUsd: number, source: AutonomyBudgetSource, refId: string): boolean {
		const at = this.clock();
		return this.db.transaction(() => this.check(estimateUsd, source).ok &&
			!!this.db.run(`INSERT INTO autonomy_budget_holds(source,ref_id,day,at,estimate_usd)
				VALUES(?,?,?,?,?) ON CONFLICT(source,ref_id) DO NOTHING`, source, refId, localDay(at), at, estimateUsd).changes);
	}

	/** null is a request known not to have been sent. Missing usage is charged at the held estimate. */
	settle(source: AutonomyBudgetSource, refId: string, costUsd: number | "estimated" | null): number {
		return this.db.transaction(() => {
			const held = this.db.get<{ estimate_usd: number; day: string; at: number }>(
				"SELECT * FROM autonomy_budget_holds WHERE source=? AND ref_id=?", source, refId);
			if (!held) return this.db.get<{ cost_usd: number }>(
				"SELECT cost_usd FROM autonomy_spending WHERE source=? AND ref_id=?", source, refId)?.cost_usd ?? 0;
			const cost = costUsd === "estimated" ? held.estimate_usd : costUsd;
			if (cost !== null) this.db.run(`INSERT INTO autonomy_spending(source,ref_id,day,at,cost_usd)
				VALUES(?,?,?,?,?) ON CONFLICT(source,ref_id) DO NOTHING`, source, refId, held.day, held.at, cost);
			this.db.run("DELETE FROM autonomy_budget_holds WHERE source=? AND ref_id=?", source, refId);
			return cost ?? 0;
		});
	}
}

function localDay(at: number): string {
	const date = new Date(at);
	return [date.getFullYear(), date.getMonth() + 1, date.getDate()].join("-");
}
