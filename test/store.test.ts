import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  LISTENER_STALE_MS,
  MAX_RESPONSES_PER_SESSION,
  SESSION_RETENTION_SECONDS,
  Store,
} from "../src/server/store.ts";

const SESSION = "session-a";
const DAY = 24 * 60 * 60;

function storeWithClock() {
  let ms = 0;
  let seconds = 1_000_000;
  const store = new Store({ now: () => seconds + ms / 1000, monotonicMs: () => ms });
  return {
    store,
    advance: (byMs: number) => (ms += byMs),
    advanceDays: (days: number) => (seconds += days * DAY),
  };
}

function reply(store: Store, text: string, sessionId = SESSION, extra: { createdAt?: number; sessionName?: string } = {}) {
  return store.addResponse({ sessionId, cwd: "/w/shop-api", text, ...extra }).response;
}

function noteOn(store: Store, responseId: number, body = "a note") {
  const note = store.addComment({ responseId, blockIndex: 0, quote: "quoted" }, body);
  assert.ok(note);
  return note;
}

test("a live reply answers the session's delivered notes and takes their sections", () => {
  const { store } = storeWithClock();
  const first = reply(store, "Para one.");
  const note = noteOn(store, first.id);
  store.claimPending(SESSION);

  const answer = reply(store, `Main.\n\n**↳ Re: note ${note.id}**\nAnswer.`);
  assert.equal(answer.text, "Main.");
  assert.deepEqual(answer.note_answers, { [note.id]: "Answer." });
  assert.equal(store.snapshot(SESSION).comments[0]!.answered_by, answer.id);
});

test("a reply without markers still answers the notes but keeps its whole text", () => {
  const { store } = storeWithClock();
  const first = reply(store, "Para one.");
  noteOn(store, first.id);
  store.claimPending(SESSION);
  const answer = reply(store, "Done.");
  assert.equal(answer.text, "Done.");
  assert.deepEqual(answer.note_answers, {});
  assert.equal(store.snapshot(SESSION).comments[0]!.answered_by, answer.id);
});

test("backfilled replies and other sessions' replies never answer notes", () => {
  const { store } = storeWithClock();
  const first = reply(store, "Para one.");
  noteOn(store, first.id);
  store.claimPending(SESSION);
  reply(store, "old reply", SESSION, { createdAt: 999_999 });
  reply(store, "other session", "session-b");
  assert.equal(store.snapshot(SESSION).comments[0]!.answered_by, null);
});

test("a snapshot holds only its own session, with the session's name and folder", () => {
  const { store } = storeWithClock();
  const mine = store.addResponse({ sessionId: SESSION, cwd: "/w/shop-api", text: "mine", sessionName: "rate limits" });
  assert.equal(mine.newSession, true);
  assert.equal(reply(store, "again").id > 0, true);
  assert.equal(store.addResponse({ sessionId: SESSION, cwd: "/w/shop-api", text: "x" }).newSession, false);
  const other = reply(store, "theirs", "session-b");
  noteOn(store, other.id);

  const snapshot = store.snapshot(SESSION);
  assert.deepEqual(snapshot.responses.map((r) => r.text), ["mine", "again", "x"]);
  assert.equal(snapshot.comments.length, 0);
  assert.equal(snapshot.session?.name, "rate limits", "a later reply without a name keeps it");
  assert.equal(snapshot.session?.cwd, "/w/shop-api");
  assert.equal(snapshot.session?.status, "offline");

  assert.equal(store.snapshot("unknown").session, null);
  assert.equal(store.snapshot(null).responses.length, 0);
});

test("a session can be registered before its first reply, and keeps its place in the list", () => {
  const { store, advanceDays } = storeWithClock();
  reply(store, "older", "session-b");
  advanceDays(1);
  store.touchSession(SESSION, "named early", "/w/shop-api");
  assert.equal(store.snapshot(SESSION).session?.name, "named early");
  assert.equal(store.addResponse({ sessionId: SESSION, cwd: "/w/shop-api", text: "first" }).newSession, false);
  assert.deepEqual(store.listSessions().map((s) => s.id), [SESSION, "session-b"]);
});

test("sessions idle for longer than the retention period are forgotten with their notes", () => {
  const { store, advanceDays } = storeWithClock();
  const old = reply(store, "old", "session-old");
  noteOn(store, old.id);
  advanceDays(SESSION_RETENTION_SECONDS / DAY - 1);
  reply(store, "recent");
  advanceDays(2);
  reply(store, "today");
  assert.equal(store.snapshot("session-old").session, null);
  assert.deepEqual(store.listSessions().map((s) => s.id), [SESSION]);
});

test("each session keeps only its newest replies", () => {
  const { store } = storeWithClock();
  const oldest = reply(store, "oldest");
  noteOn(store, oldest.id);
  reply(store, "other session", "session-b");
  for (let i = 0; i < MAX_RESPONSES_PER_SESSION; i++) reply(store, `reply ${i}`);
  const snapshot = store.snapshot(SESSION);
  assert.equal(snapshot.responses.length, MAX_RESPONSES_PER_SESSION);
  assert.equal(snapshot.responses[0]!.text, "reply 0");
  assert.equal(snapshot.comments.length, 0);
  assert.equal(store.snapshot("session-b").responses.length, 1, "other sessions are untouched");
});

test("follow-ups join the root thread and are described with the root note", () => {
  const { store } = storeWithClock();
  const first = reply(store, "Para one.");
  const root = noteOn(store, first.id, "Why?");
  const followUp = store.addComment({ parentId: root.id }, "And how?");
  const nested = store.addComment({ parentId: followUp!.id }, "Also?");
  assert.equal(followUp!.parent_id, root.id);
  assert.equal(nested!.parent_id, root.id, "a reply to a follow-up still joins the root");
  assert.equal(followUp!.quote, "quoted");

  const claimed = store.claimPending(SESSION);
  assert.deepEqual(claimed.map((c) => c.root_body), [null, "Why?", "Why?"]);
  assert.equal(store.addComment({ parentId: 999 }, "x"), null);
});

test("deleting a pending note removes its follow-ups, but not once anything was sent", () => {
  const { store } = storeWithClock();
  const first = reply(store, "Para one.");
  const root = noteOn(store, first.id);
  store.addComment({ parentId: root.id }, "follow-up");
  assert.equal(store.deletePendingComment(root.id), true);
  assert.equal(store.snapshot(SESSION).comments.length, 0);

  const sent = noteOn(store, first.id);
  store.claimPending(SESSION);
  store.addComment({ parentId: sent.id }, "pending follow-up");
  assert.equal(store.deletePendingComment(sent.id), false);
});

test("Send now: a listening waiter gets the notes, and the session turns busy", () => {
  const { store, advance } = storeWithClock();
  const first = reply(store, "Para one.");
  store.registerWaiter(SESSION, "w1");
  assert.equal(store.snapshot(SESSION).session?.status, "listening");
  assert.equal(store.pollWaiter(SESSION, "w1").action, "wait");

  noteOn(store, first.id);
  assert.deepEqual(store.requestSend([SESSION]), [SESSION]);
  assert.equal(store.snapshot(SESSION).session?.send_requested, true);
  const result = store.pollWaiter(SESSION, "w1");
  assert.equal(result.action, "send");
  assert.equal(result.comments.length, 1);
  assert.equal(store.snapshot(SESSION).session?.status, "busy");
  assert.equal(store.snapshot(SESSION).session?.send_requested, false);

  // The next turn ends: a new waiter takes over and the old one is told to exit.
  store.registerWaiter(SESSION, "w2");
  assert.equal(store.pollWaiter(SESSION, "w1").action, "exit");
  assert.equal(store.pollWaiter(SESSION, "w2").action, "wait");

  // A waiter that stops polling stops counting as listening.
  advance(LISTENER_STALE_MS + 1);
  assert.equal(store.snapshot(SESSION).session?.status, "offline");
});

test("a terminal prompt makes the waiter stand down and cancels a queued send", () => {
  const { store } = storeWithClock();
  const first = reply(store, "Para one.");
  store.registerWaiter(SESSION, "w1");
  noteOn(store, first.id);
  store.requestSend();
  store.markBusy(SESSION);
  assert.equal(store.pollWaiter(SESSION, "w1").action, "exit");
  assert.equal(store.snapshot(SESSION).session?.status, "busy");
  assert.equal(store.snapshot(SESSION).session?.send_requested, false);
});

test("a send requested while Claude is busy goes to the next waiter at once", () => {
  const { store } = storeWithClock();
  const first = reply(store, "Para one.");
  store.markBusy(SESSION);
  noteOn(store, first.id);
  store.requestSend([SESSION]);
  store.registerWaiter(SESSION, "w1");
  assert.equal(store.pollWaiter(SESSION, "w1").action, "send");
});

test("requestSend only targets sessions with pending notes", () => {
  const { store } = storeWithClock();
  reply(store, "Para one.");
  assert.deepEqual(store.requestSend([SESSION, "unknown"]), []);
});

test("refreshStatus bumps the version only when session status changes", () => {
  const { store, advance } = storeWithClock();
  reply(store, "Para one.");
  store.refreshStatus();
  const version = store.version;
  store.refreshStatus();
  assert.equal(store.version, version);
  store.registerWaiter(SESSION, "w1");
  store.refreshStatus();
  assert.equal(store.version, version + 1);
  advance(LISTENER_STALE_MS + 1);
  store.refreshStatus();
  assert.equal(store.version, version + 2);
});

test("persists sessions, and reads stores written before sessions were tracked", () => {
  const dir = mkdtempSync(join(tmpdir(), "sidenote-store-"));
  const file = join(dir, "store.json");
  const now = Date.now() / 1000;
  writeFileSync(
    file,
    JSON.stringify({
      responses: [
        { id: 1, session_id: SESSION, cwd: "/w", text: "hi", created_at: now - 60 },
        { id: 5, session_id: "ancient", cwd: "/w", text: "old", created_at: now - 30 * DAY },
      ],
      comments: [
        { id: 2, response_id: 1, block_index: 0, quote: "", body: "sent", parent_id: null, created_at: 6, delivered_at: 7 },
        { id: 3, response_id: 1, block_index: 0, quote: "", body: "pending", created_at: 6, delivered_at: null },
      ],
      next_id: 6,
    }),
  );
  const store = new Store({ file });
  const { responses, comments, session } = store.snapshot(SESSION);
  assert.deepEqual(responses[0]!.note_answers, {});
  assert.deepEqual(comments.map((c) => [c.answered_by, c.parent_id]), [[0, null], [null, null]]);
  assert.equal(session?.cwd, "/w");
  assert.equal(store.snapshot("ancient").session, null, "a month-old session is pruned on load");

  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(saved.sessions), [SESSION]);
  assert.equal(reply(store, "new").id, 6);
  assert.equal(new Store({ file }).snapshot(SESSION).responses.length, 2);
});
