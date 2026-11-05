import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MAX_RESPONSES_PER_SESSION, SESSION_RETENTION_SECONDS } from "../src/server/store.ts";
import { DAY, SESSION, fixture, noteOn, reply } from "./helpers.ts";

describe("answers", () => {
  test("a live reply answers the session's delivered notes and takes their sections", () => {
    const { store } = fixture();
    const first = reply(store, "Para one.");
    const note = noteOn(store, first.id);
    store.claimPending(SESSION);

    const answer = reply(store, `Main.\n\n**↳ Re: note ${note.id}**\nAnswer.`);
    assert.equal(answer.text, "Main.");
    assert.deepEqual(answer.note_answers, { [note.id]: "Answer." });
    assert.equal(store.sessionContent(SESSION).comments[0]?.answered_by, answer.id);
  });

  test("a reply without markers still answers the notes but keeps its whole text", () => {
    const { store } = fixture();
    noteOn(store, reply(store, "Para one.").id);
    store.claimPending(SESSION);
    const answer = reply(store, "Done.");
    assert.equal(answer.text, "Done.");
    assert.deepEqual(answer.note_answers, {});
    assert.equal(store.sessionContent(SESSION).comments[0]?.answered_by, answer.id);
  });

  test("backfilled replies and other sessions' replies never answer notes", () => {
    const { store } = fixture();
    noteOn(store, reply(store, "Para one.").id);
    store.claimPending(SESSION);
    reply(store, "old reply", { createdAt: 999_999 });
    reply(store, "other session", { sessionId: "session-b" });
    assert.equal(store.sessionContent(SESSION).comments[0]?.answered_by, null);
  });
});

describe("sessions", () => {
  test("content is per session, and a session keeps its name and folder", () => {
    const { store } = fixture();
    const first = store.addResponse({
      sessionId: SESSION,
      cwd: "/w/shop-api",
      text: "mine",
      sessionName: "rate limits",
      createdAt: undefined,
    });
    assert.equal(first.newSession, true);
    reply(store, "again");
    noteOn(store, reply(store, "theirs", { sessionId: "session-b" }).id);

    const content = store.sessionContent(SESSION);
    assert.deepEqual(
      content.responses.map((r) => r.text),
      ["mine", "again"],
    );
    assert.equal(content.comments.length, 0);
    assert.equal(store.session(SESSION)?.name, "rate limits", "a later reply without a name keeps it");
    assert.equal(store.session(SESSION)?.cwd, "/w/shop-api");
    assert.equal(store.session("unknown"), undefined);
  });

  test("ids that look like Object keys are ordinary sessions", () => {
    const { store } = fixture();
    reply(store, "x", { sessionId: "constructor" });
    reply(store, "y", { sessionId: "toString" });
    assert.equal(store.session("hasOwnProperty"), undefined);
    assert.deepEqual(
      store
        .listSessions()
        .map((s) => s.id)
        .sort(),
      ["constructor", "toString"],
    );
    assert.equal(({} as Record<string, unknown>)["cwd"], undefined, "Object.prototype is untouched");
  });

  test("a session can be registered before its first reply", () => {
    const { clock, store } = fixture();
    reply(store, "older", { sessionId: "session-b" });
    clock.advanceDays(1);
    store.touchSession(SESSION, "named early", "/w/shop-api");
    assert.equal(store.session(SESSION)?.name, "named early");
    assert.equal(
      store.addResponse({ sessionId: SESSION, cwd: "/w", text: "first", sessionName: "", createdAt: undefined })
        .newSession,
      false,
    );
    assert.deepEqual(
      store.listSessions().map((s) => s.id),
      [SESSION, "session-b"],
    );
  });

  test("a folder's sessions are those whose cwd ends in it, latest first, with what their rows show", () => {
    const { clock, store } = fixture();
    reply(store, "a", { sessionId: "older" });
    store.addMessage("older", "  Fix the\nlogin   bug ", "terminal");
    noteOn(store, reply(store, "b", { sessionId: "older" }).id);
    clock.advanceDays(1);
    reply(store, "c", { sessionId: "elsewhere", cwd: "/w/other" });
    reply(store, "d", { sessionId: "newer", cwd: "/home/me/shop-api" });
    reply(store, "e", { sessionId: "nested", cwd: "/w/shop-api/sub" });

    const sessions = store.folderSessions("shop-api");
    assert.deepEqual(
      sessions.map((session) => session.id),
      ["newer", "older"],
      "same folder name in two places is one window; a subfolder is its own",
    );
    assert.equal(sessions[1]?.first_message, "Fix the login bug");
    assert.equal(sessions[1]?.pending_notes, 1);
    assert.equal(sessions[0]?.first_message, "");
    assert.equal(sessions[0]?.pending_notes, 0);
  });
});

describe("retention", () => {
  test("sessions idle longer than the retention period are forgotten with their notes", () => {
    const { clock, store } = fixture();
    noteOn(store, reply(store, "old", { sessionId: "session-old" }).id);
    clock.advanceDays(SESSION_RETENTION_SECONDS / DAY - 1);
    reply(store, "recent");
    clock.advanceDays(2);
    reply(store, "today");
    assert.equal(store.session("session-old"), undefined);
    assert.deepEqual(
      store.listSessions().map((s) => s.id),
      [SESSION],
    );
  });

  test("each session keeps only its newest replies", () => {
    const { store } = fixture();
    noteOn(store, reply(store, "oldest").id);
    reply(store, "other session", { sessionId: "session-b" });
    for (let i = 0; i < MAX_RESPONSES_PER_SESSION; i++) reply(store, `reply ${i}`);
    const content = store.sessionContent(SESSION);
    assert.equal(content.responses.length, MAX_RESPONSES_PER_SESSION);
    assert.equal(content.responses[0]?.text, "reply 0");
    assert.equal(content.comments.length, 0);
    assert.equal(store.sessionContent("session-b").responses.length, 1, "other sessions are untouched");
  });
});

describe("notes", () => {
  test("follow-ups join the root thread and are described with the root note", () => {
    const { store } = fixture();
    const root = noteOn(store, reply(store, "Para one.").id, "Why?");
    const followUp = store.addNote({ kind: "follow-up", parentId: root.id, body: "And how?" });
    const nested = store.addNote({ kind: "follow-up", parentId: followUp!.id, body: "Also?" });
    assert.equal(followUp?.parent_id, root.id);
    assert.equal(nested?.parent_id, root.id, "a reply to a follow-up still joins the root");
    assert.equal(followUp?.quote, "quoted");
    assert.deepEqual(
      store.claimPending(SESSION).map((c) => c.root_body),
      [null, "Why?", "Why?"],
    );
    assert.equal(store.addNote({ kind: "follow-up", parentId: 999, body: "x" }), null);
    assert.equal(store.addNote({ kind: "root", responseId: 999, blockIndex: 0, quote: "", body: "x" }), null);
  });

  test("editing an unsent note keeps its place in the thread, and a sent note can't be edited", () => {
    const { store } = fixture();
    const response = reply(store, "Hi.");
    const root = noteOn(store, response.id, "Tpyo");
    const followUp = store.addNote({ kind: "follow-up", parentId: root.id, body: "More" })!;
    const stored = (id: number) => store.sessionContent(SESSION).comments.find((note) => note.id === id);

    assert.equal(store.noteSession(followUp.id), SESSION);
    assert.equal(store.noteSession(9999), null);
    assert.equal(store.editPendingNote(root.id, "Typo"), true);
    assert.deepEqual(stored(root.id), { ...root, body: "Typo" }, "only the text changes");
    assert.equal(stored(followUp.id)?.parent_id, root.id);

    store.claimPending(SESSION);
    assert.equal(store.editPendingNote(root.id, "Too late"), false);
    assert.equal(stored(root.id)?.body, "Typo");
    assert.equal(store.editPendingNote(9999, "x"), false);
  });

  test("deleting an unsent note removes its follow-ups, but not once anything was sent", () => {
    const { store } = fixture();
    const first = reply(store, "Para one.");
    const root = noteOn(store, first.id);
    store.addNote({ kind: "follow-up", parentId: root.id, body: "follow-up" });
    assert.equal(store.deletePendingNote(root.id), true);
    assert.equal(store.sessionContent(SESSION).comments.length, 0);

    const sent = noteOn(store, first.id);
    store.claimPending(SESSION);
    store.addNote({ kind: "follow-up", parentId: sent.id, body: "unsent follow-up" });
    assert.equal(store.deletePendingNote(sent.id), false);
  });

  test("every change bumps the revision pages poll with", () => {
    const { store } = fixture();
    const before = store.revision.value;
    reply(store, "x");
    assert.equal(store.revision.value, before + 1);
  });
});

describe("session list", () => {
  test("a name given in the window survives the /rename name a reply brings", () => {
    const { store } = fixture();
    reply(store, "a");
    assert.equal(store.renameSession(SESSION, "DM-1782 OAuth fix"), true);
    reply(store, "b", { sessionName: "auth" });
    assert.deepEqual([store.session(SESSION)?.label, store.session(SESSION)?.name], ["DM-1782 OAuth fix", "auth"]);
    assert.equal(store.renameSession("unknown", "x"), false);
  });

  test("forgetting a session drops its replies, notes and messages, and nothing of others", () => {
    const { store } = fixture();
    noteOn(store, reply(store, "a").id);
    store.addMessage(SESSION, "hi", "terminal");
    reply(store, "kept", { sessionId: "session-b" });
    const revision = store.revision.value;
    assert.equal(store.forgetSession(SESSION), true);
    assert.ok(store.revision.value > revision);
    assert.equal(store.session(SESSION), undefined);
    assert.deepEqual(store.sessionContent(SESSION), { responses: [], comments: [], messages: [] });
    assert.equal(store.sessionContent("session-b").responses.length, 1);
    assert.equal(store.forgetSession(SESSION), false);
  });
});
