import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { documents, main } from '../scripts/render-report.mjs';
import { validate } from '../vendor/renderer.mjs';
import { mintDocument, renderServed, instancePolicy, parseManifest } from '../../../../src/cards/document.ts';
import { builtinSkills } from '../../../../src/modules/builtin-skills.ts';

const sample = JSON.parse(readFileSync(new URL('../examples/week.json', import.meta.url), 'utf8'));

test('offline article and Showcard preview retain evidence, zero values, honest gaps, Chinese and native persisted checkbox', () => {
  const { html, cardHtml } = documents(sample);
  for (const output of [html, cardHtml]) {
    assert.match(output, /^<!DOCTYPE html>/);
    assert.match(output, /charset="utf-8"/);
    assert.match(output, /交付有进展/);
    assert.match(output, /default-src 'none'/);
    assert.doesNotMatch(output, /<(?:script|link|iframe)\b/i);
    assert.doesNotMatch(output, /(?:src|href)=["'](?:https?:|\/\/)/i);
    assert.doesNotMatch(output, /@import\b|url\(/i);
  }
  assert.match(html, /0项/);
  assert.match(html, /尚待确认/);
  assert.match(html, /合成记录 W-01/);
  assert.match(html, /data-theme="press"/);
  assert.match(html, /<svg/);
  assert.match(cardHtml, /data-persist="showcard-pro.reviewed"/);
  assert.ok(Buffer.byteLength(cardHtml) < 16000, 'preview stays small enough to pass as actual show_card HTML');
  assert.ok(Math.max(...cardHtml.split('\n').map(line => line.length)) < 2000, 'actual read tool must not truncate a preview line');
});

test('untrusted record text is escaped rather than becoming markup, scripts, URLs or title injection', () => {
  const raw = '<script src="https://example.invalid/leak">x</script></title><img src=x onerror=alert(1)>';
  const { html } = documents({ ...sample, title: raw, achievements: [{ title: raw, detail: raw, evidence: raw }], sources: [raw] });
  assert.match(html, /&lt;script/);
  assert.doesNotMatch(html, /<script\b|<img\b/i);
  assert.equal((html.match(/<title>/g) ?? []).length, 1, 'record text cannot escape into another page title');
});

test('missing records, bad schema and non-finite metrics fail without inventing results; missing owners stay explicit', () => {
  assert.throws(() => validate({ title: '没有材料', period: '本周', summary: ['待补'] }), /至少提供/);
  assert.throws(() => validate({ ...sample, metrics: [{ name: '错误', value: 'NaN', numericValue: NaN }] }), /有限数字/);
  assert.throws(() => validate({ ...sample, theme: 'remote-theme' }), /theme/);
  assert.throws(() => validate({ ...sample, summary: Array(101).fill('x') }), /100项/);
  const result = validate({ ...sample, nextWeek: [{ task: '确认排期' }] });
  assert.equal(result.nextWeek[0].owner, '待确认');
  assert.equal(result.nextWeek[0].due, '待确认');
});

test('different or unknown units and negative quantities remain exact in table without a misleading chart', () => {
  const metrics = [{ name: '收入', value: '-2元', numericValue: -2, unit: '元' }, { name: '时间', value: '1小时', numericValue: 1, unit: '小时' }];
  const { html } = documents({ ...sample, metrics });
  assert.match(html, /-2元/); assert.match(html, /1小时/); assert.doesNotMatch(html, /<svg/);
  assert.doesNotMatch(documents({ ...sample, metrics: [{ name: '未指定口径', value: '3', numericValue: 3 }] }).html, /<svg/);
});

test('CLI uses new paths, preserves input and existing output, and produces no files for invalid JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'df-t81-test-'));
  const input = join(root, '输入.json'), output = join(root, 'nested', '中文 周报.html');
  writeFileSync(input, JSON.stringify(sample));
  const before = readFileSync(input);
  const result = main(['--input', input, '--out', output]);
  assert.equal(result.networkUsed, false);
  assert.ok(existsSync(result.card)); assert.deepEqual(readFileSync(input), before);
  assert.throws(() => main(['--input', input, '--out', output]), /输出已存在/);
  writeFileSync(input, '{bad json');
  const invalid = join(root, 'not-created', 'bad.html');
  assert.throws(() => main(['--input', input, '--out', invalid]));
  assert.equal(existsSync(invalid), false);
});

test('copied release files work with empty PATH, no node_modules and network functions forbidden', () => {
  const root = mkdtempSync(join(tmpdir(), 'df-t81-offline-'));
  for (const folder of ['scripts', 'vendor/reacticle']) mkdirSync(join(root, folder), { recursive: true });
  for (const file of ['scripts/render-report.mjs', 'vendor/renderer.mjs', 'vendor/reacticle/style.css']) {
    copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(root, file));
  }
  writeFileSync(join(root, 'input.json'), JSON.stringify(sample));
  const guard = join(root, 'deny-network.cjs');
  writeFileSync(guard, `const deny=()=>{throw Error('T81 test forbids network')};globalThis.fetch=deny;for(const name of ['http','https','net','tls','dns']){const m=require('node:'+name);for(const method of ['request','get','connect','createConnection','lookup','resolve'])if(typeof m[method]==='function')m[method]=deny;}`);
  const output = execFileSync(process.execPath, ['--require', guard, join(root, 'scripts/render-report.mjs'), '--input', join(root, 'input.json'), '--out', join(root, 'report.html')], {
    encoding: 'utf8', windowsHide: true, cwd: root,
    env: { ...process.env, PATH: '', NODE_PATH: '', NODE_OPTIONS: '', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1' },
  });
  const result = JSON.parse(output);
  assert.equal(result.networkUsed, false);
  assert.match(readFileSync(result.report, 'utf8'), /用数据核对进展/);
  assert.ok(existsSync(result.card));
  assert.equal(existsSync(join(root, 'node_modules')), false);
});

test('new strict-name builtin is discoverable and its preview passes the existing Showcard host injection', () => {
  const skill = builtinSkills().find(item => item.name === 'showcard-pro');
  assert.ok(skill);
  assert.match(skill.filePath.replaceAll('\\', '/'), /\/showcard-pro\/SKILL\.md$/);
  assert.equal(builtinSkills().some(item => item.name === 'showcard_pro'), false);
  const { cardHtml } = documents(sample);
  const minted = mintDocument(cardHtml, sample.title, {});
  const served = renderServed(minted, { csp: instancePolicy('http://127.0.0.1:4567/cards/test/', []), theme: {}, sizing: 'content' });
  assert.equal((served.match(/<meta\b[^>]*http-equiv="Content-Security-Policy"/gi) ?? []).length, 1, 'host replaces author CSP instead of blocking its own runtime');
  assert.match(served, /script-src 'unsafe-inline'/);
  assert.match(served, /data-persist="showcard-pro.reviewed"/);
  assert.match(served, /id="df-theme"/);
  assert.deepEqual(parseManifest(minted).bindings, {});
});
