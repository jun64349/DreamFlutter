import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isInside } from "../../backup/path-map.ts";
import { normalizeCwd, type Core } from "../../core.ts";
import { Gateway, GROUP_PROVIDER, type ChannelInfo } from "../../gateway/gateway.ts";
import { SANDBOX_ENTRY, recordedSessionModel } from "../../pi/host.ts";
import { readSessionEntries } from "../../pi/session-metadata.ts";
import { redact } from "../../security/redaction.ts";
import type { CoreSettings } from "../../settings.ts";
import { AttentionModule } from "../attention.ts";

export type FactKind = "failed" | "stale_attention" | "health" | "upcoming" | "report" | "goal_stuck";
export interface GoalFinding {
	id: string; status: string; revision: number; generation: number; reason: string | null; noticeKey: string;
}
export interface Fact { key: string; kind: FactKind; text: string; alreadyNotified?: boolean; goal?: GoalFinding }
export interface FactWindow { since: number; at: number }
export type GoalSource = (window: FactWindow) => readonly Omit<Fact, "kind">[] | Promise<readonly Omit<Fact, "kind">[]>;
export type HealthState = Record<string, string>;

const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
const healthLabels = new Map([
	["quota", "额度已用完"], ["balance", "余额不足"], ["auth", "密钥失效"],
]);

export function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function oneLine(text: string): string {
	return redact(text, true).replace(/\s+/g, " ").trim().slice(0, 240);
}

function backendErrors(file: string, { since, at }: FactWindow): Fact[] {
	let fd: number;
	try { fd = openSync(file, "r"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	try {
		// Keep diagnostic text in the local log. Only its timestamp is sent to the model.
		const size = fstatSync(fd).size;
		const length = Math.min(size, 256 * 1024);
		const buffer = Buffer.alloc(length);
		const offset = size - length;
		const bytes = readSync(fd, buffer, 0, length, offset);
		return buffer.toString("utf8", 0, bytes).split("\n").slice(offset ? 1 : 0, -1).flatMap(line => {
			const timestamp = /^(\S+) ERROR /.exec(line)?.[1];
			const when = timestamp ? Date.parse(timestamp) : NaN;
			return when >= since && when <= at ? [{
				key: "backend_error:" + digest(line), kind: "failed",
				text: "后台出现新报错（" + new Date(when).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) + "）",
			}] : [];
		});
	} finally { closeSync(fd); }
}

function butterflyOwner(core: Core, sessionDir: string) {
	const sandbox = new Map<string, boolean>();
	return (cwd: string, session: string | null) => {
		if (session && isInside(sessionDir, session)) return false;
		if (isInside(core.paths.butterflyDir, cwd)) return true;
		if (!session) return false;
		if (!sandbox.has(session)) {
			try { sandbox.set(session, readSessionEntries(session).some(entry => entry.type === "custom" && entry.customType === SANDBOX_ENTRY)); }
			catch { sandbox.set(session, false); }
		}
		return sandbox.get(session)!;
	};
}

function failures(core: Core, window: FactWindow, belongs: ReturnType<typeof butterflyOwner>): Fact[] {
	const { since, at } = window;
	const rows = core.db.all<{ id: string; name: string; task_id: string | null }>(`
		SELECT r.id, s.name, r.task_id FROM schedule_runs r JOIN schedules s ON s.id=r.schedule_id
		WHERE s.owner='butterfly' AND r.status='failed' AND r.ended_at BETWEEN ? AND ?`, since, at);
	const tasks = new Set(rows.map(row => row.task_id));
	const facts: Fact[] = rows.map(row => ({ key: "schedule_run:" + row.id, kind: "failed", text: "日程「" + oneLine(row.name) + "」没做成" }));
	for (const row of core.db.all<{ id: string; title: string; cwd: string; session_file: string | null; updated_at: number }>(`
		SELECT id,title,cwd,session_file,updated_at FROM tasks WHERE status='failed' AND updated_at BETWEEN ? AND ?`, since, at)) {
		if (tasks.has(row.id) || !belongs(row.cwd, row.session_file)) continue;
		// The latest failed run and its task describe the same outcome.
		if (!core.db.get("SELECT 1 FROM runs WHERE task_id=? AND status='failed' AND ended_at BETWEEN ? AND ?", row.id, since, at)) {
			facts.push({ key: "task:" + row.id + ":" + row.updated_at, kind: "failed", text: "任务「" + oneLine(row.title) + "」没做成" });
		}
	}
	for (const row of core.db.all<{ id: string; task_id: string | null; title: string | null; cwd: string; session_file: string | null }>(`
		SELECT r.id,r.task_id,t.title,r.cwd,r.session_file FROM runs r LEFT JOIN tasks t ON t.id=r.task_id
		WHERE r.status='failed' AND r.ended_at BETWEEN ? AND ?
			AND NOT EXISTS (SELECT 1 FROM patrol_runs p WHERE p.id=r.slot_id)`, since, at)) {
		if ((row.task_id && tasks.has(row.task_id)) || !belongs(row.cwd, row.session_file)) continue;
		facts.push({ key: "run:" + row.id, kind: "failed", text: row.title ? "任务「" + oneLine(row.title) + "」没做成" : "蝶君有一次运行没做成" });
	}
	try { facts.push(...backendErrors(core.paths.logFile, window)); }
	catch (error) { core.log.warn("巡检未能读取后台错误日志", error); }
	return facts;
}

function stale(core: Core, at: number, hours: number): Fact[] {
	const entries = core.module(AttentionModule)?.pendingForPatrol() ?? [];
	return entries.flatMap(({ id, title, createdAt }) => {
		const late = at - createdAt - hours * HOUR;
		return late < 0 ? [] : [{ key: "attention:" + id + ":" + Math.floor(late / DAY), kind: "stale_attention", text: "「" + oneLine(title) + "」还在等你处理" }];
	});
}

function watchDue(core: Core, at: number): Fact[] {
	return core.db.all<{ id: string; text: string }>(`
		SELECT id,text FROM watch_items w WHERE done_at IS NULL AND until<=?
		AND NOT EXISTS (SELECT 1 FROM patrol_reported WHERE fact_key='watch_due:' || w.id)`, at)
		.map(row => ({ key: "watch_due:" + row.id, kind: "report", text: "留意「" + oneLine(row.text) + "」已到期" }));
}

function unreadDeliveries(core: Core, { since, at }: FactWindow, belongs: ReturnType<typeof butterflyOwner>): Fact[] {
	const rows = core.db.all<{ id: string; title: string; cwd: string; session_file: string | null; ended_at: number }>(`
		SELECT t.id,t.title,t.cwd,t.session_file,t.ended_at FROM tasks t
		WHERE t.status='done' AND t.ended_at BETWEEN ? AND ?
		AND NOT EXISTS (SELECT 1 FROM schedules s WHERE s.id=t.schedule_id AND s.kind='reminder')
		AND NOT EXISTS (SELECT 1 FROM patrol_reported WHERE fact_key='delivered:' || t.id)`, since, at);
	return rows.flatMap(row => {
		if (!belongs(row.cwd, row.session_file)) return [];
		const seen = row.session_file && core.db.get<{ seen_at: number }>(
			"SELECT seen_at FROM session_seen WHERE session_key=?", normalizeCwd(row.session_file),
		);
		if (seen && seen.seen_at > row.ended_at) return [];
		return [{ key: "delivered:" + row.id, kind: "report", text: "蝶君做完了「" + oneLine(row.title) + "」" }];
	});
}

function affectedSchedules(core: Core, gateway: Gateway | undefined, bad: ChannelInfo[], at: number,
	settings: CoreSettings, sandboxFailed: boolean): Fact[] {
	if (!sandboxFailed && bad.length === 0) return [];
	const rows = core.db.all<{ id: string; name: string; next_run_at: number; session_mode: string; session_file: string | null }>(`
		SELECT id,name,next_run_at,session_mode,session_file FROM schedules WHERE owner='butterfly' AND status='active'
		AND kind IN ('task','report') AND next_run_at>? AND next_run_at<=?`, at, at + settings.patrolIntervalMin * 60_000);
	const unavailable = (ref: string | null) => {
		if (!ref) return false;
		const slash = ref.indexOf("/");
		const provider = ref.slice(0, slash);
		if (provider !== GROUP_PROVIDER) return bad.some(channel => channel.provider === provider);
		const entries = gateway?.groups().find(group => group.id === ref.slice(slash + 1))?.entries ?? [];
		return entries.length > 0 && entries.every(entry => bad.some(channel => channel.id === entry.channel));
	};
	return rows.flatMap(row => {
		let ref = settings.defaultModel;
		if (!sandboxFailed && row.session_mode === "bound" && row.session_file) {
			const live = core.findSlotByFile(row.session_file)?.session.model;
			if (live) ref = live.provider + "/" + live.id;
			else {
				try { ref = recordedSessionModel(SessionManager.open(row.session_file))?.ref ?? ref; }
				catch { return []; }
			}
		}
		return sandboxFailed || unavailable(ref) ? [{
			key: "upcoming:" + row.id + ":" + row.next_run_at, kind: "upcoming",
			text: "日程「" + oneLine(row.name) + "」快到点了，" + (sandboxFailed ? "但沙箱打不开" : "但模型渠道不可用"),
		}] : [];
	});
}

export async function collectFacts(core: Core, settings: CoreSettings, window: FactWindow, runId: string,
	sessionDir: string, goalSources: ReadonlySet<GoalSource>, previous: HealthState, sandboxFailed: boolean): Promise<{ facts: Fact[]; health: HealthState | null }> {
	const checks = settings.patrolChecks;
	const { at } = window;
	const facts: Fact[] = [];
	if (!sandboxFailed) {
		const belongs = butterflyOwner(core, sessionDir);
		if (checks.failed) facts.push(...failures(core, window, belongs));
		if (checks.stale_attention) facts.push(...stale(core, at, settings.patrolStaleHours));
		if (checks.watch) facts.push(...watchDue(core, at));
		facts.push(...unreadDeliveries(core, window, belongs));
		if (checks.goal_stuck) for (const source of goalSources) {
			for (const fact of await source(window)) facts.push({ ...fact, text: oneLine(fact.text), kind: "goal_stuck" });
		}
	}

	const gateway = core.module(Gateway);
	const channels = !sandboxFailed && (checks.health || checks.upcoming) ? gateway?.channels() ?? [] : [];
	const bad = channels.filter(channel => channel.enabled && healthLabels.has(channel.unavailable?.kind ?? ""));
	let health: HealthState | null = null;
	if (checks.health) {
		health = sandboxFailed ? { ...previous, sandbox: "unavailable" } : Object.fromEntries(bad.map(channel => ["channel:" + channel.id, channel.unavailable!.kind]));
		const changed = (key: string, text: string) => {
			if (previous[key] !== health![key]) facts.push({ key: "health:" + key + ":" + runId, kind: "health", text });
		};
		if (sandboxFailed) changed("sandbox", "蝶君的沙箱打不开");
		for (const channel of bad) changed("channel:" + channel.id, "渠道「" + oneLine(channel.name) + "」" + healthLabels.get(channel.unavailable!.kind));
	}
	if (checks.upcoming) facts.push(...affectedSchedules(core, gateway, bad, at, settings, sandboxFailed));
	return { facts: [...new Map(facts.map(fact => [fact.key, fact])).values()].sort((a, b) => a.key.localeCompare(b.key)), health };
}
