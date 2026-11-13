/** T82 materials-only QA. No model prompts, real channels, user profiles, source Git mutations or global WSL commands. */
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {startTestCore} from '../test/harness.ts';
import {GitService} from '../src/git/service.ts';
import {hostGitRunner} from '../src/git/process.ts';
import {runWsl} from '../src/sandbox/sandbox.ts';
import {corePaths} from '../src/paths.ts';
import {Db} from '../src/db.ts';
import {locator} from '../src/modules/library-registry.ts';

const repo=resolve(import.meta.dirname,'../..'),candidate=join(repo,'dist/t82-unpacked/current');
const root='E:\\DreamFlutter实测材料\\v0.7',qa=join(repo,'dist/t82-materials-qa');
const index=JSON.parse(readFileSync(join(root,'材料索引.json'),'utf8'));
const folder=(key:string)=>join(root,index[key]);
function copyTree(from:string,to:string){mkdirSync(to,{recursive:true});for(const f of readdirSync(from,{withFileTypes:true})){assert.ok(!f.isSymbolicLink());if(f.isDirectory())copyTree(join(from,f.name),join(to,f.name));else writeFileSync(join(to,f.name),readFileSync(join(from,f.name)));}}
const proof:any={at:new Date().toISOString(),candidate:'0.7.0-test.3',paidModelCalls:0,modelPrompts:0,gatewayAttempts:0,tests:[],pass:false};
const save=()=>writeFileSync(join(qa,'api-results.json'),JSON.stringify(proof,null,2));
const test=(name:string,result:unknown)=>{proof.tests.push({name,result,pass:true});save();console.log(name+' PASS');};
const sha=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const hashes=(path:string):Record<string,string>=>Object.fromEntries(readdirSync(path,{recursive:true,withFileTypes:true}).filter(f=>f.isFile()).map(f=>{const p=join(f.parentPath,f.name);return [p,sha(p)];}));
const skillsCopy=join(qa,'skills-inputs');mkdirSync(skillsCopy,{recursive:true});
for(const [key,name]of [['U07-05','u07-community-demo'],['U07-06','u07-script-demo'],['U07-06','u07-script-failure']])copyTree(join(folder(key!),name!),join(skillsCopy,name!));
const before=hashes(skillsCopy);
const coreRoot=join(qa,'api-profile');assert.ok(!existsSync(coreRoot));
const t=await startTestCore(coreRoot,{gatewayTransport:()=>{proof.gatewayAttempts++;throw Error('Paid transport prohibited in materials QA');}});
const {core}=t;
const distro='df-t82-materials-20261109';
try{
  core.sandboxProvider=()=>({distro,ready:async()=>{},online:()=>false});
  const imported:any[]=[];
  for(const name of ['u07-community-demo','u07-script-demo','u07-script-failure']){
    const info:any=await core.call('skills.import',{folder:join(skillsCopy,name)});
    assert.equal(info.trust,'untrusted');assert.equal(info.enabled,false);
    assert.equal(core.library.fileAllowed('skill',info.filePath),false);
    const result:any=await core.call('skills.test',{filePath:info.filePath});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.scriptTrial.status,'not-run');
    assert.equal(core.library.fileAllowed('skill',info.filePath),false);
    imported.push(info);test('import-static-untrusted-'+name,{trust:info.trust,enabled:info.enabled,static:result});
  }
  assert.deepEqual(hashes(skillsCopy),before);
  const trialSuccess:any=await core.call('skills.scriptTrial',{filePath:imported[1].filePath,script:'scripts/demo.py'});
  assert.equal(trialSuccess.ok,true,JSON.stringify(trialSuccess));assert.equal(trialSuccess.exitCode,0);assert.match(trialSuccess.stdout,/U07_SCRIPT_OK/);
  assert.equal(JSON.parse(trialSuccess.artifacts.find((a:any)=>a.path==='demo-result.json').textPreview).total,79);
  test('real-sandbox-script-success',trialSuccess);
  const trialFailure:any=await core.call('skills.scriptTrial',{filePath:imported[2].filePath,script:'scripts/demo.py'});
  assert.equal(trialFailure.ok,false);assert.equal(trialFailure.exitCode,7);assert.match(trialFailure.stderr,/U07_INTENTIONAL_FAILURE/);test('real-sandbox-script-intentional-failure',trialFailure);
  for(const info of imported)assert.equal(core.library.fileAllowed('skill',info.filePath),false);
  const proposals:any=await core.call('proposals.list',{});
  const community=proposals.find((p:any)=>p.payload.name==='u07-community-demo');assert.ok(community);
  await core.call('proposals.accept',{id:community.id});assert.equal(core.library.fileAllowed('skill',imported[0].filePath),true);
  test('skill-operator-confirm',{name:imported[0].name,allowed:true});
  const configs=JSON.parse(readFileSync(join(folder('U07-07'),'MCP配置示例.json'),'utf8'));
  for(const name of ['v07-readonly-a','v07-readonly-b']){
    const registered:any=await core.call('mcp.register',{server:configs[name],cwd:t.workspace});
    const pending:any[]=await core.call('proposals.list',{}) as any[];
    const p=pending.find((p:any)=>p.kind==='mcp'&&p.payload.name===name);assert.ok(p,JSON.stringify(registered));
    assert.ok(!(await core.call('mcp.list',{}) as any).servers.some((s:any)=>s.name===name));
    await core.call('proposals.accept',{id:p.id});
    const result:any=await core.call('mcp.test',{name,cwd:t.workspace});
    assert.equal(result.ok,true,JSON.stringify(result));assert.ok(JSON.stringify(result).includes('read_sample'));test('actual-core-mcp-connect-'+name,result);
    const config=configs[name];
    const lines=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'T82 materials',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'read_sample',arguments:{}}}];
    const direct=spawnSync(config.command,config.args,{input:lines.map(q=>JSON.stringify(q)).join('\n')+'\n',encoding:'utf8',timeout:8000,windowsHide:true});
    assert.equal(direct.status,0,direct.stderr);
    const results=direct.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));
    const actual=JSON.parse(results.find((r:any)=>r.id===3).result.content[0].text);
    assert.equal(actual.total,79);assert.equal(actual.service,name.endsWith('a')?'A':'B');test('stdio-read-only-call-'+name,actual);
  }
  const list:any=await core.call('mcp.list',{});const a=list.servers.find((s:any)=>s.name==='v07-readonly-a'),b=list.servers.find((s:any)=>s.name==='v07-readonly-b');
  assert.equal(a.butterflyAllowed,false);assert.equal(b.butterflyAllowed,false);
  await core.call('mcp.setButterflyAllowed',{name:a.name,source:a.source,cwd:t.workspace,allowed:true});
  let state:any=await core.call('mcp.list',{});assert.equal(state.servers.find((s:any)=>s.name===a.name).butterflyAllowed,true);assert.equal(state.servers.find((s:any)=>s.name===b.name).butterflyAllowed,false);
  await core.call('mcp.setButterflyAllowed',{name:a.name,source:a.source,cwd:t.workspace,allowed:false});
  test('mcp-A-B-per-service-authorization',{defaultDenied:true,grantADoesNotGrantB:true,revokeA:true});
  for(const [name,args,command]of [['v07-bad-protocol',[configs[a.name].args[0],'A','--bad-protocol'],configs[a.name].command],['v07-missing-command',[],join(root,'不存在的程序.exe')]] as const){
    await core.call('mcp.save',{server:{...configs[a.name],name,command,args}});
    const result:any=await core.call('mcp.test',{name,cwd:t.workspace});assert.equal(result.ok,false);test('mcp-negative-'+name,result);
  }
  // Revocation is an explicit operator action in this owned fixture profile, no model involved.
  core.library.write('skill',locator(imported[0].filePath),{trust:'untrusted',enabled:false,butterflyAllowed:false});
  core.library.write('mcp',core.library.mcpKey({name:a.name,source:a.source}),{trust:'untrusted',enabled:false,butterflyAllowed:false});
  await core.call('memory.save',{content:'我的测试项目代号是纸鹤79。',kind:'background'});
  for(const target of ['\\\\df-v07.invalid\\share\\database-test','\\\\?\\UNC\\df-v07.invalid\\share\\database-test']){
    const previous=await core.call('storage.locations',{});
    await assert.rejects(core.call('storage.move',{kind:'database',target}),/网络|network|UNC/i);
    assert.deepEqual(await core.call('storage.locations',{}),previous);assert.ok(!core.maintenance);
  }
  test('invalid-network-database-paths',{paths:2,locationsUnchanged:true,restartScheduled:false});
  await core.shutdown();
  // Reopen same owned profile to validate persisted revocation/memory.
  const restarted=await startTestCore(coreRoot,{gatewayTransport:()=>{throw Error('Paid transport prohibited');}});
  try{
    assert.equal(restarted.core.library.fileAllowed('skill',imported[0].filePath),false);
    state=await restarted.core.call('mcp.list',{});const revoked=state.servers.find((s:any)=>s.name===a.name);assert.equal(revoked.trust,'untrusted');assert.equal(revoked.butterflyAllowed,false);
    const memory:any=await restarted.core.call('memory.list',{});assert.ok(memory.some((m:any)=>m.content.includes('纸鹤79')));
    test('isolated-profile-restart',{skillRevoked:true,mcpRevoked:true,memory:'纸鹤79'});
    const exported:any=await restarted.core.call('backup.export',{path:join(qa,'synthetic.dfbackup'),includeKeys:false,includeSandbox:false,includeMaterials:true});
    const wait=async()=>{for(let i=0;i<500;i++){const j:any=await restarted.core.call('backup.job',{});if(j.status!=='running')return j;await new Promise(r=>setTimeout(r,20));}throw Error('backup timeout');};
    const job=await wait();assert.equal(job.status,'done',JSON.stringify({exported,job}));
    const preview=await restarted.core.call('backup.inspect',{path:join(qa,'synthetic.dfbackup')});
    test('synthetic-backup-export-inspect',preview);
  }finally{await restarted.core.shutdown();}
  // Run Git service on copies, including identity despite a populated global identity.
  const hostileGlobal=join(qa,'global-author.gitconfig');writeFileSync(hostileGlobal,'[user]\nname = Global User\nemail = global@example.invalid\n');
  const runner=hostGitRunner({bundledPath:join(candidate,'core/bin/git/cmd/git.exe'),env:{...process.env,HOME:qa,USERPROFILE:qa}});
  const gitCopies=join(qa,'git-copies');mkdirSync(gitCopies);
  const services:any={};
  for(const [key,name]of [['U07-10','repo-author'],['U07-12','repo-no-author'],['U07-14','repo-conflict']]){
    const src=join(folder(key!),name!),copy=join(gitCopies,name!);copyTree(src,copy);services[name!]=new GitService(copy,runner);
    const s=await services[name!].execute('git_status');assert.equal(s.ok,true);test('git-original-copy-state-'+name,s);
  }
  const clean=services['repo-author'];let status=await clean.execute('git_status');assert.equal(status.branch,'main');assert.equal(status.dirty,false);
  const history=await clean.execute('git_history',{limit:2});assert.equal(history.commits.length,2);assert.equal(history.commits[0].subject,'v2 add totals');
  assert.equal((await clean.execute('git_branch_create',{name:'u07-test'})).ok,true);
  assert.equal((await clean.execute('git_switch',{name:'u07-test'})).ok,true);
  const reverted=await clean.execute('git_revert',{commit:history.commits[0].commit});assert.equal(reverted.ok,true,JSON.stringify(reverted));
  const recovered=await clean.execute('git_recover',{id:reverted.recoveryPoint.id});assert.equal(recovered.ok,true);assert.equal(recovered.head,history.commits[0].commit);test('git-branch-revert-recover',{reverted,recovered});
  const missing=services['repo-no-author'];assert.equal((await missing.execute('git_stage',{paths:['notes.txt']})).ok,true);
  const reject=await missing.execute('git_commit',{message:'must not succeed'});assert.equal(reject.ok,false);assert.equal(reject.code,'identity_missing');test('git-empty-local-identity',reject);
  const conflict=services['repo-conflict'];status=await conflict.execute('git_status');assert.deepEqual(status.conflicts,['notes.txt']);const conflictBefore=hashes(join(gitCopies,'repo-conflict'));
  for(const [tool,input]of [['git_switch',{name:'side'}],['git_revert',{commit:'HEAD'}]] as const){const result=await conflict.execute(tool,input);assert.equal(result.ok,false);assert.equal(result.code,'conflict');test('git-block-'+tool,result);}
  assert.deepEqual(hashes(join(gitCopies,'repo-conflict')),conflictBefore);
  // Real no-Office Linux environment: transfer trusted candidate conversion helper and synthetic DOCX through stdin.
  const payload={helper:readFileSync(join(candidate,'core/assets/office/convert_office.py'),'utf8'),document:readFileSync(join(folder('U07-21'),'无Office输入.docx')).toString('base64')};
  const py="import json,sys,tempfile,pathlib,base64,importlib.util\np=json.load(sys.stdin);d=pathlib.Path(tempfile.mkdtemp(prefix='t82-materials-office-'));h=d/'convert_office.py';h.write_text(p['helper']);s=d/'input.docx';s.write_bytes(base64.b64decode(p['document']));sp=importlib.util.spec_from_file_location('office',h);m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m);r=m.convert(s,d/'output.pdf');assert r['code']=='not_available' and r['reason']=='本机没有可用的转换程序' and not (d/'output.pdf').exists(),r;print(json.dumps(r,ensure_ascii=False))";
  const unavailable=await runWsl(['-d',distro,'-u','agent','--exec','python3','-c',py],{input:JSON.stringify(payload),timeoutMs:20000});
  assert.equal(unavailable.code,0,unavailable.stderr);test('actual-no-office-linux',JSON.parse(unavailable.stdout));
  assert.deepEqual(hashes(skillsCopy),before);assert.equal(proof.gatewayAttempts,0);proof.pass=true;
}catch(error){proof.error=String(error);console.error(error);process.exitCode=1;}
finally{await core.shutdown().catch(()=>{});const stopped=await runWsl(['--terminate',distro],{timeoutMs:15000});proof.ownedDistro={name:distro,stopped:stopped.code===0,registrationAndDiskRetained:true};save();}
