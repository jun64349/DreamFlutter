import { createHash } from "node:crypto";
import { CARD_ERROR_CODES, CARD_HOST_EXTENSION_CODES, DEFAULT_SPEC_VERSION, STATE_BUDGET_BYTES, SUPPORTED_SPEC_VERSIONS } from "./showcard/codes.js";
import { CARD_PLACEHOLDER_SOURCE } from "./showcard/placeholder-source.js";
import { CARD_RUNTIME_SOURCE } from "./showcard/runtime-source.js";
import { CARD_CONTENT_SECURITY_POLICY, injectRuntimeIntoDocument, isFullDocument } from "./showcard/wrap.js";

/**
 * Showcard 1.0 card documents (spec: docs/research/showcard-spec-1.0.md is a
 * pointer; the text lives at github.com/liliMozi/showcard spec/1.0.md).
 * The card-side runtime and the placeholder layer are the reference
 * implementation's, verbatim (./showcard/); this file is the host side:
 * reading the manifest (§1.4) and state block (§1.5), minting a complete
 * entry document (§1.1, §5.3, §6.7, §7.8), serving it (§1.7, §7.1, §7.8),
 * export equipment (§6.4) and the secret scan (§7.3).
 */

export { isFullDocument };

export const CODES = { ...CARD_ERROR_CODES, ...CARD_HOST_EXTENSION_CODES };
export const STATE_LIMIT = STATE_BUDGET_BYTES;
export const EMIT_PAYLOAD_LIMIT = 8192;
export const EMIT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * How long a card waits for this host's answer. The reference runtime uses the
 * spec's reference deadline of 5 s (§2.6 "参考时限 5 s"); a host that asks the
 * user before running a binding (§3.2) needs a person-sized deadline, so the
 * served copy waits longer. Exported files keep the reference value.
 */
export const HOST_TIMEOUT_MS = 180_000;

export interface CardBinding {
	tool: string;
	input?: Record<string, unknown>;
	description?: string;
}

export interface ParsedManifest {
	/** The manifest object as written (unknown fields kept, §1.4). */
	raw: Record<string, unknown> | null;
	bindings: Record<string, CardBinding>;
	/** Bindings whose shape is unusable, with the reason (§4.6). */
	malformed: Record<string, string>;
	specVersion: string;
	specSupported: boolean;
	parseError: string | null;
	/** display.preferredWidthPx when legal (240–1200, rounded), else null (§1.4). */
	preferredWidth: number | null;
	displayWarning: string | null;
}

const MANIFEST_BLOCK = /<script\b(?=[^>]*\btype\s*=\s*["']?application\/json)(?=[^>]*\bdata-card-manifest\b)[^>]*>([\s\S]*?)<\/script\s*>/i;
const STATE_BLOCK = /<script\b(?=[^>]*\btype\s*=\s*["']?application\/json)(?=[^>]*\bdata-card-state\b)[^>]*>([\s\S]*?)<\/script\s*>/i;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The first manifest block in document order (§1.4); nothing here refuses to render a card. */
export function parseManifest(html: string): ParsedManifest {
	const empty: ParsedManifest = {
		raw: null,
		bindings: {},
		malformed: {},
		specVersion: DEFAULT_SPEC_VERSION,
		specSupported: true,
		parseError: null,
		preferredWidth: null,
		displayWarning: null,
	};
	const block = html.match(MANIFEST_BLOCK);
	if (!block) return empty;
	let raw: unknown;
	try {
		raw = JSON.parse(block[1]!);
	} catch (error) {
		return { ...empty, parseError: error instanceof Error ? error.message : String(error) };
	}
	if (!isPlainObject(raw)) return { ...empty, parseError: "manifest 不是 JSON 对象" };
	const specVersion = typeof raw.spec === "string" && raw.spec !== "" ? raw.spec : DEFAULT_SPEC_VERSION;
	const bindings: Record<string, CardBinding> = {};
	const malformed: Record<string, string> = {};
	if (isPlainObject(raw.toolBindings)) {
		for (const [id, value] of Object.entries(raw.toolBindings)) {
			if (!isPlainObject(value) || typeof value.tool !== "string" || !value.tool) {
				malformed[id] = "缺少 tool";
				continue;
			}
			bindings[id] = {
				tool: value.tool,
				input: isPlainObject(value.input) ? value.input : undefined,
				description: typeof value.description === "string" ? value.description : undefined,
			};
		}
	}
	let preferredWidth: number | null = null;
	let displayWarning: string | null = null;
	if (raw.display !== undefined) {
		const width = isPlainObject(raw.display) ? raw.display.preferredWidthPx : undefined;
		if (!isPlainObject(raw.display)) displayWarning = "display 不是对象";
		else if (width !== undefined) {
			if (typeof width === "number" && Number.isFinite(width) && width >= 240 && width <= 1200) preferredWidth = Math.round(width);
			else displayWarning = "display.preferredWidthPx 必须是 240–1200 之间的数";
		}
	}
	return { raw, bindings, malformed, specVersion, specSupported: SUPPORTED_SPEC_VERSIONS.includes(specVersion), parseError: null, preferredWidth, displayWarning };
}

/** The state snapshot block (§1.5); absent or unreadable reads as {}. */
export function parseStateSeed(html: string): Record<string, unknown> {
	const block = html.match(STATE_BLOCK);
	if (!block) return {};
	try {
		const value = JSON.parse(block[1]!);
		return isPlainObject(value) ? value : {};
	} catch {
		return {};
	}
}

export function titleOf(html: string): string {
	return decodeEntities(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
}

function decodeEntities(text: string): string {
	return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
		return out;
	}
	return value;
}

/** Declaration digest (§5.8): the toolBindings only, keys sorted recursively. */
export function bindingsDigest(raw: Record<string, unknown> | null): string {
	const bindings = raw && isPlainObject(raw.toolBindings) ? raw.toolBindings : {};
	return createHash("sha256").update(JSON.stringify(stable(bindings))).digest("hex").slice(0, 32);
}

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function jsonScript(attribute: string, value: unknown, pretty = false): string {
	const text = JSON.stringify(value, null, pretty ? 2 : undefined).replace(/</g, "\\u003c");
	return `<script type="application/json" ${attribute}>\n${text}\n</script>`;
}

/** Inserts [snippet] right after the opening <head> (or the best place there is). */
export function injectHead(html: string, snippet: string): string {
	const head = /<head\b[^>]*>/i.exec(html);
	if (head) return html.slice(0, head.index + head[0].length) + snippet + html.slice(head.index + head[0].length);
	const root = /<html\b[^>]*>/i.exec(html);
	if (root) return html.slice(0, root.index + root[0].length) + `<head>${snippet}</head>` + html.slice(root.index + root[0].length);
	const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
	if (doctype) return html.slice(0, doctype.index + doctype[0].length) + snippet + html.slice(doctype.index + doctype[0].length);
	return snippet + html;
}

/** Replaces the first block of [attribute] (or adds one to <head>). */
function replaceBlock(html: string, pattern: RegExp, block: string): string {
	return pattern.test(html) ? html.replace(pattern, () => block) : injectHead(html, `\n${block}\n`);
}

/**
 * The entry document an agent's mint produces (§1.1: always a complete
 * document). A fragment gets a skeleton with a natural-language <title>
 * (§1.3), the card's own default-deny CSP and placeholder layer (§7.8, for
 * when it is opened without a host). Either way the manifest carries `spec`
 * (§6.7) and the opening state is burned into the state block (§5.3).
 */
export function mintDocument(code: string, title: string, state: Record<string, unknown> | undefined): string {
	let html = isFullDocument(code)
		? code
		: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(CARD_CONTENT_SECURITY_POLICY)}">
<title>${escapeHtml(title)}</title>
<style>body{margin:0;padding:12px 16px;font-family:var(--font-sans,system-ui,"Microsoft YaHei UI",sans-serif);color:var(--fg,#2b2620);font-size:14px;line-height:1.6;overflow-wrap:anywhere}button,input,select,textarea{font:inherit}</style>
<script>${CARD_PLACEHOLDER_SOURCE.replace(/<\/script/gi, "<\\/script")}</script>
</head>
<body>
${code}
</body>
</html>
`;
	if (isFullDocument(code) && !titleOf(html) && title) html = injectHead(html, `\n<title>${escapeHtml(title)}</title>`);
	const manifest = parseManifest(html);
	if (manifest.raw && typeof manifest.raw.spec !== "string") {
		html = html.replace(MANIFEST_BLOCK, () => jsonScript("data-card-manifest", { spec: DEFAULT_SPEC_VERSION, ...manifest.raw }, true));
	}
	if (state) html = replaceBlock(html, STATE_BLOCK, jsonScript("data-card-state", state));
	return html;
}

export type Theme = Record<string, string>;

/** `:root{--x:…}` from the host's theme: only custom properties with plain values (no url()). */
export function themeCss(theme: Theme): string {
	const vars = Object.entries(theme)
		.filter(([k, v]) => /^--[a-z0-9-]{1,40}$/i.test(k) && typeof v === "string" && /^[#(),.%\w\s"'-]{1,160}$/.test(v) && !/url|expression|image-set|import/i.test(v))
		.map(([k, v]) => `${k}:${v}`)
		.join(";");
	return `:root{${vars}}`;
}

/**
 * Host bridge (this host's own layer, not part of the card contract): reports
 * the content height and CSP-blocked hosts to the window, and takes theme
 * updates. §6.3: it is never written into exports.
 */
const HOST_BRIDGE = `(function(){
var last = 0;
// The content's own height: the body box plus its margins and anything that
// overflows it. Never the root's scrollHeight, which is at least the frame and
// so could only grow (spec §1.7 self-excitation).
function report() {
  var b = document.body;
  if (!b) return;
  var s = getComputedStyle(b);
  var rect = b.getBoundingClientRect();
  var bottom = rect.bottom;
  var all = b.querySelectorAll("*");
  for (var i = 0; i < all.length && i < 4000; i++) { var r = all[i].getBoundingClientRect(); if (r.height > 0 && r.bottom > bottom) bottom = r.bottom; }
  var h = Math.ceil(bottom + window.scrollY + (parseFloat(s.marginBottom) || 0));
  if (h !== last) { last = h; parent.postMessage({ type: "df:resize", height: h }, "*"); }
}
window.addEventListener("message", function (e) {
  if (e.source !== parent || !e.data || typeof e.data !== "object") return;
  if (e.data.type === "df:ping") { last = 0; report(); }
  if (e.data.type === "df:theme" && typeof e.data.css === "string") { var s = document.getElementById("df-theme"); if (s) s.textContent = e.data.css; }
});
document.addEventListener("securitypolicyviolation", function (e) {
  parent.postMessage({ type: "df:csp", blockedURI: String(e.blockedURI || ""), directive: String(e.effectiveDirective || e.violatedDirective || "") }, "*");
});
function watch() { report(); if (window.ResizeObserver) { var ro = new ResizeObserver(report); ro.observe(document.documentElement); if (document.body) ro.observe(document.body); } }
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch); else watch();
window.addEventListener("load", report);
})();`;

const HOST_RUNTIME = (() => {
	const marker = `"TIMEOUT_MS": 5000`;
	if (!CARD_RUNTIME_SOURCE.includes(marker)) throw new Error("showcard runtime: the reference deadline constant moved; update document.ts");
	return CARD_RUNTIME_SOURCE.replace(marker, `"TIMEOUT_MS": ${HOST_TIMEOUT_MS}`);
})();

/**
 * Per-instance CSP (§7.1, reference serve.js buildInstancePolicy) plus the
 * hosts this card instance was allowed to reach directly (§3.5).
 */
export function instancePolicy(prefix: string, hosts: string[]): string {
	const p = prefix.endsWith("/") ? prefix : `${prefix}/`;
	const allowed = hosts.map((h) => `https://${h}`).join(" ");
	const extra = allowed ? ` ${allowed}` : "";
	return [
		"default-src 'none'",
		`script-src 'unsafe-inline' data: ${p}${extra}`,
		`style-src 'unsafe-inline' data: ${p}${extra}`,
		`img-src data: blob: ${p}${extra}`,
		`font-src data: ${p}${extra}`,
		`media-src data: blob: ${p}${extra}`,
		`connect-src ${allowed || "'none'"}`,
		"object-src 'none'",
		"frame-src 'none'",
		"child-src 'none'",
		"worker-src 'none'",
		"manifest-src 'none'",
		"form-action 'none'",
		"base-uri 'none'",
	].join("; ");
}

/** Sizing marker on the root element (§1.7). */
function markSizing(html: string, sizing: "content" | "viewport"): string {
	const root = /<html\b([^>]*)>/i.exec(html);
	if (!root) return html;
	const attrs = root[1]!.replace(/\sdata-card-sizing\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, "");
	return `${html.slice(0, root.index)}<html${attrs} data-card-sizing="${sizing}">${html.slice(root.index + root[0].length)}`;
}

/**
 * The entry as served (§1.1 serve-time injection, never written back): the
 * reference injection (CSP meta, runtime, placeholder layer) with this host's
 * deadline, then the theme and the host bridge.
 */
export function renderServed(html: string, options: { csp: string; theme: Theme; sizing: "content" | "viewport" }): string {
	const injected = injectRuntimeIntoDocument(html, { csp: options.csp }).replace(CARD_RUNTIME_SOURCE, () => HOST_RUNTIME);
	const withHost = injectHead(
		injected,
		`\n<style id="df-theme">${themeCss(options.theme)}</style>\n<script>${HOST_BRIDGE}</script>`,
	);
	return markSizing(withHost, options.sizing);
}

/**
 * Export equipment (§6.4): the state snapshot burned in, the theme values of
 * the moment inlined, the standard shim (the reference runtime, which steps
 * aside in a host and falls back to standalone semantics on its own) and the
 * placeholder layer ahead of the document's own content. The card's own
 * default-deny CSP stays (§7.8).
 */
export function rigForExport(html: string, options: { state: Record<string, unknown>; theme: Theme }): string {
	let out = replaceBlock(html, STATE_BLOCK, jsonScript("data-card-state", options.state));
	out = out.replace(/<style data-card-export-theme>[\s\S]*?<\/style>\s*/i, "").replace(/<script data-card-export-shim>[\s\S]*?<\/script>\s*/gi, "");
	const shim = (source: string) => `<script data-card-export-shim>${source.replace(/<\/script/gi, "<\\/script")}</script>`;
	return injectHead(out, `\n${shim(CARD_RUNTIME_SOURCE)}\n${shim(CARD_PLACEHOLDER_SOURCE)}\n<style data-card-export-theme>${themeCss(options.theme)}</style>\n`);
}

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
	{ name: "AWS access key", re: /AKIA[0-9A-Z]{16}/g },
	{ name: "OpenAI 风格的 Key", re: /sk-[A-Za-z0-9]{20,}/g },
	{ name: "GitHub PAT", re: /ghp_[A-Za-z0-9]{36}/g },
	{ name: "PEM 私钥", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
	{ name: "Bearer token", re: /Bearer [A-Za-z0-9._~+/-]{20,}/g },
	// Shapes of credentials this host stores (§7.3: hosts should add their own).
	{ name: "Anthropic Key", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
	{ name: "Google API Key", re: /AIza[0-9A-Za-z_-]{35}/g },
];

/** Secrets found in [text], never echoing them (§7.3). */
export function scanSecrets(text: string): string[] {
	const hits: string[] = [];
	for (const { name, re } of SECRET_PATTERNS) {
		const count = [...text.matchAll(re)].length;
		if (count) hits.push(`${name} ${count} 处`);
	}
	return hits;
}

export function jsonSize(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value ?? null) ?? "", "utf8");
}

/** Problems that refuse a mint or an import (§5.4, §9.3 error level). */
export function validatePackage(html: string, stateText: string): string[] {
	const errors: string[] = [];
	if (!isFullDocument(html)) errors.push("入口不是完整的 HTML 文档（要有 <!DOCTYPE html>、<html>、<head>、<body>）");
	const title = titleOf(html);
	if (!title) errors.push("缺少 <title>（卡片标题，用用户的语言写）");
	else if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(title)) errors.push(`标题「${title}」是标识符写法，请用自然语言`);
	const manifest = parseManifest(html);
	if (manifest.parseError) errors.push(`manifest 不是合法 JSON：${manifest.parseError}`);
	if (manifest.raw && manifest.raw.toolBindings !== undefined && !isPlainObject(manifest.raw.toolBindings)) errors.push("toolBindings 必须是对象");
	for (const [id, why] of Object.entries(manifest.malformed)) errors.push(`绑定 ${id}：${why}`);
	if (manifest.raw && manifest.raw.spec !== undefined && typeof manifest.raw.spec !== "string") errors.push("spec 必须是字符串");
	const stateBlock = html.match(STATE_BLOCK);
	if (stateBlock) {
		try {
			JSON.parse(stateBlock[1]!);
		} catch {
			errors.push("状态快照块不是合法 JSON");
		}
	}
	const secrets = scanSecrets(`${html}\n${stateText}`);
	if (secrets.length) errors.push(`含疑似密钥：${secrets.join("、")}`);
	return errors;
}

/** File name derived from the title (§6.6). */
export function slugTitle(title: string): string {
	return (
		title
			.trim()
			.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "")
			.replace(/\s+/g, "-")
			.replace(/^\.+/, "")
			.slice(0, 80) || "card"
	);
}
