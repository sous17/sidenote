import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { migrate } from "../src/server/persistence.ts";
import { Store } from "../src/server/store.ts";
import { DAY, SESSION } from "./helpers.ts";

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
