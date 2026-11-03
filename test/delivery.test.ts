import assert from "node:assert/strict";
import { test } from "node:test";
import { LISTENER_STALE_MS } from "../src/server/delivery.ts";
import { SESSION, fixture, noteOn, reply } from "./helpers.ts";

test("a listening waiter gets the notes, and the session turns busy", () => {
  const { clock, store, delivery } = fixture();
  const first = reply(store, "Para one.");
  delivery.registerWaiter(SESSION, "w1");
  assert.equal(delivery.status(SESSION).status, "listening");
  assert.equal(delivery.pollWaiter(SESSION, "w1").action, "wait");

  noteOn(store, first.id);
  assert.deepEqual(delivery.requestSend([SESSION]), [SESSION]);
  assert.equal(delivery.status(SESSION).send_requested, true);
  const result = delivery.pollWaiter(SESSION, "w1");
  assert.equal(result.action, "send");
  assert.equal(result.comments.length, 1);
  assert.deepEqual(delivery.status(SESSION), { status: "busy", send_requested: false });

  // The next turn ends: a new waiter takes over and the old one is told to exit.
  delivery.registerWaiter(SESSION, "w2");
  assert.equal(delivery.pollWaiter(SESSION, "w1").action, "exit");
  assert.equal(delivery.pollWaiter(SESSION, "w2").action, "wait");

  // A waiter that stops polling stops counting as listening.
  clock.advanceMs(LISTENER_STALE_MS + 1);
  assert.equal(delivery.status(SESSION).status, "offline");
});

test("a terminal prompt makes the waiter stand down and cancels a queued send", () => {
  const { store, delivery } = fixture();
  noteOn(store, reply(store, "Para one.").id);
  delivery.registerWaiter(SESSION, "w1");
  delivery.requestSend([SESSION]);
  delivery.markBusy(SESSION);
  assert.equal(delivery.pollWaiter(SESSION, "w1").action, "exit");
  assert.deepEqual(delivery.status(SESSION), { status: "busy", send_requested: false });
});

test("a send requested while Claude is busy goes to the next waiter at once", () => {
  const { store, delivery } = fixture();
  const first = reply(store, "Para one.");
  delivery.markBusy(SESSION);
  noteOn(store, first.id);
  delivery.requestSend([SESSION]);
  delivery.registerWaiter(SESSION, "w1");
  assert.equal(delivery.pollWaiter(SESSION, "w1").action, "send");
});

test("a send only targets the named sessions that have unsent notes", () => {
  const { store, delivery } = fixture();
  reply(store, "no notes here");
  noteOn(store, reply(store, "other", { sessionId: "session-b" }).id);
  assert.deepEqual(delivery.requestSend([SESSION, "unknown"]), []);
  assert.equal(delivery.status("session-b").send_requested, false, "other sessions are never sent implicitly");
});

test("refresh bumps the revision only when a session's status changes", () => {
  const { clock, store, delivery } = fixture();
  reply(store, "Para one.");
  delivery.refresh();
  const revision = store.revision.value;
  delivery.refresh();
  assert.equal(store.revision.value, revision);
  delivery.registerWaiter(SESSION, "w1");
  delivery.refresh();
  assert.equal(store.revision.value, revision + 1);
  clock.advanceMs(LISTENER_STALE_MS + 1);
  delivery.refresh();
  assert.equal(store.revision.value, revision + 2);
});

test("agents without a waiter: notes saved before a turn go out when it ends", () => {
  const { store, delivery } = fixture();
  noteOn(store, reply(store, "Para one.").id);
  delivery.startTurn(SESSION);
  assert.equal(delivery.status(SESSION).status, "busy");
  const claimed = delivery.endTurn(SESSION);
  assert.equal(claimed.length, 1);
  assert.equal(delivery.status(SESSION).status, "busy", "the agent goes straight on to answer them");
  assert.deepEqual(delivery.endTurn(SESSION), [], "the follow-up turn ends with nothing more to send");
  assert.equal(delivery.status(SESSION).status, "offline");
});

test("agents without a waiter: Send now during a turn goes out when it ends", () => {
  const { store, delivery } = fixture();
  const first = reply(store, "Para one.");
  delivery.startTurn(SESSION);
  noteOn(store, first.id);
  assert.deepEqual(delivery.requestSend([SESSION]), [SESSION]);
  assert.equal(delivery.endTurn(SESSION).length, 1);
});

test("a turn ending with nothing queued sends nothing", () => {
  const { store, delivery } = fixture();
  noteOn(store, reply(store, "Para one.").id);
  assert.deepEqual(delivery.endTurn(SESSION), [], "saved notes wait for a prompt");
});
