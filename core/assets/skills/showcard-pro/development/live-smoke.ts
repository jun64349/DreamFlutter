/** T81: three bounded real conversations, existing OpenCode Go, isolated data and synthetic records. */
import assert from 'node:assert/strict';
import { backup, DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { Core } from '../../../../src/core.ts';
import { corePaths, defaultAgentDir } from '../../../../src/paths.ts';
import { Logger } from '../../../../src/log.ts';
import { RecordingNotifier } from '../../../../src/notify.ts';
import { Llm } from '../../../../src/modules/llm.ts';
import { Providers } from '../../../../src/modules/providers.ts';
import { Gateway } from '../../../../src/gateway/gateway.ts';
import { SkillsModule } from '../../../../src/modules/skills.ts';
import { CardsModule } from '../../../../src/cards/cards.ts';
import { SecretStore, relocateSecretRef } from '../../../../src/modules/secrets.ts';
import { remapColumns } from '../../../../src/backup/parts.ts';
import { PathMap } from '../../../../src/backup/path-map.ts';
import { fileHash } from '../../../../src/gateway/pi-config.ts';
import { redact, redactValue } from '../../../../src/security/redaction.ts';
import { gradeRoutingCase, type RoutingCase, type RoutingObservation } from '../../../../src/modules/skill-routing-eval.ts';
import { textOf } from '../../../../src/runs.ts';

const [sourceArg, evidenceArg, caseList] = process.argv.slice(2);
const requestedCases = caseList ? caseList.split(',') : ['RT04', 'RT10', 'RT19'];
assert.ok(requestedCases.length && new Set(requestedCases).size === requestedCases.length && requestedCases.every(id => ['RT04', 'RT10', 'RT19'].includes(id)), 'only the three declared targeted cases are allowed');
const source = resolve(sourceArg ?? ''), evidence = resolve(evidenceArg ?? '');
assert.equal(source.toLowerCase(), resolve('E:/DreamFlutter测试版/data').toLowerCase());
assert.ok(evidenceArg && !existsSync(evidence), 'new evidence filename required; never silently rerun paid smoke');
const root = mkdtempSync(join(tmpdir(), 'df-t81-live-')), data = join(root, 'data'), agent = join(root, 'agent');
for (const path of [data, agent]) mkdirSync(path, { recursive: true });
const sourceAgent = defaultAgentDir(source);
const hashes = () => Object.fromEntries(['models.json', 'auth.json', 'settings.json'].map(file => [file, fileHash(join(sourceAgent, file))]));
const before = hashes();
const readonly = new DatabaseSync(corePaths(source).dbFile, { readOnly: true });
try { await backup(readonly, corePaths(data).dbFile); } finally { readonly.close(); }
const secrets = new SecretStore(data), oldSecrets = new SecretStore(source); mkdirSync(secrets.dir, { recursive: true });
for (const file of existsSync(oldSecrets.dir) ? readdirSync(oldSecrets.dir) : []) if (file.endsWith('.dpapi')) copyFileSync(join(oldSecrets.dir, file), join(secrets.dir, file));
const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(agent, 'auth.json'), refreshOnCreate: false });
const core = new Core({ paths: corePaths(data), agentDir: agent, sessionDir: join(root, 'sessions'), log: new Logger(), notifier: new RecordingNotifier(), modelRuntime: () => runtime });
const llm = new Llm(core, () => runtime), providers = new Providers(core, llm);
const proof: any = { task: 'T-81', root, at: new Date().toISOString(), requestedCases, sourceReadOnly: true, sourceConfigHashesBefore: before, newChannelsCreated: 0, physicalRequests: 0, requestLimit: requestedCases.length === 1 ? 20 : 24, maxTokensPerRequest: 6144, dailyBudgetUsd: requestedCases.length === 1 ? 0.01 : 0.03, passed: false, attempts: [], formalRoutingDatasetChanged: false, formalScore: false, visualChecked: false };
const save = () => writeFileSync(evidence, JSON.stringify(redactValue(proof), null, 2));
const gateway = new Gateway(core, providers, { transport: (model, context, options) => {
  if (proof.physicalRequests >= proof.requestLimit) throw new Error('T81 bounded request budget exhausted');
  proof.physicalRequests++; save();
  return streamSimple(model, context, { ...options, maxRetries: 0, maxTokens: 6144, signal: AbortSignal.any([...(options?.signal ? [options.signal] : []), AbortSignal.timeout(90_000)]) });
} });
const cards = new CardsModule(core);
core.use(gateway); core.use(new SkillsModule(core, llm)); core.use(cards);
try {
  remapColumns(core.db, core.backupParts, { map: new PathMap([{ from: source, to: data }]), secretRef: ref => relocateSecretRef(ref, secrets.dir) });
  core.db.raw.exec('DELETE FROM proposals; DELETE FROM library_usage; DELETE FROM library_entries; DELETE FROM gateway_requests; DELETE FROM gateway_quota;');
  const channel = gateway.channels().find(entry => entry.source === 'df' && entry.enabled && entry.platform === 'opencode-go' && entry.models.some(m => m.id === 'mimo-v2.6-flash'));
  assert.ok(channel, 'existing OpenCode Go mimo-v2.6-flash channel required');
  proof.channel = { id: channel.id, name: channel.name, model: 'mimo-v2.6-flash' };
  const channelIds = core.db.all('SELECT id FROM gateway_channels ORDER BY id');
  core.settings.update({ defaultModel: `${channel.provider}/mimo-v2.6-flash`, fallbackModels: [], defaultThinking: 'off', agentMode: 'standard', approvalMode: 'off', autoTitle: false, memoryEnabled: false, memoryAutoExtract: false, autoCompaction: false, dailyBudgetUsd: proof.dailyBudgetUsd });
  proof.approvalNote = 'Off only in this synthetic isolated fixture; this does not test production approval gates.';
  gateway.installRuntime(runtime); await core.start();
  const datasetRaw = readFileSync(new URL('../../../../../docs/research/v0.7-routing-draft.json', import.meta.url));
  proof.originalDatasetSha256 = createHash('sha256').update(datasetRaw).digest('hex');
  const dataset = JSON.parse(datasetRaw.toString('utf8'));
  const baseDir = dirname(dirname(fileURLToPath(import.meta.url)));
  for (const caseId of requestedCases) {
    const original: RoutingCase = dataset.cases.find((item: RoutingCase) => item.id === caseId);
    const item: RoutingCase = { ...original, prompt: original.prompt.replaceAll('showcard_pro', 'showcard-pro'), required_skills: original.required_skills.map(name => name === 'showcard_pro' ? 'showcard-pro' : name) };
    const workspace = join(root, caseId); mkdirSync(workspace);
    writeFileSync(join(workspace, '本周记录.md'), '# 合成验收记录，非真实项目成绩\n周期：2026-11-02至2026-11-08\nW1：完成3项测试交付，每项保留输出证据；没有生产成绩。\nW2：仍有2项联调待验证，风险是依赖排期未定，负责人和日期待确认。\nW3：下周先确认联调窗口再复测；不能把待验写成完成。\n');
    if (caseId === 'RT19') writeFileSync(join(workspace, 'sales.csv'), 'date,region,revenue,orders\n2026-11-02,华东,1200,3\n2026-11-03,华南,800,2\n2026-11-04,华东,500,1\n');
    const records: any[] = [], slotId = `t81-${caseId}`;
    const client = core.addClient(event => { if (event.event === 'slot.record' && event.slotId === slotId) records.push(event.record); });
    await core.call('slot.open', { slotId, cwd: workspace }, client);
    const slot = core.slot(slotId);
    const active = ['skill', 'read', 'write', 'pwsh', 'show_card'];
    const known = new Set(slot.session.getAllTools().map(tool => tool.name));
    for (const name of active) assert.ok(known.has(name), `required real tool unavailable: ${name}`);
    slot.session.setActiveToolsByName(active);
    const message = `${item.prompt}\n这是授权的合成材料验收：本周记录在当前工作区“本周记录.md”${caseId === 'RT19' ? '，销售数据在“sales.csv”' : ''}，先实际读取所需材料。请直接完成，不再询问确认，输出在本工作区下report.html。只读本工作区和已加载内置技能，只写本工作区，禁止联网、禁止安装依赖、禁止查看应用数据或密钥。执行工具名是pwsh，可用Node的已确认绝对路径为${process.execPath}；按PowerShell引号规则调用。遵循技能的离线渲染器，生成后读取摘要全文并立即show_card，再给真实文件链接，避免反复统计HTML标签。未知负责人/日期保留待确认，不能把联调算完成。没有视觉工具时如实说未视觉检查，不为此另找在线工具。完成后简短回执。技能源码位于${baseDir}。`;
    const attempt: any = { caseId, repeat: 1, originalPrompt: original.prompt, effectivePrompt: item.prompt, nameMapping: { showcard_pro: 'showcard-pro' }, workspace, startedAt: new Date().toISOString(), observation: { calls: [], answer: '' } };
    proof.attempts.push(attempt); save();
    await core.call('slot.send', { slotId, record: { type: 'prompt', message } }, client);
    const deadline = Date.now() + 240_000;
    while (!records.some(record => record.type === 'agent_settled')) {
      if (Date.now() > deadline) { await slot.session.abort(); throw new Error(`${caseId} live conversation timed out`); }
      await new Promise(done => setTimeout(done, 100));
    }
    const calls = records.filter(record => record.type === 'tool_execution_start').map(start => {
      const end = records.find(record => record.type === 'tool_execution_end' && record.toolCallId === start.toolCallId);
      return { toolName: start.toolName, args: start.args ?? {}, isError: !end || !!end.isError, result: end?.result, known: known.has(start.toolName) };
    });
    const last = slot.session.messages.filter(message => message.role === 'assistant').at(-1);
    const answer = textOf(last?.content ?? '');
    const observation: RoutingObservation = { calls, answer, route: await core.call('skills.routingStatus', { slotId }) as RoutingObservation['route'], stopReason: last?.role === 'assistant' ? last.stopReason : undefined };
    attempt.observation = observation;
    // Scorer receives the explicitly renamed local case only; this is not a reapproved 30-case run.
    attempt.score = gradeRoutingCase(item, observation);
    const output = join(workspace, 'report.html');
    attempt.outputExists = existsSync(output);
    if (attempt.outputExists) {
      const html = readFileSync(output, 'utf8');
      attempt.report = { path: output, bytes: Buffer.byteLength(html), sha256: createHash('sha256').update(html).digest('hex'), hasChinese: /[\u4e00-\u9fff]/u.test(html), sourceFactsPresent: /待确认/.test(html), hasRemoteAssets: /(?:src|href)=["'](?:https?:|\/\/)/i.test(html), csvTotalCorrect: caseId !== 'RT19' || /2[,]?500/.test(html) };
    }
    attempt.passed = attempt.score.passed && observation.stopReason === 'stop' && calls.some(call => call.toolName === 'show_card' && !call.isError) && attempt.report?.hasChinese && attempt.report?.sourceFactsPresent && !attempt.report?.hasRemoteAssets && attempt.report?.csvTotalCorrect;
    attempt.finishedAt = new Date().toISOString();
    proof.requests = core.db.all('SELECT model,ok,input,output,cost,duration_ms FROM gateway_requests ORDER BY id');
    save();
    await core.call('slot.close', { slotId }, client);
    assert.ok(attempt.passed, `${caseId} targeted real conversation failed; inspect evidence, no automatic retry`);
  }
  assert.deepEqual(core.db.all('SELECT id FROM gateway_channels ORDER BY id'), channelIds);
  assert.deepEqual(hashes(), before);
  proof.sourceConfigUnchanged = true;
  proof.passed = true;
} catch (error) { proof.error = redact(error instanceof Error ? error.stack ?? error.message : String(error), true); process.exitCode = 1; }
finally { await core.shutdown(); proof.sourceConfigUnchanged = JSON.stringify(hashes()) === JSON.stringify(before); proof.finishedAt = new Date().toISOString(); save(); process.stdout.write(JSON.stringify({ passed: proof.passed, attempts: proof.attempts.map((a: any) => ({ caseId: a.caseId, passed: a.passed })), physicalRequests: proof.physicalRequests, error: proof.error }) + '\n', () => process.exit(process.exitCode ? 1 : 0)); }
