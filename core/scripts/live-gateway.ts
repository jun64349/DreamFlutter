/**
 * Live check of the model gateway against the real DeepSeek API: a model group
 * whose first channel has an invalid key and whose second is the user's Pi
 * DeepSeek provider. The conversation should move to the second channel and
 * stay there; a background call through the group should work too.
 *   node --disable-warning=ExperimentalWarning scripts/live-gateway.ts
 * Uses ~/.pi/agent for the DeepSeek provider; data and sessions go to a temp dir.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildCore } from "../src/app.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { corePaths } from "../src/paths.ts";

const piProvider = process.env.DF_PI_PROVIDER ?? "cc-switch-deep-seek";
const piModel = process.env.DF_PI_MODEL ?? "deepseek-flash";
const dir = mkdtempSync(join(tmpdir(), "df-live-gw-"));
const workspace = join(dir, "ws");
mkdirSync(workspace, { recursive: true });
const core = buildCore({
	paths: corePaths(join(dir, "data")),
	agentDir: join(homedir(), ".pi", "agent"),
	sessionDir: join(dir, "sessions"),
	log: new Logger(undefined, false),
	notifier: new RecordingNotifier(),
});
core.settings.update({ autoTitle: false, memoryAutoExtract: false, approvalMode: "off" });
await core.start();

const bad = (await core.call("gateway.saveChannel", {
	name: "坏 Key 渠道",
	platform: "deepseek",
	api: "openai-completions",
	baseUrl: "https://api.deepseek.com/v1",
	models: [{ id: piModel, contextWindow: 128_000, maxTokens: 8_192 }],
	keys: [{ secret: "sk-invalid-dreamflutter-gateway-check" }],
})) as { id: string };
await core.call("gateway.saveGroup", {
	id: "live",
	name: "实测",
	entries: [
		{ channel: bad.id, model: piModel, priority: 0 },
		{ channel: `pi:${piProvider}`, model: piModel, priority: 1 },
	],
});
core.settings.update({ defaultModel: "dreamflutter/live" });

const records: Record<string, unknown>[] = [];
const events: Record<string, unknown>[] = [];
const client = core.addClient((m) => {
	if (m.event === "slot.record") records.push(m.record as Record<string, unknown>);
	else if (m.event === "gateway.switched") events.push(m);
});
await core.call("slot.open", { slotId: "s", cwd: workspace }, client);
for (const prompt of ["只回复两个字：你好", "再只回复两个字：收到"]) {
	const before = records.filter((r) => r.type === "agent_settled").length;
	await core.call("slot.send", { slotId: "s", record: { id: "p", type: "prompt", message: prompt } }, client);
	const deadline = Date.now() + 3 * 60_000;
	while (records.filter((r) => r.type === "agent_settled").length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
	const last = records.filter((r) => r.type === "message_end" && (r.message as { role?: string }).role === "assistant").at(-1)?.message as
		| { provider: string; model: string; stopReason: string; errorMessage?: string; content: { type: string; text?: string }[] }
		| undefined;
	console.log(`\n> ${prompt}\n< [${last?.provider}/${last?.model} ${last?.stopReason}] ${last?.content.map((c) => c.text ?? "").join("") || last?.errorMessage}`);
}
console.log("\nswitch events:", events.map((e) => `${e.from} → ${e.to}（${e.reason}）`));
console.log("\nrequests:");
for (const row of core.db.all<Record<string, unknown>>("SELECT channel, ok, error_kind, ttft_ms, duration_ms, input, output, cache_read, error FROM gateway_requests ORDER BY id")) {
	console.log(" ", { ...row, error: typeof row.error === "string" ? row.error.slice(0, 80) : row.error });
}
const channels = (await core.call("gateway.channels", {})) as { name: string; unavailable: unknown }[];
console.log("\nchannel status:", channels.map((c) => `${c.name}: ${c.unavailable ? JSON.stringify(c.unavailable).slice(0, 100) : "正常"}`));

// A background call (titles, memory) through the group: the bad channel is resting, so it goes straight to DeepSeek.
const test = await core.call("providers.test", { provider: "dreamflutter", model: "live" });
console.log("\nbackground call through the group:", test);
await core.shutdown();
