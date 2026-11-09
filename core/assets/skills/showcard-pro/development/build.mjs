// Release-time only. Install the pinned development lock with --ignore-scripts in an isolated directory.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const base = dirname(dirname(fileURLToPath(import.meta.url)));
const modules = resolve(process.argv[2] ?? join(base, 'development/node_modules'));
const { buildSync } = await import(pathToFileURL(join(modules, 'esbuild/lib/main.js')).href);
const result = buildSync({
  entryPoints: [join(base, 'src/renderer.jsx')], outfile: join(base, 'vendor/renderer.mjs'),
  bundle: true, minify: true, format: 'esm', platform: 'node', target: 'node22',
  nodePaths: [modules], define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'eof', metafile: true,
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
const upstream = join(modules, 'reacticle');
mkdirSync(join(base, 'vendor/reacticle'), { recursive: true });
for (const file of ['README.md', 'package.json']) copyFileSync(join(upstream, file), join(base, 'vendor/reacticle', file));
copyFileSync(join(upstream, 'dist/index.js'), join(base, 'vendor/reacticle/index.js'));
const originalCss = readFileSync(join(upstream, 'dist/style.css'));
// No bundled webfonts: retain the semantic/theme rules and use local system fonts.
const css = originalCss.toString('utf8').replace(/@font-face\s*\{[^}]*\}/g, '');
if (/@import\b|url\(/i.test(css)) throw new Error('Unexpected external CSS asset; review before release');
writeFileSync(join(base, 'vendor/reacticle/style.css'), css);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const packages = ['reacticle', 'react', 'react-dom', 'scheduler', 'loose-envify', 'js-tokens', 'katex', 'prismjs', 'commander', 'esbuild'].map(name => {
  const json = JSON.parse(readFileSync(join(modules, name, 'package.json')));
  return { name, version: json.version, license: json.license };
});
writeFileSync(join(base, 'vendor/build-info.json'), JSON.stringify({
  tool: 'development/build.mjs', node: process.versions.node, packages,
  rendererSha256: hash(readFileSync(join(base, 'vendor/renderer.mjs'))),
  sourceSha256: hash(readFileSync(join(base, 'src/renderer.jsx'))),
  upstreamCssSha256: hash(originalCss), adaptedCssSha256: hash(Buffer.from(css)),
  adaptation: 'Removed @font-face only; no font binaries shipped. Original component JS retained unchanged. Runtime uses bundled renderer, not npm.',
  externalImports: [...new Set(Object.values(result.metafile.outputs).flatMap(output => output.imports.filter(i => i.external).map(i => i.path)))],
}, null, 2) + '\n');
console.log(JSON.stringify({ rendererBytes: readFileSync(join(base, 'vendor/renderer.mjs')).length, cssBytes: Buffer.byteLength(css), packages }));
