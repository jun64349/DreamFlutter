// Packaged desktop smoke. The Core executable is real; the model replies over loopback.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const core = resolve(process.argv[2]);
const { WebSocket } = createRequire(join(core, "package.json"))("ws");
const root = await mkdtemp(join(tmpdir(), "df-packaged-workbench-"));
const data = join(root, "data"), agent = join(root, "agent"), sessions = join(root, "sessions"), workspace = join(root, "workspace");
const requests = [];
const endpoint = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body.messages);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "local-" + requests.length, object: "chat.completion.chunk", created: 1, model: "fixture" };
    for (const choices of [
      [{ index: 0, delta: { role: "assistant", content: "local reply " + requests.length }, finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: "stop" }],
    ]) response.write("data: " + JSON.stringify({ ...base, choices }) + "\n\n");
    response.end("data: [DONE]\n\n");
  } catch { response.writeHead(400).end(); }
});
const env = Object.fromEntries(["SystemRoot", "WINDIR", "SystemDrive", "COMSPEC", "PATH", "PATHEXT", "LANG"].flatMap(key =>
  process.env[key] ? [[key, process.env[key]]] : []));
Object.assign(env, { APPDATA: root, LOCALAPPDATA: root, USERPROFILE: root, HOME: root, TEMP: root, TMP: root, TMPDIR: root,
  DREAMFLUTTER_DATA: data, DREAMFLUTTER_TEST_MASTER_KEY: "0123456789abcdef".repeat(4) });

async function withCore(run) {
  const child = spawn(process.execPath, [join(core, "src/main.ts"), "--data-dir", data, "--agent-dir", agent, "--session-dir", sessions],
    { env, cwd: workspace, windowsHide: true, stdio: "ignore" });
  const closed = once(child, "close");
  let ws;
  try {
    let info;
    for (let i = 0; i < 300; i++) {
      if (child.exitCode !== null) throw Error("bundled Core exited during startup, code " + child.exitCode);
      try {
        const saved = JSON.parse(await readFile(join(data, "core.json"), "utf8"));
        if (saved.pid === child.pid) { info = saved; break; }
      } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      await delay(100);
    }
    assert.ok(info, "bundled Core did not publish readiness");
    ws = new WebSocket("ws://127.0.0.1:" + info.port, { headers: { Authorization: "Bearer " + info.token }, handshakeTimeout: 5000 });
    await once(ws, "open");
    const replies = new Map(), events = [];
    let seq = 0;
    ws.on("message", bytes => {
      const value = JSON.parse(bytes.toString());
      if (value.event) events.push(value);
      else replies.set(value.id, value);
    });
    async function waitFor(probe, label) {
      for (let i = 0; i < 300; i++) {
        const hit = probe();
        if (hit) return hit;
        if (ws.readyState !== WebSocket.OPEN) break;
        await delay(100);
      }
      throw Error("bundled workbench timed out waiting for " + label);
    }
    async function rpc(method, params = {}) {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params }));
      const value = await waitFor(() => replies.get(id), method);
      if (value.error) throw Error(method + ": " + value.error.message);
      return value.result;
    }
    await run(rpc, () => waitFor(() => events.find(event => event.event === "slot.record" && event.record?.type === "agent_settled"), "agent_settled"), waitFor, events);
    await rpc("core.shutdown");
    const outcome = await Promise.race([closed, delay(10_000, null, { ref: false })]);
    assert.equal(outcome?.[0], 0, "bundled Core should shut down cleanly");
  } finally {
    ws?.terminate();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
}

try {
  await mkdir(workspace);
  endpoint.listen(0, "127.0.0.1");
  await once(endpoint, "listening");
  let file, sessionId, noteId;
  const note = "fixture-pinned-project-763";
  const bundles = ["usage-dashboard", "window-shortcuts"];
  for (const turn of [1, 2]) {
    await withCore(async (rpc, settled) => {
      if (turn === 1) {
        const channel = await rpc("gateway.saveChannel", { name: "offline-smoke", api: "openai-completions",
          baseUrl: "http://127.0.0.1:" + endpoint.address().port + "/v1", keys: [{ secret: "loopback-fixture" }], models: [{ id: "fixture" }] });
        await rpc("settings.update", { defaultModel: "df-" + channel.id + "/fixture", autoTitle: false, memoryAutoExtract: false });
      }
      const { plugins } = await rpc("plugins.list");
      assert.deepEqual(plugins.filter(plugin => plugin.kind === "catalog").map(plugin => plugin.id).sort(), [...bundles].sort());
      assert.equal(plugins.find(plugin => plugin.id === "memory").active, turn === 1);
      if (turn === 1) {
        noteId = (await rpc("memory.save", { content: "项目名：" + note, scope: "global", pinned: true })).item.id;
        for (const id of bundles) await rpc("plugins.install", { id });
      } else {
        assert.ok(bundles.every(id => plugins.find(plugin => plugin.id === id).active));
      }
      assert.equal((await rpc("plugins.shortcuts")).bindings[0].command, "spending.open");
      const slot = await rpc("slot.open", { cwd: workspace, sessionFile: file });
      assert.equal(slot.agentMode, "standard", "the regular workbench should start in standard mode");
      file = slot.sessionFile;
      if (turn === 1) sessionId = slot.sessionId;
      assert.equal(slot.sessionId, sessionId);
      await rpc("slot.send", { slotId: slot.slotId, record: { type: "prompt", message: "local prompt " + turn } });
      const result = await settled();
      assert.equal(result.record.aborted, false);
      const dashboard = await rpc("plugins.usage", { slotId: slot.slotId });
      assert.equal(dashboard.days.length, 7);
      assert.equal(dashboard.session.turns, turn);
      assert.equal(JSON.stringify(requests.at(-1)).includes(note), turn === 1);
      const changed = await rpc(turn === 1 ? "plugins.disable" : "plugins.enable", { id: "memory" });
      assert.equal(changed.plugins.find(plugin => plugin.id === "memory").restartRequired, true);
      if (turn === 2) {
        for (const id of bundles) await rpc("plugins.remove", { id });
        assert.deepEqual((await rpc("plugins.shortcuts")).bindings, []);
      }
      await rpc("slot.close", { slotId: slot.slotId });
      assert.match(await readFile(file, "utf8"), /"customType":"df\.dshSession"/, "the workbench did not use the official harness");
    });
  }
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1]), /local prompt 1/);
  assert.match(JSON.stringify(requests[1]), /local reply 1/);

  const legacyFile = join(sessions, "legacy-bundled.jsonl");
  const timestamp = new Date().toISOString();
  const legacyId = "legacy-bundled-fixture";
  const legacyBytes = [
    { type: "session", version: 3, id: legacyId, timestamp, cwd: workspace },
    { type: "message", id: "legacy-message", parentId: null, timestamp,
      message: { role: "user", content: [{ type: "text", text: "preserved old history" }], timestamp: Date.parse(timestamp) } },
  ].map(entry => JSON.stringify(entry)).join("\n");
  await writeFile(legacyFile, legacyBytes);
  let continuation;
  await withCore(async (rpc, settled) => {
    assert.equal((await rpc("memory.item", { id: noteId })).item.content, "项目名：" + note);
    assert.ok((await rpc("plugins.list")).plugins.filter(plugin => plugin.kind === "catalog").every(plugin => !plugin.installed));
    const original = await rpc("slot.open", { cwd: workspace, sessionFile: legacyFile });
    assert.equal(original.readOnly, true);
    continuation = await rpc("sessions.continue", { sourceSlotId: original.slotId });
    assert.notEqual(continuation.sessionId, legacyId);
    await rpc("slot.send", { slotId: continuation.slotId, record: { type: "prompt", message: "continued old chat" } });
    assert.equal((await settled()).record.aborted, false);
    await rpc("slot.close", { slotId: continuation.slotId });
    await rpc("slot.close", { slotId: original.slotId });
  });
  await withCore(async (rpc, settled, waitFor, events) => {
    const resumed = await rpc("slot.open", { cwd: workspace, sessionFile: continuation.sessionFile });
    assert.equal(resumed.sessionId, continuation.sessionId);
    await rpc("slot.send", { slotId: resumed.slotId, record: { type: "prompt", message: "restarted continued chat" } });
    assert.equal((await settled()).record.aborted, false);
    await rpc("slot.close", { slotId: resumed.slotId });
    const job = await rpc("backup.export", { path: join(root, "continued.dfbackup"), includeSandbox: false, includeMaterials: false });
    const backup = await waitFor(() => events.find(event => event.event === "backup.job" && event.job?.id === job.id && event.job.status !== "running"), "the continued session backup");
    assert.equal(backup.job.status, "done", backup.job.error);
    assert.ok(backup.job.result.manifest.files.some(entry => entry.path.includes("data/dsh/")));
  });
  assert.equal(await readFile(legacyFile, "utf8"), legacyBytes);
  assert.equal(requests.length, 4);
  assert.match(JSON.stringify(requests[3]), /preserved old history.+continued old chat.+local reply 3/);
  console.log("Bundled Core verified through desktop WebSocket: standard and continued legacy chats across restarts, original bytes unchanged, local catalog install/restart/remove, memory restart, native backup exported.");
} finally {
  endpoint.closeAllConnections();
  if (endpoint.listening) await new Promise(resolve => endpoint.close(resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 4 });
}
