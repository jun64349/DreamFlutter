// Real Core/WebSocket/Pi/SQLite, with the existing deterministic model only.
// Test data is isolated; no production handler is replaced.
import {startTestCore} from '../../../core/test/harness.ts';
import {startServer} from '../../../core/src/server.ts';
import {MemoryModule} from '../../../core/src/modules/memory.ts';
import {fauxAssistantMessage} from '../../../core/node_modules/@earendil-works/pi-ai/dist/index.js';

const t = await startTestCore();
const server = await startServer(t.core, {port:0, token:'t10-local-test'});
t.core.register('test.respond', p => {
  if (p.toolSearch) t.respond({...fauxAssistantMessage(''), content:[{type:'toolCall',id:'t11-side-tool',name:'tool_search',arguments:{query:'memory'}}],stopReason:'toolUse'});
  t.respond(fauxAssistantMessage(String(p.text ?? '收到。')));
  return {ok:true};
});
t.core.register('test.seed', async p => {
  const m = t.core.module(MemoryModule)!;
  const saved:any = await t.core.call('memory.save', {content:'项目约定：用中文说明验证结果', scope:'workspace', cwd:t.workspace});
  const path = t.core.slot(String(p.slotId)).session.sessionFile!;
  const source = m.store.commit({actor:'user', ops:[{kind:'add', item:{content:'来源记忆：测试清单包含通过和失败', scope:'workspace', workspaceId:saved.item.workspaceId, kind:'agreement', level:2, confidence:'user_explicit'}, sources:[{kind:'session',ref:path,excerpt:'测试清单包含通过和失败'}]}]});
  const promotion = m.store.commit({actor:'main_agent', explicit:true, ops:[{kind:'edit',id:saved.item.id,patch:{scope:'global',workspaceId:null}}]});
  for(let i=0;i<52;i++) await t.core.call('memory.save',{content:`日志测试条目 ${i}：只用于分页验证`,scope:'workspace',cwd:t.workspace});
  return {sourceId:source.applied[0]!.itemId, sourcePath:path, pendingId:promotion.pending[0]!.pendingId};
});
let closing = false;
async function close() {
  if(closing) return;
  closing = true;
  await server.close();
  await t.cleanup();
  process.exit(0);
}
t.core.register('test.shutdown', () => {setTimeout(()=>void close(),100);return {ok:true};});
process.stdin.resume();
process.stdin.on('end',()=>void close());
process.on('SIGTERM',()=>void close());
process.stdout.write(JSON.stringify({port:server.port,token:'t10-local-test',workspace:t.workspace,sessions:t.sessionDir})+'\n');
