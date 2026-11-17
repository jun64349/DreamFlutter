// v0.13.1: the remaining problems from the real-task verification (docs/releases/v0.13-真实任务验证回执.md, 4 and 6).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { WORKBENCH_IDENTITY } from "../src/agent/host-text.ts";
import { parseScheduleTime, scheduleTimeText } from "../src/modules/schedule-time.ts";
import { settledCount, startTestCore } from "./harness.ts";

const zone = "Asia/Taipei";
const current = Date.parse("2026-11-13T04:00:20Z"); // 12:00:20 in Asia/Taipei

test("v0.13.1 schedule time understands 「N 分钟后」 and 「N 小时后」", () => {
	const cases: Array<[string, string]> = [
		["30分钟后", "11月13日 12:31"],
		["30 分钟后", "11月13日 12:31"],
		["5分后", "11月13日 12:06"],
		["2小时后", "11月13日 14:01"],
		["2 个小时以后", "11月13日 14:01"],
		["半小时后", "11月13日 12:31"],
		["一个半小时后", "11月13日 13:31"],
		["1小时20分钟后", "11月13日 13:21"],
		["十五分钟后", "11月13日 12:16"],
		["两小时之后", "11月13日 14:01"],
		["二十分钟后", "11月13日 12:21"],
		["13小时后", "11月14日 01:01"],
	];
	for (const [input, canonical] of cases) {
		const parsed = parseScheduleTime(input, zone, current);
		assert.equal(parsed.trigger.type, "once", input);
		assert.equal(parsed.text, canonical, input);
		assert.equal(parsed.trigger.at! % 60_000, 0, `${input}: whole minutes`);
		assert.ok(parsed.trigger.at! > current, input);
		assert.equal(scheduleTimeText(parsed.trigger, current), canonical, input);
		assert.deepEqual(parseScheduleTime(canonical, zone, current).trigger, parsed.trigger, input);
	}
	for (const text of ["0分钟后", "分钟后", "后", "两十分钟后", "三十个小时二十分钟以前"])
		assert.throws(() => parseScheduleTime(text, zone, current), { code: "bad_request", message: /没看懂/ }, text);
	// The forms that worked before still do.
	assert.equal(parseScheduleTime("明天下午3点", zone, current).text, "11月14日 15:00");
	assert.equal(parseScheduleTime("每 30 分钟", zone, current).text, "每 30 分钟");
});

test("v0.13.1 the workbench agent is told it is not 蝶君", async () => {
	const t = await startTestCore();
	try {
		let system = "";
		t.respond((context: Context) => {
			const messages = context.messages.filter((m) => (m.role as string) === "system") as unknown as { content: string }[];
			system = messages.at(-1)?.content ?? "";
			return fauxAssistantMessage("好");
		});
		await t.core.call("slot.open", { slotId: "w1", cwd: t.workspace }, t.client);
		const before = settledCount(t.records("w1"));
		await t.send("w1", { id: "p1", type: "prompt", message: "你是谁" });
		await t.waitFor(() => settledCount(t.records("w1")) === before + 1);
		assert.ok(system.includes(WORKBENCH_IDENTITY), "workbench system prompt carries its identity");
		assert.match(WORKBENCH_IDENTITY, /Never call yourself 蝶君/);
	} finally {
		await t.cleanup();
	}
});
