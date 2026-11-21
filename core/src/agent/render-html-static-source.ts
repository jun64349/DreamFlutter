import { generate, parse as parseCss, walk, type CssNode, type Url } from "css-tree";
import { parse, type DefaultTreeAdapterTypes as Html } from "parse5";
import type { RenderHtmlResources } from "./render-html-resources.ts";

const STATIC_ELEMENTS = new Set(("a abbr article aside b blockquote br caption cite code col colgroup dd del details div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img kbd li main mark nav ol p pre q s samp section small span strong sub summary sup table tbody td tfoot th thead time tr u ul var").split(" "));
const VOID_ELEMENTS = new Set(["br", "col", "hr", "img"]);
const STATIC_ATTRIBUTES = new Set(["class", "id", "title", "lang", "dir", "width", "height", "alt", "colspan", "rowspan", "span", "start", "open"]);
const STATIC_RULES = new Set(["media", "supports", "font-face", "page", "keyframes", "-webkit-keyframes"]);
const SAFE_FUNCTIONS = new Set(("calc min max clamp rgb rgba hsl hsla linear-gradient repeating-linear-gradient radial-gradient repeating-radial-gradient rect translate translatex translatey translate3d scale scalex scaley rotate skew matrix counter counters attr format local").split(" "));
const STATIC_PROPERTIES = /^(?:align-[a-z-]+|background(?:-[a-z-]+)?|border(?:-[a-z-]+)?|bottom|box-(?:sizing|shadow)|break-[a-z-]+|clear|color|column(?:s|-[a-z-]+)|content|display|flex(?:-[a-z-]+)?|float|font(?:-[a-z-]+)?|gap|grid(?:-[a-z-]+)?|height|justify-[a-z-]+|left|letter-spacing|line-height|list-style(?:-[a-z-]+)?|margin(?:-[a-z-]+)?|(?:max|min)-(?:height|width)|opacity|order|outline(?:-[a-z-]+)?|overflow(?:-[a-z-]+)?|padding(?:-[a-z-]+)?|page-break-[a-z-]+|position|right|src|table-layout|text(?:-[a-z-]+)?|top|transform(?:-[a-z-]+)?|vertical-align|visibility|white-space|width|word-[a-z-]+|z-index)$/;
const SAFE_INLINE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[0-9a-z+/]+={0,2}$/i;
const SAFE_MIME = /^(?:image\/(?:png|jpeg|gif|webp)|font\/(?:woff2?|ttf|otf))$/;
const MAX_STATIC_NODES = 15_000;
const MAX_STATIC_SOURCE = 16 * 1024 * 1024;

const escaped = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const attr = (element: Html.Element, name: string) => element.attrs.find(item => item.name === name)?.value;
const cssInHtml = (text: string) => text.replaceAll("<", "\\3c ");

/** Rebuild the report from inert elements so the Windows control receives no live URLs or active HTML. */
export async function staticHtmlDocument(resources: RenderHtmlResources, signal: AbortSignal): Promise<string> {
	const entry = await resources.get(resources.url, "GET", "Document", signal);
	if (!entry) throw new Error("找不到截图入口");
	const document = parse(Buffer.from(entry.body, "base64").toString("utf8"));
	const stylesheet = new Map<string, Promise<string>>();
	const assets = new Map<string, Promise<string>>();
	let elements = 0;
	let sizeLeft = MAX_STATIC_SOURCE;
	let pendingRead = Promise.resolve();
	function budget(text: string): string {
		sizeLeft -= Buffer.byteLength(text);
		if (sizeLeft < 0) throw new Error("静态截图的合成文档过大");
		return text;
	}

	function get(url: string, type: "Stylesheet" | "Image" | "Font") {
		const read = pendingRead.then(() => resources.get(url, "GET", type, signal));
		pendingRead = read.then(() => {}, () => {});
		return read;
	}

	function urlFor(raw: string, base: string): string | undefined {
		const result = URL.parse(raw, base);
		if (result) return result.href;
		resources.report(raw, "无法识别的资源地址");
	}

	function asset(raw: string, base: string, type: "Image" | "Font"): Promise<string> {
		if (type === "Image" && SAFE_INLINE_IMAGE.test(raw)) return Promise.resolve(budget(raw));
		const url = urlFor(raw, base);
		if (!url) return Promise.resolve("");
		const key = type + " " + url;
		let pending = assets.get(key);
		if (!pending) {
			pending = get(url, type).then(response => {
				const mime = response?.headers.find(header => header.name.toLowerCase() === "content-type")?.value.split(";")[0];
				if (response && mime && SAFE_MIME.test(mime)) return "data:" + mime + ";base64," + response.body;
				if (response) resources.report(raw, "静态截图不支持此资源格式");
				return "";
			});
			assets.set(key, pending);
		}
		return pending.then(budget);
	}

	function styleSafe(value: CssNode): boolean {
		let safe = true;
		walk(value, child => {
			if (child.type === "Raw" || child.type === "Function" && !SAFE_FUNCTIONS.has(child.name.toLowerCase())) safe = false;
		});
		return safe;
	}

	async function cleanCss(css: string, base: string, mode: "stylesheet" | "declarationList", ancestors: readonly string[]): Promise<string> {
		budget(css);
		const tree = parseCss(css, { context: mode, parseCustomProperty: false });
		const pending: Promise<void>[] = [];
		walk(tree, function (node, item, list) {
			if (!item || !list) return;
			if (node.type === "Atrule") {
				const name = node.name.toLowerCase();
				if (name === "import" && node.prelude?.type === "AtrulePrelude") {
					const source = node.prelude.children.first;
					// Inline imports only when they name one stylesheet without extra conditions.
					if (node.prelude.children.size === 1 && (source?.type === "Url" || source?.type === "String")) {
						pending.push(readStylesheet(source.value, base, ancestors).then(imported => {
							if (imported) {
								const sheet = parseCss(imported);
								if (sheet.type === "StyleSheet") list.insertList(sheet.children, item);
							}
							list.remove(item);
						}));
						return this.skip;
					}
				}
				let hasUrl = false;
				if (node.prelude) walk(node.prelude, child => { if (child.type === "Url") hasUrl = true; });
				if (!STATIC_RULES.has(name) || hasUrl) { list.remove(item); return this.skip; }
			} else if (node.type === "Declaration") {
				const property = node.property.toLowerCase();
				if (!STATIC_PROPERTIES.test(property) || !styleSafe(node.value)) { list.remove(item); return this.skip; }
				const urls: Url[] = [];
				walk(node.value, child => { if (child.type === "Url") urls.push(child); });
				const type = property === "src" ? "Font" : "Image";
				pending.push(...urls.map(url => asset(url.value, base, type).then(data => { url.value = data || "data:,"; })));
			} else if (node.type === "Raw") list.remove(item);
		});
		await Promise.all(pending);
		return generate(tree);
	}

	function readStylesheet(raw: string, base: string, ancestors: readonly string[]): Promise<string> {
		const url = urlFor(raw, base);
		if (!url || ancestors.length >= 8 || ancestors.includes(url)) return Promise.resolve("");
		// Imported styles use the same URL broker as HTML images and cannot reach a file URL.
		const work = () => get(url, "Stylesheet").then(response => response
			? cleanCss(Buffer.from(response.body, "base64").toString("utf8"), url, "stylesheet", [...ancestors, url]) : "");
		if (ancestors.length) return work();
		let pending = stylesheet.get(url);
		if (!pending) { pending = work(); stylesheet.set(url, pending); }
		return pending;
	}

	async function render(node: Html.ChildNode, depth: number): Promise<string> {
		signal.throwIfAborted();
		if (depth > 64 || ++elements > MAX_STATIC_NODES) throw new Error("静态截图页面的结构过大");
		if (node.nodeName === "#text") return budget(escaped((node as Html.TextNode).value));
		if (!("tagName" in node) || node.namespaceURI !== "http://www.w3.org/1999/xhtml") return "";
		const tag = node.tagName;
		if (tag === "style") {
			const source = node.childNodes.flatMap(child => child.nodeName === "#text" ? [(child as Html.TextNode).value] : []).join("");
			return "<style>" + cssInHtml(await cleanCss(source, resources.url, "stylesheet", [])) + "</style>";
		}
		if (tag === "link" && attr(node, "rel")?.toLowerCase() === "stylesheet") {
			const href = attr(node, "href");
			return href ? "<style>" + cssInHtml(await readStylesheet(href, resources.url, [])) + "</style>" : "";
		}
		if (!STATIC_ELEMENTS.has(tag) && tag !== "html" && tag !== "head" && tag !== "body") return "";
		const attributes = node.attrs.filter(item => STATIC_ATTRIBUTES.has(item.name)).map(item => budget(` ${item.name}="${escaped(item.value)}"`));
		const inline = attr(node, "style");
		if (inline) attributes.push(' style="' + escaped(await cleanCss(inline, resources.url, "declarationList", [])) + '"');
		if (tag === "img") {
			const raw = attr(node, "src");
			const src = raw && await asset(raw, resources.url, "Image");
			if (src) attributes.push(' src="' + escaped(src) + '"');
		}
		const prefix = "<" + tag + attributes.join("") + ">";
		if (VOID_ELEMENTS.has(tag)) return prefix;
		const children = await Promise.all(node.childNodes.map(child => render(child, depth + 1)));
		if (tag === "head") {
			children.unshift('<meta charset="utf-8"><meta http-equiv="X-UA-Compatible" content="IE=edge"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:">');
		}
		return prefix + children.join("") + "</" + tag + ">";
	}

	const html = "<!doctype html>" + (await Promise.all(document.childNodes.map(child => render(child, 0)))).join("");
	if (Buffer.byteLength(html) > MAX_STATIC_SOURCE) throw new Error("静态截图的合成文档过大");
	return html;
}
