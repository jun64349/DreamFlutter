import { existsSync, readFileSync, writeFileSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, relative, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inventory, mib } from './package-footprint.mjs';

const RULE_VERSION = 'windows-x64-runtime-audit-2026-11-07-v1';
const reviewed = new Set(JSON.parse(readFileSync(new URL('./package-trim-policy.json', import.meta.url), 'utf8')).reviewedPackages);
const reasons = {
  declarations: 'Third-party TypeScript declarations: conditional types/typings or declaration siblings; Node executes retained JavaScript and native strip-types removes type-only imports. Pi SDK declarations/docs/examples remain for its public authoring workflow.',
  declarationMaps: 'Maps whose only target is a removed declaration, never a runtime JavaScript stack; all JavaScript source maps and source code remain.',
  buildMetadata: 'TypeScript incremental build state in already compiled npm libraries; no production tsc build or runtime entry reads it.',
  otherClipboardPlatforms: 'pi-tui native loader selects process.platform/process.arch; this package is Windows x64. Retain its win32-x64 helper, all licenses, and every WASI .so.',
  unusedLibraryDocs: 'undici API prose and ws/yauzl/yazl README/changelog are not loaded by their audited runtime entrypoints; keep Pi self-help docs/examples, release notes, licenses and diagnostics.',
  pdfAlternativeMinified: 'pdfjs-dist 4.10.38 duplicate minified worker/sandbox/image-decoder variants: application loads legacy/build/pdf.mjs and its unminified worker; retained full modules serve identical required PDF functionality.',
};
const legal = path => /(?:^|\/)(?:licen[cs]e[^/]*|copying[^/]*|copyright[^/]*|notice[^/]*|unlicense[^/]*|third[-_]?party[^/]*)(?:\/|$)/i.test(path);
function safeRoot(root) {
  root = realpathSync(resolve(root));
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (root.toLowerCase() === repository.toLowerCase() || !existsSync(join(root, 'app/dreamflutter.exe')) || !existsSync(join(root, 'runtime/node.exe')) || !existsSync(join(root, 'core/package.json'))) throw Error('Only a prepared full Windows delivery payload may be trimmed');
  if (JSON.parse(readFileSync(join(root, 'core/package.json'), 'utf8')).name !== 'dreamflutter-core') throw Error('Unexpected package identity');
  const build = JSON.parse(readFileSync(join(root, 'build-info.json'), 'utf8'));
  if (build.platform !== 'win32' || build.arch !== 'x64') throw Error('These audited rules apply to Windows x64 only');
  return root;
}
function runtimeTargets(value, result = []) {
  if (typeof value === 'string') result.push(value);
  else if (Array.isArray(value)) for (const part of value) runtimeTargets(part, result);
  else if (value && typeof value === 'object') for (const [key, part] of Object.entries(value)) if (!['types', 'typings', 'typesVersions'].includes(key)) runtimeTargets(part, result);
  return result;
}
function targetMatches(pattern, file) {
  const escaped = pattern.replace(/^\.\//, '').split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`).test(file);
}
export function plan(root) {
  root = safeRoot(root); const files = inventory(root), packages = new Map(), candidates = [];
  for (const file of files) {
    if (!file.path.startsWith('core/node_modules/') || legal(file.path)) continue;
    const offset = file.path.lastIndexOf('/node_modules/') + '/node_modules/'.length, tail = file.path.slice(offset), segments = tail.split('/'), width = segments[0].startsWith('@') ? 2 : 1;
    const packagePath = file.path.slice(0, offset) + segments.slice(0, width).join('/'), name = segments.slice(0, width).join('/'), within = segments.slice(width).join('/');
    let meta = packages.get(packagePath);
    if (!meta) { try { const json = JSON.parse(readFileSync(join(root, packagePath, 'package.json'), 'utf8')); meta = { name, version: json.version, runtime: [...runtimeTargets(json.exports), ...runtimeTargets(json.bin), ...runtimeTargets(json.main), ...runtimeTargets(json.module)] }; packages.set(packagePath, meta); } catch { continue; } }
    if (!reviewed.has(`${meta.name}@${meta.version}`)) continue;
    let rule;
    const declaration = /\.d\.[cm]?ts$/.test(within), declarationMap = /\.d\.[cm]?ts\.map$/.test(within);
    if ((declaration || declarationMap) && !name.startsWith('@earendil-works/')) {
      const target = within.replace(/\.map$/, '');
      // A declaration exported as a runtime/default target is unusual; never remove it.
      if (!meta.runtime.some(pattern => targetMatches(pattern, target)) && (declaration || existsSync(join(root, packagePath, target)))) rule = declarationMap ? 'declarationMaps' : 'declarations';
    }
    if (!rule && /\.tsbuildinfo$/.test(within) && ['@earendil-works/pi-tui', 'undici'].includes(name)) rule = 'buildMetadata';
    if (!rule && name === '@earendil-works/pi-tui' && meta.version === '1.4.0' && /^(?:native\/(?:darwin|linux)\/|native\/win32\/prebuilds\/win32-arm64\/)/.test(within)) rule = 'otherClipboardPlatforms';
    if (!rule && (name === 'undici' && meta.version === '8.10.2' && within.startsWith('docs/') || ['ws', 'yauzl', 'yazl'].includes(name) && /^(?:README|CHANGELOG|HISTORY)\.md$/i.test(within))) rule = 'unusedLibraryDocs';
    if (!rule && name === 'pdfjs-dist' && meta.version === '4.10.38' && /^(?:legacy\/)?(?:build\/pdf\.(?:worker|sandbox)|image_decoders\/pdf\.image_decoders)\.min\.mjs$/.test(within) && existsSync(join(root, packagePath, within.replace('.min.mjs', '.mjs')))) rule = 'pdfAlternativeMinified';
    if (rule) candidates.push({ ...file, package: name, version: meta.version, rule });
  }
  const classes = {};
  for (const file of candidates) { const row = classes[file.rule] ??= { reason: reasons[file.rule], bytes: 0, files: 0 }; row.bytes += file.bytes; row.files++; }
  for (const row of Object.values(classes)) row.mib = mib(row.bytes);
  return { ruleVersion: RULE_VERSION, root, beforeBytes: files.reduce((n,f)=>n+f.bytes,0), beforeFiles: files.length, savedBytes: candidates.reduce((n,f)=>n+f.bytes,0), classes, candidates,
    preserved: ['all core source/assets and selected JavaScript entrypoints/source maps; only audited unused PDF alternative modules are removed', 'Pi SDK docs/examples/public declarations', 'all licenses and diagnostic information', 'all Python/uv/rg/fd/Node binaries', 'sandbox image and offline provisioning', 'canvas platform binary and QuickJS WASI .so extensions'] };
}
export function trim(root, evidence) {
  const report = plan(root);
  for (const file of report.candidates) {
    const path = resolve(report.root, file.path), within = relative(report.root, path);
    if (within.startsWith('..') || !within.startsWith(`core${process.platform === 'win32' ? '\\' : '/'}node_modules`) || legal(file.path)) throw Error('Trim escaped the audited production dependency subtree');
    unlinkSync(path); // Files only; no recursive deletion or junction traversal.
  }
  const after = inventory(report.root); report.afterBytes = after.reduce((n,f)=>n+f.bytes,0); report.afterFiles = after.length; report.applied = true;
  if (report.beforeBytes - report.afterBytes !== report.savedBytes) throw Error('Measured byte delta does not match the audited deletion manifest');
  if (evidence) writeFileSync(evidence, JSON.stringify(report, null, 2));
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, evidence, action = '--plan'] = process.argv.slice(2); if (!root || !evidence || !['--plan', '--apply'].includes(action)) throw Error('usage: package-trim.mjs <payload-root> <evidence.json> [--plan|--apply]');
  const result = action === '--apply' ? trim(root, evidence) : plan(root); if (action === '--plan') writeFileSync(evidence, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, candidates: undefined }, null, 2));
}
