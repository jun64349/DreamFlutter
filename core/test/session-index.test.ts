import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { SearchHit, SessionRow, UsageRow } from "../src/modules/session-index.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

function sessionFile(path: string, cwd: string, entries: Record<string, unknown>[]): void {
	const header = { type: "session", version: 3, id: path.slice(-8), timestamp: "2026-10-01T08:00:00.000Z", cwd };
	writeFileSync(path, [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
}

const user = (id: string, text: string, ts: number) => ({ type: "message", id, parentId: null, timestamp: new Date(ts).toISOString(), message: { role: "user", content: [{ type: "text", text }], timestamp: ts } });
const assistant = (id: string, text: string, ts: number, cost = 0.01) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: new Date(ts).toISOString(),
	message: {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "deepseek",
		model: "deepseek-flash",
		usage: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 0, cost: { total: cost } },
		timestamp: ts,
	},
});

describe("session index", () => {
	let t: TestCore;
	let dir: string;

	beforeEach(async () => {
		t = await startTestCore();
		dir = join(t.sessionDir, "--ws--");
		mkdirSync(dir, { recursive: true });
		const day1 = Date.parse("2026-10-01T09:00:00");
		const day2 = Date.parse("2026-10-02T09:00:00");
		sessionFile(join(dir, "a.jsonl"), t.workspace, [
			user("u1", "帮我写一份季度销售报告", day1),
			assistant("a1", "好的，这是季度销售报告的大纲……", day1 + 1000),
			{ type: "session_info", id: "i1", parentId: null, timestamp: new Date(day1).toISOString(), name: "季度报告" },
		]);
		sessionFile(join(dir, "b.jsonl"), t.workspace, [user("u1", "翻译这段英文 hello world", day2), assistant("a1", "你好，世界", day2 + 1000, 0.02)]);
		sessionFile(join(dir, "c.jsonl"), join(t.dir, "elsewhere"), [user("u1", "别的工作区里的销售数据", day2)]);
	});

	afterEach(async () => {
		await t.cleanup();
	});

	it("lists sessions of a workspace with titles", async () => {
		const rows = (await t.core.call("sessions.list", { cwd: t.workspace })) as SessionRow[];
		assert.deepEqual(rows.map((r) => r.title).sort(), ["季度报告", "翻译这段英文 hello world"].sort());
		assert.equal(rows.find((r) => r.title === "季度报告")!.messageCount, 2);
	});

	// 0.8.2 user test 4: opening a conversation appends model or title entries, which moved it to
	// the top of the list. Its time is its last message, not the file's.
	it("orders sessions by their last message, not by later non-message entries", async () => {
		const path = join(dir, "a.jsonl");
		writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify({ type: "model_change", id: "m9", parentId: null, timestamp: new Date().toISOString(), provider: "deepseek", modelId: "deepseek-flash" })}\n`);
		const rows = (await t.core.call("sessions.list", { cwd: t.workspace })) as SessionRow[];
		assert.deepEqual(rows.map((r) => r.title), ["翻译这段英文 hello world", "季度报告"], "b's last message is newer than a's");
		assert.equal(rows.find((r) => r.title === "季度报告")!.modifiedAt, Date.parse("2026-10-01T09:00:00") + 1000);
	});

	it("searches message text, including short Chinese queries", async () => {
		const long = (await t.core.call("sessions.search", { query: "销售报告" })) as SearchHit[];
		assert.ok(long.some((h) => h.title === "季度报告" && h.snippet.includes("【销售报告】")));
		const short = (await t.core.call("sessions.search", { query: "世界" })) as SearchHit[];
		assert.equal(short.length, 1);
		assert.equal(short[0]!.role, "assistant");
		const scoped = (await t.core.call("sessions.search", { query: "销售", cwd: t.workspace })) as SearchHit[];
		assert.ok(scoped.every((h) => h.cwd === t.workspace));
	});

	it("pins and archives sessions; flags survive re-indexing", async () => {
		const path = join(dir, "b.jsonl");
		await t.core.call("sessions.list", {});
		await t.core.call("sessions.setPinned", { path, pinned: true });
		await t.core.call("sessions.setArchived", { path: join(dir, "a.jsonl"), archived: true });
		// Touch the file so it is re-parsed.
		writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify(user("u2", "再来一句", Date.now()))}\n`);
		const rows = (await t.core.call("sessions.list", { cwd: t.workspace })) as SessionRow[];
		assert.equal(rows.length, 1, "archived sessions are hidden by default");
		assert.equal(rows[0]!.pinned, true);
		assert.equal(rows[0]!.messageCount, 3);
		const archived = (await t.core.call("sessions.list", { cwd: t.workspace, archived: "only" })) as SessionRow[];
		assert.equal(archived[0]!.title, "季度报告");
	});

	it("forgets deleted files", async () => {
		await t.core.call("sessions.list", {});
		rmSync(join(dir, "a.jsonl"));
		const rows = (await t.core.call("sessions.list", { cwd: t.workspace })) as SessionRow[];
		assert.equal(rows.length, 1);
		const hits = (await t.core.call("sessions.search", { query: "销售报告" })) as SearchHit[];
		assert.ok(hits.every((h) => !h.path.endsWith("a.jsonl")));
	});

	it("summarizes usage by day and by model", async () => {
		const byDay = (await t.core.call("usage.summary", { groupBy: "day" })) as UsageRow[];
		assert.deepEqual(byDay.map((r) => r.key), ["2026-10-01", "2026-10-02"]);
		assert.equal(byDay[1]!.cost, 0.02);
		const byModel = (await t.core.call("usage.summary", { groupBy: "model" })) as UsageRow[];
		assert.equal(byModel.length, 1);
		assert.equal(byModel[0]!.key, "deepseek/deepseek-flash");
		assert.equal(byModel[0]!.input, 2000);
		assert.equal(byModel[0]!.responses, 2);
	});

	it("indexes sessions the core itself ran", async () => {
		await t.core.call("slot.open", { slotId: "s1", cwd: t.workspace }, t.client);
		t.respond(fauxAssistantMessage("关于火星探测的回答"));
		await t.send("s1", { id: "p", type: "prompt", message: "讲讲火星探测" });
		await t.waitFor(() => settledCount(t.records("s1")) === 1);
		const hits = (await t.core.call("sessions.search", { query: "火星探测" })) as SearchHit[];
		assert.equal(hits.length, 2, "both the question and the answer match");
	});
});
