/** Build time only. Downloads are explicit; packaging calls --offline and never falls back to a network install. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, copyFileSync, cpSync, rmSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
export const repository = resolve(import.meta.dirname, '..');
export const lockPath = join(repository, 'core/bundled-runtime.lock.json');
export const lock = JSON.parse(readFileSync(lockPath));
export const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export function run(exe, args, options = {}) { return execFileSync(exe, args, { encoding:'utf8', windowsHide:true, maxBuffer:16e6, ...options }); }
export function verify(file, entry) { if (!existsSync(file) || sha256(file) !== entry.sha256) throw Error(`Pinned SHA-256 mismatch or missing file: ${entry.file}`); }
export function assets() { return [...new Map([lock.git, lock.font, ...lock.windows, ...lock.linux, ...lock.licenses].map(e=>[e.file,e])).values()]; }
export function cachedAssets(cache, offline) {
  mkdirSync(cache,{recursive:true});
  for (const entry of assets()) {
    const file=join(cache,entry.file);
    if (existsSync(file)) { verify(file,entry); continue; } // Corruption is never silently replaced.
    if (offline) throw Error(`Offline build cache is missing ${entry.file}; run prepare-bundled-runtime.mjs --download --cache <dir> first.`);
    run('curl.exe',['--fail','--location','--silent','--show-error','--retry','3',entry.url,'--output',file]); verify(file,entry);
  }
}
export function treeFiles(root) {
  const result=[];
  const walk=dir=>{for(const item of readdirSync(dir,{withFileTypes:true})){const file=join(dir,item.name);if(lstatSync(file).isSymbolicLink())throw Error(`Unexpected link: ${file}`);if(item.isDirectory())walk(file);else result.push({path:relative(root,file).replaceAll('\\','/'),bytes:lstatSync(file).size,sha256:sha256(file)});}};
  walk(root); return result.sort((a,b)=>a.path.localeCompare(b.path));
}
export function installWindows(target, cache) {
  target=resolve(target); if(!existsSync(join(target,'core/package.json')))throw Error('Target is not a prepared DreamFlutter payload');
  const scratch=mkdtempSync(join(tmpdir(),'df-t75-prepare-'));
  try {
    const git=join(target,'core/bin/git'), unpack=join(scratch,'git'); mkdirSync(unpack);
    run(join(process.env.SystemRoot??'C:\\Windows','System32/tar.exe'),['-xf',join(cache,lock.git.file),'-C',unpack]);
    if(!existsSync(join(unpack,'cmd/git.exe'))||!existsSync(join(unpack,'LICENSE.txt')))throw Error('MinGit layout/license is missing');
    // Delete only the exact module we own, after resolving its parent and rejecting links.
    if(dirname(git)!==resolve(target,'core/bin')||realpathSync(dirname(git)).toLowerCase()!==resolve(realpathSync(target),'core/bin').toLowerCase()||existsSync(git)&&lstatSync(git).isSymbolicLink())throw Error('Unsafe Git destination');
    rmSync(git,{recursive:true,force:true});cpSync(unpack,git,{recursive:true});
    const gitVersion=run(join(git,'cmd/git.exe'),['--version']).trim(); if(gitVersion!==`git version ${lock.git.version}`)throw Error('MinGit version mismatch');
    const pythonRoot=join(target,'core/python');
    const installs=readdirSync(pythonRoot,{withFileTypes:true}).filter(d=>d.isDirectory()&&!d.isSymbolicLink()&&d.name.startsWith('cpython-')).map(d=>d.name).sort().reverse();
    const python=join(pythonRoot,installs[0]??'missing','python.exe');
    if(!run(python,['--version']).includes(lock.python))throw Error('Portable Python version differs from pinned wheels');
    const purelib=run(python,['-I','-B','-c',"import sysconfig;print(sysconfig.get_paths()['purelib'])"]).trim();
    // Reinstall from verified wheels even if metadata versions match: local edits must not enter a formal package.
    console.log(run(python,['-I','-B','-m','pip','--isolated','install','--disable-pip-version-check','--no-index','--no-deps','--no-compile','--require-hashes','--target',purelib,'--upgrade','--find-links',cache,'-r',join(repository,'core/office-windows.requirements.txt')]));
    const font=join(scratch,'font');mkdirSync(font);
    const tar=join(process.env.SystemRoot??'C:\\Windows','System32/tar.exe');
    run(tar,['-xf',join(cache,lock.font.file),'-C',font]);
    const data=readdirSync(font).find(n=>n.startsWith('data.tar.'));if(!data)throw Error('Font .deb payload missing');run(tar,['-xf',join(font,data),'-C',font]);
    const mpl=join(dirname(python),'Lib/site-packages/matplotlib/mpl-data');
    copyFileSync(join(font,'usr/share/fonts/truetype/wqy/wqy-microhei.ttc'),join(mpl,'fonts/ttf/wqy-microhei.ttc'));
    copyFileSync(join(font,'usr/share/doc/fonts-wqy-microhei/copyright'),join(mpl,'fonts/ttf/wqy-microhei-COPYRIGHT.txt'));
    const apache=lock.licenses.find(e=>e.file.endsWith('LICENSE-APACHE.txt'));copyFileSync(join(cache,apache.file),join(mpl,'fonts/ttf/wqy-microhei-Apache-2.0.txt'));
    const rc=join(mpl,'matplotlibrc');
    const original=readFileSync(rc,'utf8').replace(/\n#{1,2} DreamFlutter bundled Chinese font[\s\S]*$/, '');
    // Matplotlib reads its template once with single-# defaults uncommented, then as normal config.
    // Change those defaults in place, avoiding duplicate keys and malformed single-# prose.
    writeFileSync(rc,original.replace(/^#font\.sans-serif:.*$/m,'#font.sans-serif: WenQuanYi Micro Hei, DejaVu Sans').replace(/^#axes\.unicode_minus:.*$/m,'#axes.unicode_minus: False')+'\n## DreamFlutter bundled Chinese font\n');
    const actual=JSON.parse(run(python,['-I','-B','-c',"import importlib.metadata as m,json;print(json.dumps({d.metadata['Name'].lower().replace('_','-'):d.version for d in m.distributions()}))"]));
    for(const entry of lock.windows)if(actual[entry.name]!==entry.version)throw Error(`Python distribution mismatch: ${entry.name}`);
    const bytes=dir=>readdirSync(dir,{withFileTypes:true}).reduce((sum,item)=>{const path=join(dir,item.name);if(lstatSync(path).isSymbolicLink())throw Error('Unexpected runtime link');return sum+(item.isDirectory()?bytes(path):lstatSync(path).size);},0);
    const manifest={schema:1,lockSha256:sha256(lockPath),gitVersion,gitFiles:treeFiles(git),python:relative(target,python),pythonBytes:bytes(dirname(python)),pythonDistributions:actual,fontSha256:sha256(join(mpl,'fonts/ttf/wqy-microhei.ttc'))};
    manifest.gitBytes=manifest.gitFiles.reduce((sum,file)=>sum+file.bytes,0);manifest.pythonAddedBytes=manifest.pythonBytes-62780059;
    if(manifest.gitBytes>96237338*1.2||manifest.pythonAddedBytes>150231893*1.2)throw Error('T75 PAUSE: formal MinGit/Python growth exceeds R3/R4 by more than 20%; report before continuing');
    writeFileSync(join(target,'core/bundled-runtime.json'),JSON.stringify(manifest,null,2)+'\n');
    for(const name of ['bundled-runtime.lock.json','office-windows.requirements.txt','office-linux.requirements.txt'])if(resolve(target)!==repository)copyFileSync(join(repository,'core',name),join(target,'core',name));
    console.log(JSON.stringify({target,gitVersion,gitBytes:manifest.gitFiles.reduce((s,f)=>s+f.bytes,0),pythonDistributions:lock.windows.length}));
    return {python,manifest};
  } finally { if(dirname(scratch)!==resolve(tmpdir())||!scratch.includes('df-t75-prepare-'))throw Error('Unsafe scratch cleanup');rmSync(scratch,{recursive:true,force:true}); }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2), option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
  const cache=resolve(option('--cache',process.env.DREAMFLUTTER_BUNDLE_CACHE??join(repository,'core/bin/.bundle-cache')));
  if(!args.includes('--offline')&&!args.includes('--download'))throw Error('Choose --download for preparation or --offline for packaging');
  cachedAssets(cache,args.includes('--offline'));
  if(args.includes('--verify-image')){
    const image=join(repository,'core/sandbox-image/dreamflutter-sandbox.tar.gz');
    const info=JSON.parse(readFileSync(join(dirname(image),'dreamflutter-sandbox.json')));
    if(info.officeLayer?.lockSha256!==sha256(lockPath)||sha256(image)!==info.sha256)throw Error('Bundled sandbox office layer is missing or does not match the pinned lock/image hash');
  }
  if(!args.includes('--download-only')&&!args.includes('--verify-only'))installWindows(option('--target',repository),cache);
}
