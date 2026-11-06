// T-11 isolated real Core + real DeepSeek. Only test inspection/fixtures are added.
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,appendFileSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {ModelRuntime} from '../../../core/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import {buildCore} from '../../../core/src/app.ts';
import {corePaths} from '../../../core/src/paths.ts';
import {Logger} from '../../../core/src/log.ts';
import {RecordingNotifier} from '../../../core/src/notify.ts';
import {configurePiNetworking} from '../../../core/src/pi/http.ts';
import {startServer} from '../../../core/src/server.ts';
import {MemoryModule} from '../../../core/src/modules/memory.ts';

const evidence=resolve('../Claude Codex Bridge/T-11-evidence');
mkdirSync(evidence,{recursive:true});
const dir=process.argv[2]??mkdtempSync(join(tmpdir(),'df-t11-live-'));
const stamp=`live-${Date.now()}`;
const paths=corePaths(join(dir,'data'));
const copied=JSON.parse(execFileSync(process.execPath,['--disable-warning=ExperimentalWarning',resolve('../core/scripts/copy-channels.ts'),'E:/DreamFlutter测试版/data',paths.dataDir],{encoding:'utf8'}));
const channel=copied.find((c:any)=>c.models.includes('deepseek-v4.1-flash'));
if(!channel)throw new Error('Configured DeepSeek required; no fallback model');
const model=`df-${channel.channel}/deepseek-v4.1-flash`;
const agentDir=join(dir,'agent');mkdirSync(agentDir,{recursive:true});
const workspace=join(dir,'workspace');mkdirSync(workspace,{recursive:true});
const runtime=await ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:null,refreshOnCreate:false});
const log=new Logger(paths.logFile,false);
await configurePiNetworking(agentDir,log);
const core=buildCore({paths,agentDir,sessionDir:join(dir,'sessions'),log,notifier:new RecordingNotifier(),modelRuntime:()=>runtime});
const row=core.db.get<any>('SELECT models FROM gateway_channels WHERE id=?',channel.channel)!;
const models=JSON.parse(row.models).filter((m:any)=>m.id==='deepseek-v4.1-flash');
models[0].contextWindow=48000;models[0].maxTokens=4096;
core.db.run('UPDATE gateway_channels SET models=? WHERE id=?',JSON.stringify(models),channel.channel);
core.settings.update({defaultModel:model,auxModel:model,memoryModel:model,defaultThinking:'low',autoTitle:false,memoryAutoExtract:false,autoCompaction:false,backgroundCompaction:'off',memoryDailyBudgetUsd:.10,dailyBudgetUsd:.30,approvalMode:'ask'});
let label='setup',reserved=0;
const calls:any[]=[];
const prior=readdirSync(evidence).filter(f=>/^live-.*-calls.json$/.test(f)).reduce((n,f)=>n+JSON.parse(readFileSync(join(evidence,f),'utf8')).reduce((s:number,c:any)=>s+(c.usage?.cost?.total??0),0),0);
const save=()=>writeFileSync(join(evidence,`${stamp}-calls.json`),JSON.stringify(calls,null,2));
const emit=(type:string,data:any)=>appendFileSync(join(evidence,`${stamp}.jsonl`),JSON.stringify({at:new Date().toISOString(),type,...data})+'\n');
const original=runtime.streamSimple.bind(runtime);
runtime.streamSimple=((m:any,context:any,options:any={})=>{
 const spent=prior+calls.reduce((s,c)=>s+(c.usage?.cost?.total??0),0);
 const reserve=Buffer.byteLength(JSON.stringify(context))*.15/1e6+4096*.6/1e6;
 if(spent+reserved+reserve>.375||calls.length>=120)throw new Error('T11_BUDGET_STOP');
 reserved+=reserve;
 const c:any={id:calls.length+1,label,at:Date.now(),model:`${m.provider}/${m.id}`,messages:context.messages,systemPrompt:context.systemPrompt,tools:context.tools?.map((t:any)=>t.name)};
 calls.push(c);save();
 const stream=original(m,context,{...options,maxTokens:Math.min(options.maxTokens??4096,4096)});
 void stream.result().then((answer:any)=>{reserved-=reserve;Object.assign(c,{usage:structuredClone(answer.usage),answer:answer.content,stop:answer.stopReason,error:answer.errorMessage,ms:Date.now()-c.at});save();emit('response',c);},(e:any)=>{reserved-=reserve;c.error=String(e);save();});
 return stream;
}) as typeof runtime.streamSimple;
await core.start();
const memory=core.module(MemoryModule)!;
function inspect(){return {items:memory.store.list({statuses:['active','forgotten','refuted','review','ended']}),jobs:core.db.all('SELECT * FROM memory_jobs'),deferred:core.db.all('SELECT * FROM memory_deferred_extractions'),tasks:core.db.all('SELECT * FROM memory_task_views'),snapshots:core.db.all('SELECT * FROM memory_snapshots'),compactions:core.db.all('SELECT * FROM context_compactions'),runs:core.db.all('SELECT id,session_id,kind,cost FROM runs'),gateway:core.db.all('SELECT * FROM gateway_requests'),calls:calls.map(({id,label,usage,ms,tools,stop,error})=>({id,label,usage,ms,tools,stop,error})),spentUsd:prior+calls.reduce((s,c)=>s+(c.usage?.cost?.total??0),0)};}
core.register('test.label',p=>{label=String(p.label);return {ok:true};});
core.register('test.inspect',()=>inspect());
core.register('test.storageFaultObserved',()=>({observed:calls.some(c=>c.messages?.some((m:any)=>m.role==='toolResult'&&JSON.stringify(m.content).includes('T11 synthetic storage failure')))}));
core.register('test.materials',()=>({materials:core.db.all('SELECT * FROM memory_materials'),calibration:core.db.all("SELECT * FROM app_flags WHERE key LIKE 'memory_token_scale:%'")}));
core.register('test.queueMaterials',()=>{memory.work.queueMaterials(['global']);return {ok:true};});
core.register('test.evidence',p=>{emit('check',p);return {ok:true};});
core.register('test.failSave',p=>{
 const db=core.db.raw;
 if(p.on){db.exec("CREATE TRIGGER t11_fail_save BEFORE INSERT ON memory_items BEGIN SELECT RAISE(ABORT,'T11 synthetic storage failure'); END");}
 else db.exec('DROP TRIGGER IF EXISTS t11_fail_save');
 return {ok:true};
});
const server=await startServer(core,{port:0,token:'t11-isolated-test'});
let closing=false;
async function close(){if(closing)return;closing=true;try{await server.close();await core.shutdown();}finally{save();emit('closed',{dir});process.exit(0);}}
core.register('test.shutdown',()=>{writeFileSync(join(evidence,`${stamp}-final.json`),JSON.stringify(inspect(),null,2));setTimeout(()=>void close(),100);return {ok:true};});
process.stdin.resume();process.stdin.on('end',()=>void close());process.on('SIGTERM',()=>void close());
emit('setup',{dir,model,price:models[0].cost,priorUsd:prior});
process.stdout.write(JSON.stringify({port:server.port,token:'t11-isolated-test',workspace,sessions:join(dir,'sessions'),model,dir,stamp})+'\n');
