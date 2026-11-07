import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const [mode, configFile, delivery, evidence] = process.argv.slice(2);
const parse = file => { try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return undefined; } };
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(probe, seconds = 90) { const end = Date.now() + seconds * 1000; while (Date.now() < end) { const result = await probe(); if (result) return result; await sleep(150); } throw Error('T69 validation timed out'); }
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const url = path => pathToFileURL(path).href;
function cleanEnv(run, data) {
  const profile = join(run, 'profile'), local = join(profile, 'AppData/Local'), roaming = join(profile, 'AppData/Roaming'), temp = join(run, 'temp');
  for (const dir of [profile, local, roaming, temp]) mkdirSync(dir, { recursive: true });
  const windows = process.env.SystemRoot ?? 'C:\\Windows';
  return { SystemRoot: windows, WINDIR: windows, SystemDrive: windows.slice(0,2), ComSpec: join(windows,'System32/cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PATH: [join(windows,'System32'), join(windows,'System32/WindowsPowerShell/v1.0'),join(windows,'System32/Wbem')].join(';'),
    USERPROFILE: profile, HOME: profile, APPDATA: roaming, LOCALAPPDATA: local, TEMP: temp, TMP: temp,
    DREAMFLUTTER_DATA: data, CI: '1', JITI_FS_CACHE: 'false', PYTHONDONTWRITEBYTECODE: '1' };
}
function workspace(config) {
  const root = resolve(config.temporary);
  assert.ok(root.toLowerCase().startsWith((resolve(tmpdir()) + '\\df-t69-').toLowerCase()));
  assert.ok(existsSync(join(root,'t69-workspace.json'))); return root;
}
function writePdf(path) {
  const stream = 'BT /F1 18 Tf 72 720 Td (T69 PDF text extraction OK) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offsets = [0]; for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(pdf); pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(path,pdf);
}
function rpcClient(WebSocket, info, events) {
  const socket = new WebSocket(`ws://127.0.0.1:${info.port}`, { headers: { Authorization: `Bearer ${info.token}` } }); let id=0; const pending=new Map();
  const ready=new Promise((done,reject)=>{socket.once('open',done);socket.once('error',reject);});
  socket.on('message',bytes=>{const m=JSON.parse(bytes);if(!pending.has(m.id)){events.push(m);return;}const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.done(m.result);});socket.on('error',()=>{});
  return { close:()=>socket.close(), async call(method,params={},seconds=60){await ready;return new Promise((done,reject)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(Error(`RPC timeout: ${method}`));},seconds*1000);pending.set(key,{done,reject,timer});socket.send(JSON.stringify({id:key,method,params}));});} };
}

if (mode === '--features') {
  const config=parse(configFile), root=workspace(config), run=mkdtempSync(join(root,'clean-features-')), data=join(run,'data'), bundle=join(resolve(delivery),'current');
  assert.ok(existsSync(join(bundle,'runtime/node.exe')));mkdirSync(data);mkdirSync(join(run,'workspace'));
  const context={run,data,bundle,delivery:resolve(delivery),workspace:join(run,'workspace'),evidence:resolve(evidence),hold:!process.argv.includes('--no-hold')};writeFileSync(join(run,'context.json'),JSON.stringify(context));
  const env=cleanEnv(run,data), child=spawn(join(bundle,'runtime/node.exe'),['--disable-warning=ExperimentalWarning',resolve(process.argv[1]),'--features-child',join(run,'context.json')],{env,cwd:context.workspace,windowsHide:true,stdio:['ignore','pipe','pipe']});
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{appendFileSync(join(run,'validation.log'),b);process.stdout.write(b);});
  const code=await new Promise(done=>child.once('close',done));process.exitCode=code??1;
} else if (mode === '--features-child') {
  const c=parse(configFile), {run,data,bundle}=c, agent=join(data,'pi'), sessions=join(agent,'sessions'), env=process.env;
  const proof={at:new Date().toISOString(),run,bundle,profile:env.USERPROFILE,path:env.PATH,passed:false,externalModelCalls:0,localModelCalls:0,rows:[]};
  const save=()=>writeFileSync(c.evidence,JSON.stringify(proof,null,2)), row=(operation,detail)=>{proof.rows.push({operation,detail});save();console.log(operation);};
  let api, rpc, window;
  try {
    assert.ok(!/flutter|dotnet|hermes|\\dev\\|node_modules/i.test(env.PATH));
    const where=join(env.SystemRoot,'System32/where.exe');proof.absentHostTools={};
    for(const tool of ['node','python','flutter','dotnet']){try{execFileSync(where,[tool],{env,windowsHide:true,stdio:'pipe'});proof.absentHostTools[tool]=false;}catch{proof.absentHostTools[tool]=true;}}
    assert.ok(Object.values(proof.absentHostTools).every(Boolean));
    mkdirSync(sessions,{recursive:true});mkdirSync(join(data,'window'),{recursive:true});writeFileSync(join(data,'window/prefs.json'),JSON.stringify({'flutter.workspace':c.workspace,'flutter.recentWorkspaces':[c.workspace]}));writeFileSync(join(agent,'settings.json'),'{}');
    const seed=`const {buildCore}=await import(${JSON.stringify(url(join(bundle,'core/src/app.ts')))});const {corePaths}=await import(${JSON.stringify(url(join(bundle,'core/src/paths.ts')))});const {Logger}=await import(${JSON.stringify(url(join(bundle,'core/src/log.ts')))});const {RecordingNotifier}=await import(${JSON.stringify(url(join(bundle,'core/src/notify.ts')))});const core=buildCore({paths:corePaths(${JSON.stringify(data)}),agentDir:${JSON.stringify(agent)},sessionDir:${JSON.stringify(sessions)},piMigration:{automatic:false},log:new Logger(),notifier:new RecordingNotifier()});core.settings.update({autoCheckUpdates:false,memoryPaused:true,autoTitle:false,memoryAutoExtract:false,notifications:false,approvalMode:'off',closeBehavior:'tray'});await core.shutdown();`;
    execFileSync(join(bundle,'runtime/node.exe'),['--disable-warning=ExperimentalWarning','--input-type=module','--eval',seed],{env,windowsHide:true,timeout:30000});
    const {default:WebSocket}=await import(url(join(bundle,'core/node_modules/ws/wrapper.mjs'))); const events=[];
    api=createServer(async(req,res)=>{
      if(req.url==='/article'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end('<html><head><title>T69 local page</title></head><body><p>T69 LOCAL FETCH OK 中文正文</p></body></html>');return;}
      if(req.url!=='/v1/chat/completions'){res.writeHead(404).end();return;}
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));
      const turn=proof.localModelCalls++;assert.ok(turn<4,'unexpected local model retry');assert.ok(body.tools.some(t=>t.function?.name==='pwsh'));assert.ok(body.tools.some(t=>t.function?.name==='show_card'));
      const call=turn===0?{id:'t69-python',type:'function',function:{name:'pwsh',arguments:JSON.stringify({description:'检查本次包内 Python 解释器路径',command:'python -c "import sys; print(\'T69_PYTHON_OK\'); print(sys.executable)"'})}}:turn===1?{id:'t69-card',type:'function',function:{name:'show_card',arguments:JSON.stringify({title:'瘦身包验收卡片',html:'<h1>T69 CARD OK</h1><p>来自隔离假模型的真实卡片工具。</p>'})}}:undefined;
      res.writeHead(200,{'content-type':'text/event-stream'});const base={id:`chat-t69-${turn}`,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'t69-local'};
      res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:call?{role:'assistant',tool_calls:[{index:0,...call}]}:{role:'assistant',content:'T69 CLEAN CONVERSATION OK'},finish_reason:null}]})}\n\n`);
      res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:call?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}})}\n\ndata: [DONE]\n\n`);res.end();save();
    });await new Promise(done=>api.listen(0,'127.0.0.1',done));
    window=spawn(join(c.delivery,'DreamFlutter.exe'),[],{env,cwd:c.delivery,detached:true,stdio:'ignore',windowsHide:true});window.unref();
    const info=await until(()=>{const i=parse(join(data,'core.json'));return i&&alive(i.pid)?i:undefined;},150);proof.corePid=info.pid;
    rpc=rpcClient(WebSocket,info,events);const hello=await rpc.call('core.hello');row('portable-window-started-its-bundled-node-with-no-host-tools',{version:hello.version,pid:info.pid,absentHostTools:proof.absentHostTools});
    const channel=await rpc.call('gateway.saveChannel',{name:'T69 本地假模型',api:'openai-completions',baseUrl:`http://127.0.0.1:${api.address().port}/v1`,models:[{id:'t69-local',name:'T69 local',contextWindow:32000,maxTokens:1024,reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],keys:[{secret:'T69_SYNTHETIC_LOCAL_ONLY_KEY'}]});
    await rpc.call('settings.update',{defaultModel:`df-${channel.id}/t69-local`,approvalMode:'off'});
    await rpc.call('slot.open',{slotId:'t69-clean',cwd:c.workspace});await rpc.call('slot.send',{slotId:'t69-clean',record:{id:'t69-prompt',type:'prompt',message:'T69 sequence: execute the provided Python tool, show the card, then reply OK.'}});
    await until(()=>events.some(e=>e.event==='slot.record'&&e.slotId==='t69-clean'&&e.record?.type==='agent_end'),120);
    const transcript=JSON.stringify(events);proof.toolResults=events.filter(e=>e.event==='slot.record'&&e.slotId==='t69-clean'&&e.record?.type==='tool_execution_end').map(e=>({name:e.record.toolName,isError:e.record.isError,result:e.record.result}));save();
    const python=proof.toolResults.find(t=>t.name==='pwsh');assert.ok(python);assert.equal(python.isError,false,'The actual Python tool result must succeed');const pythonText=python.result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');assert.match(pythonText,/T69_PYTHON_OK/);assert.match(pythonText,/core[\\/]+python/);assert.match(transcript,/T69 CLEAN CONVERSATION OK/);assert.equal(proof.localModelCalls,3);
    row('clean-conversation-and-bundled-python-tool-passed',{localModelCalls:proof.localModelCalls,remoteCalls:0});
    const fetched=await rpc.call('webSearch.fetch',{url:`http://127.0.0.1:${api.address().port}/article`});assert.match(JSON.stringify(fetched),/T69 LOCAL FETCH OK/);row('local-web-fetch-without-DeepSeek-key-passed',{backend:'local'});
    const pdf=join(c.workspace,'t69.pdf');writePdf(pdf);const converted=await rpc.call('files.convert',{path:pdf});assert.match(converted.text,/T69 PDF text extraction OK/);assert.equal(converted.parts,1);row('packaged-PDF-text-extraction-passed',{parts:converted.parts,text:converted.text});
    const cards=await rpc.call('cards.list',{cwd:c.workspace});const card=cards.find(card=>card.title==='瘦身包验收卡片');assert.ok(card);const opened=await rpc.call('cards.open',{id:card.id,theme:{},sizing:'content'});const shell=await(await fetch(opened.url)).text();const frame=/<iframe id="card" sandbox="allow-scripts" src="([^"]+)"/.exec(shell)?.[1];assert.ok(frame);const html=await(await fetch(new URL(frame,opened.url))).text();assert.match(html,/T69 CARD OK/);assert.match(html,/showcard reference injection layer/);row('real-card-tool-and-rendering-HTTP-passed',{cardId:card.id,url:opened.url});
    const set=await rpc.call('cards.request',{id:card.id,capability:'state.set',payload:{key:'t69',value:'state-ok'}});assert.ok(JSON.stringify(set).includes('ok'));const get=await rpc.call('cards.request',{id:card.id,capability:'state.get',payload:{key:'t69'}});assert.match(JSON.stringify(get),/state-ok/);row('card-state-roundtrip-passed',{cardId:card.id});
    const licenses=await rpc.call('updates.licenses');assert.ok(licenses.generated);assert.equal(licenses.entries.length,JSON.parse(readFileSync(join(bundle,'licenses/third-party.json'),'utf8')).entries.length);const diag=await rpc.call('updates.diagnostics');assert.ok(statSync(diag.path).size>0);const {readZip}=await import(url(join(bundle,'core/src/cards/zip.ts')));const entries=readZip(readFileSync(diag.path));assert.ok(entries.some(e=>e.name==='summary.json'));assert.ok(!entries.some(e=>e.data.toString('utf8').includes('T69_SYNTHETIC_LOCAL_ONLY_KEY')));row('licenses-and-redacted-diagnostics-passed',{licenseEntries:licenses.entries.length,diagnosticEntries:entries.length});
    proof.sessionFile=(await rpc.call('slot.list')).find(s=>s.slotId==='t69-clean')?.sessionFile;
    proof.passed=true;proof.state='ready-for-ui';save();console.log(`READY_FOR_UI ${run}`);
    if(c.hold)await until(()=>existsSync(join(run,'release-ui.txt')),900);
  }catch(error){proof.error=error.message.slice(0,800);save();console.error(proof.error);process.exitCode=1;}
  finally{rpc?.close();if(api?.listening){api.closeAllConnections();await new Promise(done=>api.close(done));}try{const helper=join(bundle,'app/dreamflutter_update.exe');for(const pid of execFileSync(helper,['processes',c.delivery],{env,windowsHide:true,encoding:'utf8'}).trim().split(/\s+/).filter(p=>p&&Number(p)!==process.pid))execFileSync(helper,['stop',c.delivery,pid],{env,windowsHide:true});}catch{}proof.cleanedProcesses=!alive(proof.corePid);proof.state=proof.passed?'complete':'failed';save();}
} else if (mode === '--sandbox') {
  const config=parse(configFile),root=workspace(config),run=mkdtempSync(join(root,'clean-sandbox-')),bundle=resolve(delivery),context={run,bundle,evidence:resolve(evidence)};
  writeFileSync(join(run,'context.json'),JSON.stringify(context));const child=spawn(join(bundle,'runtime/node.exe'),['--disable-warning=ExperimentalWarning',resolve(process.argv[1]),'--sandbox-child',join(run,'context.json')],{env:cleanEnv(run,join(run,'data')),cwd:run,windowsHide:true,stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{appendFileSync(join(run,'validation.log'),b);process.stdout.write(b);});process.exitCode=await new Promise(done=>child.once('close',done))??1;
} else if (mode === '--sandbox-child') {
  const c=parse(configFile),{run,bundle}=c,proof={at:new Date().toISOString(),run,bundle,passed:false,externalModelCalls:0,rows:[]};const save=()=>writeFileSync(c.evidence,JSON.stringify(proof,null,2));
  const {buildCore}=await import(url(join(bundle,'core/src/app.ts'))),{corePaths}=await import(url(join(bundle,'core/src/paths.ts'))),{Logger}=await import(url(join(bundle,'core/src/log.ts'))),{RecordingNotifier}=await import(url(join(bundle,'core/src/notify.ts'))),{runWsl,Sandbox}=await import(url(join(bundle,'core/src/sandbox/sandbox.ts')));
  const before=(await runWsl(['--list','--quiet'])).stdout.replaceAll('\0','').trim().split(/\r?\n/).filter(Boolean).sort(),nonce=randomUUID().slice(0,8),distro=`df-t69-clean-${nonce}`,table=`df_t69_${nonce}`,uid=70000+Number.parseInt(nonce.slice(0,3),16);assert.ok(!before.includes(distro));
  proof.distro=distro;proof.existingDistrosBefore=before;proof.isolatedFirewall={table,uid,changesOnlyTestFixture:true};let adjusted=false;
  const wsl=async(args,options={})=>{for(const flag of ['-d','--distribution','--terminate','--unregister','--import']){const i=args.indexOf(flag);if(i>=0)assert.equal(args[i+1],distro);}assert.ok(!args.includes('--shutdown'));
    if(options.input){let input=String(options.input).replaceAll('23456',String(uid)).replaceAll('dreamflutter',table);if(!adjusted&&args.includes('root')&&input.includes('CHECK_OK')){input=`usermod -u ${uid} agent\nchown -R agent:agent /workspace /home/agent\n`+input;adjusted=true;}options={...options,input};}
    proof.rows.push({args,script:options.input?'isolated fixture uid/table only':undefined});save();return runWsl(args,options);};
  const image=join(bundle,'core/sandbox-image/dreamflutter-sandbox.tar.gz');assert.ok(existsSync(image));globalThis.fetch=async()=>{throw Error('No network fetch is permitted during offline bundled provisioning');};
  const core=buildCore({paths:corePaths(join(run,'data')),agentDir:join(run,'agent'),sessionDir:join(run,'sessions'),log:new Logger(),notifier:new RecordingNotifier(),piMigration:{automatic:false},sandbox:{distro,dir:join(run,'sandbox'),image,wsl}});core.settings.update({autoCheckUpdates:false,memoryPaused:true,autoTitle:false,sandboxOnline:false});
  try{await core.start();const sandbox=core.module(Sandbox);assert.equal(sandbox.distro,distro);assert.ok(resolve(sandbox.dir).startsWith(resolve(run)+'\\'));await core.call('sandbox.provision');
    const status=await until(async()=>{const s=await core.call('sandbox.status');if(s.state==='error')throw Error(s.error);return s.state==='ready'?s:undefined;},600);assert.equal(status.mirror,'随应用附带');assert.equal(status.online,false);
    const items=(await core.call('sandbox.selfTest')).items;assert.ok(items.length>=10);assert.ok(items.every(i=>i.passed),JSON.stringify(items));proof.selfTests=items;
    const tools=await wsl(['-d',distro,'-u','agent','--cd','/workspace','--','sh','-c',`python3 -c 'import numpy,pandas,matplotlib,openpyxl; print("T69_OFFLINE_PYTHON_OK")'; rg --version | head -1; fd --version`]);proof.tools=tools;assert.match(tools.stdout,/T69_OFFLINE_PYTHON_OK/);assert.match(tools.stdout,/ripgrep/);assert.match(tools.stdout,/(?:fd|fdfind) /);
    const offline=await wsl(['-d',distro,'-u','agent','--','sh','-c','curl --noproxy "*" -s -m 3 -o /dev/null -w "%{http_code}" http://8.8.8.8/ || true']);assert.equal(offline.stdout.trim(),'000');proof.offline=offline;
    proof.diskBytes={running:statSync(join(run,'sandbox/disk/ext4.vhdx')).size,resetTemplate:statSync(join(run,'sandbox/clean.vhdx')).size};proof.passed=true;console.log('OFFLINE BUNDLED SANDBOX PASSED');
  }catch(error){proof.error=error.message;process.exitCode=1;console.error(error.message);}
  finally{try{await wsl(['-d',distro,'-u','root','--','sh','-c',`nft delete table inet ${table} 2>/dev/null || true`]);}catch{}await core.call('sandbox.remove').catch(error=>{proof.cleanupError=error.message;process.exitCode=1;});await core.shutdown();const after=(await runWsl(['--list','--quiet'])).stdout.replaceAll('\0','').trim().split(/\r?\n/).filter(Boolean).sort();proof.existingDistrosAfter=after;proof.cleanedDistro=!after.includes(distro);proof.cleanedDirectory=!existsSync(join(run,'sandbox'));try{assert.deepEqual(after,before);}catch{proof.otherDistroListChanged=true;process.exitCode=1;}save();}
} else throw Error('usage: t69-validation.mjs --features|--sandbox <workspace.json> <portable-dir|payload-dir> <evidence.json>');
