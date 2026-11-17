// 0.13.1 install / upgrade / rollback / uninstall verification on this Windows account
// (docs/releases/v0.13.1-安装升级验证计划.md). One phase per run:
//
//   node scripts/v0131-install/drive.mjs <phase>
//
// Phases: preflight, install, seed, upgrade, rollback, uninstall-keep, reinstall, uninstall-all.
// Evidence: app/build/v0131_install/<phase>.json and screenshots. No model is called.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from '../../core/node_modules/ws/index.js';
import { hashFile } from '../../core/src/update/download.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const phase = process.argv[2];
const evidenceDir = join(repo, 'app/build/v0131_install');
mkdirSync(evidenceDir, { recursive: true });
const local = process.env.LOCALAPPDATA;
const root = join(local, 'DreamFlutter');
const data = join(root, 'data');
const dist = join(repo, 'dist/v0.13.1-install');
const statePath = join(evidenceDir, 'state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const proof = { phase, at: new Date().toISOString(), passed: false, rows: [] };
const evidence = join(evidenceDir, `${phase}.json`);
const row = (step, detail = {}) => { proof.rows.push({ at: new Date().toISOString(), step, ...detail }); writeFileSync(evidence, JSON.stringify(proof, null, 2)); console.log(step, JSON.stringify(detail)); };
const saveState = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(probe, seconds = 120, what = 'condition') { const end = Date.now() + seconds * 1000; for (;;) { const r = await probe(); if (r) return r; if (Date.now() > end) throw Error(`Timed out: ${what}`); await sleep(250); } }
const parse = path => { try { return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')); } catch { return undefined; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const ps = command => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command + '; exit 0'], { encoding: 'utf8', windowsHide: true, timeout: 120000 }).trim();

const PACKAGES = { '0.13.0': join(dist, 'v0.13.0/Velopack'), '0.13.1': join(dist, 'v0.13.1/Velopack'), '0.13.2-test.1': join(dist, 'v0.13.2-test.1/Velopack'), '0.13.2-test.2': join(dist, 'v0.13.2-test.2/Velopack') };
const MARK = { memory: 'V0131 安装验证：这条记忆升级后必须还在', schedule: 'V0131 安装验证提醒', file: 'v0131-preserved.json' };

// ---- machine state outside the app: what an uninstall must leave clean ---------------------------------
function machine() {
  const distros = (() => { try { return execFileSync('wsl.exe', ['-l', '-q'], { windowsHide: true }).toString('utf16le').replace(/\0/g, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean); } catch { return []; } })();
  const lxss = JSON.parse(ps("$r=@(); Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss -ErrorAction SilentlyContinue | ForEach-Object { $p=Get-ItemProperty $_.PSPath; $r+=[pscustomobject]@{name=$p.DistributionName;path=$p.BasePath} }; ConvertTo-Json -Compress @($r)") || '[]');
  const uninstallKey = ps("$k=Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DreamFlutter -ErrorAction SilentlyContinue; if($k){ConvertTo-Json -Compress @{name=$k.DisplayName;version=$k.DisplayVersion;location=$k.InstallLocation;uninstall=$k.UninstallString}}");
  const run = ps("$k=Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run -ErrorAction SilentlyContinue; if($k -and $k.DreamFlutter){[string]$k.DreamFlutter}");
  const startMenu = join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs');
  const desktop = ps('[Environment]::GetFolderPath("Desktop")');
  const shortcuts = [startMenu, desktop].flatMap(dir => { try { return readdirSync(dir).filter(n => /dreamflutter/i.test(n)).map(n => join(dir, n)); } catch { return []; } });
  const siblings = readdirSync(local).filter(n => /^DreamFlutter/i.test(n));
  const processes = ps("Get-Process | Where-Object { $_.Path -and $_.Path -like '" + root.replace(/'/g, "''") + "*' } | ForEach-Object { \"$($_.Id) $($_.Path)\" }").split(/\r?\n/).filter(Boolean);
  return { distros, lxss, uninstallKey: uninstallKey ? JSON.parse(uninstallKey) : null, run: run || null, shortcuts, localAppDataEntries: siblings, rootExists: existsSync(root), processes };
}

// ---- the installed app ----------------------------------------------------------------------------------
let feed;
function rpcClient(info) {
  const socket = new WebSocket(`ws://127.0.0.1:${info.port}`, { headers: { Authorization: `Bearer ${info.token}` } });
  let id = 0; const waiting = new Map();
  const ready = new Promise((done, reject) => { socket.once('open', done); socket.once('error', reject); });
  socket.on('message', bytes => { const r = JSON.parse(bytes); const task = waiting.get(r.id); if (!task) return; waiting.delete(r.id); clearTimeout(task.timer); r.error ? task.reject(Object.assign(Error(JSON.stringify(r.error)), { rpc: r.error })) : task.done(r.result); });
  socket.on('close', () => { for (const t of waiting.values()) { clearTimeout(t.timer); t.reject(Error('Core connection closed')); } waiting.clear(); });
  socket.on('error', () => {});
  return { close() { socket.close(); }, async call(method, params = {}, seconds = 60) { await ready; return new Promise((done, reject) => { const key = ++id; const timer = setTimeout(() => { waiting.delete(key); reject(Error(`RPC timed out: ${method}`)); }, seconds * 1000); waiting.set(key, { done, reject, timer }); socket.send(JSON.stringify({ id: key, method, params })); }); } };
}
async function connect(version, seconds = 180) {
  return until(async () => {
    const info = parse(join(data, 'core.json')); if (!info || !alive(info.pid)) return;
    let c; try { c = rpcClient(info); const status = await c.call('updates.status', {}, 3); if (!version || status.application.version === version) return { client: c, status, pid: info.pid }; } catch {} c?.close();
  }, seconds, `background ${version ?? ''}`);
}
const helper = args => execFileSync(join(root, 'current/app/dreamflutter_update.exe'), args, { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
const windowPid = () => until(() => Number(ps("Get-Process dreamflutter -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '" + join(root, 'current').replace(/'/g, "''") + "*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1 -ExpandProperty Id")) || undefined, 120, 'window process');
const windowHandle = pid => until(() => Number(ps(`[Diagnostics.Process]::GetProcessById(${pid}).MainWindowHandle.ToInt64()`)) || undefined, 120, 'visible window');
function screenshot(pid, name) {
  const file = join(evidenceDir, `${name}.png`);
  try {
    ps(`Add-Type -AssemblyName System.Drawing; Add-Type @'
using System; using System.Runtime.InteropServices;
public static class W { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); public struct R { public int L, T, Rt, B; } }
'@; [W]::SetProcessDPIAware() | Out-Null; $h=[Diagnostics.Process]::GetProcessById(${pid}).MainWindowHandle; [W]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 600; $r=New-Object W+R; [W]::GetWindowRect($h,[ref]$r) | Out-Null; $b=New-Object Drawing.Bitmap ($r.Rt-$r.L),($r.B-$r.T); $g=[Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($r.L,$r.T,0,0,$b.Size); $b.Save('${file.replace(/'/g, "''")}'); $g.Dispose(); $b.Dispose()`);
    return file;
  } catch (e) { return `screenshot failed: ${e.message.split('\n')[0]}`; }
}
async function startFeed(selected) {
  const packages = new Map();
  for (const [version, folder] of Object.entries(PACKAGES)) {
    const name = `DreamFlutter-${version}-win-x64-full.nupkg`, path = join(folder, name);
    if (existsSync(path)) packages.set(version, { version, name, path, size: statSync(path).size, sha256: await hashFile(path) });
  }
  let source;
  const server = createServer((req, res) => {
    const tag = /^\/repos\/jun64349\/DreamFlutter\/releases\/tags\/v(.+)$/.exec(req.url ?? '')?.[1];
    if (req.url === '/repos/jun64349/DreamFlutter/releases/latest' || tag) {
      const pkg = packages.get(tag ?? server.selected); if (!pkg) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ tag_name: `v${pkg.version}`, body: `0.13.1 安装验证本机发布 ${pkg.version}`, html_url: `${source}/release/${pkg.version}`, assets: [{ name: pkg.name, size: pkg.size, browser_download_url: `${source}/assets/${pkg.name}`, digest: `sha256:${pkg.sha256}` }] }));
      return;
    }
    const pkg = [...packages.values()].find(p => req.url === `/assets/${p.name}`);
    if (!pkg) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Length', pkg.size); createReadStream(pkg.path).pipe(res);
  });
  server.selected = selected;
  await new Promise(done => server.listen(state.feedPort ?? 0, '127.0.0.1', done));
  state.feedPort = server.address().port; saveState();
  source = `http://127.0.0.1:${state.feedPort}`;
  feed = server;
  return { server, source, packages };
}
const feedSource = () => `http://127.0.0.1:${state.feedPort}`;
/** Starts the installed app the way its shortcut does (root DreamFlutter.exe), with the local test feed. */
async function launch(version) {
  const started = Date.now();
  const child = spawn(join(root, 'DreamFlutter.exe'), [], { cwd: root, env: { ...process.env, DREAMFLUTTER_UPDATE_TEST_SOURCE: feedSource() }, detached: true, stdio: 'ignore' });
  child.unref();
  const pid = await windowPid(); await windowHandle(pid);
  const windowMs = Date.now() - started;
  const core = await connect(version);
  return { pid, windowMs, coreMs: Date.now() - started, ...core };
}
async function stopApp() {
  try { for (const id of helper(['processes', root]).split(/\s+/).filter(Boolean)) helper(['stop', root, id]); } catch {}
  try { await until(() => machine().processes.length === 0, 15, 'graceful exit'); return; } catch {}
  ps("Get-Process | Where-Object { $_.Path -and $_.Path -like '" + root.replace(/'/g, "''") + "*' } | Stop-Process -Force");
  await until(() => machine().processes.length === 0, 60, 'app processes to exit');
}
const journal = () => parse(join(data, 'updates/journal.json'));
async function marks(client) {
  const memories = await client.call('memory.list', { query: 'V0131' }).catch(e => ({ error: e.message }));
  const schedules = await client.call('schedules.list').catch(e => ({ error: e.message }));
  const settings = (await client.call('core.hello')).settings;
  const file = join(data, MARK.file);
  return {
    memory: JSON.stringify(memories).includes(MARK.memory),
    schedule: JSON.stringify(schedules).includes(MARK.schedule),
    setting: settings?.closeBehavior,
    fileHash: existsSync(file) ? await hashFile(file) : null,
  };
}

// ---- phases ---------------------------------------------------------------------------------------------
const phases = {
  async preflight() {
    const m = machine();
    proof.passed = true;
    for (const [v, folder] of Object.entries(PACKAGES)) row('package', { version: v, setup: existsSync(join(folder, 'DreamFlutter-win-x64-Setup.exe')), nupkg: existsSync(join(folder, `DreamFlutter-${v}-win-x64-full.nupkg`)) });
    assert.equal(m.rootExists, false, `${root} already exists`);
    assert.equal(m.uninstallKey, null, 'a DreamFlutter uninstall entry already exists');
    // Real-environment originals this run may overwrite: the dev Start-menu shortcut and the data pointer.
    for (const [from, to] of [[join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/DreamFlutter.lnk'), 'original-real-DreamFlutter.lnk'], [join(process.env.APPDATA, 'DreamFlutter/installation.json'), 'original-real-installation.json']])
      if (existsSync(from)) writeFileSync(join(evidenceDir, to), readFileSync(from));
    state.before = m; saveState();
    row('machine-before', m);
  },
  async install() {
    // Like a double-click: Setup's own window, then it starts the app by itself.
    const setup = join(PACKAGES['0.13.0'], 'DreamFlutter-win-x64-Setup.exe');
    const t0 = Date.now();
    execFileSync(setup, [], { timeout: 900000 });
    const installMs = Date.now() - t0;
    await until(() => existsSync(join(root, 'current/app/dreamflutter.exe')), 60, 'installed files');
    const m = machine();
    row('installed', { installMs, machine: m, rootSizeBytes: Number(ps(`(Get-ChildItem -LiteralPath '${root}' -Recurse -File -Force | Measure-Object Length -Sum).Sum`)) });
    assert.ok(m.uninstallKey, 'uninstall entry registered');
    const pid = await windowPid(); await windowHandle(pid);
    row('first-window', { sinceSetupStartMs: Date.now() - t0, pid, screenshot: screenshot(pid, '1-first-window') });
    proof.passed = true;
  },
  /** Restart the installed app with the local test feed (the only difference from a normal start). */
  async relaunch() {
    await stopApp();
    await startFeed(process.argv[3] ?? '0.13.1');
    const app = await launch(process.argv[4]);
    row('relaunched', { windowMs: app.windowMs, coreMs: app.coreMs, version: app.status.application.version, build: app.status.application.build });
    app.client.close(); feed.close(); proof.passed = true;
  },
  async seed() {
    await stopApp(); await startFeed(process.argv[3] ?? '0.13.0');
    const app = await launch(process.argv[3] ?? '0.13.0');
    row('started-with-test-feed', { windowMs: app.windowMs, coreMs: app.coreMs });
    const c = app.client;
    await c.call('settings.update', { closeBehavior: 'quit', autoCheckUpdates: false });
    await c.call('memory.save', { content: MARK.memory, scope: 'global', kind: 'fact' });
    const time = await c.call('schedules.parseTime', { text: '每天 08:00' });
    await c.call('schedules.save', { name: MARK.schedule, kind: 'reminder', trigger: time.trigger });
    writeFileSync(join(data, MARK.file), JSON.stringify({ value: 'V0131-DATA-MUST-SURVIVE', at: Date.now() }));
    row('seeded', await marks(c));
    const t0 = Date.now();
    const current = await c.call('sandbox.status');
    if (current.state !== 'provisioning' && current.state !== 'ready') await c.call('sandbox.provision', {}, 900);
    const sandbox = await until(async () => { const s = await c.call('sandbox.status'); return s.state === 'ready' || s.ready ? s : undefined; }, 900, 'sandbox ready');
    row('sandbox', { provisionMs: Date.now() - t0, status: sandbox, distros: machine().distros });
    state.sandboxDistros = [...new Set([...(state.sandboxDistros ?? []), sandbox.distro])];
    state.seeded = await marks(c); saveState();
    row('screenshot', { file: screenshot(await windowPid(), '2-seeded') });
    c.close();
    proof.passed = true;
  },
  async update(target, expectRollback) {
    await stopApp();
    const { server } = await startFeed(target);
    const app = await launch();
    const from = app.status.application.version;
    const before = await marks(app.client);
    const checked = await app.client.call('updates.check', {}, 120);
    assert.equal(checked.available?.version, target, JSON.stringify(checked));
    const downloaded = await app.client.call('updates.download', {}, 900);
    assert.equal(downloaded.downloaded, true);
    row('downloaded', { from, target, bytes: checked.available.size, signature: downloaded.signature?.state });
    const win = await windowPid();
    const t0 = Date.now();
    await app.client.call('updates.install', { windowPid: win, approveUnsigned: true, prefs: {} }); app.client.close();
    const end = await until(() => { const j = journal(); if (j?.to !== target) return; if (['manual-recovery', 'cancelled'].includes(j.phase)) throw Error(`update stopped: ${j.phase} ${j.error ?? ''}`); return (expectRollback ? j.phase === 'rolled-back' : ['verified', 'accepted'].includes(j.phase)) ? j : undefined; }, 900, `update to ${target}`);
    const expected = expectRollback ? from : target;
    const next = await connect(expected, 300);
    const pid = await windowPid(); await windowHandle(pid);
    const after = await marks(next.client);
    row('updated', { phase: end.phase, totalMs: Date.now() - t0, version: next.status.application.version, build: next.status.application.build, before, after, journal: end, screenshot: screenshot(pid, expectRollback ? '4-rolled-back' : '3-upgraded') });
    for (const key of ['memory', 'schedule', 'setting', 'fileHash']) assert.deepEqual(after[key], state.seeded[key], `data kept: ${key}`);
    if (expectRollback) assert.equal(parse(join(data, 'restore-result.json'))?.ok, true, 'pre-update backup restored');
    next.client.close(); server.close();
    proof.passed = true;
  },
  async upgrade() { await phases.update(process.argv[3] ?? '0.13.2-test.1', false); },
  async rollback() { await phases.update(process.argv[3] ?? '0.13.2-test.2', true); },
  async 'uninstall-keep'() {
    await startFeed('0.13.1');
    let app; try { app = await connect('0.13.1', 5); } catch { app = await launch('0.13.1'); }
    const preview = await app.client.call('uninstall.preview');
    row('preview', preview);
    const win = await windowPid();
    await app.client.call('uninstall.start', { keepData: true, windowPid: win });
    await until(() => !existsSync(join(root, 'current')) && machine().processes.length === 0, 600, 'uninstall');
    await sleep(5000);
    const m = machine();
    const preserved = m.localAppDataEntries.filter(n => /preserved-data/i.test(n)).map(n => join(local, n));
    row('after-uninstall-keep', { machine: m, preserved, preservedHasFile: preserved.some(p => existsSync(join(p, MARK.file))) });
    assert.equal(m.uninstallKey, null); assert.equal(m.rootExists, false);
    assert.ok(preserved.length, 'data kept next to the install root');
    assert.ok(!m.distros.some(d => !state.before.distros.includes(d)), 'sandbox unregistered');
    proof.passed = true;
  },
  async reinstall() {
    const setup = join(PACKAGES['0.13.1'], 'DreamFlutter-win-x64-Setup.exe');
    execFileSync(setup, [], { timeout: 900000 });
    await until(() => existsSync(join(root, 'current/app/dreamflutter.exe')), 60, 'installed files');
    await stopApp();
    await startFeed('0.13.1');
    const app = await launch('0.13.1');
    const { candidates } = await app.client.call('uninstall.preservedData');
    row('candidates', { candidates, screenshot: screenshot(app.pid, '6-reinstalled') });
    assert.ok(candidates.length);
    await app.client.call('uninstall.restorePreservedData', { path: candidates[0].path }); app.client.close();
    const next = await until(async () => { try { const n = await connect('0.13.1', 5); const r = await n.client.call('backup.restoreResult').catch(() => null); if (r && r.ok !== undefined) return { ...n, result: r }; n.client.close(); } catch {} }, 300, 'restore');
    const after = await marks(next.client);
    row('restored', { result: next.result, after, leftover: machine().localAppDataEntries, screenshot: screenshot(await windowPid(), '6-restored') });
    for (const key of ['memory', 'schedule', 'setting', 'fileHash']) assert.deepEqual(after[key], state.seeded[key], `data restored: ${key}`);
    // Uninstalling with a running sandbox must be clean too.
    const t0 = Date.now();
    await next.client.call('sandbox.provision', {}, 900);
    await until(async () => { const s = await next.client.call('sandbox.status'); return s.state === 'ready' || s.ready ? s : undefined; }, 900, 'sandbox ready');
    await next.client.call('sandbox.selfTest', {}, 300).catch(e => row('selftest-error', { error: e.message }));
    const running = await next.client.call('sandbox.status');
    state.sandboxDistros = [...new Set([...(state.sandboxDistros ?? []), running.distro])]; saveState();
    row('sandbox-running', { provisionMs: Date.now() - t0, distro: running.distro, distros: machine().distros });
    next.client.close();
    proof.passed = true;
  },
  async 'uninstall-all'() {
    const m0 = machine();
    assert.ok(m0.uninstallKey?.uninstall, 'uninstall entry');
    // What Windows Settings › Apps runs, while the app and its sandbox are still running.
    const t0 = Date.now();
    execFileSync('cmd.exe', ['/d', '/s', '/c', m0.uninstallKey.uninstall], { windowsHide: true, timeout: 900000, cwd: process.env.TEMP });
    await until(() => !existsSync(join(root, 'current')), 600, 'uninstall');
    await sleep(8000);
    const m = machine();
    const newDistros = m.distros.filter(d => !state.before.distros.includes(d));
    const newLxss = m.lxss.filter(x => !state.before.lxss.some(y => y.name === x.name));
    const logs = readdirSync(process.env.TEMP).filter(n => n.startsWith('dreamflutter-uninstall-'));
    row('after-uninstall-all', { uninstallMs: Date.now() - t0, machine: m, newDistros, newLxss, uninstallLogs: logs, otherDistrosKept: state.before.distros.every(d => m.distros.includes(d)) });
    assert.equal(m.rootExists, false); assert.equal(m.uninstallKey, null); assert.equal(m.run, null);
    const newShortcuts = m.shortcuts.filter(x => !state.before.shortcuts.includes(x));
    const sandboxMenu = (state.sandboxDistros ?? []).filter(d => m.shortcuts.some(x => x.endsWith(d)));
    row('menu-leftovers', { newShortcuts, sandboxMenu });
    assert.deepEqual(newDistros, []); assert.deepEqual(newLxss, []); assert.deepEqual(newShortcuts, []); assert.deepEqual(sandboxMenu, [], 'WSL start-menu folder of our sandbox removed');
    assert.ok(state.before.distros.every(d => m.distros.includes(d)), "the user's own distros kept");
    proof.passed = true;
  },
};

try {
  assert.ok(phases[phase] && !['update'].includes(phase), `unknown phase ${phase}`);
  await phases[phase]();
  row('done', { passed: proof.passed });
} catch (error) {
  proof.error = error.stack ?? String(error);
  row('failed', { error: error.message });
  process.exitCode = 1;
} finally {
  if (feed?.listening) { feed.closeAllConnections(); feed.close(); }
  writeFileSync(evidence, JSON.stringify(proof, null, 2));
  setTimeout(() => process.exit(), 500).unref();
}
