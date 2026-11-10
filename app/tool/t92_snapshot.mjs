// Snapshot current source without copying build caches or traversing junctions.
import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join,dirname,relative} from 'node:path';
import {createHash} from 'node:crypto';
const repo=resolve(process.cwd()),target=resolve(repo,'app/build/t92_work/current');
if(target!==resolve('E:/claude/DreamFlutter/app/build/t92_work/current'))throw Error('Unexpected task root');
const files=execFileSync('rg',['--files','--hidden','app','packages','core','runtime'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/);
const manifest=[];
for(const file of files){
  const source=resolve(repo,file),destination=resolve(target,file);
  if(relative(target,destination).startsWith('..'))throw Error('Snapshot path escaped');
  mkdirSync(dirname(destination),{recursive:true});copyFileSync(source,destination);
  manifest.push({path:file,sha256:createHash('sha256').update(readFileSync(source)).digest('hex')});
}
writeFileSync(join(repo,'app/build/t92-source-manifest.json'),JSON.stringify({at:new Date().toISOString(),files:manifest},null,2));
process.stdout.write(`copied ${files.length} source files\n`);
