import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildCore } from "../src/app.ts";
import { corePaths } from "../src/paths.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { Gateway, type Transport } from "../src/gateway/gateway.ts";
import { PiMigration } from "../src/gateway/pi-migration.ts";
import { readPiJson } from "../src/gateway/pi-config.ts";
import { secretFileOf } from "../src/modules/secrets.ts";
import { Llm } from "../src/modules/llm.ts";
import { recordedSessionModel } from "../src/pi/host.ts";

const API_KEY = "T70B_SYNTHETIC_API_KEY", ACCESS = "T70B_SYNTHETIC_OAUTH", FRESH = "T70B_SYNTHETIC_REFRESHED";
const oauth = (access: string, expires = Date.now() + 3600000) => ({ type: "oauth" as const, access, refresh: "T70B_SYNTHETIC_REFRESH", expires });
const reply = () => { const stream = createAssistantMessageEventStream(); queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("MOCK_OK") }); stream.end(); }); return stream; };
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "df-t70b-")), agentDir = join(root, "agent"), sessions = join(root, "sessions"), workspace = join(root, "workspace");
  for (const path of [agentDir, sessions, workspace]) mkdirSync(path);
  const base = builtinProviders().find(p => p.id === "openai")!, modelId = base.getModels().find(m => m.type === "chat")!.id;
  const retained = oauth("T70B_LEGACY_CODEX");
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: API_KEY }, "openai-codex": retained }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  const sent: { route: string; provider: string; credentialMatches: boolean }[] = [];
  const apiTransport: Transport = (model, _context, options) => { const native = model.provider === "openai"; sent.push({ route: native ? "oauth" : "api-key", provider: model.provider, credentialMatches: options?.apiKey === (native ? FRESH : API_KEY) }); return reply(); };
  let runtime: ModelRuntime;
  const core = buildCore({ paths: corePaths(join(root, "data")), agentDir, sessionDir: sessions, log: new Logger(), notifier: new RecordingNotifier(), piMigration: { automatic: false, oauthRuntime: async () => runtime }, gatewayTransport: apiTransport });
  core.settings.update({ defaultModel: `openai/${modelId}`, autoTitle: false, memoryPaused: true, memoryAutoExtract: false, autoCheckUpdates: false });
  const migration = core.module(PiMigration)!, gateway = core.module(Gateway)!;
  const state = await migration.migrate() as ReturnType<PiMigration["status"]>; assert.equal(state.status, "done", state.error);
  const mapped = core.db.get<{ channel_id: string }>("SELECT channel_id FROM pi_channel_map WHERE provider='openai'")!.channel_id;
  const apiChannel = gateway.channel(mapped)!, key = core.db.get<{ secret: string }>("SELECT secret FROM gateway_keys WHERE channel_id=?", mapped)!;
  const secretFile = secretFileOf(key.secret)!;
  const fingerprint = () => ({ channels: core.db.all("SELECT * FROM gateway_channels ORDER BY id"), keys: core.db.all("SELECT * FROM gateway_keys ORDER BY id"), maps: core.db.all("SELECT * FROM pi_channel_map ORDER BY provider"), cipher: createHash("sha256").update(readFileSync(secretFile)).digest("hex"), defaultModel: core.settings.get().defaultModel });
  const before = fingerprint(); assert.equal(readPiJson(join(agentDir, "auth.json")).openai, undefined);
  runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), refreshOnCreate: false });
  let refreshes = 0;
  runtime.registerNativeProvider({ ...base, auth: { oauth: { name: "Synthetic ChatGPT", isSubscription: true, async login() { return oauth(ACCESS, Date.now() - 10000); }, async refresh(previous) { refreshes++; return { ...previous, access: FRESH, expires: Date.now() + 3600000 }; }, async toAuth(current) { return { apiKey: current.access }; } } },
    stream: (model, _context, options) => { sent.push({ route: "oauth", provider: model.provider, credentialMatches: options?.apiKey === FRESH }); return reply(); },
    streamSimple: (model, _context, options) => { sent.push({ route: "oauth", provider: model.provider, credentialMatches: options?.apiKey === FRESH }); return reply(); },
  });
  const assertIntact = () => { assert.deepEqual(fingerprint(), before); assert.deepEqual(readPiJson(join(agentDir, "auth.json"))["openai-codex"], retained); };
  const login = async () => {
    const flow = await core.call("piMigration.oauthStart", { provider: "openai" }) as { id: string };
    const limit = Date.now() + 10000;
    while (true) {
      const status = await core.call("piMigration.oauthStatus", { id: flow.id }) as { status: string; error?: string };
      if (status.status === "done") break;
      assert.equal(status.status, "running", status.error); assert.ok(Date.now() < limit, "Synthetic login timed out");
      await new Promise(done => setTimeout(done, 10));
    }
    await runtime.getAuth("openai", { minOAuthValidityMs: 0 }); assert.equal(refreshes, 1); await gateway.refreshConfiguration(); assertIntact();
  };
  return { root, workspace, sessions, core, gateway, runtime, migration, modelId, apiChannel, mapped, sent, before, login, assertIntact, auth: () => readPiJson(join(agentDir, "auth.json")), async cleanup() { await core.shutdown(); assert.ok(root.startsWith(join(tmpdir(), "df-t70b-"))); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

test("T70b gate: migrated OpenAI API key and ChatGPT OAuth coexist through login, refresh, isolated routes and logout", async () => {
  const t = await fixture();
  try {
    await t.login();
    assert.ok(t.gateway.channels().some(c => c.id === "pi:openai" && c.oauth && c.enabled));
    t.gateway.installRuntime(t.runtime);
    for (const provider of [t.apiChannel.provider, "openai"]) { const result = await t.runtime.completeSimple(t.runtime.getModel(provider, t.modelId)!, { messages: [] }, { sessionId: `t70b-${provider}` }); assert.equal(result.stopReason, "stop", result.errorMessage); }
    assert.deepEqual(t.sent.map(s => [s.route, s.provider, s.credentialMatches]), [["api-key", t.apiChannel.provider, true], ["oauth", "openai", true]]);
    await t.core.call("piMigration.oauthLogout", { provider: "openai" }); t.assertIntact(); assert.equal(t.auth().openai, undefined);
    await t.runtime.completeSimple(t.runtime.getModel(t.apiChannel.provider, t.modelId)!, { messages: [] });
    assert.equal(t.sent.at(-1)!.route, "api-key"); assert.equal(t.sent.at(-1)!.credentialMatches, true);
    writeFileSync("../Claude Codex Bridge/T70b-storage-gate.json", JSON.stringify({ passed: true, loginAndRefreshPreserveApiChannelAndCiphertext: true, logoutPreservesApiChannelAndCiphertext: true, retainedCodexPreserved: true, explicitGroupRoutesUseCorrectSyntheticCredentials: true, requests: t.sent, modelId: t.modelId }, null, 2));
  } finally { await t.cleanup(); }
});

test("T70b gate: a newly selected ChatGPT auxiliary model and a fresh OAuth history keep the OAuth provider", async () => {
  const t = await fixture();
  try {
    await t.login(); t.gateway.installRuntime(t.runtime);
    const native = t.runtime.getModel("openai", t.modelId)!, api = t.runtime.getModel(t.apiChannel.provider, t.modelId)!;
    // Only these two synthetic/authenticated candidates are supplied; no ambient providers or real credentials are inspected.
    const available = { getAvailable: async () => [native, api] } as unknown as ModelRuntime;
    t.core.settings.update({ auxModel: `openai/${t.modelId}` });
    const selected = await new Llm(t.core).auxModel(available);
    const history = SessionManager.create(t.workspace, t.sessions); history.appendModelChange("openai", t.modelId); history.appendMessage({ role: "user", content: "T70b synthetic OAuth history created after login", timestamp: Date.now() });
    const recorded = history.buildSessionContext().model!;
    const reference = recordedSessionModel(history)!;
    const restored = t.core.restoreSessionModel!(reference.ref, t.runtime, reference.recordedAt);
    t.assertIntact();
    const proof = { passed: selected?.provider === "openai" && restored?.provider === "openai", modelId: t.modelId, migratedApiProvider: t.apiChannel.provider, requestedOAuthProvider: "openai", actualAuxiliaryProvider: selected?.provider, recordedFreshHistoryProvider: recorded.provider, actualHistoryProvider: restored?.provider, secretAndApiChannelPreserved: true };
    writeFileSync("../Claude Codex Bridge/T70b-routing-gate.json", JSON.stringify(proof, null, 2));
    assert.equal(selected?.provider, "openai", "Fresh ChatGPT auxiliary selection must not be rewritten to the migrated API key channel");
    assert.equal(restored?.provider, "openai", "Fresh ChatGPT history must not be restored as the migrated API key channel");
  } finally { await t.cleanup(); }
});

test("T70b mixed history uses the last model record on its active branch, including assistant messages", async () => {
  const t = await fixture();
  try {
    await t.login();
    const oldAt = t.core.db.get<{ imported_at: number }>("SELECT imported_at FROM pi_channel_map WHERE provider='openai'")!.imported_at - 1000;
    const newAt = t.migration.status().at! + 1000;
    const entries: SessionEntry[] = [
      { type: "model_change", id: "old", parentId: null, timestamp: new Date(oldAt).toISOString(), provider: "openai", modelId: t.modelId },
      { type: "message", id: "user", parentId: "old", timestamp: new Date(newAt).toISOString(), message: { role: "user", content: "A later user entry must not change the model record's age", timestamp: newAt } },
      { type: "message", id: "new", parentId: "user", timestamp: new Date(newAt).toISOString(), message: { ...fauxAssistantMessage("Synthetic OAuth response"), provider: "openai", model: t.modelId, timestamp: newAt } },
      { type: "model_change", id: "other-branch", parentId: "old", timestamp: new Date(oldAt).toISOString(), provider: "openai", modelId: t.modelId },
    ];
    const history = SessionManager.inMemory(t.workspace, {}, entries);
    const restore = () => { const record = recordedSessionModel(history)!; const context = history.buildSessionContext().model!; assert.equal(record.ref, `${context.provider}/${context.modelId}`); return t.core.restoreSessionModel!(record.ref, t.runtime, record.recordedAt); };
    assert.equal(restore()?.provider, t.apiChannel.provider);
    history.branch("user"); assert.equal(restore()?.provider, t.apiChannel.provider);
    history.branch("new"); assert.equal(restore()?.provider, "openai");
    history.branch("old"); assert.equal(restore()?.provider, t.apiChannel.provider);
    const invalid = SessionManager.inMemory(t.workspace, {}, [{ ...entries[0]!, timestamp: "invalid" }]);
    const invalidRecord = recordedSessionModel(invalid)!;
    assert.equal(invalidRecord.recordedAt, undefined);
    assert.equal(t.core.restoreSessionModel!(invalidRecord.ref, t.runtime, invalidRecord.recordedAt)?.provider, "openai");
    t.assertIntact();
  } finally { await t.cleanup(); }
});
