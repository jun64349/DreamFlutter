/** Exactly two short requests. Copies only encrypted channel credentials into a new isolated root. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { buildCore } from "../src/app.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { corePaths } from "../src/paths.ts";

const source = process.argv[2];
const evidence = process.argv[3];
if (!source || !evidence) throw new Error("usage: live-model-config-t61.ts <source-data> <evidence-json>");
const dir = mkdtempSync(join(tmpdir(), "df-t61-live-"));
const data = join(dir, "data");
const copied = JSON.parse(execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(dirname(fileURLToPath(import.meta.url)), "copy-channels.ts"), source, data], { encoding: "utf8" })) as { channel: string; models: string[] }[];
const ids = ["deepseek-v4.1-flash", "mimo-v2.6-flash"];
const channel = copied.find((c) => ids.every((id) => c.models.includes(id)));
assert.ok(channel, "two requested models must be available on the copied channel");
// Bound output only in the isolated copy. No model list/quota request or hidden model work.
const db = new DatabaseSync(corePaths(data).dbFile);
const row = db.prepare("SELECT models FROM gateway_channels WHERE id = ?").get(channel.channel)!;
db.prepare("UPDATE gateway_channels SET models = ? WHERE id = ?").run(JSON.stringify((JSON.parse(String(row.models)) as any[]).map((m) => ({ ...m, maxTokens: 2048 }))), channel.channel);
db.close();
const workspace = join(dir, "workspace");
const agentDir = join(dir, "agent");
const sessionDir = join(dir, "sessions");
for (const path of [workspace, agentDir, sessionDir]) mkdirSync(path);
const core = buildCore({ paths: corePaths(data), agentDir, sessionDir, log: new Logger(undefined, false), notifier: new RecordingNotifier() });
core.settings.update({ autoTitle: false, memoryAutoExtract: false, memoryPaused: true, approvalMode: "off", defaultThinking: null,
  defaultModel: "dreamflutter/t61-live", modelContextWindows: { "dreamflutter/t61-live": 64000, [`df-${channel.channel}/${ids[1]}`]: 96000 } });
const records: any[] = [];
const client = core.addClient((m) => { if (m.event === "slot.record") records.push(m.record); });
let serial = 0;
async function waitFor(probe: () => any, limit = 120_000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) { const value = probe(); if (value) return value; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error("isolated real request timed out");
}
async function rpc(type: string, params: Record<string, unknown>) {
  const id = `rpc-${++serial}`;
  await core.call("slot.send", { slotId: "verify", record: { id, type, ...params } }, client);
  const response = await waitFor(() => records.find((r) => r.id === id && r.type === "response"));
  assert.equal(response.success, true);
  return response.data;
}
const results: any[] = [];
try {
  await core.start();
  await core.call("gateway.saveGroup", { id: "t61-live", name: "T61 isolated", entries: ids.map((model, priority) => ({ channel: channel.channel, model, priority })) });
  await core.call("slot.open", { slotId: "verify", cwd: workspace }, client);
  for (let i = 0; i < 2; i++) {
    if (i) await rpc("set_model", { provider: `df-${channel.channel}`, modelId: ids[i] });
    const state = await rpc("get_state", {});
    const before = records.length;
    await core.call("slot.send", { slotId: "verify", record: { id: `prompt-${i}`, type: "prompt", message: "不要调用工具，只回复 OK。" } }, client);
    await waitFor(() => records.slice(before).some((r) => r.type === "agent_settled"));
    const answer = records.slice(before).filter((r) => r.type === "message_end" && r.message?.role === "assistant").at(-1)?.message;
    const info = await core.call("context.info", { slotId: "verify" });
    results.push({ selection: state.model, thinking: state.thinkingLevel, context: info, provider: answer?.provider, model: answer?.model,
      stopReason: answer?.stopReason, text: answer?.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""), usage: answer?.usage });
    console.log(JSON.stringify({ request: i + 1, ...results.at(-1) }));
    assert.equal(answer?.stopReason, "stop", answer?.errorMessage);
    assert.ok(results.at(-1).text?.includes("OK"));
  }
  const requests = core.db.all("SELECT model, ok, input, output, cache_read, cache_write, cost, duration_ms FROM gateway_requests ORDER BY id");
  assert.equal(requests.length, 2, "no auxiliary or retry requests allowed");
  writeFileSync(evidence, JSON.stringify({ at: new Date().toISOString(), isolatedRoot: dir, requests, results }, null, 2));
} finally {
  await core.shutdown();
}
