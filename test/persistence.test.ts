import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { migrate } from "../src/server/persistence.ts";
import { Store } from "../src/server/store.ts";
import { DAY, FakeClock, SESSION } from "./helpers.ts";

function scratchDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "sidenote-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sessionFile = (dir: string, id: string): string => join(dir, "sessions", `${id}.json`);
const addReply = (store: Store, sessionId: string, text = "hi"): number =>
  store.addResponse({ sessionId, cwd: "/w", text, sessionName: "", createdAt: undefined }).response.id;

test("moves a store.json from an older version into session files, pruned and private", (t) => {
  const dir = scratchDir(t);
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
  const store = new Store({ dir });
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

  assert.deepEqual(readdirSync(join(dir, "sessions")), [`${SESSION}.json`]);
  assert.equal(statSync(sessionFile(dir, SESSION)).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "ids.json")).mode & 0o777, 0o600);
  assert.equal(existsSync(file), false);
  assert.ok(existsSync(`${file}.migrated`), "the old store is kept, not deleted");

  addReply(store, SESSION, "new");
  const reloaded = new Store({ dir });
  assert.equal(reloaded.sessionContent(SESSION).responses.length, 2);
  assert.equal(reloaded.sessionContent(SESSION).comments.length, 2);
});

test("a change writes only the session it touched", (t) => {
  const dir = scratchDir(t);
  const store = new Store({ dir });
  addReply(store, "one");
  addReply(store, "two");
  const untouched = sessionFile(dir, "two");
  const marked = `${readFileSync(untouched, "utf8")}\n`;
  writeFileSync(untouched, marked);
  addReply(store, "one", "again");
  assert.equal(readFileSync(untouched, "utf8"), marked);
});

test("forgetting a session deletes its file, and pruning one does too", (t) => {
  const dir = scratchDir(t);
  const clock = new FakeClock();
  const store = new Store({ dir, clock });
  addReply(store, "kept");
  addReply(store, "forgotten");
  addReply(store, "pruned");
  store.forgetSession("forgotten");
  assert.equal(existsSync(sessionFile(dir, "forgotten")), false);
  clock.advanceDays(8);
  addReply(store, "kept");
  assert.deepEqual(readdirSync(join(dir, "sessions")), ["kept.json"]);
});

test("ids aren't reused after the session holding the newest one is forgotten", (t) => {
  const dir = scratchDir(t);
  const store = new Store({ dir });
  addReply(store, "one");
  const newest = addReply(store, "two");
  store.forgetSession("two");
  assert.ok(addReply(new Store({ dir }), "three") > newest);
});

test("a message from before a session's first reply survives a restart", (t) => {
  const dir = scratchDir(t);
  new Store({ dir }).addMessage("not-seen-yet", "first prompt", "terminal");
  const store = new Store({ dir });
  assert.equal(store.sessionContent("not-seen-yet").messages.length, 1);
  assert.equal(store.session("not-seen-yet"), undefined);
  assert.equal(store.forgetSession("not-seen-yet"), true);
  assert.equal(existsSync(sessionFile(dir, "not-seen-yet")), false);
});

test("a damaged session file doesn't cost the others, and stays for whoever looks", (t) => {
  const dir = scratchDir(t);
  const store = new Store({ dir });
  addReply(store, "fine");
  addReply(store, "broken");
  addReply(store, "wrong-shape");
  writeFileSync(sessionFile(dir, "broken"), "{ not json");
  writeFileSync(sessionFile(dir, "wrong-shape"), "null");
  writeFileSync(join(dir, "sessions", "..json"), "{}");
  const reloaded = new Store({ dir });
  assert.deepEqual(
    reloaded.listSessions().map((s) => s.id),
    ["fine"],
  );
  addReply(reloaded, "fine");
  assert.equal(readFileSync(sessionFile(dir, "broken"), "utf8"), "{ not json");
});

test("a lost ids file is rebuilt from the highest id in the sessions", (t) => {
  const dir = scratchDir(t);
  const store = new Store({ dir });
  const newest = addReply(store, "one");
  rmSync(join(dir, "ids.json"));
  assert.ok(addReply(new Store({ dir }), "one") > newest);
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

test("names given in the window are kept, and stores from before them load with none", (t) => {
  const old = migrate({ sessions: { a: { name: "auth", cwd: "/w", last_active: 1 } } });
  assert.equal(old.sessions.get("a")?.label, "");
  const dir = scratchDir(t);
  const store = new Store({ dir });
  store.touchSession(SESSION, "", "/w");
  store.renameSession(SESSION, "DM-1782 OAuth fix");
  assert.equal(new Store({ dir }).session(SESSION)?.label, "DM-1782 OAuth fix");
});

test("a turn sidenote ran keeps its prompt and steps in the session's file", (t) => {
  const dir = scratchDir(t);
  const store = new Store({ dir });
  store.addResponse({
    sessionId: SESSION,
    cwd: "/w",
    text: "Done.",
    sessionName: "",
    createdAt: undefined,
    turn: {
      prompt: "Fix it",
      notesSent: 1,
      steps: [{ tool: "Edit", summary: "a.ts", after_block: -1, failed: false }],
      ended: "interrupted",
    },
  });
  const [reply] = new Store({ dir }).sessionContent(SESSION).responses;
  assert.equal(reply?.prompt, "Fix it");
  assert.equal(reply?.notes_sent, 1);
  assert.deepEqual(reply?.steps, [{ tool: "Edit", summary: "a.ts", after_block: -1, failed: false }]);
  assert.equal(reply?.ended, "interrupted");
});
