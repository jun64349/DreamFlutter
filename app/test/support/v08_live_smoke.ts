// v0.8 closing: a real-model walk through the workbench flows the new UI relies on (Claude, 2026-11-10).
// Isolated Core in a temp dir; the channel is copied from the user's test install (never created here);
// real DeepSeek V4.1 Flash; a hard budget stop. Run from app/:  node test/support/v08_live_smoke.ts
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {ModelRuntime} from '../../../core/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import {buildCore} from '../../../core/src/app.ts';
import {corePaths} from '../../../core/src/paths.ts';
import {Logger} from '../../../core/src/log.ts';
import {RecordingNotifier} from '../../../core/src/notify.ts';
import {configurePiNetworking} from '../../../core/src/pi/http.ts';

const dir = mkdtempSync(join(tmpdir(), 'df-v08-live-'));
const results: {flow: string; ok: boolean; note: string}[] = [];
let spent = 0;
const check = (flow: string, ok: boolean, note: string) => { results.push({flow, ok, note}); console.log(`${ok ? 'PASS' : 'FAIL'} ${flow}: ${note}`); };
try {
  const paths = corePaths(join(dir, 'data'));
  const copied = JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', resolve('../core/scripts/copy-channels.ts'), 'E:/DreamFlutter测试版/data', paths.dataDir], {encoding: 'utf8'}));
  const channel = copied.find((c: any) => c.models.includes('deepseek-v4.1-flash'));
  if (!channel) throw new Error('No configured DeepSeek channel in the test install');
  const model = `df-${channel.channel}/deepseek-v4.1-flash`;
  const agentDir = join(dir, 'agent'); mkdirSync(agentDir, {recursive: true});
  const workspace = join(dir, 'workspace'); mkdirSync(workspace, {recursive: true});
  writeFileSync(join(workspace, 'notes.md'), '待核对\n第二行保持不变\n');
  const runtime = await ModelRuntime.create({authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false});
  const log = new Logger(paths.logFile, false);
  await configurePiNetworking(agentDir, log);
  const original = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = ((m: any, context: any, options: any = {}) => {
    if (spent > 0.2) throw new Error('V08_BUDGET_STOP');
    const stream = original(m, context, {...options, maxTokens: Math.min(options.maxTokens ?? 2048, 2048)});
    void stream.result().then((a: any) => { spent += a.usage?.cost?.total ?? 0; }, () => {});
    return stream;
  }) as typeof runtime.streamSimple;
  const core = buildCore({paths, agentDir, sessionDir: join(dir, 'sessions'), log, notifier: new RecordingNotifier(), modelRuntime: () => runtime});
  core.settings.update({defaultModel: model, smallTaskModel: model, largeTaskModel: model, defaultThinking: 'low', autoTitle: false, memoryAutoExtract: false, autoCompaction: false, backgroundCompaction: 'off', approvalMode: 'changes', autoCheckUpdates: false} as any);
  await core.start();
  const messages: any[] = [];
  const client = core.addClient((m: any) => messages.push(m));
  const wait = async (probe: () => any, ms = 90_000) => { const end = Date.now() + ms; for (;;) { const v = probe(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 200)); } };
  const finished = () => messages.filter(m => m.event === 'run.finished').length;
  const prompt = async (text: string, during?: () => Promise<void>) => {
    const n = finished();
    await core.call('slot.send', {slotId: 'w', record: {id: String(Math.random()), type: 'prompt', message: text}}, client);
    if (during) await during();
    await wait(() => finished() > n);
  };
  const lastReply = () => { const msgs = core.slot('w').session.messages as any[]; const a = [...msgs].reverse().find(m => m.role === 'assistant'); return (a?.content ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('') + (a?.errorMessage ? ` [error ${a.errorMessage}]` : ''); };
  await core.call('slot.open', {slotId: 'w', cwd: workspace}, client);

  // 4.3 / 4.5: a plain reply comes back.
  await prompt('用一句话说说你能帮我做什么。');
  check('4.3 对话回复', lastReply().trim().length > 0, lastReply().slice(0, 60));

  // 4.4: a file change waits in 等你处理 (now group) and goes ahead when allowed.
  await prompt('把 notes.md 的第一行改成「已核对」，其他行不动。', async () => {
    const end = Date.now() + 90_000;
    for (;;) {
      const list: any = await core.call('attention.list', {}, client);
      const now = (list.now ?? []).find((i: any) => i.actions.includes('allow'));
      if (now) { check('4.4 批准进等你处理', now.group === 'now', now.title); await core.call('attention.resolve', {id: now.id, action: 'allow'}, client); return; }
      if (Date.now() > end || finished() > 1) { check('4.4 批准进等你处理', false, 'no approval appeared'); return; }
      await new Promise(r => setTimeout(r, 300));
    }
  });
  const notes = readFileSync(join(workspace, 'notes.md'), 'utf8');
  check('4.4 允许后改动生效', notes.startsWith('已核对') && notes.includes('第二行保持不变'), JSON.stringify(notes));

  // 4.11: remembering, then correcting in the conversation returns which item changed.
  await prompt('请记住：我写周报喜欢用表格。');
  const remembered: any = await core.call('memory.items', {}, client).catch(() => core.call('memory.list', {}, client));
  const text = JSON.stringify(remembered);
  check('4.11 对话里记住', text.includes('表格'), text.includes('表格') ? '记下了' : (lastReply().slice(0, 60) || 'no reply'));
  const before = messages.filter(m => m.event === 'memory.correction').length;
  await prompt('我改主意了：周报不用表格，改用分点。请更新刚才那条记忆。');
  const corrected = messages.filter(m => m.event === 'memory.correction').length > before;
  check('4.11 纠正后返回改了哪条', corrected, corrected ? '收到 memory.correction' : lastReply().slice(0, 80));

  // 4.10: one search over conversations, files and memory.
  const found: any = await core.call('search.all', {query: '周报'}, client);
  check('4.10 统一搜索', !!found && JSON.stringify(found).includes('周报'), Object.keys(found ?? {}).join(','));

  // 4.5: Git commit with a draft written by the small-task model.
  execFileSync('git', ['init', '-q'], {cwd: workspace});
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '-A'], {cwd: workspace});
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init'], {cwd: workspace});
  writeFileSync(join(workspace, 'notes.md'), '已核对\n第二行保持不变\n第三行：补充结论\n');
  const draft: any = await core.call('git.prepareCommit', {cwd: workspace, paths: ['notes.md']}, client);
  const message = String(draft?.message ?? draft?.draft ?? '').trim();
  check('4.5 提交说明草稿（小任务模型）', message.length > 0, message.slice(0, 80) || JSON.stringify(draft).slice(0, 120));
  console.log(`cost USD ${spent.toFixed(5)}`);
  await core.shutdown();
} catch (e) {
  check('run', false, String((e as Error).stack ?? e));
} finally {
  rmSync(dir, {recursive: true, force: true});
  writeFileSync(resolve('build/v08-live-smoke.json'), JSON.stringify({at: new Date().toISOString(), spentUsd: spent, results}, null, 2));
}
