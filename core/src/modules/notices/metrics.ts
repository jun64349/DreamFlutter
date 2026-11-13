import type { Core } from "../../core.ts";
import { readSessionEntries } from "../../pi/session-metadata.ts";
import { localDay } from "../session-index.ts";
import type { NoticeCategory } from "./journal.ts";

interface DailyMetrics {
	day: string;
	quietSuppressed: number;
	duplicateSuppressed: number;
	sentByCategory: Record<NoticeCategory, number>;
	blockedNotifications: { key: string; objectRef: string | null; count: number }[];
	followUpsByDelivery: { goalId: string; count: number }[];
}

export function attentionMetrics(core: Core, days: number, now = Date.now()): DailyMetrics[] {
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	const result = new Map<string, DailyMetrics>();
	for (let offset = days - 1; offset >= 0; offset--) {
		const date = new Date(midnight);
		date.setDate(date.getDate() - offset);
		const day = localDay(date.getTime());
		result.set(day, { day, quietSuppressed: 0, duplicateSuppressed: 0,
			sentByCategory: { decision: 0, blocked: 0, review: 0, done: 0, reminder: 0 }, blockedNotifications: [], followUpsByDelivery: [] });
	}
	const first = result.keys().next().value!;
	const start = new Date(midnight);
	start.setDate(start.getDate() - (days - 1));
	for (const row of core.db.all<{ day: string; quiet_suppressed: number; duplicate_suppressed: number }>(
		"SELECT * FROM notification_metrics WHERE day>=? AND day<=?", first, localDay(now))) {
		const day = result.get(row.day)!;
		day.quietSuppressed = row.quiet_suppressed;
		day.duplicateSuppressed = row.duplicate_suppressed;
	}
	for (const row of core.db.all<{ key: string; category: NoticeCategory; object_ref: string | null; sent_at: number }>(
		"SELECT key,category,object_ref,sent_at FROM notification_receipts WHERE state='sent' AND sent_at>=? AND sent_at<=? ORDER BY sent_at,key",
		start.getTime(), now)) {
		const day = result.get(localDay(row.sent_at));
		if (!day) continue;
		day.sentByCategory[row.category]++;
		if (row.category === "blocked" && row.object_ref !== null) day.blockedNotifications.push({ key: row.key, objectRef: row.object_ref, count: 1 });
	}
	const counts = followUps(core, start.getTime(), now);
	for (const [day, goals] of counts) {
		result.get(day)!.followUpsByDelivery = [...goals].map(([goalId, count]) => ({ goalId, count })).sort((a, b) => a.goalId.localeCompare(b.goalId));
	}
	return [...result.values()];
}

/** T-115 already persists a paired user request and program-authored progress receipt. */
function followUps(core: Core, since: number, until: number): Map<string, Map<string, number>> {
	const files = new Map<string, Set<string>>();
	for (const row of core.db.all<{ session_file: string; goal_id: string }>("SELECT session_file,goal_id FROM butterfly_chat_tasks")) {
		let ids = files.get(row.session_file);
		if (!ids) files.set(row.session_file, ids = new Set());
		ids.add(row.goal_id);
	}
	const counts = new Map<string, Map<string, number>>();
	const seen = new Set<string>();
	for (const [file, goals] of files) {
		let rows: ReturnType<typeof readSessionEntries>;
		try { rows = readSessionEntries(file); }
		catch { continue; }
		const users = new Map<string, number>();
		for (const { message } of rows) {
			const key = message?.dfChatTaskMessage;
			if (message?.role !== "user" || typeof key !== "string" || !key.startsWith("task-user:") ||
				typeof message.timestamp !== "number" || message.timestamp < since || message.timestamp > until) continue;
			users.set(key.slice("task-user:".length), message.timestamp);
		}
		for (const { message } of rows) {
			const key = message?.dfChatTaskMessage;
			if (message?.role !== "assistant" || message.provider !== "dreamflutter-system" || message.model !== "butterfly-task-receipt" ||
				typeof key !== "string" || !key.startsWith("task-answer:") || seen.has(key)) continue;
			const at = users.get(key.slice("task-answer:".length));
			const text = message.content?.[0]?.text;
			const goalId = typeof text === "string" ? /^目标 ([^，\n]+)，/.exec(text)?.[1] : undefined;
			if (at === undefined || !goalId || !goals.has(goalId)) continue;
			seen.add(key);
			const day = localDay(at);
			let goalsThatDay = counts.get(day);
			if (!goalsThatDay) counts.set(day, goalsThatDay = new Map());
			goalsThatDay.set(goalId, (goalsThatDay.get(goalId) ?? 0) + 1);
		}
	}
	return counts;
}
