import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import WebSocket from "ws";
import { Db } from "../src/db.ts";
import { corePaths } from "../src/paths.ts";
import { moveResultFile, pendingMoveFile, requestMove } from "../src/storage/move.ts";

it("normal main process stops, copies, restarts, reconnects at the stable discovery root and retains category paths", { timeout: 120_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "df-storage-process-")), root = join(temporary, "data");
  const children: ChildProcess[] = [];
  let socket: WebSocket | undefined;
  let serial = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  async function start() {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", resolve("src/main.ts"), "--data-dir", root, "--echo-log"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let output = "", errors = "";
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error("main did not become ready: " + errors)), 60_000);
      child.stderr!.on("data", (data) => { errors += data; });
      child.stdout!.on("data", (data) => {
        output += data;
        if (output.split(/\r?\n/).slice(0, -1).some((line) => line.startsWith("{") && JSON.parse(line).ready)) { clearTimeout(timer); done(); }
      });
      child.once("exit", (code) => { clearTimeout(timer); if (!output.includes('"ready":true')) reject(new Error(`main exited ${code}: ${errors}`)); });
    });
    const info = JSON.parse(readFileSync(join(root, "core.json"), "utf8"));
    socket = new WebSocket(`ws://127.0.0.1:${info.port}`, { headers: { Authorization: `Bearer ${info.token}` } });
    await new Promise<void>((done, reject) => { socket!.once("open", done); socket!.once("error", reject); });
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
    });
    return child;
  }
  function call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++serial;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timed out: ${method}`)); }, 10_000);
      pending.set(id, { resolve(value) { clearTimeout(timer); done(value); }, reject(error) { clearTimeout(timer); reject(error); } });
      socket!.send(JSON.stringify({ id, method, params }));
    });
  }
  async function exited(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error("core did not stop normally")), 10_000);
      child.once("exit", () => { clearTimeout(timer); done(); });
    });
  }
  try {
    let child = await start();
    await call("settings.update", { memoryPaused: true, memoryAutoExtract: false, autoTitle: false, memoryMinFreeBytes: 123 });
    const initial = await call("storage.locations");
    assert.match(initial.rows.find((r: any) => r.id === "database").path, /application-data/);
    for (const kind of ["database", "configuration", "sessions", "cache"]) {
      const old = (await call("storage.locations")).rows.find((r: any) => r.id === kind).path;
      const target = join(temporary, `new-${kind}`);
      const request = await call("storage.move", { kind, target });
      assert.equal(request.restartRequired, true);
      await exited(child);
      child = await start();
      const locations = await call("storage.locations");
      assert.equal(locations.rows.find((r: any) => r.id === kind).path, target);
      assert.equal(locations.lastMove.id, request.id);
      assert.equal(locations.lastMove.ok, true);
      assert.ok(existsSync(locations.lastMove.backup));
      const hello = await call("core.hello");
      assert.equal(hello.settings.memoryMinFreeBytes, 123);
      assert.equal(hello.sessionDir, locations.rows.find((r: any) => r.id === "sessions").path);
      if (kind === "database") assert.equal(existsSync(join(old, "core.db")), false);
      assert.equal(existsSync(join(root, "storage-move.json")), false);
    }
    await call("core.shutdown"); await exited(child);
    child = await start();
    assert.equal((await call("storage.locations")).rows.find((r: any) => r.id === "sessions").path, join(temporary, "new-sessions"));
    await call("core.shutdown"); await exited(child);
  } finally {
    socket?.terminate();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited(child); }
    assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + "\\df-storage-process-") || resolve(temporary).startsWith(resolve(tmpdir()) + "/df-storage-process-"));
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

it("a startup and rollback-result failure exits, retains recovery journal and recovers on the next normal start", { timeout: 90_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "df-storage-process-failure-")), root = join(temporary, "data"), target = join(temporary, "target");
  mkdirSync(root); mkdirSync(join(root, "pi")); const db = new Db(join(root, "core.db")); db.close();
  requestMove(root, "database", target, join(root, "pi"), join(root, "pi", "sessions"), join(root, "core.db"));
  mkdirSync(moveResultFile(root));
  const occupying = createServer(); await new Promise<void>((done) => occupying.listen(0, "127.0.0.1", done));
  const port = (occupying.address() as { port: number }).port;
  const children: ChildProcess[] = [];
  const exited = (child: ChildProcess) => new Promise<number | null>((done, reject) => {
    if (child.exitCode !== null) { done(child.exitCode); return; }
    const timer = setTimeout(() => reject(new Error("failed core must exit instead of retaining an instance lock")), 30_000);
    child.once("exit", (code) => { clearTimeout(timer); done(code); });
  });
  try {
    const failed = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", resolve("src/main.ts"), "--data-dir", root, "--port", String(port), "--echo-log"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let failureLog = ""; failed.stderr!.on("data", (data) => { failureLog += data; });
    children.push(failed);
    assert.equal(await exited(failed), 1, failureLog);
    assert.equal(existsSync(join(root, "core.lock")), false);
    assert.ok(existsSync(pendingMoveFile(root)));
    assert.equal(corePaths(root).dbFile, join(root, "core.db"));
    rmSync(moveResultFile(root), { recursive: true });
    const recovered = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", resolve("src/main.ts"), "--data-dir", root], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    children.push(recovered);
    await new Promise<void>((done, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("recovery did not become ready")), 30_000);
      recovered.stdout!.on("data", (chunk) => { output += chunk; if (output.includes('"ready":true')) { clearTimeout(timer); done(); } });
      recovered.once("exit", (code) => { clearTimeout(timer); if (!output.includes('"ready":true')) reject(new Error(`recovery exited ${code}`)); });
    });
    assert.equal(JSON.parse(readFileSync(moveResultFile(root), "utf8")).ok, false);
    assert.equal(existsSync(pendingMoveFile(root)), false);
    assert.ok(existsSync(join(root, "core.db"))); assert.equal(existsSync(target), false);
    recovered.kill("SIGTERM"); await exited(recovered);
  } finally {
    await new Promise<void>((done) => occupying.close(() => done()));
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited(child); }
    assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + "\\df-storage-process-failure-") || resolve(temporary).startsWith(resolve(tmpdir()) + "/df-storage-process-failure-"));
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
