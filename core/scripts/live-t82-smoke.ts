/** One bounded functional smoke per v0.7 feature. No routing dataset, retries or product writes. */
import assert from 'node:assert/strict';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
const [sourceArg,evidenceArg,resumeArg]=process.argv.slice(2),repo=resolve(import.meta.dirname,'../..');
assert.ok(sourceArg&&evidenceArg);const source=resolve(sourceArg),evidence=resolve(evidenceArg);
assert.ok(!existsSync(evidence),'No silent repetition of a paid smoke');
const gates=JSON.parse(readFileSync(join(repo,'Claude Codex Bridge/T82-gates.json'),'utf8').replace(/^\uFEFF/,''));
assert.equal(gates.length,8);assert.ok(gates.every((g:any)=>g.status==='passed'));
const {buildCore}=await import('../src/app.ts'),{Db}=await import('../src/db.ts'),{corePaths,defaultAgentDir}=await import('../src/paths.ts');
const {streamSimple}=await import('@earendil-works/pi-ai/compat');
const {SecretStore,secretFileOf,relocateSecretRef}=await import('../src/modules/secrets.ts');
const {Logger}=await import('../src/log.ts'),{RecordingNotifier}=await import('../src/notify.ts');
const {ALLOW,APPROVAL_TITLE}=await import('../src/pi/dialogs.ts'),{textOf}=await import('../src/runs.ts');
const {runWsl}=await import('../src/sandbox/sandbox.ts'),{bundledImage}=await import('../src/sandbox/image.ts');
const {findGit}=await import('../src/git/process.ts'),{bundledPython,toolchainEnv}=await import('../src/agent/toolchain.ts');
const {redactValue}=await import('../src/security/redaction.ts');
const root=resumeArg?resolve(resumeArg):mkdtempSync(join(repo,'dist/t82-smoke-')),data=join(root,'data'),agent=join(root,'agent');
if(resumeArg){assert.equal(dirname(root),join(repo,'dist'));assert.match(basename(root),/^t82-smoke-/);}else{mkdirSync(data);mkdirSync(agent);}
const sha=(path:string)=>existsSync(path)?createHash('sha256').update(readFileSync(path)).digest('hex'):null;
const protectedFiles=()=>Object.fromEntries(['models.json','auth.json','settings.json'].map(f=>[f,sha(join(defaultAgentDir(source),f))]));const before=protectedFiles();
const read=new DatabaseSync(corePaths(source).dbFile,{readOnly:true});
type Row=Record<string,string|number|null>;
const channel=read.prepare("SELECT * FROM gateway_channels WHERE platform='opencode-go' AND enabled=1 ORDER BY sort,created_at LIMIT 1").get() as Row;assert.ok(channel);
const key=read.prepare('SELECT * FROM gateway_keys WHERE channel_id=? AND enabled=1 ORDER BY sort,created_at LIMIT 1').get(channel.id) as Row;read.close();assert.ok(key);
const modelId='mimo-v2.6-flash',model=JSON.parse(String(channel.models)).find((m:any)=>m.id===modelId);assert.ok(model);channel.models=JSON.stringify([{...model,maxTokens:8192}]);
if(!resumeArg){
const oldSecrets=new SecretStore(source),secrets=new SecretStore(data),secretFile=secretFileOf(String(key.secret));assert.ok(secretFile);assert.equal(resolve(secretFile).toLowerCase(),resolve(join(oldSecrets.dir,basename(secretFile))).toLowerCase());mkdirSync(secrets.dir,{recursive:true});copyFileSync(secretFile,join(secrets.dir,basename(secretFile)));key.secret=relocateSecretRef(String(key.secret),secrets.dir);
const db=new Db(corePaths(data).dbFile);for(const [table,row] of [['gateway_channels',channel],['gateway_keys',key]] as const){const cols=Object.keys(row);db.raw.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>row[c]!));}db.close();
}
const proof:any={at:new Date().toISOString(),task:'T82 necessary functional smoke',root,model:modelId,sourceReadOnly:true,sourceConfigHashesBefore:before,newChannels:0,budgetUsd:.50,sourceSmokeCeilingUsd:.45,cleanDialogueReserveUsd:.05,physicalRequests:0,requestLimit:80,attempts:[],routingDatasetRead:false,automaticRetries:0,pass:false};
if(resumeArg){const previous=JSON.parse(readFileSync(join(repo,'Claude Codex Bridge/T82-live-smoke-final.json'),'utf8'));assert.equal(previous.root,root);assert.ok(previous.skillPassed&&!previous.mcpPassed);Object.assign(proof,previous,{pass:false,resumedAt:new Date().toISOString(),resumedFrom:'T82-live-smoke-final.json',harnessVisibilityIssue:previous.error});delete proof.error;}
let phaseStart=0;const cost=()=>Number(core.db.get<{n:number}>('SELECT COALESCE(SUM(cost),0) n FROM gateway_requests')?.n??0);
const save=()=>{proof.costUsd=cost();writeFileSync(evidence,JSON.stringify(redactValue(proof),null,2));};
const core=buildCore({paths:corePaths(data),agentDir:agent,sessionDir:join(root,'sessions'),piMigration:{automatic:false},log:new Logger(),notifier:new RecordingNotifier(),gatewayTransport:(m,context,options)=>{
 const reserve=Buffer.byteLength(JSON.stringify(context),'utf8')/3*Math.max(m.cost.input,.15)/1e6+8192*Math.max(m.cost.output,.6)/1e6;
 if(proof.physicalRequests>=80||proof.physicalRequests-phaseStart>=24||cost()+reserve>.45)throw Error('T82_MODEL_BUDGET_STOP');proof.physicalRequests++;save();
 return streamSimple(m,context,{...options,maxRetries:0,maxTokens:8192,signal:AbortSignal.any([...(options?.signal?[options.signal]:[]),AbortSignal.timeout(90_000)])});
}});
core.settings.update({defaultModel:`df-${channel.id}/${modelId}`,auxModel:`df-${channel.id}/${modelId}`,fallbackModels:[],defaultThinking:'off',autoTitle:false,autoCheckUpdates:false,memoryEnabled:false,memoryAutoExtract:false,memoryPaused:true,autoCompaction:false,backgroundCompaction:'off',approvalMode:'changes',maxTurnsPerRun:24,dailyBudgetUsd:.45});
const records=new Map<string,any[]>();let approvals=0;
const client=core.addClient(event=>{if(event.event!=='slot.record')return;const id=String(event.slotId),r=event.record as any;records.set(id,[...(records.get(id)??[]),r]);if(r.type==='extension_ui_request'&&r.method==='select'&&String(r.title).includes(APPROVAL_TITLE)){approvals++;void core.call('slot.send',{slotId:id,record:{type:'extension_ui_response',id:r.id,value:ALLOW}},client);}});
const baseTools=['skill','read','glob','write','edit','pwsh','show_card','skill_register','skill_test','skill_script_trial','mcp_register','mcp_test','tool_search'];
async function open(id:string,cwd:string,sessionFile?:string){await core.call('slot.open',{slotId:id,cwd,sessionFile,agentMode:'standard'},client);if(id!=='mcp')activate(id);}
function activate(id:string,extra:string[]=[]){const session=core.slot(id).session,known=new Set(session.getAllTools().map(t=>t.name));session.setActiveToolsByName([...baseTools,...extra].filter(n=>known.has(n)));}
async function prompt(id:string,message:string,label:string){
 const start=(records.get(id)??[]).length,previous=(records.get(id)??[]).filter(r=>r.type==='agent_settled').length;
 const row:any={label,started:new Date().toISOString(),pass:false};proof.attempts.push(row);save();
 await core.call('slot.send',{slotId:id,record:{type:'prompt',message}},client);const deadline=Date.now()+360_000;
 while((records.get(id)??[]).filter(r=>r.type==='agent_settled').length===previous){if(Date.now()>deadline){await core.slot(id).session.abort();throw Error(`Timeout ${label}; no retry`);}await new Promise(r=>setTimeout(r,100));}
 const events=(records.get(id)??[]).slice(start),inputs=new Map(events.filter(r=>r.type==='tool_execution_start').map(r=>[r.toolCallId,r.args]));row.calls=events.filter(r=>r.type==='tool_execution_end').map(r=>({name:r.toolName,args:inputs.get(r.toolCallId),isError:r.isError,result:r.result}));
 const last=core.slot(id).session.messages.filter(m=>m.role==='assistant').at(-1);row.answer=textOf(last?.content??'');row.stopReason=last?.role==='assistant'?last.stopReason:undefined;row.finished=new Date().toISOString();save();
 assert.equal(row.stopReason,'stop',`${label}: ${last?.role==='assistant'?last.errorMessage??row.stopReason:'no assistant'}`);assert.ok(!row.calls.some((c:any)=>c.isError),`${label}: tool failure`);row.pass=true;save();console.log(JSON.stringify({label,requests:proof.physicalRequests,costUsd:cost()}));return row;
}
const loaded=(row:any,name:string)=>row.calls.some((c:any)=>c.name==='skill'&&c.result?.details?.name===name&&!c.isError);
const make=(name:string)=>{const path=join(root,`case-${name}`);mkdirSync(path);return path;};
const distro=`df-t82-smoke-${randomUUID().slice(0,10)}`;let imported=false;
try{
 await core.start();save();
 if(!resumeArg){
 // A new owned distro only; never use/shutdown/move the user's existing default sandbox.
 const disk=join(root,'trial-distro');mkdirSync(disk);const image=bundledImage();assert.ok(image);const importedResult=await runWsl(['--import',distro,disk,image,'--version','2'],{timeoutMs:120_000});assert.equal(importedResult.code,0,importedResult.stderr);imported=true;proof.trialDistro=distro;
 core.sandboxProvider=()=>({distro,ready:async()=>{},online:()=>false});
 const skillCwd=make('skill');copyFileSync(join(repo,'docs/research/v0.7-r1-skills-mcp.md'),join(skillCwd,'community-research.md'));
 phaseStart=proof.physicalRequests;await open('skill',skillCwd);
 const created=await prompt('skill','使用 $skill-builder，为本次隔离验收做一个独特的术语检查技能 t82-terms；先读取已提供的 community-research.md 比较成熟方案（这是既有核实调研，不冒称新联网搜索），我已明确选择自建。SKILL.md 不超过30行；scripts/check.py 用Python标准库读取第一个参数的JSON {"text":"含旧词","forbidden":["旧词"]}，写 terms-result.json={"hits":["旧词"]}。skill_register 的content填完整SKILL.md，files填源码字符串，sourceKind=agent，不需要write中转。对返回proposalId做skill_test及一次skill_script_trial（同上述样例）。禁止本机执行，保持待确认，完成后简短报告。','skill-create');
 assert.ok(loaded(created,'skill-builder'));for(const name of ['skill_register','skill_test'])assert.ok(created.calls.some((c:any)=>c.name===name));const proposal=(await core.call('proposals.list',{}) as any[]).find(p=>p.kind==='skill'&&p.payload.name==='t82-terms');assert.ok(proposal);assert.equal(proposal.status,'pending');assert.ok(!existsSync(join(agent,'skills/t82-terms/SKILL.md')));
 const trial=created.calls.find((c:any)=>c.name==='skill_script_trial');assert.ok(trial);const tested=JSON.parse(textOf(trial.result.content));assert.ok(tested.ok);assert.deepEqual(JSON.parse(tested.artifacts.find((a:any)=>a.path==='terms-result.json').textPreview).hits,['旧词']);
 await core.call('proposals.accept',{id:proposal.id});await core.slot('skill').handle({type:'df_reload',id:'t82-skill-reload'},client.id);activate('skill');
 const used=await prompt('skill','验收操作者已在管理端确认。请使用 $t82-terms，只实际加载技能，不再执行脚本，简短报告。','skill-confirmed');assert.ok(loaded(used,'t82-terms'));proof.skillPassed=true;await core.closeSlot('skill');save();
 const mcpCwd=make('mcp'),fixture=join(mcpCwd,'fixture.mjs');copyFileSync(join(repo,'docs/research/v0.7-r1-skills-mcp.md'),join(mcpCwd,'community-research.md'));
 copyFileSync(join(repo,'core/scripts/t82-mcp-fixture.mjs'),fixture);
 writeFileSync(join(mcpCwd,'mcp-fixture.md'),`# Owned T82 fixture, not a public Registry entry\nOfficial lifecycle: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle\nCompare community-research.md, then register this agent-owned local test service, protocol 2025-11-25:\n${JSON.stringify({name:'t82-fixture',transport:'stdio',command:process.execPath,args:[fixture],exposure:'direct'})}\nOnly echo returns T82_MCP_READONLY_OK. Keep butterfly authorization off.\n`);
 phaseStart=proof.physicalRequests;await open('mcp',mcpCwd);
 const registered=await prompt('mcp','使用 $mcp-builder，接入 mcp-fixture.md 描述的自有本地测试服务 t82-fixture。先读取该文件和community-research.md的官方协议/Registry说明，不谎称已发布Registry。用mcp_register，sourceKind=agent，保持待确认；不自己信任/启用/提前连接，简短报告。','mcp-register');assert.ok(loaded(registered,'mcp-builder'));
 const mp=(await core.call('proposals.list',{}) as any[]).find(p=>p.kind==='mcp'&&p.payload.name==='t82-fixture');assert.ok(mp);assert.equal((await core.call('mcp.list',{}) as any).servers.length,0);await core.call('proposals.accept',{id:mp.id});await core.slot('mcp').handle({type:'df_reload',id:'t82-mcp-reload'},client.id);
 }else{
  phaseStart=proof.physicalRequests;const cwd=join(root,'case-mcp'),sessionFile=readdirSync(join(root,'sessions')).filter(n=>n.endsWith('.jsonl')).map(n=>join(root,'sessions',n)).find(file=>JSON.parse(readFileSync(file,'utf8').split('\n')[0]).cwd===cwd);assert.ok(sessionFile);await open('mcp',cwd,sessionFile);
 }
 const discoveryDeadline=Date.now()+10_000;while(!core.slot('mcp').session.getAllTools().some(t=>t.name==='mcp__t82_fixture__echo')){assert.ok(Date.now()<discoveryDeadline,'MCP discovery did not finish; no model call issued');await new Promise(r=>setTimeout(r,50));}
 const message=resumeArg?'继续同一次接入流程：此前连接测试已经真实通过。验收操作者已纠正工具可见列表，当前默认会话确有mcp__t82_fixture__echo。只实际调用这个只读echo一次，不再登记、mcp_test或搜索。核对T82_MCP_READONLY_OK，简短报告连接、业务、信任、启用四状态；蝶君授权保持关闭。':'验收操作者已确认并重新加载。先实际mcp_test t82-fixture，再直接实际调用已有mcp__t82_fixture__echo。核对T82_MCP_READONLY_OK，分别报告连接、业务、信任、启用；蝶君授权保持关闭。';
 const connected=await prompt('mcp',message,resumeArg?'mcp-business-completion':'mcp-business');const testedMcp=[...proof.attempts].flatMap((a:any)=>a.calls??[]).find((c:any)=>c.name==='mcp_test');assert.ok(testedMcp);assert.ok(JSON.parse(textOf(testedMcp.result.content)).ok);assert.ok(connected.calls.some((c:any)=>c.name==='mcp__t82_fixture__echo'&&textOf(c.result.content).includes('T82_MCP_READONLY_OK')));proof.mcpPassed=true;await core.closeSlot('mcp');save();
 const gitCwd=make('git'),git=await findGit();assert.ok(git);const native=(...args:string[])=>spawnSync(git,args,{cwd:gitCwd,encoding:'utf8',windowsHide:true});assert.equal(native('init','-b','main').status,0);native('config','user.name','T82 synthetic fixture');native('config','user.email','t82@example.invalid');writeFileSync(join(gitCwd,'sample.txt'),'base\n');native('add','sample.txt');assert.equal(native('-c','commit.gpgSign=false','commit','-m','synthetic baseline').status,0);writeFileSync(join(gitCwd,'sample.txt'),'T82 changed\n');
 phaseStart=proof.physicalRequests;await open('git',gitCwd);activate('git',['git_status','git_diff','git_history']);const inspected=await prompt('git','这是一次Git只读功能冒烟。只用git_status、git_diff、git_history检查当前隔离仓库，核对sample.txt的T82 changed改动和已有历史。不要暂存、提交、切换、推送或使用shell。简短报告。','git-inspect');for(const name of ['git_status','git_diff','git_history'])assert.ok(inspected.calls.some((c:any)=>c.name===name));assert.ok(inspected.calls.every((c:any)=>c.name.startsWith('git_')));proof.gitPassed=true;await core.closeSlot('git');save();
 const officeCwd=make('office');writeFileSync(join(officeCwd,'清单.csv'),'编号,类别,数量\n001,海风,2\n002,山林,4\n003,海风,3\n','utf8');
 phaseStart=proof.physicalRequests;await open('office',officeCwd);const office=await prompt('office','使用 $data-analysis、$office-xlsx、$office-docx，读取清单.csv，做一次小样办公交付：编号保留前导零，按类别静态汇总海风5、山林4。生成result.xlsx（明细和汇总）、中文标题/类别标签的chart.png、嵌入同一张图和汇总表的report.docx。用已有pwsh调用随包python，可把全部操作写在一个短脚本后一次运行。核对后简短报告，不安装库、不做公式重算、不做PDF。','office-delivery');for(const name of ['data-analysis','office-xlsx','office-docx'])assert.ok(loaded(office,name));
 const python=bundledPython();assert.ok(python);const checked=spawnSync(python,['-I','-B',join(repo,'scripts/t82-verify-office.py'),officeCwd],{encoding:'utf8',windowsHide:true});assert.equal(checked.status,0,checked.stdout+checked.stderr);proof.office=JSON.parse(checked.stdout);proof.officePassed=true;await core.closeSlot('office');save();
 const showCwd=make('showcard');writeFileSync(join(showCwd,'本周记录.md'),'# 合成验收周报材料\n周期：2026-11-02至2026-11-08。完成2项受控验证，另1项联调仍待确认，不是生产成绩。风险：依赖排期未定。下周先确认联调窗口。负责人和日期均待确认。\n');
 phaseStart=proof.physicalRequests;await open('showcard',showCwd);const report=await prompt('showcard',`使用 $showcard-pro，由本周记录.md直接做一份可展示周报，标题“联合验收周报”，输出report.html和摘要卡。用技能已随包的离线renderer，Node绝对路径为${process.execPath}；用pwsh按PowerShell引号规则调用，禁止联网和安装依赖。生成后读摘要全文立即show_card，再核对完整文件，简短结束。保留2项完成、1项待确认，不能把待验写成已完成，不反复重做摘要。`,'showcard-delivery');assert.ok(loaded(report,'showcard-pro'));assert.ok(report.calls.some((c:any)=>c.name==='show_card'&&!c.isError));const html=readFileSync(join(showCwd,'report.html'),'utf8');assert.ok(html.includes('联合验收周报')&&html.includes('待确认'));assert.ok(!/(?:src|href)=["'](?:https?:|\/\/)/i.test(html));proof.showcardPassed=true;proof.showcard={path:join(showCwd,'report.html'),bytes:Buffer.byteLength(html)};await core.closeSlot('showcard');
 proof.pass=['skillPassed','mcpPassed','gitPassed','officePassed','showcardPassed'].every(k=>proof[k]);assert.ok(proof.pass);assert.deepEqual(protectedFiles(),before);assert.equal(core.db.get<{n:number}>('SELECT COUNT(*) n FROM gateway_channels')?.n,1);
}catch(error){proof.error=error instanceof Error?error.stack??error.message:String(error);process.exitCode=1;}
finally{proof.approvals=approvals;proof.requests=core.db.all('SELECT ok,model,input,output,cost,error_kind FROM gateway_requests ORDER BY id');save();await core.shutdown();if(imported){proof.ownedDistroStop=await runWsl(['--terminate',distro],{timeoutMs:20_000});}proof.sourceConfigUnchanged=JSON.stringify(protectedFiles())===JSON.stringify(before);writeFileSync(evidence,JSON.stringify(redactValue(proof),null,2));process.stdout.write(JSON.stringify({pass:proof.pass,requests:proof.physicalRequests,costUsd:proof.costUsd,error:proof.error,evidence})+'\n',()=>process.exit(process.exitCode??0));}
