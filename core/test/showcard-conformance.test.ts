import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import jsdom from "jsdom";
import { defineTestTool } from "../src/cards/bindings.ts";
import { CardsModule, type Card } from "../src/cards/cards.ts";
import { startServer } from "../src/server.ts";
import { settledCount, startTestCore, type TestCore } from "./harness.ts";

/**
 * The official Showcard conformance probes (fixtures/showcard-probes, copied
 * verbatim from github.com/liliMozi/showcard conformance/probes) run against
 * this host: each card is served by the core exactly as the window's WebView
 * gets it (ticketed URL, serve-time injection, per-instance CSP), opened in
 * jsdom, and its socket answered by `cards.request`. Judging follows the
 * suite's driver (conformance/src/host-suite.js): wait for
 * data-probe-status="done", read every data-probe verdict, plus
 * document-renders and probe-completed.
 *
 * Two bridges, as in the suite's own reference adapter: jsdom does not run
 * scripts inside an iframe, so the card document is opened top-level with
 * `window.parent.postMessage` wired to the host; and jsdom has no CSP engine,
 * so the resource loader refuses every origin but the core's own (what the
 * instance CSP does in WebView2).
 */

const { JSDOM, VirtualConsole, requestInterceptor } = jsdom;
type Dom = InstanceType<typeof JSDOM>;

const PROBES = join(import.meta.dirname, "fixtures", "showcard-probes");
const FILES = [
	"envelope-shape",
	"capabilities-shape",
	"emit-shape",
	"state-roundtrip",
	"state-persistence",
	"state-budget",
	"undeclared-binding",
	"contract-unsupported",
	"sugar-invoke",
	"sugar-persist",
	"sugar-result",
	"passive-placeholder",
];

interface Verdict {
	probe: string;
	pass: boolean;
	detail: string;
}

describe("Showcard conformance probes", () => {
	let t: TestCore;
	let http: { port: number; close(): Promise<void> };
	let cards: CardsModule;
	let sessionFile: string;
	let elsewhere: string;
	const windows: Dom[] = [];

	before(async () => {
		defineTestTool("conformance.echo", (input) => ({ echo: input === undefined ? null : input }));
		t = await startTestCore();
		http = await startServer(t.core, { port: 0, token: "test" });
		cards = t.core.module(CardsModule)!;
		// Two real conversations: the probe cards live in the first; emit's `to` names the second.
		for (const slotId of ["home", "elsewhere"]) {
			await t.core.call("slot.open", { slotId, cwd: t.workspace }, t.client);
			t.respond(fauxAssistantMessage("好"));
			await t.send(slotId, { id: "p", type: "prompt", message: "你好" });
			await t.waitFor(() => settledCount(t.records(slotId)) === 1);
		}
		sessionFile = t.core.slot("home").info().sessionFile!;
		elsewhere = t.core.slot("elsewhere").info().sessionId!;
	});

	after(async () => {
		for (const w of windows) w.window.close();
		await http.close();
		await t.cleanup();
	});

	/** Opens one instance of [card] the way the window does, and answers its socket through the core. */
	async function mount(card: Card): Promise<Dom> {
		const { url } = (await t.core.call("cards.open", { id: card.id, theme: {} })) as { url: string };
		const shell = await (await fetch(url)).text();
		const src = shell.match(/<iframe id="card" sandbox="allow-scripts" src="([^"]+)"/)![1]!;
		const origin = `http://127.0.0.1:${http.port}`;
		const dom = await JSDOM.fromURL(origin + src, {
			runScripts: "dangerously",
			resources: { interceptors: [requestInterceptor(async (request) => (request.url.startsWith(`${origin}/`) ? undefined : new Response("", { status: 403 })))] },
			pretendToBeVisual: true,
			virtualConsole: new VirtualConsole(),
			beforeParse(window) {
				Object.defineProperty(window, "parent", {
					configurable: true,
					value: {
						postMessage(message: { type?: string; requestId?: string; capability?: unknown; payload?: unknown }) {
							if (!message || message.type !== "card:request") return;
							void (t.core.call("cards.request", { id: card.id, capability: message.capability, payload: message.payload }) as Promise<Record<string, unknown>>).then((envelope) => {
								window.dispatchEvent(new window.MessageEvent("message", { data: { type: "card:response", requestId: message.requestId, ...envelope } }));
							});
						},
					},
				});
			},
		});
		windows.push(dom);
		return dom;
	}

	async function judge(dom: Dom, timeoutMs = 3000): Promise<{ completed: boolean; verdicts: Verdict[] }> {
		const deadline = Date.now() + timeoutMs;
		let completed = false;
		while (Date.now() < deadline) {
			if (dom.window.document.querySelector('[data-probe-status="done"]')) {
				completed = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 10));
		}
		const doc = dom.window.document;
		const verdicts: Verdict[] = [...doc.querySelectorAll("[data-probe]")].map((e) => ({ probe: e.getAttribute("data-probe")!, pass: e.getAttribute("data-verdict") === "pass", detail: e.textContent ?? "" }));
		const reported = verdicts.length;
		const marker = (doc.querySelector("[data-probe-static]")?.textContent ?? "").trim();
		verdicts.push({ probe: "document-renders", pass: marker !== "", detail: marker ? "rendered" : "no static content" });
		verdicts.push({ probe: "probe-completed", pass: completed && reported > 0, detail: `${reported} judgment(s)` });
		return { completed, verdicts };
	}

	function assertAllPass(name: string, verdicts: Verdict[]): void {
		const failed = verdicts.filter((v) => !v.pass);
		assert.deepEqual(failed, [], `${name}: ${failed.map((f) => `${f.probe} - ${f.detail}`).join("; ")}`);
	}

	for (const name of FILES) {
		it(name, async () => {
			let html = readFileSync(join(PROBES, `${name}.card.html`), "utf8");
			// emit's `to` must name a real conversation in a host that routes (§2.3).
			if (name === "emit-shape") html = html.replaceAll("sess_elsewhere", elsewhere);
			const card = cards.mint({ title: "", code: html, cwd: t.workspace, sessionFile });
			let { verdicts } = await judge(await mount(card));
			if (name === "state-persistence") {
				// Remount: a new instance of the same entity (suite: remount()).
				({ verdicts } = await judge(await mount(card)));
			}
			assertAllPass(name, verdicts);
		});
	}

	it("package-relative-assets (a package with its own assets/)", async () => {
		const card = cards.import(join(PROBES, "package-relative-assets"), t.workspace);
		const { verdicts } = await judge(await mount(card));
		assertAllPass("package-relative-assets", verdicts);
	});

	it("emit reached the card's conversation", () => {
		const delivered = t.messages.filter((m) => m.event === "card.emitted");
		assert.ok(delivered.some((m) => m.name === "probe.clicked"));
	});
});
