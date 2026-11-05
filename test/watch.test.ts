import assert from "node:assert/strict";
import { test } from "node:test";
import { IDLE_MINUTES, ServerWatch, WATCH_INTERVAL_MS, type WatchChecks } from "../src/server/watch.ts";

const IDLE_TICKS = (IDLE_MINUTES * 60_000) / WATCH_INTERVAL_MS;

function watch(overrides: Partial<WatchChecks> = {}): ServerWatch {
  return new ServerWatch({
    holdsLock: () => true,
    isRegistered: () => true,
    register: () => {},
    working: () => false,
    ...overrides,
  });
}

function tick(target: ServerWatch, times: number): string | null {
  let reason: string | null = null;
  for (let count = 0; count < times; count += 1) reason = target.tick();
  return reason;
}

test("a server nothing uses stops after the idle time, and not before", () => {
  const target = watch();
  assert.equal(tick(target, IDLE_TICKS - 1), null);
  assert.match(target.tick() ?? "", /nothing used it/);
});

test("any use starts the idle time again", () => {
  const target = watch();
  tick(target, IDLE_TICKS - 1);
  target.active();
  assert.equal(tick(target, IDLE_TICKS - 1), null);
});

test("a server that lost the lock stops at once, however busy it is", () => {
  const target = watch({ holdsLock: () => false });
  target.active();
  assert.match(target.tick() ?? "", /another server/);
});

test("server.json is written again only when it doesn't name this server", () => {
  let registered = false;
  let writes = 0;
  const target = watch({
    isRegistered: () => registered,
    register: () => {
      registered = true;
      writes += 1;
    },
  });
  tick(target, 3);
  assert.equal(writes, 1);
});

test("the lock is checked before server.json, so a replaced server can't overwrite the new one's", () => {
  let writes = 0;
  const target = watch({ holdsLock: () => false, isRegistered: () => false, register: () => (writes += 1) });
  target.tick();
  assert.equal(writes, 0);
});

test("a turn in progress keeps the server up with no client watching, and the idle time starts after it", () => {
  let working = true;
  const target = watch({ working: () => working });
  assert.equal(tick(target, IDLE_TICKS * 2), null);
  working = false;
  assert.equal(tick(target, IDLE_TICKS - 1), null);
  assert.match(target.tick() ?? "", /nothing used it/);
});

test("a turn in progress doesn't keep a server that lost the lock", () => {
  const target = watch({ working: () => true, holdsLock: () => false });
  assert.match(target.tick() ?? "", /another server/);
});
