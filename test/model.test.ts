import assert from "node:assert/strict";
import { test } from "node:test";
import { Model, sessionLabel } from "../src/web/model.ts";
import type { Note, SessionState, StateSnapshot, StoredResponse, UserMessage } from "../src/shared/types.ts";

function model(status: SessionState, messageAt: number | null, delivered: boolean, replyAt?: number): Model {
  const result = new Model("s");
  const session = { id: "s", name: "", cwd: "/w", last_active: 0, status, send_requested: false };
  const responses = replyAt === undefined ? [] : [{ id: 1, created_at: replyAt } as StoredResponse];
  const messages =
    messageAt === null
      ? []
      : [{ id: 2, created_at: messageAt, delivered_at: delivered ? messageAt : null } as UserMessage];
  result.snapshot = {
    version: 1,
    session,
    folder: "w",
    sessions: [],
    responses,
    comments: [],
    messages,
  } satisfies StateSnapshot;
  return result;
}

test("the dots show from a message being sent until its reply arrives", () => {
  assert.equal(model("listening", 10, false, 5).awaitingReply(), true, "sent, the waiter hasn't taken it yet");
  assert.equal(model("busy", 10, false, 5).awaitingReply(), true, "queued behind Claude's turn");
  assert.equal(model("busy", 10, true, 5).awaitingReply(), true, "Claude has it");
  assert.equal(model("busy", 10, true).awaitingReply(), true, "a first message, with no replies yet");
  assert.equal(model("busy", 10, true, 20).awaitingReply(), false, "the reply arrived");
});

test("the dots don't show when nothing is on its way", () => {
  assert.equal(model("busy", null, false, 5).awaitingReply(), false, "no messages");
  assert.equal(
    model("listening", 10, true, 5).awaitingReply(),
    false,
    "Claude is idle, so the turn ended without a reply",
  );
  assert.equal(model("offline", 10, false, 5).awaitingReply(), false, "nothing can pick it up");
});

test("what Claude is doing shows only with the dots", () => {
  const working = model("busy", 10, true, 5);
  working.snapshot.session!.activity = "Editing a.ts";
  assert.equal(working.activity(), "Editing a.ts");

  const answered = model("busy", 10, true, 20);
  answered.snapshot.session!.activity = "Editing a.ts";
  assert.equal(answered.activity(), "", "the reply arrived");

  assert.equal(model("busy", 10, true, 5).activity(), "", "no tool call yet");
});

test("a note sent with Send now shows the dots and what Claude is doing, until its reply", () => {
  const note = { id: 3, delivered_at: 10, answered_by: null } as Note;
  const working = model("busy", null, false, 5);
  working.snapshot.comments = [note];
  working.snapshot.session!.activity = "Editing a.ts";
  assert.equal(working.awaitingReply(), true);
  assert.equal(working.activity(), "Editing a.ts");

  const answered = model("busy", null, false, 5);
  answered.snapshot.comments = [{ ...note, answered_by: 1 }];
  assert.equal(answered.awaitingReply(), false, "the reply arrived");

  const pending = model("busy", null, false, 5);
  pending.snapshot.comments = [{ ...note, delivered_at: null }];
  assert.equal(pending.awaitingReply(), false, "not sent, so Claude isn't on it");

  const idle = model("listening", null, false, 5);
  idle.snapshot.comments = [note];
  assert.equal(idle.awaitingReply(), false, "the turn ended");
});

test("Claude's messages show only while the reply is awaited", () => {
  const working = model("busy", 10, true, 5);
  working.snapshot.session!.progress = ["Looking.", "Found it."];
  assert.deepEqual(working.progress(), ["Looking.", "Found it."]);

  const answered = model("busy", 10, true, 20);
  answered.snapshot.session!.progress = ["Looking."];
  assert.deepEqual(answered.progress(), [], "the reply took over, so the text isn't shown twice");
});

test("a session is called by its /rename name, else its first message, else its short id", () => {
  const id = "0123456789";
  assert.equal(sessionLabel({ id, name: "auth", first_message: "Fix login" }), "auth");
  assert.equal(sessionLabel({ id, name: "", first_message: "Fix login" }), "Fix login");
  assert.equal(sessionLabel({ id, name: "", first_message: "" }), "Session 01234567");
});
