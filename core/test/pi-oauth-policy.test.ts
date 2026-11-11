import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Core } from "../src/core.ts";
import { corePaths } from "../src/paths.ts";
import { Logger } from "../src/log.ts";
import { RecordingNotifier } from "../src/notify.ts";
import { Providers } from "../src/modules/providers.ts";
import { Llm } from "../src/modules/llm.ts";
import { Gateway } from "../src/gateway/gateway.ts";
import { PiMigration } from "../src/gateway/pi-migration.ts";
import { CHATGPT_OAUTH_PROVIDER, canLoginChannelOAuth } from "../src/gateway/pi-oauth-policy.ts";

const credential = (access: string, expires = Date.now() + 3600000) => ({ type: "oauth" as const, access, refresh: "T70_SYNTHETIC_REFRESH", expires });
async function fixture(auth: object) {
  const root = mkdtempSync(join(tmpdir(), "df-t70-")), agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
  mkdirSync(agentDir); mkdirSync(sessionDir);
  const authPath = join(agentDir, "auth.json"), modelsPath = join(agentDir, "models.json");
  writeFileSync(authPath, JSON.stringify(auth)); writeFileSync(modelsPath, "{}");
  const runtime = await ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false });
  let runtimeCalls = 0;
  const core = new Core({ paths: corePaths(join(root, "data")), agentDir, sessionDir, log: new Logger(), notifier: new RecordingNotifier() });
  const providers = new Providers(core, new Llm(core)), gateway = new Gateway(core, providers);
  core.use(new PiMigration(core, providers, gateway, { automatic: false, oauthRuntime: async () => { runtimeCalls++; return runtime; } })); core.use(gateway);
  providers.channelsAuthoritative = true;
  const read = () => JSON.parse(readFileSync(authPath, "utf8"));
  return { core, runtime, authPath, read, runtimeCalls: () => runtimeCalls, gateway: core.module(Gateway)!, async cleanup() { await core.shutdown(); assert.ok(root.startsWith(join(tmpdir(), "df-t70-"))); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}
async function waitFor(probe: () => boolean) { const limit = Date.now() + 10000; while (!probe()) { if (Date.now() > limit) throw Error("Synthetic OAuth flow timed out"); await new Promise(done => setTimeout(done, 10)); } }

test("channel OAuth whitelist contains exactly the current public ChatGPT subscription provider", () => {
  const providers = builtinProviders(), chatgpt = providers.find(p => p.id === CHATGPT_OAUTH_PROVIDER)!;
  assert.equal(CHATGPT_OAUTH_PROVIDER, "openai"); assert.equal(chatgpt.auth.oauth!.name, "OpenAI (ChatGPT subscription)"); assert.equal(chatgpt.auth.oauth!.isSubscription, true);
  assert.equal(chatgpt.auth.oauth!.loginLabel, "Sign in with ChatGPT");
  assert.deepEqual(providers.filter(p => canLoginChannelOAuth(p.id)).map(p => p.id), ["openai"]);
  for (const id of ["future-oauth", "openai-codex", "OPENAI", "anthropic", "github-copilot"]) assert.equal(canLoginChannelOAuth(id), false);
});

test("disabled OAuth starts never invoke auth runtime or mutate existing OAuth/API key credentials", async () => {
  const t = await fixture({ anthropic: credential("T70_ANTHROPIC"), "github-copilot": credential("T70_COPILOT"), "openai-codex": credential("T70_CODEX"), openai: { type: "api_key", key: "T70_API_KEY" } });
  const before = readFileSync(t.authPath, "utf8");
  try {
    for (const provider of ["anthropic", "github-copilot", "openai-codex", "new-oauth-provider"]) await assert.rejects(t.core.call("piMigration.oauthStart", { provider }), (e: any) => e.code === "oauth_login_disabled");
    assert.equal(t.runtimeCalls(), 0); assert.equal(readFileSync(t.authPath, "utf8"), before);
    assert.equal(t.core.db.get("SELECT value FROM pi_channel_migration WHERE id=1"), undefined);
  } finally { await t.cleanup(); }
});

test("ChatGPT first login, automatic refresh and logout use public Pi runtime with synthetic credentials", async () => {
  const retained = credential("T70_RETAINED"), apiKey = { type: "api_key", key: "T70_API_KEY" };
  const t = await fixture({ anthropic: retained, google: apiKey }); let refreshed = 0, logins = 0;
  const base = builtinProviders().find(p => p.id === CHATGPT_OAUTH_PROVIDER)!;
  t.runtime.registerNativeProvider({ ...base, auth: { oauth: { name: "T70 synthetic ChatGPT", isSubscription: true,
    async login(interaction) { logins++; interaction.notify({ type: "auth_url", url: "https://example.invalid/t70" }); const code = await interaction.prompt({ type: "manual_code", message: "Synthetic code" }); assert.equal(code, "T70_CODE"); return credential("T70_EXPIRED", Date.now() - 10000); },
    async refresh(previous) { refreshed++; return { ...previous, access: "T70_REFRESHED", expires: Date.now() + 3600000 }; },
    async toAuth(current) { return { apiKey: current.access }; },
  } } });
  try {
    const flow = await t.core.call("piMigration.oauthStart", { provider: CHATGPT_OAUTH_PROVIDER }) as { id: string };
    let status: any;
    for (let i = 0; i < 100; i++) { status = await t.core.call("piMigration.oauthStatus", { id: flow.id }); if (status.prompt) break; await new Promise(done => setTimeout(done, 10)); }
    assert.equal(status.prompt.type, "manual_code");
    await t.core.call("piMigration.oauthAnswer", { id: flow.id, value: "T70_CODE" });
    await waitFor(() => !!t.read()[CHATGPT_OAUTH_PROVIDER]);
    const auth = await t.runtime.getAuth(CHATGPT_OAUTH_PROVIDER, { minOAuthValidityMs: 0 });
    assert.equal(auth?.auth.apiKey, "T70_REFRESHED"); assert.equal(refreshed, 1); assert.equal(logins, 1);
    await t.gateway.refreshConfiguration();
    assert.ok(t.gateway.channels().some(c => c.id === "pi:openai" && c.oauth && c.enabled));
    await t.core.call("piMigration.oauthLogout", { provider: CHATGPT_OAUTH_PROVIDER });
    assert.deepEqual(t.read(), { anthropic: retained, google: apiKey });
    assert.equal(t.core.db.get("SELECT value FROM pi_channel_migration WHERE id=1"), undefined);
  } finally { await t.cleanup(); }
});

// 0.8.2 user test: "Sign in with ChatGPT requires a device ID (UUID) for this installation". Pi's own
// terminal passes the installation's ID; the window's login must too, and the same one every time.
test("ChatGPT login gets this installation's stable device ID, kept in Pi's settings", async () => {
  const t = await fixture({}); const ids: (string | undefined)[] = [];
  const base = builtinProviders().find(p => p.id === CHATGPT_OAUTH_PROVIDER)!;
  t.runtime.registerNativeProvider({ ...base, auth: { oauth: { name: "T70 synthetic ChatGPT", isSubscription: true,
    async login(_interaction, options) { ids.push(options?.getDeviceId?.(), options?.getDeviceId?.()); assert.equal(options?.agentName, "DreamFlutter", "OpenAI shows this name on its consent page"); return credential("T70_DEVICE"); },
    async refresh(previous) { return previous; },
    async toAuth(current) { return { apiKey: current.access }; },
  } } });
  try {
    for (let round = 0; round < 2; round++) {
      const flow = await t.core.call("piMigration.oauthStart", { provider: CHATGPT_OAUTH_PROVIDER }) as { id: string };
      let status: any;
      for (let i = 0; i < 500; i++) { status = await t.core.call("piMigration.oauthStatus", { id: flow.id }); if (status.status !== "running") break; await new Promise(done => setTimeout(done, 10)); }
      assert.equal(status.status, "done", status.error);
    }
    assert.equal(ids.length, 4);
    assert.match(ids[0]!, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.ok(ids.every(id => id === ids[0]), "the same ID on every call and every login");
    assert.equal(JSON.parse(readFileSync(join(t.authPath, "..", "settings.json"), "utf8")).deviceId, ids[0]);
  } finally { await t.cleanup(); }
});

for (const retainedProvider of ["anthropic", "openai-codex"]) test(`retained ${retainedProvider} OAuth refreshes and bridges until logout; API keys cannot be logged out here`, async () => {
  const t = await fixture({ [retainedProvider]: credential("T70_OLD", Date.now() - 10000), openai: { type: "api_key", key: "T70_API_KEY" } });
  const base = builtinProviders().find(p => p.id === retainedProvider)!; let refreshed = 0;
  t.runtime.registerNativeProvider({ ...base, auth: { oauth: { name: "T70 retained OAuth", async login() { throw Error("Must never re-login"); }, async refresh(previous) { refreshed++; return { ...previous, access: "T70_RENEWED", expires: Date.now() + 3600000 }; }, async toAuth(current) { return { apiKey: current.access }; } } } });
  try {
    await assert.rejects(t.core.call("piMigration.oauthStart", { provider: retainedProvider }));
    await t.runtime.getAuth(retainedProvider, { minOAuthValidityMs: 0 }); assert.equal(refreshed, 1); assert.equal(t.read()[retainedProvider].access, "T70_RENEWED");
    await t.gateway.refreshConfiguration(); assert.ok(t.gateway.channels().some(c => c.id === `pi:${retainedProvider}` && c.oauth && c.enabled));
    await assert.rejects(t.core.call("piMigration.oauthLogout", { provider: "openai" }), (e: any) => e.code === "bad_request");
    await t.core.call("piMigration.oauthLogout", { provider: retainedProvider }); assert.deepEqual(t.read(), { openai: { type: "api_key", key: "T70_API_KEY" } });
  } finally { await t.cleanup(); }
});
