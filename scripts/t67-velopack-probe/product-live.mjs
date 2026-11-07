import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from '../../core/node_modules/ws/index.js';
import { hashFile } from '../../core/src/update/download.ts';

const [configFile, evidence, packagePrefix = 'product-final'] = process.argv.slice(2);
assert.match(packagePrefix, /^product-[A-Za-z0-9-]+$/);
const temporary = resolve(JSON.parse(readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')).temporary);
const underTemp = temporary.toLowerCase().startsWith((resolve(tmpdir()) + '\\').toLowerCase());
const t69Workspace = underTemp && /^df-t69-[a-f0-9]+$/i.test(temporary.split(/[\\/]/).at(-1)) && existsSync(join(temporary, 't69-workspace.json'));
assert.ok(temporary.toLowerCase().startsWith((resolve(tmpdir()) + '\\df-t67-velopack-').toLowerCase()) || t69Workspace);
const run = mkdtempSync(join(temporary, 'product-live-')), installed = join(run, 'installed'), data = join(run, 'data'), agent = join(data, 'pi'), sessions = join(agent, 'sessions');
const workspace = join(run, 'workspace'), profile = join(run, 'profile');
mkdirSync(installed); mkdirSync(sessions, { recursive: true }); mkdirSync(join(data, 'window'));
mkdirSync(workspace); mkdirSync(join(profile, 'AppData', 'Roaming'), { recursive: true }); mkdirSync(join(profile, 'AppData', 'Local'), { recursive: true });
writeFileSync(join(data, 'window', 'prefs.json'), JSON.stringify({ 'flutter.workspace': workspace, 'flutter.recentWorkspaces': [workspace] })); writeFileSync(join(agent, 'settings.json'), '{}');
const proof = { at: new Date().toISOString(), run, workspace, profile, passed: false, modelCalls: 0, rows: [] };
const row = (operation, detail) => { proof.rows.push({ at: new Date().toISOString(), operation, detail }); writeFileSync(evidence, JSON.stringify(proof, null, 2)); console.log(operation); };
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(probe, seconds = 90) { const end = Date.now() + seconds * 1000; while (Date.now() < end) { const result = await probe(); if (result) return result; await sleep(100); } throw Error('Timed out waiting for product update'); }
const parse = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } };
const journalFile = join(data, 'updates', 'journal.json'), infoFile = join(data, 'core.json');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const packages = new Map(); let server, client, initialCore, feedClosed = false;
function rpcClient(info) {
  const socket = new WebSocket(`ws://127.0.0.1:${info.port}`, { headers: { Authorization: `Bearer ${info.token}` } });
  let id = 0; const waiting = new Map();
  const ready = new Promise((done, reject) => { socket.once('open', done); socket.once('error', reject); });
  socket.on('message', bytes => { const result = JSON.parse(bytes); const task = waiting.get(result.id); if (!task) return; waiting.delete(result.id); clearTimeout(task.timer); result.error ? task.reject(Error(JSON.stringify(result.error))) : task.done(result.result); });
  socket.on('close', () => { for (const task of waiting.values()) { clearTimeout(task.timer); task.reject(Error('Core connection closed')); } waiting.clear(); });
  socket.on('error', () => {});
  return { close() { socket.close(); }, async call(method, params = {}, seconds = 60) { await ready; return new Promise((done, reject) => { const key = ++id; const timer = setTimeout(() => { waiting.delete(key); reject(Error(`RPC timed out: ${method}`)); }, seconds * 1000); waiting.set(key, { done, reject, timer }); socket.send(JSON.stringify({ id: key, method, params })); }); } };
}
async function connect(version) {
  return until(async () => {
    const info = parse(infoFile); if (!info || !alive(info.pid)) return;
    let probe; try { probe = rpcClient(info); const status = await probe.call('updates.status', {}, 3); if (status.application.version === version) return { client: probe, status, pid: info.pid }; } catch {} probe?.close();
  }, 120);
}
function helper(args) { return execFileSync(join(installed, 'current', 'app', 'dreamflutter_update.exe'), args, { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim(); }
async function windowPid() { return until(() => { try { const list = helper(['windows', installed]).split(/\s+/).filter(Boolean).map(Number); return list[0]; } catch {} }); }
async function visibleWindow(pid) {
  return until(() => Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Diagnostics.Process]::GetProcessById(${pid}).MainWindowHandle.ToInt64()`], { windowsHide: true, encoding: 'utf8', timeout: 10000 }).trim()) || undefined);
}
let selected = '0.6.0-test.2';
try {
  await until(() => existsSync(join(temporary, `${packagePrefix}-packages.json`)), 1200);
  for (const n of [1, 2, 3]) {
    const version = `0.6.0-test.${n}`, folder = join(temporary, `${packagePrefix}-test${n}`, 'Velopack'), name = `DreamFlutter-${version}-win-x64-full.nupkg`, path = join(folder, name);
    const { size } = (await import('node:fs')).statSync(path); packages.set(version, { version, folder, name, path, size, sha256: await hashFile(path) });
  }
  server = createServer((req, res) => {
    const tag = /^\/repos\/jun64349\/DreamFlutter\/releases\/tags\/v(.+)$/.exec(req.url ?? '')?.[1];
    if (req.url === '/repos/jun64349/DreamFlutter/releases/latest' || tag) {
      const pkg = packages.get(tag ?? selected); if (!pkg) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ tag_name: `v${pkg.version}`, body: `T67 full product local release ${pkg.version}`, assets: [{ name: pkg.name, size: pkg.size, browser_download_url: `${source}/assets/${pkg.name}`, digest: `sha256:${pkg.sha256}` }] })); return;
    }
    const pkg = [...packages.values()].find(pkg => req.url === `/assets/${pkg.name}`);
    if (!pkg) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Length', pkg.size); createReadStream(pkg.path).pipe(res);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const source = `http://127.0.0.1:${server.address().port}`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dirname(fileURLToPath(import.meta.url)), 'extract-portable.ps1'), '-Archive', join(packages.get('0.6.0-test.1').folder, 'DreamFlutter-win-x64-Portable.zip'), '-Destination', installed], { windowsHide: true, timeout: 180000 });
  const appRoot = join(installed, 'current'), node = join(appRoot, 'runtime', 'node.exe');
  const env = { ...process.env, USERPROFILE: profile, HOME: profile, APPDATA: join(profile, 'AppData', 'Roaming'), LOCALAPPDATA: join(profile, 'AppData', 'Local'), DREAMFLUTTER_DATA: data, DREAMFLUTTER_UPDATE_TEST_SOURCE: source };
  const seed = `const {buildCore}=await import(${JSON.stringify(pathToFileURL(join(appRoot, 'core/src/app.ts')).href)}); const {corePaths}=await import(${JSON.stringify(pathToFileURL(join(appRoot, 'core/src/paths.ts')).href)}); const {Logger}=await import(${JSON.stringify(pathToFileURL(join(appRoot, 'core/src/log.ts')).href)}); const {RecordingNotifier}=await import(${JSON.stringify(pathToFileURL(join(appRoot, 'core/src/notify.ts')).href)}); const core=buildCore({paths:corePaths(${JSON.stringify(data)}),agentDir:${JSON.stringify(agent)},sessionDir:${JSON.stringify(sessions)},piMigration:{automatic:false},log:new Logger(),notifier:new RecordingNotifier()});core.settings.update({autoCheckUpdates:false,memoryPaused:true,autoTitle:false,memoryAutoExtract:false,notifications:false,closeBehavior:'tray'});await core.shutdown();`;
  execFileSync(node, ['--disable-warning=ExperimentalWarning', '--input-type=module', '--eval', seed], { env, windowsHide: true, timeout: 30000 });
  const sentinel = join(data, 't67-preserved-data.json'); writeFileSync(sentinel, JSON.stringify({ stage: 'test1', value: 'T67-DATA-MUST-SURVIVE' })); const firstHash = await hashFile(sentinel);
  initialCore = spawn(node, ['--disable-warning=ExperimentalWarning', join(appRoot, 'core/src/main.ts'), '--data-dir', data, '--agent-dir', agent, '--session-dir', sessions], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  initialCore.stdout.on('data', bytes => appendFileSync(join(run, 'initial-core.log'), bytes)); initialCore.stderr.on('data', bytes => appendFileSync(join(run, 'initial-core.log'), bytes));
  ({ client } = await connect('0.6.0-test.1'));
  const window = spawn(join(installed, 'DreamFlutter.exe'), [], { env, cwd: installed, detached: true, stdio: 'ignore', windowsHide: false }); window.unref();
  const firstWindow = await windowPid(), handle = await visibleWindow(firstWindow);
  row('full-test1-window-and-backend-running', { windowPid: firstWindow, windowHandle: handle, corePid: initialCore.pid, dataHash: firstHash, packageBytes: packages.get('0.6.0-test.1').size });
  const startupValue = () => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$t67Key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run');if($t67Key){try{[string]$t67Key.GetValue('DreamFlutter')}finally{$t67Key.Dispose()}}"], { encoding: 'utf8', windowsHide: true }).trim();
  const previousStartup = startupValue();
  if (t69Workspace) row('startup-toggle-not-repeated-for-package-trimming', { changed: false });
  else if (!previousStartup) {
    try { helper(['startup', installed, 'enable']); assert.equal(startupValue().toLowerCase(), (`\"${join(installed, 'DreamFlutter.exe')}\" --start-hidden`).toLowerCase()); }
    finally { helper(['startup', installed, 'disable']); }
    assert.equal(startupValue(), ''); row('current-user-startup-enable-disable-verified', { clean: true });
  } else row('startup-existing-other-installation-preserved', { changed: false });
  for (const n of [2, 3]) {
    const target = `0.6.0-test.${n}`; selected = target;
    const checked = await client.call('updates.check'); assert.equal(checked.available.version, target);
    const downloaded = await client.call('updates.download', {}, 600); assert.equal(downloaded.downloaded, true); assert.equal(downloaded.signature.state, 'unsigned');
    const oldWindow = await windowPid(); row(`full-test${n}-downloaded-and-verified`, { target, sha256: checked.available.sha256, bytes: checked.available.size });
    await client.call('updates.install', { windowPid: oldWindow, approveUnsigned: true, prefs: { workspace, recentWorkspaces: [workspace] } }); client.close(); client = undefined;
    if (n === 2 && process.env.T67_INTERRUPT_GUARD === '1') {
      const interrupted = await until(() => { const journal = parse(journalFile), info = parse(infoFile); return journal?.phase === 'validating' && info?.pid !== initialCore.pid && alive(info?.pid) ? journal : undefined; }, 240);
      const guardImage = execFileSync('powershell.exe', ['-NoProfile', '-Command', `[Diagnostics.Process]::GetProcessById(${interrupted.guardPid}).MainModule.FileName`], { windowsHide: true, encoding: 'utf8' }).trim();
      assert.ok(resolve(guardImage).toLowerCase().startsWith((resolve(run) + '\\').toLowerCase()));
      process.kill(interrupted.guardPid);
      row('validation-guardian-interrupted-write-gate-retained', { pid: interrupted.guardPid, phase: interrupted.phase, acceptedWrites: interrupted.acceptedWrites });
      await until(() => { const journal = parse(journalFile); return journal?.guardPid !== interrupted.guardPid && alive(journal?.guardPid); }, 30);
    }
    if (n === 3) {
      await until(() => { const journal = parse(journalFile); return journal?.to === target && ['prepared', 'applying', 'validating'].includes(journal.phase) ? journal : undefined; }, 120);
      server.closeAllConnections(); await new Promise(done => server.close(done)); feedClosed = true;
      await until(() => { const journal = parse(journalFile); if (['rolled-back', 'manual-recovery', 'cancelled'].includes(journal?.phase)) throw Error('Fault build did not reach startup validation; see retained guardian log'); return journal?.phase === 'validating'; }, 240);
      // Simulate partially written migration data before the deliberately failed background exits.
      writeFileSync(sentinel, JSON.stringify({ stage: 'failed-test3-migration' }));
      const db = new DatabaseSync(join(data, 'core.db')); db.prepare("UPDATE settings SET value='\"tray\"' WHERE key='closeBehavior'").run(); db.close();
      row('full-test3-failed-migration-injected-source-offline', { sourceClosed: feedClosed, acceptedWrites: parse(journalFile).acceptedWrites });
    }
    const expected = '0.6.0-test.2';
    await until(() => { const journal = parse(journalFile); if (journal?.phase === 'manual-recovery' || journal?.phase === 'cancelled') throw Error(`Update stopped: ${journal.error}`); return journal?.to === target && (n === 2 ? ['verified', 'accepted'].includes(journal.phase) : journal.phase === 'rolled-back') ? journal : undefined; }, 240);
    const next = await connect(expected); client = next.client;
    const nextWindow = await windowPid(), nextHandle = await visibleWindow(nextWindow);
    await until(() => !alive(parse(journalFile)?.guardPid), 30); await sleep(1500);
    assert.equal(parse(infoFile)?.pid, next.pid, 'The validated background must survive guardian exit'); assert.equal(alive(next.pid), true);
    if (n === 2) {
      assert.equal(await hashFile(sentinel), firstHash);
      await client.call('settings.update', { closeBehavior: 'quit' });
      writeFileSync(sentinel, JSON.stringify({ stage: 'test2', value: 'NEW-DATA-BEFORE-TEST3' }));
      proof.test2Hash = await hashFile(sentinel); assert.equal(parse(journalFile).acceptedWrites, true);
      row('full-test1-to-test2-verified-data-preserved', { version: next.status.application.version, windowPid: nextWindow, windowHandle: nextHandle, corePid: next.pid, journal: parse(journalFile).phase, initialHash: firstHash, test2Hash: proof.test2Hash });
    } else {
      assert.equal(await hashFile(sentinel), proof.test2Hash); const hello = await client.call('core.hello'); assert.equal(hello.settings.closeBehavior, 'quit');
      const journal = parse(journalFile); assert.equal(journal.attemptedRollback, true); assert.equal(existsSync(journal.backup), true);
      assert.equal(parse(join(data, 'restore-result.json')).ok, true);
      const log = existsSync(join(journal.guardDir, 'guardian.log')) ? readFileSync(join(journal.guardDir, 'guardian.log'), 'utf8') : readFileSync(join(data, 'updates/history', `${journal.id}.log`), 'utf8');
      assert.match(log, /New background exited during startup \(code 42\)/);
      row('full-test3-to-test2-offline-binary-and-data-rollback-verified', { version: next.status.application.version, windowPid: nextWindow, windowHandle: nextHandle, corePid: next.pid, phase: journal.phase, backup: journal.backup, preservedHash: await hashFile(sentinel), setting: hello.settings.closeBehavior });
    }
  }
  proof.passed = true; proof.offlineRollback = feedClosed; row('full-product-live-passed', { modelCalls: 0 });
} catch (error) { proof.error = error.message; row('full-product-live-failed', { error: error.message }); process.exitCode = 1; }
finally {
  client?.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  try { for (const id of helper(['processes', installed]).split(/\s+/).filter(Boolean)) helper(['stop', installed, id]); } catch {}
  const journal = parse(journalFile);
  if (journal?.guardPid && alive(journal.guardPid)) { const exe = execFileSync('powershell.exe', ['-NoProfile', '-Command', `[Diagnostics.Process]::GetProcessById(${journal.guardPid}).MainModule.FileName`], { windowsHide: true, encoding: 'utf8' }).trim(); if (resolve(exe).toLowerCase().startsWith((resolve(run) + '\\').toLowerCase())) process.kill(journal.guardPid); }
  if (initialCore?.pid && alive(initialCore.pid)) initialCore.kill();
  writeFileSync(evidence, JSON.stringify(proof, null, 2));
}
