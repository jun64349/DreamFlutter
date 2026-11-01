/**
 * Live check of an OpenCode Go channel: fetches the model list, adds the
 * channel the way the window does, has a two-turn conversation with thinking
 * and a tool call, and makes one background call (no session).
 *   $env:OPENCODE_GO_API_KEY = "oc_sk_..."   (PowerShell; keeps the key out of the command line)
 *   node --disable-warning=ExperimentalWarning scripts/live-opencode.ts [model] [anthropic]
 * The model defaults to deepseek-v4.1-flash; "anthropic" uses the Anthropic endpoint
 * (pick one of its models, e.g. minimax-m3). Data and sessions go to a temp dir.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildCore } from "../src/app.ts";
import { platform } from "../src/gateway/platforms.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { corePaths } from "../src/paths.ts";

const key = process.env.OPENCODE_GO_API_KEY;
if (!key) {
	console.error("Set OPENCODE_GO_API_KEY first.");
	process.exit(1);
}
const modelId = process.argv[2] ?? "deepseek-v4.1-flash";
const api = process.argv[3] === "anthropic" ? "anthropic-messages" : "openai-completions";
const baseUrl = platform("opencode-go")!.endpoints.find((e) => e.api === api)!.baseUrl;

const dir = mkdtempSync(join(tmpdir(), "df-live-go-"));
const workspace = join(dir, "ws");
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, "hello.txt"), "蝴蝶 butterfly 42\n");
const core = buildCore({
	paths: corePaths(join(dir, "data")),
	agentDir: join(homedir(), ".pi", "agent"),
	sessionDir: join(dir, "sessions"),
	log: new Logger(undefined, false),
	notifier: new RecordingNotifier(),
});
core.settings.update({ autoTitle: false, memoryAutoExtract: false, approvalMode: "off" });
await core.start();

const listed = (await core.call("gateway.fetchModels", { platform: "opencode-go", api, baseUrl, apiKey: key })) as { id: string; contextWindow?: number; efforts?: string[] }[];
console.log(`model list (${api}): ${listed.length} models`);
const model = listed.find((m) => m.id === modelId);
if (!model) {
	console.error(`${modelId} is not in the list: ${listed.map((m) => m.id).join(", ")}`);
	process.exit(1);
}
console.log("model:", model);

const channel = (await core.call("gateway.saveChannel", { name: "OpenCode Go", platform: "opencode-go", api, baseUrl, models: [model], keys: [{ secret: key }] })) as { id: string };
core.settings.update({ defaultModel: `df-${channel.id}/${modelId}`, defaultThinking: "high" });

const records: Record<string, unknown>[] = [];
const client = core.addClient((m) => {
	if (m.event === "slot.record") records.push(m.record as Record<string, unknown>);
});
await core.call("slot.open", { slotId: "s", cwd: workspace }, client);
for (const prompt of ["读一下 hello.txt，只回复里面的数字", "再只回复两个字：收到"]) {
	const before = records.filter((r) => r.type === "agent_settled").length;
	await core.call("slot.send", { slotId: "s", record: { id: "p", type: "prompt", message: prompt } }, client);
	const deadline = Date.now() + 3 * 60_000;
	while (records.filter((r) => r.type === "agent_settled").length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
	const last = records.filter((r) => r.type === "message_end" && (r.message as { role?: string }).role === "assistant").at(-1)?.message as
		| { stopReason: string; errorMessage?: string; content: { type: string; text?: string; thinking?: string }[] }
		| undefined;
	const thought = last?.content.some((c) => c.type === "thinking" && c.thinking);
	console.log(`\n> ${prompt}\n< [${last?.stopReason}${thought ? " · thought" : ""}] ${last?.content.map((c) => c.text ?? "").join("") || last?.errorMessage}`);
}
console.log("\nrequests:");
for (const row of core.db.all<Record<string, unknown>>("SELECT ok, error_kind, ttft_ms, duration_ms, input, output, cache_read, error FROM gateway_requests ORDER BY id")) {
	console.log(" ", { ...row, error: typeof row.error === "string" ? row.error.slice(0, 120) : row.error });
}
// A call outside a conversation (titles, memory) has no session id of its own.
console.log("\nbackground call:", await core.call("gateway.testChannel", { channel: channel.id, model: modelId }));
await core.shutdown();
