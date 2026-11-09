// Maintainer-only lock refresh: official, versioned metadata must agree with T-72's measured files.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const evidence = join(root, 'docs/research/v0.7-t72-evidence');
const windows = JSON.parse(readFileSync(join(evidence, 'windows-results.json')));
const linux = JSON.parse(readFileSync(join(evidence, 'linux-exact-results.json')));
const old = JSON.parse(readFileSync(join(evidence, 'run-context.json'))).windowsTempRoot;
const cache = resolve(process.argv[2]); mkdirSync(cache, { recursive: true });
const norm = s => s.toLowerCase().replaceAll('_', '-');
const selected = windows.cases.find(c => c.case === 'recommended').installed.filter(([n]) => n !== 'pip');
const linuxNames = ['python-docx', 'python-pptx', 'pypdf', 'typing-extensions', 'xlsxwriter'];
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const wheels = [];
for (const [name, version] of selected) {
  const metadata = JSON.parse(execFileSync('curl.exe', ['-fsSL', '--retry', '3', `https://pypi.org/pypi/${norm(name)}/${version}/json`], { encoding: 'utf8', windowsHide: true, maxBuffer: 8e6 }));
  const recorded = windows.wheelhouse.find(w => norm(w.file.split('-')[0]) === norm(name));
  const official = metadata.urls.find(w => w.filename === recorded?.file);
  if (!official || official.digests.sha256 !== recorded.sha256) throw Error(`Official wheel mismatch: ${name}`);
  const entry = { name: norm(name), version, file: official.filename, sha256: official.digests.sha256, bytes: official.size, url: official.url,
    license: metadata.info.license_expression || metadata.info.license || metadata.info.classifiers.filter(c => c.startsWith('License ::')).join(';'), source: metadata.info.project_url };
  if (entry.license.length > 300) entry.license = metadata.info.classifiers.filter(c => c.startsWith('License ::')).join(';') || 'See included wheel license texts';
  const source = join(old, 'windows/wheels', entry.file); if (hash(source) !== entry.sha256) throw Error('Cached research wheel changed');
  copyFileSync(source, join(cache, entry.file)); wheels.push(entry);
}
const fontUrl = 'https://deb.debian.org/debian/pool/main/f/fonts-wqy-microhei/fonts-wqy-microhei_0.2.0-beta-4_all.deb';
const fontFile = 'fonts-wqy-microhei_0.2.0-beta-4_all.deb';
execFileSync('curl.exe', ['-fsSL', '--retry', '3', fontUrl, '-o', join(cache, fontFile)], { windowsHide: true });
const git = JSON.parse(readFileSync(join(evidence, 'mingit-results.json')));
copyFileSync(join(old, git.asset), join(cache, git.asset));
const licenses = [];
const py = 'https://raw.githubusercontent.com';
const toolList = [['rg','BurntSushi/ripgrep','',['LICENSE-MIT','UNLICENSE']],['fd','sharkdp/fd','v',['LICENSE-MIT','LICENSE-APACHE']],['uv','astral-sh/uv','',['LICENSE-MIT','LICENSE-APACHE']]];
for (const [tool, repo, prefix, names] of toolList) {
  const path = tool === 'uv' ? join(root, 'core/bin/uv.exe') : join(process.env.USERPROFILE, '.pi/agent/bin', `${tool}.exe`);
  const version = /\d+\.\d+\.\d+/.exec(execFileSync(path, ['--version'], {encoding:'utf8',windowsHide:true}))[0];
  for (const name of names) licenses.push({ tool, version, url: `${py}/${repo}/${prefix}${version}/${name}`, file: `${tool}-${version}-${name}.txt` });
}
licenses.push({tool:'Velopack',version:'1.2.161',url:`${py}/velopack/velopack/1.2.161/LICENSE`,file:'Velopack-1.2.161-LICENSE.txt'});
for (const entry of licenses) { execFileSync('curl.exe', ['-fsSL', '--retry','3',entry.url,'-o',join(cache,entry.file)],{windowsHide:true}); entry.sha256=hash(join(cache,entry.file)); }
const lock = { schema: 1, platform:'win32-x64', python:'3.13.18',
  git: { version:'2.56.0.windows.4', file:git.asset, url:git.url, sha256:git.sha256, bytes:git.downloadBytes, license:'GPL-2.0-only and bundled component licenses', source:'https://github.com/git-for-windows/git/tree/v2.56.0.windows.4' },
  font: { name:'WenQuanYi Micro Hei', version:'0.2.0-beta-4', file:fontFile, url:fontUrl, sha256:hash(join(cache,fontFile)), license:'Apache-2.0 OR GPL-3.0-or-later WITH Font-exception-2.0' },
  windows: wheels,
  linux: wheels.filter(w => linuxNames.includes(w.name)),
  linuxReuse: { numpy:linux.baseline.numpy, pandas:linux.baseline.pandas, matplotlib:linux.baseline.matplotlib, openpyxl:linux.baseline.openpyxl, lxml:linux.baseline.lxml, pillow:linux.baseline.pillow },
  baseImage: { sha256:'d29ec8eb1e6ed5cde7ea1c47135d4e1af6a73061acdf747e923329cf7c199e8a',file:'sandbox-base-d29ec8eb.tar.gz', bytes:472724239 }, licenses };
writeFileSync(join(root,'core/bundled-runtime.lock.json'),JSON.stringify(lock,null,2)+'\n');
for (const platform of ['windows','linux']) writeFileSync(join(root,`core/office-${platform}.requirements.txt`), '# Generated from bundled-runtime.lock.json; install with --no-index --require-hashes --no-deps\n'+lock[platform].map(w=>`${w.name}==${w.version} --hash=sha256:${w.sha256}`).join('\n')+'\n');
console.log(JSON.stringify({cache,windows:wheels.length,linux:lock.linux.length,font:lock.font,licenses:licenses.length}));
