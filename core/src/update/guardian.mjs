// Runs from a private staging directory outside Velopack's replaceable current/.
// All program replacement is performed by the native Velopack helper.
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, rmSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import WebSocket from 'ws';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const read = () => JSON.parse(readFileSync(config.journalFile, 'utf8'));
function log(message) { appendFileSync(join(config.guardDir, 'guardian.log'), `${new Date().toISOString()} ${message}\n`); }
function alive(pid) { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
async function patch(changes, condition = () => true) {
  const lock = config.journalFile + '.lock'; let fd;
  for (let i = 0; i < 100; i++) {
    try { fd = openSync(lock, 'wx', 0o600); writeFileSync(fd, JSON.stringify({ pid: process.pid })); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (!alive(JSON.parse(readFileSync(lock, 'utf8')).pid)) rmSync(lock, { force: true }); } catch {}
      await sleep(10);
    }
  }
  if (fd === undefined) throw Error('Journal locked');
  try {
    const current = read();
    if (!condition(current)) throw Error('Update stage no longer permits this operation');
    if (current.acceptedWrites && ['rollback-needed', 'rolled-back'].includes(changes.phase)) throw Error('New data forbids rollback');
    const temporary = `${config.journalFile}.${process.pid}.partial`;
    writeFileSync(temporary, JSON.stringify({ ...current, ...changes, at: Date.now() }, null, 2), { mode: 0o600 });
    renameSync(temporary, config.journalFile);
  } finally { closeSync(fd); rmSync(lock, { force: true }); }
}
const helper = (args, timeout = 180000) => new Promise((done, reject) => execFile(config.helper, args, { windowsHide: true, timeout, maxBuffer: 65536, encoding: 'utf8' }, (error, stdout) => error ? reject(Error(error.killed ? 'Velopack helper timed out' : `Velopack helper failed (code ${error.code})`)) : done(stdout.trim())));
function installedVersion() {
  try { return JSON.parse(readFileSync(join(config.appRoot, 'build-info.json'), 'utf8')).version; } catch { return null; }
}
async function waitUpdater(seconds = 180) {
  let clear = 0;
  for (let i = 0; i < seconds * 2; i++) {
    if (!(await helper(['updaters', config.installRoot]))) { if (++clear === 2) return; } else clear = 0;
    await sleep(500);
  }
  throw Error('Velopack updater did not finish; application startup held');
}
async function waitVersion(expected, seconds = 30) {
  await waitUpdater();
  for (let i = 0; i < seconds * 5; i++) { if (installedVersion() === expected) return; await sleep(200); }
  throw Error('Application replacement did not finish');
}
function startCore(recover = false) {
  const node = join(config.appRoot, 'runtime', 'node.exe');
  const entry = join(config.appRoot, 'core', 'src', recover ? 'update/recover-entry.ts' : 'main.ts');
  const args = recover ? [entry, process.argv[2]] : [entry, '--data-dir', config.dataRoot, '--agent-dir', config.agentDir, '--session-dir', config.sessionsDir];
  const child = spawn(node, ['--disable-warning=ExperimentalWarning', ...args], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, DREAMFLUTTER_DATA: config.dataRoot } });
  child.on('error', () => {}); return child;
}
async function hello(info, validate, inspect = false) {
  return new Promise((done, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${info.port}`, { headers: { Authorization: `Bearer ${info.token}` } });
    const timer = setTimeout(() => { socket.terminate(); reject(Error('Handshake timed out')); }, 3000);
    let phase = 1;
    socket.on('error', () => { clearTimeout(timer); reject(Error('Handshake failed')); });
    socket.on('open', () => socket.send(JSON.stringify({ id: 1, method: 'core.hello', params: {} })));
    socket.on('message', bytes => {
      let response; try { response = JSON.parse(bytes); } catch { return; }
      if (response.id !== phase) return;
      if (response.error) { clearTimeout(timer); socket.close(); reject(Error('Startup validation refused')); return; }
      if (phase === 1 && (validate || inspect)) {
        phase = 2; socket.send(JSON.stringify({ id: 2, method: validate ? 'updates.validateReady' : 'updates.status', params: validate ? { nonce: config.nonce } : {} }));
      } else {
        clearTimeout(timer); socket.close();
        if (inspect && response.result?.application?.version !== config.to) reject(Error('Existing background version mismatch')); else done(response.result);
      }
    });
  });
}
async function waitCore(child, validate) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error(`New background exited during startup (code ${child.exitCode})`);
    try {
      const info = JSON.parse(readFileSync(config.infoFile, 'utf8'));
      if (info.pid === child.pid) { await hello(info, validate); return; }
    } catch {}
    await sleep(200);
  }
  throw Error('Background handshake did not complete');
}
async function existingBackground() {
  try {
    const info = JSON.parse(readFileSync(config.infoFile, 'utf8'));
    const owned = (await helper(['processes', config.installRoot])).split(/\s+/).map(Number);
    if (!alive(info.pid) || !owned.includes(info.pid)) return;
    await hello(info, false, true);
    return { pid: info.pid, get exitCode() { return alive(info.pid) ? null : 1; }, unref() {} };
  } catch { return undefined; }
}
function startWindow() {
  const child = spawn(join(config.installRoot, 'DreamFlutter.exe'), [], { cwd: config.installRoot, detached: true, windowsHide: false, stdio: 'ignore', env: { ...process.env, DREAMFLUTTER_DATA: config.dataRoot } });
  child.on('error', () => {}); child.unref();
}
async function stopFailedProcesses() {
  const pids = (await helper(['processes', config.installRoot])).split(/\s+/).filter(s => /^\d+$/.test(s));
  for (const pid of pids) await helper(['stop', config.installRoot, pid]);
}
async function rollback(resume = false) {
  if (!resume) await patch({ phase: 'rollback-needed', attemptedRollback: true, error: '新版本启动验证失败，正在恢复旧版本和更新前备份。' }, state => !state.acceptedWrites && !state.attemptedRollback && ['applying', 'validating'].includes(state.phase));
  await waitUpdater(); await stopFailedProcesses();
  if (installedVersion() !== config.from) await helper(['rollback', config.installRoot, config.oldFeed, config.sdkCache]);
  await waitVersion(config.from);
  const recovery = startCore(true);
  await patch({ recoveryPid: recovery.pid });
  const code = await new Promise((done, reject) => { const timer = setTimeout(() => reject(Error('Data restore timed out')), 120000); recovery.once('exit', code => { clearTimeout(timer); done(code); }); recovery.once('error', reject); });
  if (code !== 0) throw Error('Data restore failed; backup retained');
  const old = startCore(); await waitCore(old, false); old.unref(); startWindow();
  log('Old application and pre-update data restored');
}

try {
  mkdirSync(config.sdkCache, { recursive: true });
  await patch({ guardPid: process.pid });
  let stage = read();
  if (stage.phase === 'rollback-needed' && !stage.acceptedWrites) { await rollback(true); stage = read(); }
  if (stage.phase === 'prepared') {
    for (let i = 0; i < 300 && (alive(stage.corePid) || alive(stage.windowPid)); i++) await sleep(200);
    if (alive(stage.corePid) || alive(stage.windowPid)) throw Error('Old application did not stop normally');
    await patch({ phase: 'applying' }, current => current.phase === 'prepared' && !current.acceptedWrites);
    log('Old window and background stopped; applying verified package');
    await helper(['apply', config.installRoot, config.newFeed, config.sdkCache]);
    await waitVersion(config.to);
  }
  stage = read();
  if (stage.phase === 'applying' && installedVersion() !== config.to) {
    await helper(['apply', config.installRoot, config.newFeed, config.sdkCache]);
    await waitVersion(config.to);
  }
  if (['applying', 'validating'].includes(stage.phase) && !stage.acceptedWrites) {
    await patch({ phase: 'validating' });
    const background = await existingBackground() ?? startCore(); await waitCore(background, false);
    if (!(await helper(['windows', config.installRoot]))) startWindow();
    await waitCore(background, true); background.unref();
    log('New background handshake, database and data paths verified');
  }
} catch (error) {
  log(error instanceof Error ? error.message : 'Update health check failed');
  try {
    const stage = read();
    if (!stage.acceptedWrites && !stage.attemptedRollback && ['applying', 'validating'].includes(stage.phase)) await rollback();
    else if (stage.phase === 'prepared') await patch({ phase: 'cancelled', error: '程序未正常退出，更新未开始；备份已保留。' });
    else if (stage.phase !== 'verified' && stage.phase !== 'accepted' && stage.phase !== 'rolled-back') await patch({ phase: 'manual-recovery', error: '自动恢复未能完成，已保留程序、数据和备份，请导出诊断后处理。' });
  } catch { try { await patch({ phase: 'manual-recovery', error: '自动恢复未能完成，已保留现场和备份。' }); } catch {} }
  log('Update did not complete; recovery outcome recorded without deleting backup');
  process.exitCode = 1;
}
