import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { runWsl, type SandboxStatus } from "../src/sandbox/sandbox.ts";
import { dialogs, settledCount, startTestCore, type TestCore } from "./harness.ts";

/**
 * 蝶君's tools in a real WSL sandbox, with the faux model. Builds a sandbox
 * (several minutes: download + apt), so it only runs with DF_WSL_LIVE=1:
 *   $env:DF_WSL_LIVE = "1"; node --disable-warning=ExperimentalWarning --test test/sandbox-live.test.ts
 */
const live = process.env.DF_WSL_LIVE === "1";
const distro = "DFSandboxTestLive";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join("") : "";
}

describe("sandbox sessions on WSL (DF_WSL_LIVE=1)", { skip: !live }, () => {
	let t: TestCore;
	before(async () => {
		t = await startTestCore(undefined, { sandbox: { distro } });
		await t.core.call("sandbox.provision", {});
		for (;;) {
			await new Promise((r) => setTimeout(r, 3_000));
			const status = (await t.core.call("sandbox.status", {})) as SandboxStatus;
			if (status.state === "ready") break;
			if (status.state === "error") throw new Error(status.error ?? "provisioning failed");
		}
	});
	after(async () => {
		await t?.core.call("sandbox.remove", {}).catch(() => {});
		await t?.cleanup();
	});

	it("runs bash, writes, reads and searches inside the sandbox without asking", async () => {
		t.core.settings.update({ approvalMode: "all" });
		const results: string[] = [];
		const steps = [
			fauxToolCall("bash", { command: "cd /workspace/scratch && echo 你好沙箱 > hello.txt && pwd && whoami && (grep -c drvfs /proc/mounts || true)" }),
			fauxToolCall("write", { file_path: "/workspace/outbox/report.md", content: "# 报告\n结论：沙箱可用\n" }),
			fauxToolCall("read", { file_path: "/workspace/scratch/hello.txt" }),
			fauxToolCall("grep", { pattern: "结论", path: "/workspace/outbox" }),
			fauxToolCall("bash", { command: "pwd" }),
		];
		let step = 0;
		const route = (context: Context) => {
			const last = context.messages.at(-1)!;
			if (last.role === "toolResult") results.push(textOf(last.content));
			return step < steps.length ? fauxAssistantMessage([steps[step++]!], { stopReason: "toolUse" }) : fauxAssistantMessage("做完了");
		};
		t.respond(...(Array.from({ length: steps.length + 1 }, () => route) as never[]));
		const info = (await t.core.call("slot.open", { slotId: "dj", cwd: t.workspace, sandbox: true }, t.client)) as { sandbox: boolean; agentMode: string };
		assert.equal(info.sandbox, true);
		assert.equal(info.agentMode, "standard");
		await t.send("dj", { id: "p", type: "prompt", message: "试一下沙箱" });
		await t.waitFor(() => settledCount(t.records("dj")) === 1, 120_000);

		assert.equal(dialogs(t.records("dj")).length, 0, "nothing to approve in the sandbox");
		assert.match(results[0]!, /\/workspace\/scratch\nagent\n/, `bash: ${results[0]}`);
		assert.match(results[2]!, /你好沙箱/);
		assert.match(results[3]!, /report\.md/);
		assert.match(results[4]!, /^\/workspace\/scratch/, "the shell keeps its directory");
		const check = await runWsl(["-d", distro, "-u", "agent", "--", "cat", "/workspace/outbox/report.md"]);
		assert.match(check.stdout, /沙箱可用/);
	});
});
