import { readdirSync, lstatSync, writeFileSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const mib = bytes => Number((bytes / 1048576).toFixed(4));
export function inventory(root) {
  root = resolve(root); const files = [];
  function walk(dir) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name), name = relative(root, path).replaceAll('\\', '/');
      if (/^(?:data|\.git|build|old-versions)(?:\/|$)/i.test(name)) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw Error(`Unexpected link in measured delivery: ${name}`);
      if (stat.isDirectory()) walk(path); else if (stat.isFile()) files.push({ path: name, bytes: stat.size });
    }
  }
  walk(root); return files.sort((a, b) => a.path.localeCompare(b.path));
}
export function category(path) {
  const name = path.replace(/^current\//, '');
  if (/^(?:Update\.exe|DreamFlutter\.exe|sq\.version|packages\/|\.velopack)/i.test(name) || /^app\/(?:dreamflutter_update\.exe|velopack_libc\.dll)$/i.test(name)) return 'Velopack';
  if (name.startsWith('app/')) return 'Flutter client';
  if (name.startsWith('runtime/')) return 'Node';
  if (name.startsWith('core/node_modules/')) return 'Core production dependencies';
  if (name.startsWith('core/python/') || /^core\/bin\/(?:uv|uvx|uvw)\.exe$/i.test(name)) return 'Python and uv';
  if (/^core\/bin\/(?:rg|fd)\.exe$/i.test(name)) return 'Tools rg and fd';
  if (name.startsWith('core/sandbox-image/')) return 'Sandbox image';
  if (name.startsWith('licenses/')) return 'Licenses';
  return 'Other';
}
export function measure(root, archives = []) {
  const files = inventory(root), categories = {}, packages = {}, extensions = {};
  for (const file of files) {
    const bucket = category(file.path); const row = categories[bucket] ??= { bytes: 0, files: 0 }; row.bytes += file.bytes; row.files++;
    const name = file.path.replace(/^current\//, ''), pkg = /^core\/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(name)?.[1];
    if (pkg) { const entry = packages[pkg] ??= { name: pkg, bytes: 0, files: 0 }; entry.bytes += file.bytes; entry.files++; }
    const ext = /(?:\.d\.[cm]?ts|\.[^.\/]+)$/.exec(name)?.[0] ?? '(none)'; const e = extensions[ext] ??= { bytes: 0, files: 0 }; e.bytes += file.bytes; e.files++;
  }
  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  for (const r of Object.values(categories)) r.mib = mib(r.bytes);
  return { at: new Date().toISOString(), root: resolve(root), unit: 'MiB = 1048576 bytes; logical file bytes, not allocation or memory', excluded: ['root data/', '.git/', 'root build/', 'old-versions/; historical packages kept outside measured directory'], bytes, mib: mib(bytes), fileCount: files.length, categories,
    archives: archives.map(path => ({ path: resolve(path), bytes: statSync(path).size, mib: mib(statSync(path).size) })),
    largestPackages: Object.values(packages).sort((a,b) => b.bytes-a.bytes).slice(0,50).map(p=>({...p,mib:mib(p.bytes)})), extensions,
    largestFiles: [...files].sort((a,b)=>b.bytes-a.bytes).slice(0,50), files };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, evidence, ...archives] = process.argv.slice(2); if (!root || !evidence) throw Error('usage: package-footprint.mjs <delivery-root> <evidence.json> [download-archives...]');
  const result = measure(root, archives); writeFileSync(evidence, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ root: result.root, bytes: result.bytes, mib: result.mib, fileCount: result.fileCount, categories: result.categories, archives: result.archives, largestPackages: result.largestPackages.slice(0,20), extensions: result.extensions }, null, 2));
}
