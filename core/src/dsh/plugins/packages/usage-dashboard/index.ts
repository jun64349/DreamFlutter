import type { Context } from "@deepseek-ai/cordis";
import type { Session } from "@deepseek-ai/dsh-session";
import * as sessionStats from "@deepseek-ai/dsh-session-stats";
import type { SessionStatsProjection } from "@deepseek-ai/dsh-session-stats/types";
import type { Ledger } from "../../../../ledger/ledger.ts";

interface UsageDay {
	date: string;
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	missingUsage: number;
	amounts: Record<string, number>;
}

interface UsageDashboard {
	read(session?: Session): {
		since: number;
		until: number;
		timeZone: string;
		days: UsageDay[];
		session?: SessionStatsProjection;
	};
}

declare module "@deepseek-ai/cordis" {
	interface Context {
		dfLedger: Ledger;
		dfUsageDashboard: UsageDashboard;
	}
}

export const name = "dreamflutter-usage-dashboard";
export const inject = ["dfLedger", "sessionProjections"];

export async function apply(ctx: Context): Promise<void> {
	await ctx.plugin(sessionStats);
	ctx.provide("dfUsageDashboard", {
		read(session?: Session) {
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			const start = new Date(today);
			start.setDate(start.getDate() - 6);
			const end = new Date(today);
			end.setDate(end.getDate() + 1);
			const since = start.getTime(), until = end.getTime();
			const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
			const { rows } = ctx.dfLedger.summary({ since, until, timeZone, groupBy: "all", period: "day" });
			const byDate = new Map(rows.map(({ period, requests, input, output, cacheRead, cacheWrite, missingUsage, amounts }) =>
				[period, { requests, input, output, cacheRead, cacheWrite, missingUsage, amounts }]));
			const format = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
			const days: UsageDay[] = [];
			for (const day = new Date(start); day < end; day.setDate(day.getDate() + 1)) {
				const date = format.format(day);
				const usage = byDate.get(date) ?? { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, missingUsage: 0, amounts: {} };
				days.push({ date, ...usage });
			}
			const stats = session && ctx.sessionProjections.snapshot(session, ["sessionStats"]).values.sessionStats;
			return { since, until, timeZone, days, ...(stats && { session: stats }) };
		},
	} satisfies UsageDashboard);
}
