/** Continue only materials checks not completed by t82-materials-qa; no paid models or source mutations. */
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {startTestCore} from '../test/harness.ts';
import {locator} from '../src/modules/library-registry.ts';
import {GitService} from '../src/git/service.ts';
import {hostGitRunner} from '../src/git/process.ts';
import {runWsl} from '../src/sandbox/sandbox.ts';
import {Db} from '../src/db.ts';
import {stageBackup} from '../src/backup/restore.ts';
import {corePaths} from '../src/paths.ts';
const repo=resolve(import.meta.dirname,'../..'),candidate=join(repo,'dist/t82-unpacked/current'),root='E:\\DreamFlutter实测材料\\v0.7',qa=join(repo,'dist/t82-materials-qa');
const index=JSON.parse(readFileSync(join(root,'材料索引.json'),'utf8')),folder=(key:string)=>join(root,index[key]);
const proof:any={at:new Date().toISOString(),paidModelCalls:0,modelPrompts:0,gatewayAttempts:0,tests:[],pass:false};
const save=()=>writeFileSync(join(qa,'finish-results.json'),JSON.stringify(proof,null,2));
const test=(name:string,result:unknown)=>{proof.tests.push({name,result,pass:true});save();console.log(name+' PASS');};
const sha=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const hashes=(path:string):Record<string,string>=>Object.fromEntries(readdirSync(path,{recursive:true,withFileTypes:true}).filter(f=>f.isFile()).map(f=>{const p=join(f.parentPath,f.name);return [p,sha(p)];}));
function copyTree(from:string,to:string){mkdirSync(to,{recursive:true});for(const f of readdirSync(from,{withFileTypes:true})){assert.ok(!f.isSymbolicLink());if(f.isDirectory())copyTree(join(from,f.name),join(to,f.name));else writeFileSync(join(to,f.name),readFileSync(join(from,f.name)));}}
const distro='df-t82-materials-20261109';let active:any;
const opts={gatewayTransport:async()=>{proof.gatewayAttempts++;throw Error('Paid transport prohibited');}};
try{
 active=await startTestCore(join(qa,'api-profile'),opts);
 const skills:any[]=await active.core.call('skills.list',{cwd:active.workspace});
 const skill=skills.find(s=>s.name==='u07-community-demo');assert.ok(skill);
 active.core.library.write('skill',locator(skill.filePath),{trust:'untrusted',enabled:false,butterflyAllowed:false});
 let state:any=await active.core.call('mcp.list',{});const a=state.servers.find((s:any)=>s.name==='v07-readonly-a');assert.ok(a);
 active.core.library.write('mcp',active.core.library.mcpKey({name:a.name,source:a.source}),{trust:'untrusted',enabled:false,butterflyAllowed:false});
 await active.core.shutdown();active=await startTestCore(join(qa,'api-profile'),opts);
 assert.equal(active.core.library.fileAllowed('skill',skill.filePath),false);
 state=await active.core.call('mcp.list',{});const revoked=state.servers.find((s:any)=>s.name===a.name);assert.equal(revoked.trust,'untrusted');assert.equal(revoked.butterflyAllowed,false);
 const memory:any=await active.core.call('memory.list',{});assert.ok(memory.some((m:any)=>m.content.includes('纸鹤79')));
 test('profile-restart-with-canonical-locator',{skillRevoked:true,mcpRevoked:true,memory:'纸鹤79',firstHarnessFailure:'used raw mixed-case skill path; corrected to exported locator()'});
 if(!existsSync(join(qa,'synthetic.dfbackup')))await active.core.call('backup.export',{path:join(qa,'synthetic.dfbackup'),includeKeys:false,includeSandbox:false,includeMaterials:true});
 const wait=async()=>{for(let i=0;i<1000;i++){const j:any=await active.core.call('backup.job',{});if(!j||j.status!=='running')return j;await new Promise(r=>setTimeout(r,20));}throw Error('backup timeout');};
 const job=await wait();if(job)assert.equal(job.status,'done',JSON.stringify(job));test('synthetic-backup-export-inspect',await active.core.call('backup.inspect',{path:join(qa,'synthetic.dfbackup')}));
 // Stage to a new private destination, read restored DB without switching any user application.
 const restoreRoot=join(qa,'restored-profile');mkdirSync(restoreRoot,{recursive:true});
 const staged=await stageBackup(join(qa,'synthetic.dfbackup'),{paths:corePaths(restoreRoot),agentDir:join(restoreRoot,'agent'),sessionsDir:join(restoreRoot,'sessions'),appVersion:'0.7.0-test.3'},{parts:active.core.backupParts});
 const restoredFiles=readdirSync(staged.dir,{recursive:true,withFileTypes:true}).filter(f=>f.isFile()&&f.name==='core.db');assert.equal(restoredFiles.length,1);
 const restored=new Db(join(restoredFiles[0]!.parentPath,'core.db'));
 try{
  assert.ok(restored.all<{content:string}>('SELECT content FROM memory_items').some(m=>m.content.includes('纸鹤79')));
  const entries=restored.all<any>('SELECT * FROM library_entries');assert.ok(entries.some(e=>e.kind==='skill'&&e.locator.includes('u07-community-demo')&&e.trusted===0));assert.ok(entries.some(e=>e.kind==='mcp'&&e.trusted===0&&e.butterfly_allowed===0));
 }finally{restored.close();}
 test('backup-staged-into-new-location',{testMemory:true,revokedPermissionsRemainRevoked:true,keysIncluded:false});
 await active.core.shutdown();active=null;
 const copies=join(qa,'git-copies');assert.ok(!existsSync(copies));mkdirSync(copies);
 const globalAuthor=join(qa,'global-author.gitconfig');writeFileSync(globalAuthor,'[user]\nname = Global User\nemail = global@example.invalid\n');
 // hostGitRunner intentionally scrubs GIT_*; HOME/.gitconfig supplies an actual populated global author.
 const gitHome=join(qa,'git-home');mkdirSync(gitHome);writeFileSync(join(gitHome,'.gitconfig'),readFileSync(globalAuthor));
 const runner=hostGitRunner({bundledPath:join(candidate,'core/bin/git/cmd/git.exe'),env:{...process.env,HOME:gitHome,USERPROFILE:gitHome}}),services:any={};
 for(const [key,name]of [['U07-10','repo-author'],['U07-12','repo-no-author'],['U07-14','repo-conflict']]){
  const src=join(folder(key!),name!),copy=join(copies,name!);copyTree(src,copy);services[name!]=new GitService(copy,runner);
  const s=await services[name!].execute('git_status');assert.equal(s.ok,true);test('git-copy-state-'+name,s);
 }
 const clean=services['repo-author'];let status=await clean.execute('git_status');assert.equal(status.branch,'main');assert.equal(status.dirty,false);
 const history=await clean.execute('git_history',{limit:2});assert.equal(history.commits.length,2);assert.equal(history.commits[0].subject,'v2 add totals');
 assert.equal((await clean.execute('git_branch_create',{name:'u07-test'})).ok,true);assert.equal((await clean.execute('git_switch',{name:'u07-test'})).ok,true);
 const reverted=await clean.execute('git_revert',{commit:history.commits[0].commit});assert.equal(reverted.ok,true,JSON.stringify(reverted));
 const recovered=await clean.execute('git_recover',{id:reverted.recoveryPoint.id});assert.equal(recovered.ok,true);assert.equal(recovered.head,history.commits[0].commit);test('git-branch-revert-recover',{reverted,recovered});
 const missing=services['repo-no-author'];assert.equal((await missing.execute('git_stage',{paths:['notes.txt']})).ok,true);
 const reject=await missing.execute('git_commit',{message:'must not succeed'});assert.equal(reject.ok,false);assert.equal(reject.code,'identity_missing');test('git-empty-local-identity-despite-global',reject);
 const conflict=services['repo-conflict'];status=await conflict.execute('git_status');assert.deepEqual(status.conflicts,['notes.txt']);const original=hashes(join(copies,'repo-conflict'));
 for(const [tool,input]of [['git_switch',{name:'side'}],['git_revert',{commit:'HEAD'}]] as const){const result=await conflict.execute(tool,input);assert.equal(result.ok,false);assert.equal(result.code,'conflict');test('git-block-'+tool,result);}
 assert.deepEqual(hashes(join(copies,'repo-conflict')),original);
 const payload={helper:readFileSync(join(candidate,'core/assets/office/convert_office.py'),'utf8'),document:readFileSync(join(folder('U07-21'),'无Office输入.docx')).toString('base64')};
 const py="import json,sys,tempfile,pathlib,base64,importlib.util\np=json.load(sys.stdin);d=pathlib.Path(tempfile.mkdtemp(prefix='t82-materials-office-'));h=d/'convert_office.py';h.write_text(p['helper']);s=d/'input.docx';s.write_bytes(base64.b64decode(p['document']));sp=importlib.util.spec_from_file_location('office',h);m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m);r=m.convert(s,d/'output.pdf');assert r['code']=='not_available' and r['reason']=='本机没有可用的转换程序' and not (d/'output.pdf').exists(),r;print(json.dumps(r,ensure_ascii=False))";
 const unavailable=await runWsl(['-d',distro,'-u','agent','--exec','python3','-c',py],{input:JSON.stringify(payload),timeoutMs:20000});assert.equal(unavailable.code,0,unavailable.stderr);test('actual-no-office-linux',JSON.parse(unavailable.stdout));
 assert.equal(proof.gatewayAttempts,0);proof.pass=true;
}catch(error){proof.error=String(error);console.error(error);process.exitCode=1;}
finally{if(active)await active.core.shutdown().catch(()=>{});const stop=await runWsl(['--terminate',distro],{timeoutMs:15000});proof.ownedDistro={name:distro,stopped:stop.code===0,registrationAndDiskRetained:true};save();}
