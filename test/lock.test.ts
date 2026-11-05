import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { processInfo } from "../src/node/process.ts";
import { acquireServerLock, holdServerLock, releaseServerLock, serverLockOwner } from "../src/server/lock.ts";
import type { ServerInfo } from "../src/shared/types.ts";

const serverScript = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js");
const NO_SUCH_PID = 2 ** 22 + 12345;

function files(): { lock: string } {
  return { lock: join(mkdtempSync(join(tmpdir(), "sidenote-lock-")), "server.lock") };
}

function age(file: string): void {
  const past = new Date(Date.now() - 60_000);
  utimesSync(file, past, past);
}

test("the lock has one owner until it is released", () => {
  const { lock } = files();
  assert.equal(acquireServerLock(lock), true);
  assert.equal(acquireServerLock(lock), false, "held by a running process");
  assert.equal(serverLockOwner(lock), process.pid);
  releaseServerLock(lock);
  assert.equal(existsSync(lock), false);
  assert.equal(serverLockOwner(lock), null);
  assert.equal(acquireServerLock(lock), true);
});

test("a lock left by a crashed server is taken over", () => {
  const { lock } = files();
  writeFileSync(lock, `${NO_SUCH_PID}\nsome day`);
  assert.equal(serverLockOwner(lock), null);
  assert.equal(acquireServerLock(lock), true);
  assert.equal(serverLockOwner(lock), process.pid);
});

test("a server between creating the lock and writing its pid still holds it", () => {
  const { lock } = files();
  writeFileSync(lock, "");
  assert.equal(acquireServerLock(lock), false);
  age(lock);
  assert.equal(acquireServerLock(lock), true, "unless it never finished");
});

test("a lock whose pid now belongs to a later process is taken over, and that process is left alone", () => {
  const { lock } = files();
  writeFileSync(lock, `${process.ppid}\na start time from before a reboot`);
  assert.equal(serverLockOwner(lock), null, "so nothing is told to stop it");
  assert.equal(acquireServerLock(lock), true);
});

test("a live server keeps its lock however old it is, with or without anything else on disk", () => {
  const { lock } = files();
  const started = processInfo(process.ppid)!.started;
  writeFileSync(lock, `${process.ppid}\n${started}`);
  age(lock);
  assert.equal(acquireServerLock(lock), false);
});

test("a lock from before start times counts only if its pid is a sidenote server", () => {
  const { lock } = files();
  writeFileSync(lock, String(process.ppid));
  assert.equal(acquireServerLock(lock), true, "this pid is the test runner, not a server");
});

test("a server holds on to its lock, takes it back if deleted, and notices another owner", () => {
  const { lock } = files();
  acquireServerLock(lock);
  assert.equal(holdServerLock(lock), true);
  rmSync(lock);
  assert.equal(holdServerLock(lock), true);
  assert.equal(serverLockOwner(lock), process.pid);
  writeFileSync(lock, `${process.ppid}\n${processInfo(process.ppid)!.started}`);
  assert.equal(holdServerLock(lock), false);
  releaseServerLock(lock);
  assert.ok(existsSync(lock), "another server's lock isn't released");
});

test("of servers started at the same moment, exactly one keeps running", async () => {
  assert.ok(existsSync(serverScript), "run npm run build first");
  const home = mkdtempSync(join(tmpdir(), "sidenote-home-"));
  mkdirSync(join(home, ".sidenote"));
  const servers: ChildProcess[] = Array.from({ length: 5 }, () =>
    spawn(process.execPath, [serverScript], { env: { ...process.env, HOME: home }, stdio: "ignore" }),
  );
  const exited = new Set<ChildProcess>();
  for (const server of servers) server.on("exit", () => exited.add(server));
  try {
    const deadline = Date.now() + 5000;
    while (exited.size < servers.length - 1 && Date.now() < deadline) await sleep(50);
    await sleep(200);
    assert.equal(servers.length - exited.size, 1);
    const running = servers.find((server) => !exited.has(server));
    const info = JSON.parse(readFileSync(join(home, ".sidenote", "server.json"), "utf8")) as ServerInfo;
    assert.equal(info.pid, running?.pid, "server.json names the survivor");
  } finally {
    for (const server of servers) server.kill();
  }
  await sleep(200);
  assert.equal(existsSync(join(home, ".sidenote", "server.lock")), false, "a clean stop releases the lock");
});

/** A real server in a scratch home, checking on itself every 50ms instead of every 5 seconds. */
async function watchedServer(t: TestContext): Promise<{ server: ChildProcess; dir: string; env: NodeJS.ProcessEnv }> {
  const home = mkdtempSync(join(tmpdir(), "sidenote-home-"));
  const dir = join(home, ".sidenote");
  mkdirSync(dir);
  const env = { ...process.env, HOME: home, SIDENOTE_WATCH_INTERVAL_MS: "50" };
  const server = spawn(process.execPath, [serverScript], { env, stdio: "ignore" });
  t.after(() => {
    server.kill();
    rmSync(home, { recursive: true, force: true });
  });
  await until(() => existsSync(join(dir, "server.json")));
  return { server, dir, env };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("it didn't happen in time");
    await sleep(20);
  }
}

test("a running server puts back a server.json that something deleted", async (t) => {
  const { server, dir } = await watchedServer(t);
  const file = join(dir, "server.json");
  const before = readFileSync(file, "utf8");
  rmSync(file);
  await until(() => existsSync(file));
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(server.exitCode, null);
});

test("with server.json gone, a second server still finds the first and exits", async (t) => {
  const { server, dir, env } = await watchedServer(t);
  rmSync(join(dir, "server.json"));
  const second = spawn(process.execPath, [serverScript], {
    env: { ...env, SIDENOTE_WATCH_INTERVAL_MS: "" },
    stdio: "ignore",
  });
  await once(second, "exit");
  assert.equal(server.exitCode, null);
});

test("a server that lost the lock leaves server.json alone, even when it names that server", async (t) => {
  const { server, dir } = await watchedServer(t);
  const file = join(dir, "server.json");
  const info = (): ServerInfo => JSON.parse(readFileSync(file, "utf8")) as ServerInfo;
  // What a new server's write looks like to a check that still holds the lock: it's put back.
  writeFileSync(file, JSON.stringify({ port: 1, token: "t", pid: process.ppid }));
  await until(() => info().pid === server.pid);
  writeFileSync(join(dir, "server.lock"), `${process.ppid}\n${processInfo(process.ppid)!.started}`);
  await once(server, "exit");
  assert.ok(existsSync(file), "the lock's new owner decides what happens to it");
});

test("a server that lost the lock to another stops, and leaves that server's files alone", async (t) => {
  const { server, dir } = await watchedServer(t);
  const lock = join(dir, "server.lock");
  // In this order, as a new server does it: with server.json first, a check between the two writes
  // would still hold the lock, write server.json back, and remove it again on stopping.
  writeFileSync(lock, `${process.ppid}\n${processInfo(process.ppid)!.started}`);
  writeFileSync(join(dir, "server.json"), JSON.stringify({ port: 1, token: "t", pid: process.ppid }));
  await once(server, "exit");
  assert.ok(existsSync(lock));
  assert.ok(existsSync(join(dir, "server.json")));
});
