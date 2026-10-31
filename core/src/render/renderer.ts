import { randomBytes } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Core } from "../core.ts";

const RENDER_DIR = fileURLToPath(new URL("../../assets/render/", import.meta.url));
const FILES: Record<string, string> = { "mermaid.min.js": "text/javascript; charset=utf-8", "chart.umd.js": "text/javascript; charset=utf-8" };

/** Serves the hidden renderer page and its two libraries at /render/ (rich output, plan §C4). */
export function registerRenderer(core: Core): void {
	core.registerHttp("/render/", (req: IncomingMessage, res: ServerResponse, path: string) => {
		const name = path.slice("/render/".length);
		if (name === "renderer.html") {
			const nonce = randomBytes(16).toString("base64");
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Security-Policy": `default-src 'none'; script-src 'self' 'nonce-${nonce}' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:`,
				"Cache-Control": "no-store",
			});
			res.end(rendererPage(nonce));
			return;
		}
		const type = FILES[name];
		if (!type) {
			res.writeHead(404).end();
			return;
		}
		const file = join(RENDER_DIR, name);
		res.writeHead(200, { "Content-Type": type, "Content-Length": String(statSync(file).size), "Cache-Control": "max-age=86400" });
		if (req.method === "HEAD") return void res.end();
		createReadStream(file).pipe(res);
	});
}

/**
 * Hidden page the window renders Mermaid diagrams, charts and SVG in
 * (message `{id, kind, source, css, width, scale}` → `{id, ok, png, svg,
 * width, height}` back over window.chrome.webview).
 */
export function rendererPage(nonce: string): string {
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{margin:0;background:transparent}#stage{position:absolute;left:0;top:0;padding:16px;display:inline-block}</style>
<script src="mermaid.min.js"></script><script src="chart.umd.js"></script>
</head><body><div id="stage"></div>
<script nonce="${nonce}">
(function(){
var wv = window.chrome && window.chrome.webview;
var stage = document.getElementById("stage");
function reply(m) { if (wv) wv.postMessage(JSON.stringify(m)); }
function vars(css) { var out = {}; (css || "").replace(/(--[a-z0-9-]+)\\s*:\\s*([^;}]+)/gi, function (_, k, v) { out[k] = v.trim(); }); return out; }
function rasterize(svgText, w, h, scale) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.onload = function () {
      var c = document.createElement("canvas"); c.width = Math.ceil(w * scale); c.height = Math.ceil(h * scale);
      var g = c.getContext("2d"); g.scale(scale, scale); g.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL("image/png").split(",")[1]);
    };
    img.onerror = function () { reject(new Error("SVG 无法绘制")); };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);
  });
}
function sizeOf(svgEl) {
  var vb = svgEl.viewBox && svgEl.viewBox.baseVal;
  var w = parseFloat(svgEl.getAttribute("width")) || (vb && vb.width) || 600;
  var h = parseFloat(svgEl.getAttribute("height")) || (vb && vb.height) || 400;
  if (String(svgEl.getAttribute("width") || "").indexOf("%") >= 0 && vb && vb.width) { w = vb.width; h = vb.height; }
  return { w: w, h: h };
}
function fixSize(svgText, maxWidth) {
  var doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  var el = doc.documentElement;
  if (!el || el.nodeName.toLowerCase() !== "svg" || doc.getElementsByTagName("parsererror").length) throw new Error("不是有效的 SVG");
  if (!el.getAttribute("xmlns")) el.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  var s = sizeOf(el);
  if (maxWidth && s.w > maxWidth * 2) { s.h = s.h * (maxWidth * 2) / s.w; s.w = maxWidth * 2; }
  el.setAttribute("width", String(s.w)); el.setAttribute("height", String(s.h));
  el.style.maxWidth = "";
  return { text: new XMLSerializer().serializeToString(el), w: s.w, h: s.h };
}
var mermaidReady = false, count = 0;
async function render(m) {
  var v = vars(m.css);
  var scale = m.scale || 2;
  if (m.kind === "svg") {
    var s = fixSize(m.source, m.width);
    return { svg: s.text, png: await rasterize(s.text, s.w, s.h, scale), width: s.w, height: s.h };
  }
  if (m.kind === "mermaid") {
    if (!window.mermaid) throw new Error("Mermaid 没有加载");
    var dark = m.dark === true;
    window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", htmlLabels: false, flowchart: { htmlLabels: false }, fontFamily: v["--font-sans"] || "Microsoft YaHei UI, sans-serif",
      themeVariables: { primaryColor: v["--surface"] || (dark ? "#2a2723" : "#fbf7f0"), primaryBorderColor: v["--accent"] || "#b0603a", primaryTextColor: v["--fg"] || (dark ? "#eee" : "#2b2620"), lineColor: v["--muted"] || "#8a8174", fontSize: "14px", background: "transparent" } });
    var out = await window.mermaid.render("m" + (++count), m.source);
    var f = fixSize(out.svg, m.width);
    return { svg: f.text, png: await rasterize(f.text, f.w, f.h, scale), width: f.w, height: f.h };
  }
  if (m.kind === "chart") {
    if (!window.Chart) throw new Error("图表库没有加载");
    var spec = typeof m.source === "string" ? JSON.parse(m.source) : m.source;
    var w = Math.min(m.width || 640, 1000), h = spec.height || Math.round(w * 0.55);
    stage.innerHTML = "";
    var canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
    canvas.style.width = w + "px"; canvas.style.height = h + "px"; stage.appendChild(canvas);
    var palette = (v["--chart"] || "#b0603a,#4f7a8a,#c9a14a,#6b8f5e,#8c5d8f,#a85454,#5b6b9c").split(",").map(function (c) { return c.trim(); });
    var type = spec.type || "bar";
    var datasets = (spec.series || spec.datasets || []).map(function (s, i) {
      var color = s.color || palette[i % palette.length];
      var pieLike = type === "pie" || type === "doughnut";
      return { label: s.name || s.label || ("系列" + (i + 1)), data: s.data || [], borderColor: pieLike ? "transparent" : color,
        backgroundColor: pieLike ? (s.data || []).map(function (_, j) { return palette[j % palette.length]; }) : (type === "line" ? color : color + "cc"),
        fill: type === "area", tension: 0.3, pointRadius: type === "scatter" ? 4 : 2, borderWidth: 2 };
    });
    var chartType = type === "area" ? "line" : type;
    var fg = v["--fg"] || "#2b2620", muted = v["--muted"] || "#8a8174", grid = v["--border"] || "#e5ded2";
    var chart = new window.Chart(canvas, { type: chartType, data: { labels: spec.labels || spec.x || [], datasets: datasets },
      options: { responsive: false, animation: false, devicePixelRatio: scale, indexAxis: spec.horizontal ? "y" : "x",
        plugins: { title: { display: !!spec.title, text: spec.title || "", color: fg, font: { size: 15 } }, legend: { display: datasets.length > 1 || type === "pie" || type === "doughnut", labels: { color: fg } } },
        scales: (type === "pie" || type === "doughnut" || type === "radar") ? {} : { x: { stacked: !!spec.stacked, ticks: { color: muted }, grid: { color: grid }, title: { display: !!spec.xLabel, text: spec.xLabel || "", color: muted } }, y: { stacked: !!spec.stacked, ticks: { color: muted }, grid: { color: grid }, title: { display: !!spec.yLabel, text: spec.yLabel || "", color: muted } } } } });
    var png = canvas.toDataURL("image/png").split(",")[1];
    chart.destroy();
    return { png: png, width: w, height: h };
  }
  throw new Error("不支持的类型 " + m.kind);
}
if (wv) wv.addEventListener("message", function (e) {
  var m = e.data;
  if (typeof m === "string") { try { m = JSON.parse(m); } catch (err) { return; } }
  if (!m || !m.id) return;
  render(m).then(function (r) { r.id = m.id; r.ok = true; reply(r); }, function (err) { reply({ id: m.id, ok: false, error: String(err && err.message || err) }); });
});
reply({ ready: true });
})();
</script></body></html>`;
}
