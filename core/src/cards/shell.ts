/**
 * The page the window's WebView loads for one card instance: the card in a
 * sandboxed iframe (allow-scripts only, so an opaque origin, §7.1) and a
 * relay between that iframe and the Flutter window (window.chrome.webview).
 * Only messages from the card's own window are relayed (reference host.js:
 * `event.source !== iframe.contentWindow` is ignored).
 */
export function shellPage(nonce: string, src: string): string {
	return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:transparent}iframe{border:0;width:100%;height:100%;display:block;background:transparent;color-scheme:normal}</style>
</head><body>
<iframe id="card" sandbox="allow-scripts" src="${src}" title="card"></iframe>
<script nonce="${nonce}">
(function(){
var frame = document.getElementById("card");
var wv = window.chrome && window.chrome.webview;
function up(m) { if (wv) wv.postMessage(m); }
window.addEventListener("message", function (e) {
  if (e.source !== frame.contentWindow) return;
  var m = e.data;
  if (!m || typeof m !== "object" || typeof m.type !== "string") return;
  if (m.type === "card:request" || m.type.indexOf("df:") === 0) up(m);
});
if (wv) wv.addEventListener("message", function (e) {
  var m = e.data;
  if (typeof m === "string") { try { m = JSON.parse(m); } catch (err) { return; } }
  if (!m || typeof m.type !== "string") return;
  if (m.type === "shell:reload") { frame.src = "${src}?r=" + Date.now(); return; }
  if ((m.type === "card:response" || m.type.indexOf("df:") === 0) && frame.contentWindow) frame.contentWindow.postMessage(m, "*");
});
frame.addEventListener("load", function () {
  if (frame.contentWindow) frame.contentWindow.postMessage({ type: "df:ping" }, "*");
  up({ type: "shell:loaded" });
});
})();
</script>
</body></html>`;
}
