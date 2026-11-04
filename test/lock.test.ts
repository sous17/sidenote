import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { acquireServerLock, releaseServerLock } from "../src/server/lock.ts";
import type { ServerInfo } from "../src/shared/types.ts";

const serverScript = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js");
const NO_SUCH_PID = 2 ** 22 + 12345;

function files(): { lock: string; server: string } {
  const dir = mkdtempSync(join(tmpdir(), "sidenote-lock-"));
  return { lock: join(dir, "server.lock"), server: join(dir, "server.json") };
}

function age(file: string): void {
  const past = new Date(Date.now() - 60_000);
  utimesSync(file, past, past);
}

test("the lock has one owner until it is released", () => {
  const { lock, server } = files();
  assert.equal(acquireServerLock(lock, server), true);
  assert.equal(acquireServerLock(lock, server), false, "held by a running process");
  releaseServerLock(lock);
  assert.equal(existsSync(lock), false);
  assert.equal(acquireServerLock(lock, server), true);
});

test("a lock left by a crashed server is taken over", () => {
  const { lock, server } = files();
  writeFileSync(lock, String(NO_SUCH_PID));
  assert.equal(acquireServerLock(lock, server), true);
  assert.equal(readFileSync(lock, "utf8"), String(process.pid));
});

test("a server between creating the lock and writing its pid still holds it", () => {
  const { lock, server } = files();
  writeFileSync(lock, "");
  assert.equal(acquireServerLock(lock, server), false);
  age(lock);
  assert.equal(acquireServerLock(lock, server), true, "unless it never finished");
});

test("an old lock whose pid now belongs to something else is taken over", () => {
  const { lock, server } = files();
  writeFileSync(lock, String(process.ppid));
  age(lock);
  writeFileSync(server, JSON.stringify({ port: 1, token: "t", pid: NO_SUCH_PID }));
  assert.equal(acquireServerLock(lock, server), true);
});

test("a long-running server keeps its lock", () => {
  const { lock, server } = files();
  writeFileSync(lock, String(process.ppid));
  age(lock);
  writeFileSync(server, JSON.stringify({ port: 1, token: "t", pid: process.ppid }));
  assert.equal(acquireServerLock(lock, server), false);
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
