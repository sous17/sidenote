import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { migrate } from "../src/server/persistence.ts";
import { Store } from "../src/server/store.ts";
import { DAY, FakeClock, SESSION } from "./helpers.ts";

test("reads stores from older versions, prunes them, and saves them privately", () => {
  const file = join(mkdtempSync(join(tmpdir(), "sidenote-store-")), "store.json");
  const now = Date.now() / 1000;
  writeFileSync(
    file,
    JSON.stringify({
      responses: [
        { id: 1, session_id: SESSION, cwd: "/w", text: "hi", created_at: now - 60 },
        { id: 5, session_id: "ancient", cwd: "/w", text: "old", created_at: now - 30 * DAY },
      ],
      comments: [
        {
          id: 2,
          response_id: 1,
          block_index: 0,
          quote: "",
          body: "sent",
          parent_id: null,
          created_at: 6,
          delivered_at: 7,
        },
        { id: 3, response_id: 1, block_index: 0, quote: "", body: "unsent", created_at: 6, delivered_at: null },
      ],
      next_id: 6,
    }),
  );
  const store = new Store({ file });
  const { responses, comments } = store.sessionContent(SESSION);
  assert.deepEqual(responses[0]?.note_answers, {});
  assert.deepEqual(
    comments.map((c) => [c.answered_by, c.parent_id]),
    [
      [0, null],
      [null, null],
    ],
  );
  assert.equal(store.session(SESSION)?.cwd, "/w");
  assert.equal(store.session("ancient"), undefined, "a month-old session is pruned on load");

  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(saved.sessions), [SESSION]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  store.addResponse({ sessionId: SESSION, cwd: "/w", text: "new", sessionName: "", createdAt: undefined });
  assert.equal(new Store({ file }).sessionContent(SESSION).responses.length, 2);
});

test("drops malformed session ids and repairs next_id", () => {
  const data = migrate({
    sessions: { ["__proto__"]: { name: "x", cwd: "/x", last_active: 1 }, ok: { name: "", cwd: "/w", last_active: 1 } },
    responses: [
      { id: 7, session_id: "../evil", cwd: "", text: "", created_at: 1, note_answers: {} },
      { id: 9, session_id: "ok", cwd: "/w", text: "", created_at: 2, note_answers: {} },
    ],
    comments: [],
    next_id: 3,
  });
  assert.deepEqual([...data.sessions.keys()], ["ok"]);
  assert.deepEqual(
    data.responses.map((r) => r.id),
    [9],
  );
  assert.equal(data.nextId, 10, "never reuses an id already on disk");
});

test("messages load from disk, stores without any get none, and ids never collide with them", () => {
  assert.deepEqual(migrate({ responses: [] }).messages, [], "stores from before the message box");
  const data = migrate({
    messages: [
      { id: 12, session_id: "ok", text: "hi", source: "page", created_at: 1, delivered_at: null },
      { id: 13, session_id: "../evil", text: "x", source: "page", created_at: 1, delivered_at: null },
    ],
    next_id: 3,
  });
  assert.deepEqual(
    data.messages.map((m) => m.id),
    [12],
  );
  assert.equal(data.nextId, 13);
});

test("a session's messages are forgotten with it", () => {
  const clock = new FakeClock();
  const store = new Store({ clock });
  store.addResponse({ sessionId: SESSION, cwd: "/w", text: "hi", sessionName: "", createdAt: undefined });
  store.addMessage(SESSION, "hello", "terminal");
  store.addMessage("not-seen-yet", "first prompt", "terminal");
  store.addResponse({ sessionId: "other", cwd: "/w", text: "x", sessionName: "", createdAt: undefined });
  assert.equal(store.sessionContent("not-seen-yet").messages.length, 1, "kept until its first reply arrives");
  clock.advanceDays(8);
  store.addResponse({ sessionId: "other", cwd: "/w", text: "y", sessionName: "", createdAt: undefined });
  assert.equal(store.sessionContent(SESSION).messages.length, 0);
  assert.equal(store.sessionContent("not-seen-yet").messages.length, 0);
});

test("names given in the window are kept, and stores from before them load with none", () => {
  const old = migrate({ sessions: { a: { name: "auth", cwd: "/w", last_active: 1 } } });
  assert.equal(old.sessions.get("a")?.label, "");
  const file = join(mkdtempSync(join(tmpdir(), "sidenote-store-")), "store.json");
  const store = new Store({ file });
  store.touchSession(SESSION, "", "/w");
  store.renameSession(SESSION, "DM-1782 OAuth fix");
  assert.equal(new Store({ file }).session(SESSION)?.label, "DM-1782 OAuth fix");
});
