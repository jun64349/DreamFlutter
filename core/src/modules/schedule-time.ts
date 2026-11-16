import { RpcError } from "../core.ts";
import type { Trigger } from "./scheduler.ts";

const examples = ["每天 08:00", "每周一 09:00", "11月14日 14:00"];
const days = "日一二三四五六";
const clockPattern = /(?:早上|上午|中午|下午|晚上|夜里)?\s*\d{1,2}(?::\d{1,2}|点(?:半|\d{1,2}分?)?)?/gu;

function invalid(): never {
	throw new RpcError("bad_request", "没看懂时间，请试试“每天 08:00”“每周一 09:00”或“11月14日 14:00”。", { examples });
}

function timezoneOf(value: unknown): string {
	const zone = value === undefined ? Intl.DateTimeFormat().resolvedOptions().timeZone : value;
	if (typeof zone !== "string" || !zone.trim()) return invalid();
	try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); } catch { return invalid(); }
	return zone;
}

function parts(at: number, timezone: string) {
	const values = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
		.formatToParts(at);
	const get = (name: string) => Number(values.find(item => item.type === name)?.value);
	return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

function atZone(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
	const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute));
	if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day) return invalid();
	const wanted = Date.UTC(year, month - 1, day, hour, minute);
	let guess = wanted;
	for (let i = 0; i < 4; i++) {
		const p = parts(guess, zone);
		const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
		const delta = wanted - shown;
		if (!delta) break;
		guess += delta;
	}
	const p = parts(guess, zone);
	if (p.year !== year || p.month !== month || p.day !== day || p.hour !== hour || p.minute !== minute) return invalid();
	return guess;
}

function clock(raw: string): string {
	const value = raw.replace(/\s+/g, "");
	const match = /^(早上|上午|中午|下午|晚上|夜里)?(\d{1,2})(?::(\d{1,2})|点(半|\d{1,2}分?)?)?$/.exec(value);
	if (!match) return invalid();
	let hour = Number(match[2]);
	const minute = match[3] ? Number(match[3]) : match[4] === "半" ? 30 : match[4] ? Number(match[4].replace("分", "")) : 0;
	if (hour > 23 || minute > 59 || match[1] && (hour < 1 || hour > 12)) return invalid();
	if (["下午", "晚上", "夜里"].includes(match[1] ?? "") && hour < 12) hour += 12;
	if (match[1] === "中午" && hour < 12) hour += 12;
	if (["早上", "上午"].includes(match[1] ?? "") && hour === 12) hour = 0;
	return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function clocks(raw: string): string[] {
	const matches = [...raw.matchAll(clockPattern)];
	if (!matches.length || raw.replace(clockPattern, "").replace(/[、，,\s]/g, "")) return invalid();
	return [...new Set(matches.map(match => clock(match[0]!)))].sort();
}

function cron(times: string[], dayField = "*", weekField = "*"): Trigger {
	const expressions = times.map(time => {
		const [hour, minute] = time.split(":").map(Number);
		return `${minute} ${hour} ${dayField} * ${weekField}`;
	});
	return { type: "cron", ...(expressions.length === 1 ? { cron: expressions[0] } : { crons: expressions }) };
}

function onceText(year: number, month: number, day: number, hour: number, minute: number, zone: string, current: number): string {
	const date = year === parts(current, zone).year ? `${month}月${day}日` : `${year}年${month}月${day}日`;
	return `${date} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function parseScheduleTime(value: unknown, timezone?: unknown, current = Date.now()): { trigger: Trigger; text: string } {
	if (typeof value !== "string" || !value.trim()) return invalid();
	const text = value.trim().replace(/\s+/g, " ");
	const zone = timezoneOf(timezone);
	let match: RegExpExecArray | null;
	match = /^每\s*(\d+)\s*(小时|分钟)$/.exec(text);
	if (match) {
		const count = Number(match[1]);
		const everyMs = count * (match[2] === "小时" ? 3_600_000 : 60_000);
		if (!Number.isSafeInteger(everyMs) || everyMs < 60_000) return invalid();
		return { trigger: { type: "interval", everyMs }, text: everyMs % 3_600_000 === 0 ? `每 ${everyMs / 3_600_000} 小时` : `每 ${everyMs / 60_000} 分钟` };
	}
	match = /^(每天|工作日|周末)\s*(.+)$/.exec(text);
	if (match) {
		const times = clocks(match[2]!);
		const trigger = cron(times, "*", match[1] === "工作日" ? "1,2,3,4,5" : match[1] === "周末" ? "0,6" : "*");
		trigger.timezone = zone;
		return { trigger, text: `${match[1]} ${times.join("、")}` };
	}
	match = /^每(?:周|星期|礼拜)([一二三四五六日天、，, ]+)\s*(.+)$/.exec(text);
	if (match) {
		const dayList = match[1]!.replace(/[、，,\s]/g, "").replaceAll("天", "日");
		if (!dayList || [...dayList].some(day => !days.includes(day))) return invalid();
		const weekdays = [...new Set([...dayList].map(day => days.indexOf(day)))].sort((a, b) => a - b);
		const times = clocks(match[2]!);
		const trigger = cron(times, "*", weekdays.join(","));
		trigger.timezone = zone;
		return { trigger, text: `每周${weekdays.map(day => days[day]).join("、")} ${times.join("、")}` };
	}
	match = /^每月\s*(\d{1,2})\s*[日号]\s*(.+)$/.exec(text);
	if (match) {
		const day = Number(match[1]);
		if (day < 1 || day > 31) return invalid();
		const times = clocks(match[2]!);
		const trigger = cron(times, String(day));
		trigger.timezone = zone;
		return { trigger, text: `每月${day}日 ${times.join("、")}` };
	}
	match = /^(今天|明天|后天|(?:周|星期|礼拜)[一二三四五六日天]|(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日|(\d{4})-(\d{1,2})-(\d{1,2}))\s*(.+)$/.exec(text);
	const clockOnly = !match;
	const times = clocks(match?.[8] ?? text);
	if (times.length !== 1) return invalid();
	const [hour, minute] = times[0]!.split(":").map(Number) as [number, number];
	const today = parts(current, zone);
	let year = Number(match?.[2] ?? match?.[5] ?? today.year), month = Number(match?.[3] ?? match?.[6] ?? today.month), day = Number(match?.[4] ?? match?.[7] ?? today.day);
	if (clockOnly) {
		if (atZone(year, month, day, hour, minute, zone) <= current) {
			const next = new Date(Date.UTC(year, month - 1, day + 1));
			year = next.getUTCFullYear(); month = next.getUTCMonth() + 1; day = next.getUTCDate();
		}
	} else if (["今天", "明天", "后天"].includes(match![1]!)) {
		const offset = ["今天", "明天", "后天"].indexOf(match![1]!);
		const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
		year = date.getUTCFullYear(); month = date.getUTCMonth() + 1; day = date.getUTCDate();
	} else if (/^(周|星期|礼拜)/.test(match![1]!)) {
		const target = days.indexOf(match![1]!.at(-1)!.replace("天", "日"));
		const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
		const delta = (target - weekday + 7) % 7;
		const date = new Date(Date.UTC(today.year, today.month - 1, today.day + delta));
		year = date.getUTCFullYear(); month = date.getUTCMonth() + 1; day = date.getUTCDate();
		if (atZone(year, month, day, hour, minute, zone) <= current) {
			const next = new Date(Date.UTC(year, month - 1, day + 7));
			year = next.getUTCFullYear(); month = next.getUTCMonth() + 1; day = next.getUTCDate();
		}
	} else if (!match![2] && !match![5]) {
		let at = atZone(year, month, day, hour, minute, zone);
		if (at <= current) { year++; at = atZone(year, month, day, hour, minute, zone); }
	}
	const at = atZone(year, month, day, hour, minute, zone);
	if (at <= current) throw new RpcError("bad_request", "这个时间已经过了，换一个以后的时间。", { examples, past: true });
	return { trigger: { type: "once", at, timezone: zone }, text: onceText(year, month, day, hour, minute, zone, current) };
}

export function scheduleTimeText(trigger: Trigger, current = Date.now()): string | null {
	if (trigger.type === "interval") {
		const ms = trigger.everyMs;
		return ms && ms >= 60_000 && ms % 60_000 === 0 ? ms % 3_600_000 === 0 ? `每 ${ms / 3_600_000} 小时` : `每 ${ms / 60_000} 分钟` : null;
	}
	if (trigger.type === "once") {
		if (!trigger.at || !Number.isFinite(trigger.at) || trigger.at % 60_000 !== 0) return null;
		try { const zone = timezoneOf(trigger.timezone), p = parts(trigger.at, zone); return onceText(p.year, p.month, p.day, p.hour, p.minute, zone, current); }
		catch { return null; }
	}
	if (trigger.type !== "cron") return null;
	const expressions = trigger.crons ?? (trigger.cron ? [trigger.cron] : []);
	if (!expressions.length) return null;
	const parsed = expressions.map(expression => /^(\d{1,2}) (\d{1,2}) (\*|\d{1,2}) \* (\*|[0-6](?:,[0-6])*)$/.exec(expression));
	if (parsed.some(match => !match)) return null;
	const fields = parsed.map(match => match!);
	if (fields.some(match => Number(match[1]) > 59 || Number(match[2]) > 23 || match[3] !== fields[0]![3] || match[4] !== fields[0]![4])) return null;
	const times = [...new Set(fields.map(match => `${match[2]!.padStart(2, "0")}:${match[1]!.padStart(2, "0")}`))].sort();
	const date = fields[0]![3]!, week = fields[0]![4]!;
	if (date !== "*" && week !== "*") return null;
	if (date !== "*") return Number(date) >= 1 && Number(date) <= 31 ? `每月${Number(date)}日 ${times.join("、")}` : null;
	if (week === "*") return `每天 ${times.join("、")}`;
	if (week === "1,2,3,4,5") return `工作日 ${times.join("、")}`;
	if (week === "0,6") return `周末 ${times.join("、")}`;
	const values = week.split(",").map(Number);
	if (values.some((value, index) => index > 0 && value <= values[index - 1]!)) return null;
	return `每周${values.map(value => days[value]).join("、")} ${times.join("、")}`;
}
