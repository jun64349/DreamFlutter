import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Job } from "../src/backup/backup.ts";
import { Archive } from "../src/backup/archive.ts";
import { applyPendingRestore } from "../src/backup/switch.ts";
import { CORE_VERSION, normalizeCwd } from "../src/core.ts";
import { Db } from "../src/db.ts";
import { GoalsModule, type GoalScheduler } from "../src/modules/goals.ts";
import type { Schedule } from "../src/modules/scheduler.ts";
import { SANDBOX_ENTRY } from "../src/pi/host.ts";
import { MIGRATIONS } from "../src/schema.ts";
import { startTestCore, type TestCore } from "./harness.ts";

const trigger = { type: "interval", everyMs: 600_000, anchor: 1 };
const v09Tables = ["schedule_changes", "patrol_runs", "watch_items", "session_seen", "patrol_reported", "jobs",
	"goals", "goal_revisions", "goal_events", "goal_intents", "goal_waits", "goal_evidence", "goal_reviews", "goal_ledger",
	"goal_approvals", "goal_proposals"];

function savedSession(t: TestCore, sandbox = false) {
	const manager = SessionManager.create(t.workspace, t.sessionDir);
	if (sandbox) manager.appendCustomEntry(SANDBOX_ENTRY, { sandbox: true });
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "旧对话原文" }], timestamp: 10 });
	manager.appendMessage(fauxAssistantMessage("旧对话回复"));
	return manager.getSessionFile()!;
}

it("T106 upgrades schema 16 without losing old schedules, sessions or memories", async () => {
	let t = await startTestCore();
	try {
		const file = savedSession(t, true);
		const original = readFileSync(file, "utf8");
		const { dbFile } = t.core.paths;
		await t.core.shutdown();
		unlinkSync(dbFile);
		const legacy = new DatabaseSync(dbFile);
		try {
			for (const migration of MIGRATIONS.slice(0, 16)) legacy.exec(migration);
			legacy.exec("PRAGMA user_version=16");
			legacy.prepare(`INSERT INTO schedules(id,name,prompt,cwd,kind,trigger,missed_policy,session_mode,session_file,status,created_by,created_at,updated_at)
				VALUES('legacy','旧日程','继续核对',?,'task',?,'skip','bound',?,'paused','agent',1,1)`).run(t.workspace, JSON.stringify(trigger), file);
			legacy.prepare("INSERT INTO session_meta(path,cwd,first_message) VALUES(?,?,'旧对话原文')").run(file, t.workspace);
			legacy.prepare("INSERT INTO workspaces(id,path,path_key,created_at) VALUES('ws',?,?,1)").run(t.workspace, normalizeCwd(t.workspace));
			legacy.prepare(`INSERT INTO memory_items(id,version,level,kind,content,scope,workspace_id,confidence,status,created_at,updated_at,created_by)
				VALUES('legacy-memory',1,1,'fact','保留这条旧记忆','workspace','ws','high','active',1,1,'user')`).run();
		} finally { legacy.close(); }
		t = await startTestCore(t.dir);
		const db = t.core.db;
		assert.equal(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version, MIGRATIONS.length);
		const actual = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map(table => table.name);
		for (const table of v09Tables) assert.ok(actual.includes(table), table);
		const schedule = await t.core.call("schedules.get", { id: "legacy" }) as Schedule;
		assert.deepEqual([schedule.name, schedule.prompt, schedule.sessionFile, schedule.owner, schedule.createdRole], ["旧日程", "继续核对", file, "butterfly", "butterfly"]);
		assert.equal(db.get<{ first_message: string }>("SELECT first_message FROM session_meta WHERE path=?", file)?.first_message, "旧对话原文");
		assert.equal(readFileSync(file, "utf8"), original);
		assert.equal(db.get<{ content: string }>("SELECT content FROM memory_items WHERE id='legacy-memory'")?.content, "保留这条旧记忆");
	} finally { await t.cleanup(); }
});

async function backupJob(t: TestCore, method: string, params: Record<string, unknown>) {
	const started = await t.core.call(method, params) as Job;
	const result = await t.waitFor(() => t.messages.map(message => message.job as Job | undefined)
		.find(job => job?.id === started.id && (job.status === "done" || job.status === "failed" || job.status === "cancelled")), 120_000);
	assert.equal(result.status, "done", JSON.stringify(result));
}

it("T111 restores patrol records from an old exporter without installing its transcripts or replacing local ones", async () => {
	const source = await startTestCore();
	let target: TestCore | undefined;
	try {
		const sourceDir = join(source.core.paths.dataDir, "patrol-sessions");
		const oldTranscript = join(sourceDir, "old.jsonl");
		mkdirSync(sourceDir);
		writeFileSync(oldTranscript, '{"content":"旧巡检原文"}\n');
		source.core.db.run("INSERT INTO patrol_runs(id,started_at,status,manual,note,session_file) VALUES('old',1,'notified',0,'旧巡检记录',?)", oldTranscript);
		const exporter = new URL("../src/backup/export.ts", import.meta.url);
		const legacy = new URL(exporter);
		legacy.search = "t111-legacy";
		const current = readFileSync(exporter, "utf8");
		const prior = current.replace(' || n === "patrol-sessions"', "");
		assert.notEqual(prior, current);
		const hook = registerHooks({ load(url, context, next) {
			return url === legacy.href ? { format: "module-typescript", source: prior, shortCircuit: true } : next(url, context);
		} });
		let createBackup: typeof import("../src/backup/export.ts").createBackup;
		try { ({ createBackup } = await import(legacy.href)); }
		finally { hook.deregister(); }
		const archivePath = join(source.dir, "old.dfbackup");
		await createBackup({ paths: source.core.paths, agentDir: source.agentDir, sessionsDir: source.sessionDir, db: source.core.db.raw, appVersion: CORE_VERSION },
			{ out: archivePath, kind: "manual", credentials: "none", includeMaterials: false });
		const archive = await Archive.open(archivePath);
		try { assert.match((await archive.readBuffer("data/appdata/patrol-sessions/old.jsonl")).toString(), /旧巡检原文/); }
		finally { archive.close(); }

		target = await startTestCore();
		const paths = target.core.paths;
		const localDir = join(paths.dataDir, "patrol-sessions");
		const localTranscript = join(localDir, "current.jsonl");
		mkdirSync(localDir);
		writeFileSync(localTranscript, "这台电脑的巡检原文");
		await backupJob(target, "backup.stage", { path: archivePath });
		await backupJob(target, "backup.apply", {});
		await target.core.shutdown();
		assert.equal(applyPendingRestore(paths)?.ok, true);
		const restored = new Db(paths.dbFile);
		try {
			const old = restored.get<{ note: string; session_file: string }>("SELECT note,session_file FROM patrol_runs WHERE id='old'");
			assert.equal(old?.note, "旧巡检记录");
			assert.equal(old.session_file, join(localDir, "old.jsonl"));
			assert.equal(existsSync(old.session_file), false);
			assert.equal(readFileSync(localTranscript, "utf8"), "这台电脑的巡检原文");
		} finally { restored.close(); }
	} finally { await target?.cleanup(); await source.cleanup(); }
});

it("T106 restores 0.9 rows and remaps their owned paths into a new data directory", async () => {
	const source = await startTestCore();
	let target: TestCore | undefined;
	try {
		const db = source.core.db;
		const file = savedSession(source);
		db.run("INSERT INTO session_meta(path,cwd,first_message) VALUES(?,?,'旧对话原文') ON CONFLICT(path) DO NOTHING", file, source.workspace);
		const goals = source.core.module(GoalsModule)!;
		goals.executor.stop();
		const artifact = join(source.workspace, "报告.md");
		const goal = await source.core.call("goals.create", { title: "报告", originText: "交付报告", mandateRef: "user:t106", sessionFile: file,
			scope: { cwd: source.workspace }, spec: { objective: "报告", deliverables: [artifact] } }) as ReturnType<GoalScheduler["detail"]>;
		const schedule = await source.core.call("schedules.save", { name: "报告日程", prompt: "核对报告", cwd: source.workspace,
			trigger, sessionMode: "bound", sessionFile: file, status: "paused" }) as Schedule;
		db.run("UPDATE schedules SET goal_id=? WHERE id=?", goal.id, schedule.id);
		db.run("INSERT INTO session_seen(session_key,seen_at) VALUES(?,9)", normalizeCwd(file));
		db.run("INSERT INTO patrol_runs(id,started_at,status,manual,note,session_file) VALUES('patrol',1,'notified',0,'报告进度',?)", file);
		db.run("INSERT INTO watch_items(id,text,created_by,created_at) VALUES('watch','等待报告','user',1)");
		db.run("INSERT INTO patrol_reported(fact_key) VALUES('watch_due:watch')");
		db.run("INSERT INTO goal_waits(id,goal_id,kind,ref,status,created_at) VALUES('wait',?,'external','report','open',1)", goal.id);
		db.run("INSERT INTO goal_evidence(id,goal_id,kind,ref,detail,version,created_at) VALUES('evidence',?,'artifact',?,?,1,1)",
			goal.id, artifact, JSON.stringify({ path: artifact }));
		db.run("INSERT INTO goal_reviews(id,goal_id,revision,evidence_version,layer,verdict,created_at) VALUES('review',?,1,1,'program','continue',1)", goal.id);
		db.run(`INSERT INTO goal_ledger(id,goal_id,kind,state,est_cost,est_input_tokens,est_output_tokens,est_active_ms,cost,created_at)
			VALUES('charge',?,'main','settled',0.2,2,2,0,0.1,1)`, goal.id);
		db.run("INSERT INTO goal_approvals(id,goal_id,revision,kind,status,payload,created_at) VALUES('approval',?,1,'scope','accepted',?,1)",
			goal.id, JSON.stringify({ scope: { cwd: source.workspace } }));
		db.run(`INSERT INTO goal_proposals(id,session_file,message_id,origin_text,draft,created_at,status)
			VALUES('proposal',?,'msg','原话',?,1,'pending')`, file, JSON.stringify({ title: "提议", scope: { cwd: source.workspace } }));
		const output = join(source.core.paths.cacheDir, "jobs", "job.log");
		mkdirSync(join(source.core.paths.cacheDir, "jobs"), { recursive: true });
		writeFileSync(output, "后台作业输出");
		db.run(`INSERT INTO jobs(id,session_file,slot_id,cwd,sandboxed,kind,label,status,exit_code,started_at,ended_at,output_path,goal_id,goal_revision)
			VALUES('job',?,'slot',?,0,'pwsh','核对','completed',0,1,2,?,?,1)`, file, source.workspace, output, goal.id);
		goals.scheduler.post(goal.id, "external.event", "backup-fixture", { ref: "receipt", path: artifact });
		const archive = join(source.dir, "t106.dfbackup");
		await backupJob(source, "backup.export", { path: archive });

		target = await startTestCore();
		await backupJob(target, "backup.stage", { path: archive, workspaces: [{ from: source.workspace, to: target.workspace }] });
		await backupJob(target, "backup.apply", {});
		const paths = target.core.paths;
		await target.core.shutdown();
		assert.equal(applyPendingRestore(paths)?.ok, true);
		const restored = new Db(paths.dbFile);
		try {
			for (const table of v09Tables) assert.ok(restored.get(`SELECT 1 FROM ${table} LIMIT 1`), table);
			const session = restored.get<{ path: string; cwd: string }>("SELECT path,cwd FROM session_meta WHERE first_message='旧对话原文'")!;
			assert.ok(normalizeCwd(session.path).startsWith(normalizeCwd(target.sessionDir)));
			assert.equal(session.cwd, target.workspace);
			assert.match(readFileSync(session.path, "utf8"), /旧对话回复/);
			assert.ok(restored.get("SELECT 1 FROM session_seen WHERE session_key=? AND seen_at=9", normalizeCwd(session.path)));
			assert.deepEqual({ ...restored.get<Record<string, unknown>>("SELECT status,reason,session_file,json_extract(scope,'$.cwd') AS cwd FROM goals WHERE id=?", goal.id) },
				{ status: "paused", reason: "imported", session_file: session.path, cwd: target.workspace });
			assert.ok(restored.get("SELECT 1 FROM goal_revisions WHERE goal_id=? AND json_extract(scope,'$.cwd')=?", goal.id, target.workspace));
			assert.ok(restored.get("SELECT 1 FROM goal_evidence WHERE id='evidence' AND ref=? AND json_extract(detail,'$.path')=?", join(target.workspace, "报告.md"), join(target.workspace, "报告.md")));
			assert.ok(restored.get("SELECT 1 FROM goal_events WHERE dedupe_key='backup-fixture' AND json_extract(payload,'$.path')=?", join(target.workspace, "报告.md")));
			assert.ok(restored.get("SELECT 1 FROM schedules WHERE id=? AND goal_id=? AND cwd=? AND session_file=?", schedule.id, goal.id, target.workspace, session.path));
			assert.ok(restored.get("SELECT 1 FROM schedule_changes WHERE schedule_id=? AND json_extract(after,'$.cwd')=? AND json_extract(after,'$.sessionFile')=?", schedule.id, target.workspace, session.path));
			assert.ok(restored.get("SELECT 1 FROM patrol_runs WHERE id='patrol' AND session_file=?", session.path));
			assert.ok(restored.get("SELECT 1 FROM goal_proposals WHERE id='proposal' AND session_file=? AND json_extract(draft,'$.scope.cwd')=?", session.path, target.workspace));
			assert.ok(restored.get("SELECT 1 FROM jobs WHERE id='job' AND exit_code=0 AND goal_id=? AND session_file=? AND cwd=? AND output_path IS NULL",
				goal.id, session.path, target.workspace));
		} finally { restored.close(); }
	} finally { await target?.cleanup(); await source.cleanup(); }
});
