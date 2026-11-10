// T91: isolated production Core + Pi + SQLite, scripted Faux provider only.
// The sandbox transport is a local fixture; no WSL distribution or user keys.
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {fauxAssistantMessage, fauxToolCall} from '../../../core/node_modules/@earendil-works/pi-ai/dist/index.js';
import {startTestCore} from '../../../core/test/harness.ts';
import {startServer} from '../../../core/src/server.ts';

const t=await startTestCore();
const other=join(t.dir,'other-project'); mkdirSync(other);
mkdirSync(t.core.paths.butterflyDir,{recursive:true});
const git=(...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false',...args],{cwd:t.workspace,encoding:'utf8',windowsHide:true}).trim();
git('init','-b','main'); git('config','user.name','T91 fixture'); git('config','user.email','t91@example.invalid'); git('config','core.autocrlf','false');
writeFileSync(join(t.workspace,'notes.md'),'# 实验记录\n\n三组实验结果一致，第二组需要复测。\n');
writeFileSync(join(t.workspace,'report.md'),'# 实验小结\n\n等待整理。\n');
git('add','.');git('commit','-m','isolated fixture');
t.core.settings.update({approvalMode:'off',smallTaskModel:'faux/faux-text',butterflyStartWaitSeconds:10});
const captured:Record<string,unknown>[]=[];
t.core.register('test.responses',(p)=>{
  const steps=Array.isArray(p.steps)?p.steps:[];
  t.faux.setResponses(steps.map((raw:any)=>async(context:any,options:any)=>{
    captured.push({messages:context.messages,tools:context.tools?.map((tool:any)=>tool.name)});
    if(raw.delayMs)await new Promise<void>((resolve)=>{const timer=setTimeout(resolve,raw.delayMs);options?.signal?.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});
    if(options?.signal?.aborted)return fauxAssistantMessage('',{stopReason:'aborted'});
    if(raw.error)return fauxAssistantMessage('',{stopReason:'error',errorMessage:raw.error});
    return raw.tools?fauxAssistantMessage(raw.tools.map((tool:any)=>fauxToolCall(tool.name,tool.arguments)),{stopReason:'toolUse'}):fauxAssistantMessage(String(raw.text??'收到。'));
  })); return {ok:true};
});
// Open a host fixture session, then mark its role. Only the role/OS transport is
// substituted: prepare/start, task lifecycle, questions and deliveries are real.
t.core.register('test.butterflyRole',(p)=>{const slot=t.core.slot(String(p.slotId));Object.defineProperty(slot,'sandboxed',{value:true,configurable:true});return {ok:true};});
t.core.register('test.deadline',(p)=>{t.core.db.run('UPDATE butterfly_intents SET start_at=? WHERE id=?',Date.now()-1,String(p.id));return t.core.call('butterfly.tick');});
t.core.register('test.inspect',()=>({requests:captured.length,pendingResponses:t.faux.getPendingResponseCount(),notifications:t.messages.filter((m)=>m.event==='notification'),files:{report:readFileSync(join(t.workspace,'report.md'),'utf8')},head:git('log','-1','--format=%s'),staged:git('diff','--cached','--name-only')}));
t.core.register('test.read',(p)=>({exists:existsSync(String(p.path)),content:existsSync(String(p.path))?readFileSync(String(p.path),'utf8'):null}));
const library=join(t.dir,'folder-skill');mkdirSync(library);writeFileSync(join(library,'SKILL.md'),'---\nname: folder-check\ndescription: 核对文件引用\n---\nCheck the supplied text.\n');
const download=createServer((_req,res)=>{res.setHeader('Content-Type','text/markdown');res.end('---\nname: link-check\ndescription: 从链接导入的技能\n---\nCheck the supplied text.\n');});
await new Promise<void>((resolve)=>download.listen(0,'127.0.0.1',resolve));
const link=`http://127.0.0.1:${(download.address() as {port:number}).port}/SKILL.md`;
t.core.register('test.library',async()=>{
  await t.core.call('templates.save',{name:'实验周报',description:'整理每周实验记录',body:'整理 {{主题}} 的实验周报',params:[{name:'主题',default:'本周'}]});
  const script=join(t.dir,'mcp.mjs');writeFileSync(script,`import{createInterface}from'node:readline';const rl=createInterface({input:process.stdin});rl.on('close',()=>process.exit());rl.on('line',l=>{const m=JSON.parse(l);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'read_notes',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:'fixture'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`);
  await t.core.call('mcp.save',{server:{name:'lab-notes',description:'读取实验资料',transport:'stdio',command:process.execPath,args:[script],enabled:true}});
  return {folder:library,url:link};
});
const server=await startServer(t.core,{port:0,token:'t91-isolated'});
let closing=false;
async function close(){if(closing)return;closing=true;download.close();await server.close();await t.cleanup();process.exit(0);}
t.core.register('test.shutdown',()=>{setTimeout(()=>void close(),50);return {ok:true};});
process.stdin.resume();process.stdin.on('end',()=>void close());process.on('SIGTERM',()=>void close());
process.stdout.write(JSON.stringify({port:server.port,token:'t91-isolated',workspace:t.workspace,other,home:t.core.paths.butterflyDir,sessions:t.sessionDir,root:t.dir})+'\n');
