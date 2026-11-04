import assert from "node:assert/strict";
import { test } from "node:test";
import { LISTENER_STALE_MS } from "../src/server/delivery.ts";
import { MAX_PROMPT_CHARS } from "../src/shared/types.ts";
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

test("a message from the page wakes a listening waiter, with pending notes alongside", () => {
  const { store, delivery } = fixture();
  noteOn(store, reply(store, "Para one.").id);
  delivery.registerWaiter(SESSION, "w1");
  assert.equal(delivery.requestPrompt(SESSION, "Now add tests"), "sent");
  assert.equal(delivery.status(SESSION).queued_prompt, "Now add tests");

  const result = delivery.pollWaiter(SESSION, "w1");
  assert.equal(result.action, "send");
  assert.equal(result.prompt, "Now add tests");
  assert.equal(result.comments.length, 1, "pending notes ride along");
  assert.deepEqual(delivery.status(SESSION), { status: "busy", send_requested: false });

  const [message] = store.sessionContent(SESSION).messages;
  assert.equal(message?.text, "Now add tests");
  assert.notEqual(message?.delivered_at, null, "shown as delivered once Claude has it");
});

test("messages sent while Claude is busy wait together for the next waiter", () => {
  const { store, delivery } = fixture();
  reply(store, "Para one.");
  delivery.markBusy(SESSION);
  assert.equal(delivery.requestPrompt(SESSION, "first"), "queued");
  assert.equal(delivery.requestPrompt(SESSION, "second"), "queued");
  delivery.registerWaiter(SESSION, "w1");
  const result = delivery.pollWaiter(SESSION, "w1");
  assert.equal(result.action, "send");
  assert.equal(result.prompt, "first\n\nsecond");
  assert.deepEqual(result.comments, [], "a message goes even without notes");
});

test("a waiting message rides along with a terminal prompt instead of being lost", () => {
  const { store, delivery } = fixture();
  reply(store, "Para one.");
  delivery.markBusy(SESSION);
  delivery.requestPrompt(SESSION, "from the page");
  delivery.markBusy(SESSION);
  assert.equal(delivery.status(SESSION).queued_prompt, "from the page", "a terminal prompt doesn't drop it");
  assert.equal(store.claimMessages(SESSION), "from the page");
  assert.equal(delivery.status(SESSION).queued_prompt, undefined);
});

test("a message can't go to a session that isn't listening, or grow past the limit", () => {
  const { store, delivery } = fixture();
  reply(store, "Para one.");
  assert.equal(delivery.requestPrompt(SESSION, "hello?"), "offline");
  assert.equal(delivery.status(SESSION).queued_prompt, undefined);

  delivery.registerWaiter(SESSION, "w1");
  assert.equal(delivery.requestPrompt(SESSION, "x".repeat(MAX_PROMPT_CHARS + 1)), "too-long");
  assert.equal(delivery.requestPrompt(SESSION, "x".repeat(MAX_PROMPT_CHARS - 1)), "sent");
  assert.equal(delivery.requestPrompt(SESSION, "more"), "too-long", "joining would pass the limit");
  assert.equal(delivery.status(SESSION).queued_prompt?.length, MAX_PROMPT_CHARS - 1);
});

test("a message stays visible from the moment it is sent, even if a wake-up marks the session busy", () => {
  const { store, delivery } = fixture();
  reply(store, "Para one.");
  delivery.registerWaiter(SESSION, "w1");
  delivery.requestPrompt(SESSION, "testing the button");
  assert.equal(store.sessionContent(SESSION).messages[0]?.delivered_at, null, "waiting until the waiter takes it");
  delivery.pollWaiter(SESSION, "w1");
  delivery.markBusy(SESSION);
  reply(store, "Got it.");
  assert.deepEqual(
    store.sessionContent(SESSION).messages.map((m) => [m.text, m.source]),
    [["testing the button", "page"]],
  );
});
