import assert from "node:assert/strict";
import { it } from "node:test";
import { parseScheduleTime, scheduleTimeText } from "../src/modules/schedule-time.ts";
import { startTestCore } from "./harness.ts";

const current = Date.parse("2026-11-13T04:00:00Z");
const zone = "Asia/Taipei";

it("parses every supported Chinese time form and writes canonical text back", () => {
	const cases: Array<[string, string]> = [
		["11月14日 14:00", "11月14日 14:00"],
		["11月14日14:00", "11月14日 14:00"],
		["2026年11月14日 下午3点", "11月14日 15:00"],
		["2026-11-14 9点半", "11月14日 09:30"],
		["2026-11-1414:00", "11月14日 14:00"],
		["今天 晚上10点", "11月13日 22:00"],
		["明天下午3点", "11月14日 15:00"],
		["明天 9:00", "11月14日 09:00"],
		["后天 早上8点", "11月15日 08:00"],
		["周五 下午3点", "11月13日 15:00"],
		["星期一 9点", "11月16日 09:00"],
		["晚上10点", "11月13日 22:00"],
		["14:00", "11月13日 14:00"],
		["9点半", "11月14日 09:30"],
		["每天 08:00", "每天 08:00"],
		["每天8点", "每天 08:00"],
		["每天 9点半、下午3点", "每天 09:30、15:00"],
		["每天 08:00，12:00,18:00", "每天 08:00、12:00、18:00"],
		["每天 08:00 12:00", "每天 08:00、12:00"],
		["工作日 9:00", "工作日 09:00"],
		["工作日9点", "工作日 09:00"],
		["工作日 下午3点", "工作日 15:00"],
		["周末 10:00", "周末 10:00"],
		["周末10点", "周末 10:00"],
		["周末 9点半", "周末 09:30"],
		["每周一 09:00", "每周一 09:00"],
		["每周一9点", "每周一 09:00"],
		["每星期一、三、五 9点", "每周一、三、五 09:00"],
		["每礼拜二、四 10:00", "每周二、四 10:00"],
		["每周六 8点", "每周六 08:00"],
		["每月1日 10:00", "每月1日 10:00"],
		["每月1号10点", "每月1日 10:00"],
		["每月 15 号 下午3点", "每月15日 15:00"],
		["每 2 小时", "每 2 小时"],
		["每 30 分钟", "每 30 分钟"],
	];
	for (const [input, canonical] of cases) {
		const parsed = parseScheduleTime(input, zone, current);
		assert.equal(parsed.text, canonical, input);
		assert.equal(scheduleTimeText(parsed.trigger, current), canonical, input);
		const again = parseScheduleTime(canonical, zone, current);
		assert.deepEqual(again.trigger, parsed.trigger, input);
	}
});

it("shows the year only when a one-off crosses the current year", () => {
	const nearYearEnd = Date.parse("2026-12-31T15:00:00Z"); // 23:00 in Asia/Taipei
	const next = parseScheduleTime("明天9点", zone, nearYearEnd);
	assert.equal(next.text, "2027年1月1日 09:00");
	assert.equal(scheduleTimeText(next.trigger, nearYearEnd), next.text);
	assert.deepEqual(parseScheduleTime(next.text, zone, nearYearEnd).trigger, next.trigger);
	const sameYear = parseScheduleTime("12月31日23:30", zone, nearYearEnd);
	assert.equal(sameYear.text, "12月31日 23:30");
	assert.equal(scheduleTimeText(sameYear.trigger, nearYearEnd), sameYear.text);
});

it("rejects unclear or past times with examples and leaves arbitrary cron unrendered", () => {
	for (const text of ["随便哪天", "每天 25:00", "每月32日 10:00"])
		assert.throws(() => parseScheduleTime(text, zone, current), { code: "bad_request", message: /没看懂/, data: { examples: ["每天 08:00", "每周一 09:00", "11月14日 14:00"] } });
	for (const text of ["2026-11-12 10:00", "今天 08:00"])
		assert.throws(() => parseScheduleTime(text, zone, current), { code: "bad_request", message: /已经过了/, data: { examples: ["每天 08:00", "每周一 09:00", "11月14日 14:00"], past: true } });
	assert.throws(() => parseScheduleTime("每天 08:00", "Not/A_Timezone", current), { code: "bad_request" });
	assert.equal(scheduleTimeText({ type: "cron", cron: "*/5 * * * *", timezone: zone }), null);
	assert.equal(scheduleTimeText({ type: "once", at: current + 1, timezone: zone }), null);
});

it("window task schedules use Butterfly cwd, require a prompt, and expose timeText", async () => {
	const t = await startTestCore();
	try {
		const parsed = parseScheduleTime("每天 9点半", zone, current);
		const saved = await t.core.call("schedules.save", { kind: "task", name: "写笔记", prompt: "整理学习内容", trigger: parsed.trigger }) as { cwd: string; timeText: string };
		assert.equal(saved.cwd, t.core.paths.butterflyDir);
		assert.equal(saved.timeText, parsed.text);
		await assert.rejects(t.core.call("schedules.save", { kind: "task", name: "空任务", trigger: parsed.trigger }), { code: "bad_request" });
	} finally { await t.cleanup(); }
});
