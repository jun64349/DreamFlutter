import assert from "node:assert/strict";
import { it } from "node:test";
import { proxyEnvironment } from "../src/agent/system-proxy.ts";

it("passes system proxy to HTTP clients used by uv/pip/npm/git without changing the parent environment", () => {
	const base = { Path: "tools" };
	const env = proxyEnvironment({ enabled: true, server: "http=127.0.0.1:7890;https=localhost:7891", bypass: "*.example.test;<local>" }, base);
	assert.equal(env.http_proxy, "http://127.0.0.1:7890");
	assert.equal(env.HTTPS_PROXY, "http://localhost:7891");
	assert.equal(env.https_proxy, env.HTTPS_PROXY);
	assert.match(env.NO_PROXY!, /\.example\.test/);
	assert.deepEqual(base, { Path: "tools" });
});

it("respects explicit upper/lowercase proxy, no_proxy and disabled system proxy", () => {
	const proxy = { enabled: true, server: "127.0.0.1:7890" };
	const env = proxyEnvironment(proxy, { https_proxy: "http://custom:99", HTTP_PROXY: "", no_proxy: "private.test" });
	assert.equal(env.https_proxy, "http://custom:99"); assert.equal(env.HTTPS_PROXY, undefined);
	assert.equal(env.HTTP_PROXY, ""); assert.equal(env.http_proxy, undefined);
	assert.equal(env.no_proxy, "private.test"); assert.equal(env.NO_PROXY, undefined);
	assert.deepEqual(proxyEnvironment({ ...proxy, enabled: false }, { A: "b" }), { A: "b" });
	assert.equal(proxyEnvironment({ enabled: true, server: "javascript:bad" }, {}).HTTP_PROXY, undefined);
	assert.equal(proxyEnvironment(proxy, { ALL_PROXY: "socks5://custom:88" }).HTTP_PROXY, undefined);
	assert.deepEqual(proxyEnvironment({ ...proxy, autoConfig: true }, { HTTP_PROXY: "http://explicit:88" }), { HTTP_PROXY: "http://explicit:88" });
});
