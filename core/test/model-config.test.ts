import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { fauxAssistantMessage, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { Gateway, channelProvider } from "../src/gateway/gateway.ts";
import { catalogModel } from "../src/gateway/catalog.ts";
import { ContextModule } from "../src/modules/context.ts";
import { dshCompactionSettings } from "../src/agent/harness.ts";
import { startTestCore, type TestCore } from "./harness.ts";

describe("v0.6 model configuration", () => {
  let t: TestCore;
  afterEach(async () => { await t?.cleanup(); });
  async function start() { t = await startTestCore(); }
  async function channel(models: unknown[], platform?: string) {
    return (await t.core.call("gateway.saveChannel", { name: "Models", platform, api: "openai-completions", baseUrl: "https://example.invalid/v1", models, keys: [{ secret: "test-only" }] }) as {id: string}).id;
  }
  async function open() { await t.core.call("slot.open", { slotId: "models", cwd: t.workspace }, t.client); return t.core.slots.get("models")!; }
  let request = 0;
  async function rpc(type: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = `model-${++request}`;
    await t.send("models", { id, type, ...params });
    const response = await t.waitFor(() => t.records("models").find((r) => r.id === id && r.type === "response"));
    assert.equal(response.success, true, JSON.stringify(response));
    return response.data;
  }

  it("switches thinking and windows, clamps old defaults, and follows the recommendation for new sessions", async () => {
    await start();
    const id = await channel([{ id: "reasoner", thinkingLevels: ["low", "high"], contextWindow: 80_000 }, { id: "plain", thinkingLevels: ["off"], contextWindow: 40_000 }]);
    const provider = channelProvider(id);
    t.core.settings.update({ defaultModel: `${provider}/reasoner`, defaultThinking: "max" });
    const slot = await open();
    assert.equal(slot.session.thinkingLevel, "high", "old specified level is retained in settings but clamped in session");
    await rpc("set_model", { provider, modelId: "plain" });
    assert.equal(slot.session.thinkingLevel, "off");
    assert.equal((await t.core.call("context.info", { slotId: "models" }) as any).contextWindow, 40_000);
    await rpc("set_model", { provider, modelId: "reasoner" });
    assert.ok(["low", "high"].includes(slot.session.thinkingLevel));
    assert.deepEqual((await rpc("get_available_thinking_levels")).levels, ["low", "high"]);
    t.core.settings.update({ defaultThinking: null });
    await rpc("new_session");
    assert.equal(slot.session.thinkingLevel, "high", "Pi clamps medium upward to high");
    assert.equal(t.core.settings.get().defaultThinking, null);
  });

  it("uses an override for native models, context information and the existing compression threshold, and restores the source value", async () => {
    await start();
    const slot = await open();
    t.core.settings.update({ modelContextWindows: { "faux/faux-1": 100_000 }, compactionThresholdPercent: 20 });
    const info = await t.core.call("context.info", { slotId: "models" }) as any;
    assert.equal(slot.session.model!.contextWindow, 100_000);
    assert.equal(info.contextWindow, 100_000);
    assert.equal(info.thresholdTokens, 20_000);
    const settings = t.core.module(ContextModule)!.settingsFor(slot.session.sessionId, slot.session.model!, dshCompactionSettings(slot.session.model!, true));
    assert.equal(100_000 - settings.reserveTokens, info.thresholdTokens);
    t.core.settings.update({ modelContextWindows: {} });
    assert.equal((await rpc("get_state")).model.contextWindow, 200_000);
    assert.equal(slot.session.model!.contextWindow, 200_000);
  });

  it("reports unknown windows honestly and preserves the SDK execution fallback", async () => {
    await start();
    const id = await channel([{ id: "unknown" }]);
    const slot = await open();
    await rpc("set_model", { provider: channelProvider(id), modelId: "unknown" });
    assert.equal(slot.session.model!.contextWindow, 128_000);
    assert.equal((await rpc("get_state")).model.contextWindow, null);
    assert.equal((await t.core.call("context.info", { slotId: "models" }) as any).contextWindow, null);
    assert.equal((await rpc("df_context_usage")).contextWindow, 0);
    t.core.settings.update({ modelContextWindows: { [`${channelProvider(id)}/unknown`]: 64_000 } });
    assert.equal((await rpc("get_state")).model.contextWindow, 64_000);
  });

  it("takes known channel windows from the catalog and preserves its native thinking map", async () => {
    await start();
    const id = await channel([{ id: "deepseek-v4.1-flash" }], "opencode-go");
    const slot = await open();
    await rpc("set_model", { provider: channelProvider(id), modelId: "deepseek-v4.1-flash" });
    const known = catalogModel("opencode-go", "deepseek-v4.1-flash")!;
    assert.ok(known);
    assert.equal(slot.session.model!.contextWindow, known.contextWindow);
    assert.deepEqual(getSupportedThinkingLevels(slot.session.model!), getSupportedThinkingLevels(known));
  });

  it("persists group order, returns it to selectors, appends new groups and rejects stale reorders atomically", async () => {
    await start();
    for (const id of ["a", "b", "c"]) await t.core.call("gateway.saveGroup", { id, name: id, entries: [] });
    await t.core.call("gateway.reorderGroups", { ids: ["c", "a", "b"] });
    await open();
    const listed = await rpc("get_available_models");
    assert.deepEqual(listed.models.filter((m: any) => m.provider === "dreamflutter").map((m: any) => m.id), ["c", "a", "b"]);
    await assert.rejects(() => t.core.call("gateway.reorderGroups", { ids: ["c", "a", "a"] }));
    await t.core.call("gateway.saveGroup", { id: "a", name: "rename", entries: [] });
    await t.core.call("gateway.saveGroup", { id: "d", name: "d", entries: [] });
    assert.deepEqual(t.core.module(Gateway)!.groups().map((g) => g.id), ["c", "a", "b", "d"]);
    t = await t.reopen();
    assert.deepEqual(t.core.module(Gateway)!.groups().map((g) => g.id), ["c", "a", "b", "d"]);
  });

  it("keeps routed group and compression windows equal and clamps thinking to the actual member", async () => {
    t = await startTestCore(undefined, { gatewayTransport: (model, context, options) => t.faux.streamSimple(model as never, context as never, options) });
    const id = await channel([{ id: "large", contextWindow: 100_000, thinkingLevels: ["off"] }, { id: "small", contextWindow: 60_000, thinkingLevels: ["high"] }]);
    await t.core.call("gateway.saveGroup", { id: "route", name: "Route", entries: [{ channel: id, model: "large", priority: 0 }, { channel: id, model: "small", priority: 1 }] });
    t.core.settings.update({ defaultModel: "dreamflutter/route", defaultThinking: "high", modelContextWindows: { "dreamflutter/route": 50_000 }, compactionThresholdPercent: 30 });
    const slot = await open();
    t.respond((_context, options, _state, model) => {
      assert.equal(model.contextWindow, 50_000);
      assert.equal(options?.reasoning, undefined, "Pi omits reasoning when the routed member only supports off");
      const compression = t.core.module(ContextModule)!.settingsFor(slot.session.sessionId, model, dshCompactionSettings(model, true));
      assert.equal(model.contextWindow - compression.reserveTokens, 15_000);
      return fauxAssistantMessage("ok");
    });
    await t.send("models", { id: "route-prompt", type: "prompt", message: "ok" });
    await t.waitFor(() => t.records("models").some((r) => r.type === "agent_settled"), 15_000);
    const answer = t.records("models").filter((r) => r.type === "message_end").at(-1)?.message as any;
    assert.equal(answer.stopReason, "stop", answer.errorMessage);
    const info = await t.core.call("context.info", { slotId: "models" }) as any;
    assert.equal(info.contextWindow, 50_000);
    assert.equal(info.thresholdTokens, 15_000);
    await rpc("set_model", { provider: channelProvider(id), modelId: "large" });
    assert.equal((await t.core.call("context.info", { slotId: "models" }) as any).contextWindow, 100_000);
  });

  it("reports the actual restore destination without losing historical channel values", async () => {
    await start();
    const id = await channel([{ id: "deepseek-v4.1-flash", contextWindow: 77_000 }], "opencode-go");
    const provider = channelProvider(id);
    const key = `${provider}/deepseek-v4.1-flash`;
    t.core.settings.update({ modelContextWindows: { [key]: 42_000 } });
    assert.deepEqual(await t.core.call("gateway.modelWindow", { provider, model: "deepseek-v4.1-flash" }), { value: 77_000, source: "channel" });
    assert.equal(t.core.module(Gateway)!.window(provider, "deepseek-v4.1-flash"), 42_000);
    t.core.settings.update({ modelContextWindows: {} });
    assert.equal(t.core.module(Gateway)!.window(provider, "deepseek-v4.1-flash"), 77_000);
    assert.deepEqual(await t.core.call("gateway.modelWindow", { provider: "faux", model: "faux-1" }), { value: 200_000, source: "catalog" });
  });

  it("rejects invalid window maps and empty capability lists without changing saved settings", async () => {
    await start();
    t.core.settings.update({ modelContextWindows: { "faux/faux-1": 32_000 } });
    for (const invalid of [null, [], { "bad": 123 }, { "p/m": 0 }, { "p/m": 1.5 }, { "p/m": "2000" }]) {
      t.core.settings.update({ modelContextWindows: invalid });
      assert.deepEqual(t.core.settings.get().modelContextWindows, { "faux/faux-1": 32_000 });
    }
    await assert.rejects(() => channel([{ id: "m", thinkingLevels: [] }]), /至少选择/);
    assert.equal(t.core.module(Gateway)!.channels().filter((c) => c.source === "df").length, 0);
  });
});
