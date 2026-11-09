import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ALLOW, DENY } from "../src/pi/dialogs.ts";
import { dialogs, settledCount, startTestCore, type TestCore } from "./harness.ts";

describe("T-74 actual Pi tool registration and workbench approval", () => {
	let t: TestCore;
	function git(...args: string[]) { return execFileSync("git", ["-c", "commit.gpgSign=false", ...args], { cwd: t.workspace, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
	beforeEach(async () => {
		t = await startTestCore();
		git("init", "-b", "main"); git("config", "user.name", "T74 fixture"); git("config", "user.email", "fixture@example.invalid");
		writeFileSync(join(t.workspace, "hello.txt"), "base\n"); git("add", "hello.txt"); git("commit", "-m", "base");
		t.core.settings.update({ approvalMode: "all" });
		await t.core.call("slot.open", { slotId: "git", cwd: t.workspace }, t.client);
	});
	afterEach(async () => { await t?.cleanup(); });
	const call = (name: string, input: Parameters<typeof fauxToolCall>[1] = {}) => fauxAssistantMessage([fauxToolCall(name, input)], { stopReason: "toolUse" });
	async function send(message: string) {
		const before = settledCount(t.records("git"));
		await t.send("git", { id: `prompt-${Math.random()}`, type: "prompt", message });
		return () => t.waitFor(() => settledCount(t.records("git")) > before, 20_000);
	}
	it("executes real read tools without a dialog even in all approval mode", async () => {
		t.respond(call("git_status"), call("git_diff"), call("git_history"), fauxAssistantMessage("已核对"));
		await (await send("检查 Git"))();
		assert.equal(dialogs(t.records("git")).length, 0);
		const results = t.records("git").filter((r) => r.type === "tool_execution_end");
		assert.deepEqual(results.map((r) => r.toolName), ["git_status", "git_diff", "git_history"]);
		for (const result of results) assert.equal(result.isError, false, JSON.stringify(result));
	});
	it("denies a write without touching the index, then stages and commits only after approval", async () => {
		writeFileSync(join(t.workspace, "hello.txt"), "changed\n");
		t.respond(call("git_stage", { paths: ["hello.txt"] }), fauxAssistantMessage("已拒绝"));
		let done = await send("暂存这个改动");
		let dialog = await t.waitFor(() => dialogs(t.records("git"))[0]);
		await t.send("git", { type: "extension_ui_response", id: dialog.id, value: DENY }); await done();
		assert.equal(git("diff", "--cached", "--name-only"), "");
		const before = dialogs(t.records("git")).length;
		t.respond(call("git_stage", { paths: ["hello.txt"] }), call("git_commit", { message: "T74 approved commit" }), fauxAssistantMessage("完成"));
		done = await send("暂存并提交");
		for (let i = 0; i < 2; i++) {
			dialog = await t.waitFor(() => dialogs(t.records("git"))[before + i], 20_000);
			await t.send("git", { type: "extension_ui_response", id: dialog.id, value: ALLOW });
		}
		await done();
		assert.equal(git("log", "-1", "--format=%s"), "T74 approved commit");
		assert.equal(git("log", "-1", "--format=%an <%ae>"), "T74 fixture <fixture@example.invalid>");
	});
});
