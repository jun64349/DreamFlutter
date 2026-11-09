#!/usr/bin/env node
// Uses the already bundled Node runtime and release-time renderer. No npm, network or browser dependency.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderBody, validate } from '../vendor/renderer.mjs';

const base = dirname(dirname(fileURLToPath(import.meta.url)));
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const compactCss = `:root{color-scheme:light;--ra-color-bg:#faf9f6;--ra-color-text:#232321;--ra-color-heading:#171715;--ra-color-muted:#67665f;--ra-color-accent:#b33c28;--ra-color-border:#d9d6ce;--ra-color-surface:#eeece5}
*{box-sizing:border-box}body{margin:0;background:var(--ra-color-bg);color:var(--ra-color-text);font:15px/1.7 system-ui,"Microsoft YaHei","Noto Sans CJK SC",sans-serif;overflow-wrap:anywhere}article{padding:24px;max-width:760px;margin:auto}h1{font-size:clamp(26px,5vw,40px);line-height:1.2;margin:12px 0 16px;letter-spacing:-.03em}h2{font-size:20px;margin-top:24px;border-top:1px solid var(--ra-color-border);padding-top:16px}h3{font-size:16px;margin:16px 0 4px}p{margin:8px 0}ul{padding-left:22px}svg{display:block;width:100%;height:auto}input{accent-color:var(--ra-color-accent)}.sc-source{font-size:12px;color:var(--ra-color-muted)}header{margin-bottom:20px}section{margin:20px 0}footer{border-top:1px solid var(--ra-color-border);padding-top:14px}button{font:inherit}table{border-collapse:collapse;width:100%}td,th{padding:8px;text-align:left;border-bottom:1px solid var(--ra-color-border)}`;

export function documents(data) {
  const r = validate(data);
  const css = readFileSync(join(base, 'vendor/reacticle/style.css'), 'utf8').replace(/@font-face\s*\{[^}]*\}/g, '');
  if (/@import\b|url\(\s*["']?(?!data:)/i.test(css)) throw new Error('样式含非内联资源，拒绝离线交付');
  const local = `body{margin:0;background:#faf9f6;overflow-wrap:anywhere}.ra-theme{--ra-font-body:system-ui,"Microsoft YaHei","Noto Sans CJK SC",sans-serif;--ra-font-heading:Georgia,"Microsoft YaHei",serif}svg{display:block;max-width:100%;height:auto}.sc-source{color:var(--ra-color-muted);font-size:.8em}.sc-risk{border-left:3px solid var(--ra-color-accent);padding-left:1.2em}h1{overflow-wrap:anywhere}[data-theme] .ra-table{min-width:0;max-width:100%;margin-inline:0}[data-theme] .ra-table__scroll{min-width:0;max-width:100%;overflow-x:auto}[data-theme] .ra-table__table{width:100%;min-width:0;table-layout:fixed}[data-theme] .ra-table__table th,[data-theme] .ra-table__table td{white-space:normal;overflow-wrap:anywhere;word-break:normal}[data-theme] .ra-table__table th:nth-child(1){width:25%}[data-theme] .ra-table__table th:nth-child(2){width:20%}[data-theme] .ra-table__table th:nth-child(3){width:55%}@media(max-width:640px){article{padding:20px!important}h1{font-size:2rem!important}table{font-size:12px}td,th{padding:7px!important}}@media print{body{background:white}section{break-inside:avoid}}`;
  // Short lines let the actual read tool return the entire preview without its per-line truncation.
  const wrap = (body, style) => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; base-uri 'none'; form-action 'none'"><title>${escape(r.title)}</title><style>${style}</style></head><body>${body}</body></html>`.replace(/></g, '>\n<');
  return { html: wrap(renderBody(r), css + local), cardHtml: wrap(renderBody(r, true), compactCss) };
}

export function main(args = process.argv.slice(2)) {
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--out') throw new Error('用法：node render-report.mjs --input report.json --out /所选输出目录/周报.html');
  const input = resolve(args[1]), output = resolve(args[3]);
  if (extname(output).toLowerCase() !== '.html') throw new Error('输出必须是.html文件');
  const preview = output.slice(0, -5) + '.card.html';
  if (input === output || input === preview || existsSync(output) || existsSync(preview)) throw new Error('输出已存在或与输入相同；请选择新文件名，原文件未覆盖');
  const raw = readFileSync(input);
  if (raw.length > 2 * 1024 * 1024) throw new Error('输入超过2MiB，请先按记录分组整理');
  const result = documents(JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')));
  mkdirSync(dirname(output), { recursive: true });
  const written = [];
  try { writeFileSync(output, result.html, { flag: 'wx' }); written.push(output); writeFileSync(preview, result.cardHtml, { flag: 'wx' }); written.push(preview); }
  catch (error) { throw new Error(`写入失败：${error.message}；已写入：${written.join('、') || '无'}。未宣称整次交付成功。`); }
  return { report: output, card: preview, reportBytes: Buffer.byteLength(result.html), cardBytes: Buffer.byteLength(result.cardHtml), networkUsed: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(main(), null, 2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
