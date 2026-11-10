// Real window RPC + GitService + Git; all data lives in an owned temp repository.
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {startTestCore} from '../../../core/test/harness.ts';
import {startServer} from '../../../core/src/server.ts';
import {fauxAssistantMessage} from '../../../core/node_modules/@earendil-works/pi-ai/dist/index.js';
const t=await startTestCore();
const git=(...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false',...args],{cwd:t.workspace,encoding:'utf8',windowsHide:true}).trim();
git('init','-b','main');git('config','user.name','T90 fixture');git('config','user.email','t90@example.invalid');git('config','core.autocrlf','false');
writeFileSync(join(t.workspace,'report.md'),'# 实验小结\n\n结论待补充。\n');git('add','report.md');git('commit','-m','fixture base');
writeFileSync(join(t.workspace,'report.md'),'# 实验小结\n\n已补充三组实验的对比与下一步验证。\n');
writeFileSync(join(t.workspace,'summary.md'),'# 实验摘要\n\n三组结果总体一致。\n');
writeFileSync(join(t.workspace,'unrelated.txt'),'other staged content\n');git('add','unrelated.txt');
t.core.settings.update({smallTaskModel:'faux/faux-text',approvalMode:'all'});
t.respond(...Array.from({length:20},()=>fauxAssistantMessage('整理实验结论与下一步验证')));
const server=await startServer(t.core,{port:0,token:'t90-local-test'});
t.core.register('test.manual',()=>{t.core.settings.update({smallTaskModel:null});return {ok:true};});
t.core.register('test.change',()=>{writeFileSync(join(t.workspace,'report.md'),'# 后来变化的实验小结\n');return {ok:true};});
t.core.register('test.result',()=>({subject:git('log','-1','--format=%s'),files:git('show','--pretty=','--name-only','HEAD').split('\n'),staged:git('diff','--cached','--name-only'),confirmations:[]}));
let closing=false;
async function close(){if(closing)return;closing=true;await server.close();await t.cleanup();process.exit(0);}
t.core.register('test.shutdown',()=>{setTimeout(()=>void close(),100);return {ok:true};});
process.stdin.resume();process.stdin.on('end',()=>void close());process.on('SIGTERM',()=>void close());
process.stdout.write(JSON.stringify({port:server.port,token:'t90-local-test',workspace:t.workspace,sessions:t.sessionDir})+'\n');
