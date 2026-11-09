/** No model call; inspect the actual native-app Core path against the owned T82 MCP fixture. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {buildCore} from '../src/app.ts';
import {corePaths} from '../src/paths.ts';
import {Logger} from '../src/log.ts';
import {RecordingNotifier} from '../src/notify.ts';
const root=resolve(process.argv[2]!);assert.ok(root.startsWith(resolve(import.meta.dirname,'../../dist')+'\\'));const evidence=process.argv[3]!;
const result:any={root,modelCalls:0,pass:false};
const core=buildCore({paths:corePaths(join(root,'data')),agentDir:join(root,'agent'),sessionDir:join(root,'sessions'),piMigration:{automatic:false},log:new Logger(),notifier:new RecordingNotifier(),gatewayTransport:()=>{result.modelCalls++;throw Error('T82 free diagnosis forbids all model requests');}});
const client=core.addClient(()=>{});
try{
 await core.start();result.list=await core.call('mcp.list',{});result.test=await core.call('mcp.test',{name:'t82-fixture',cwd:join(root,'case-mcp')});
 await core.call('slot.open',{slotId:'free-probe',cwd:join(root,'case-mcp'),agentMode:'standard'},client);
 await new Promise(r=>setTimeout(r,1500));const slot=core.slot('free-probe');result.info=slot.info();result.tools=slot.session.getAllTools().map(t=>t.name).filter(n=>n.includes('mcp')||n==='tool_search');result.directBusinessPresent=result.tools.includes('mcp__t82_fixture__echo');result.activeBefore=slot.session.getActiveToolNames().filter(n=>n.includes('mcp')||n==='tool_search');slot.session.setActiveToolsByName(['mcp_test','tool_search']);result.activeAfterNarrowing=slot.session.getActiveToolNames();result.pass=result.modelCalls===0;
}catch(error){result.error=String(error);process.exitCode=1;}
finally{await core.shutdown();writeFileSync(evidence,JSON.stringify(result,null,2));console.log(JSON.stringify(result));process.exit(process.exitCode??0);}
