import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ConversationView,
  NewNoteRequest,
  Note,
  SessionState,
  SessionSummary,
  StateSnapshot,
  StoredResponse,
} from "../src/shared/types.ts";
import { App, type ChatApi, type Terminal, type TuiApi } from "../src/tui/app.ts";
import { parseKeys } from "../src/tui/keys.ts";

const SESSION = "s1";

const REPLY_ONE = "First reply.";
const REPLY_TWO = [
  "I moved the check into verifyToken.",
  "",
  "- it runs on both routes",
  "- it compares in constant time",
  "",
  "```ts",
  "const a = 1;",
  "const b = 2;",
  "const c = 3;",
  "```",
].join("\n");

/** An in-memory server: notes added through it show up in the next state. */
class FakeApi implements TuiApi {
  snapshot: StateSnapshot;
  sessionList: SessionSummary[] = [];
  readonly added: NewNoteRequest[] = [];
  readonly deleted: number[] = [];
  sends = 0;
  #nextId = 100;

  constructor(responses: StoredResponse[], comments: Note[] = [], status: SessionState = "listening") {
    this.snapshot = {
      version: 1,
      session: { id: SESSION, name: "auth-refactor", cwd: "/w/demo", last_active: 0, status, send_requested: false },
      responses,
      comments,
    };
  }

  async sessions(): Promise<SessionSummary[]> {
    return this.sessionList;
  }

  async state(known: number): Promise<StateSnapshot | null> {
    return known === this.snapshot.version ? null : structuredClone(this.snapshot);
  }

  async addNote(request: NewNoteRequest): Promise<void> {
    this.added.push(request);
    const parent = "parent_id" in request ? this.snapshot.comments.find((n) => n.id === request.parent_id) : undefined;
    this.change({
      comments: [
        ...this.snapshot.comments,
        note({
          id: this.#nextId++,
          body: request.body,
          ...("parent_id" in request
            ? { parent_id: request.parent_id, response_id: parent!.response_id, block_index: parent!.block_index }
            : { response_id: request.response_id, block_index: request.block_index, quote: request.quote }),
        }),
      ],
    });
  }

  async deleteNote(id: number): Promise<void> {
    this.deleted.push(id);
    this.change({ comments: this.snapshot.comments.filter((n) => n.id !== id) });
  }

  async send(): Promise<void> {
    this.sends += 1;
  }

  change(fields: Partial<StateSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...fields, version: this.snapshot.version + 1 };
  }
}

class FakeTerminal implements Terminal {
  columns: number;
  rows: number;
  frame: string[] = [];
  cursor: { row: number; column: number } | null = null;
  quit = (): void => {
    this.quitted = true;
  };
  quitted = false;
  edited: string | null = null;

  constructor(columns = 80, rows = 30) {
    this.columns = columns;
    this.rows = rows;
  }

  size(): { columns: number; rows: number } {
    return { columns: this.columns, rows: this.rows };
  }

  draw(rows: string[], cursor: { row: number; column: number } | null): void {
    this.frame = rows;
    this.cursor = cursor;
  }

  async editText(): Promise<string | null> {
    return this.edited;
  }

  /** The frame as plain text, with sidenote's own color codes removed. */
  get text(): string[] {
    return this.frame.map((row) => row.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[!-~]*?\x1b\\/g, ""));
  }

  /** The rows the cursor is on, marked by the gutter. */
  get selected(): string[] {
    return this.text.filter((row) => row.startsWith("▌ ")).map((row) => row.slice(2).trimEnd());
  }

  has(text: string): boolean {
    return this.text.some((row) => row.includes(text));
  }
}

function reply(id: number, text: string, fields: Partial<StoredResponse> = {}): StoredResponse {
  return {
    id,
    session_id: SESSION,
    cwd: "/w/demo",
    text,
    created_at: 1_700_000_000 + id * 60,
    note_answers: {},
    ...fields,
  };
}

function note(fields: Partial<Note> & Pick<Note, "id" | "body">): Note {
  return {
    response_id: 2,
    block_index: 0,
    quote: "",
    parent_id: null,
    created_at: 1_700_000_500 + fields.id,
    delivered_at: null,
    answered_by: null,
    ...fields,
  };
}

async function start(api: FakeApi, terminal = new FakeTerminal()): Promise<{ app: App; terminal: FakeTerminal }> {
  const app = new App({ api, terminal, ansi: { color: true, hyperlinks: true }, sessionId: SESSION, cwd: "/w/demo" });
  await app.refresh();
  return { app, terminal };
}

async function press(app: App, data: string): Promise<void> {
  for (const key of parseKeys(data)) await app.handleKey(key);
}

test("opens on the latest reply, with the cursor on its first block", async () => {
  const { terminal } = await start(new FakeApi([reply(1, REPLY_ONE), reply(2, REPLY_TWO)]));
  assert.match(terminal.text[0]!, /^sidenote · auth-refactor +● listening$/);
  assert.match(terminal.text[1]!, /^ {2}── [^─]+ ─+$/, "the latest reply's header is at the top");
  assert.deepEqual(terminal.selected, ["I moved the check into verifyToken."]);
  assert.match(terminal.text.at(-1)!, /j\/k move · n note · N note on reply · q quit/);
});

test("writes a note on a block and sends it to Claude", async () => {
  const api = new FakeApi([reply(2, REPLY_TWO)]);
  const { app, terminal } = await start(api);
  await press(app, "jn");
  assert.ok(terminal.has("── Note on: it runs on both routes"), "the editor says what the note is about");
  assert.ok(terminal.has("Your note for Claude…"));
  await press(app, "why both?");
  assert.ok(terminal.has("  why both?"));
  assert.deepEqual(terminal.cursor, { row: terminal.rows - 2, column: 11 });
  await press(app, "\r");
  assert.deepEqual(api.added, [{ response_id: 2, block_index: 1, quote: "it runs on both routes", body: "why both?" }]);
  assert.equal(api.sends, 1);
  assert.match(terminal.text.at(-1)!, /Sent to Claude/);
  assert.ok(terminal.has("│ why both?"), "the note shows under its block");
  assert.ok(terminal.has("│ Pending"));
});

test("when Claude isn't listening, Enter saves the note for the next prompt", async () => {
  const api = new FakeApi([reply(2, REPLY_TWO)], [], "offline");
  const { app, terminal } = await start(api);
  assert.ok(terminal.has("○ not listening"));
  await press(app, "nhello");
  assert.ok(terminal.has("⏎ save: Claude isn't listening"));
  await press(app, "\r");
  assert.equal(api.added.length, 1);
  assert.equal(api.sends, 0);
  assert.ok(terminal.has("goes with your next prompt"));
});

test("Alt+Enter adds a line, Esc keeps a draft, and Ctrl+S saves without sending", async () => {
  const api = new FakeApi([reply(2, REPLY_TWO)]);
  const { app, terminal } = await start(api);
  await press(app, "nline one\x1b\rline two");
  assert.ok(terminal.has("  line one") && terminal.has("  line two"));
  await press(app, "\x1b");
  assert.ok(terminal.has("Draft kept"));
  await press(app, "n");
  assert.ok(terminal.has("  line two"), "the draft comes back");
  await press(app, "\x13");
  assert.deepEqual(
    api.added.map((n) => n.body),
    ["line one\nline two"],
  );
  assert.equal(api.sends, 0);
});

test("N notes the whole reply, and S sends pending notes", async () => {
  const api = new FakeApi([reply(2, REPLY_TWO)]);
  const { app, terminal } = await start(api);
  await press(app, "Noverall?\x13");
  assert.deepEqual(api.added, [{ response_id: 2, block_index: -1, quote: "", body: "overall?" }]);
  assert.ok(terminal.has("1 pending · ● listening"));
  await press(app, "S");
  assert.equal(api.sends, 1);
  assert.ok(terminal.has("Sending 1 note to Claude"));
});

test("v picks lines of a code block to note", async () => {
  const api = new FakeApi([reply(2, REPLY_TWO)]);
  const { app, terminal } = await start(api);
  await press(app, "jjj");
  assert.deepEqual(terminal.selected, ["ts", "│ const a = 1;", "│ const b = 2;", "│ const c = 3;"]);
  await press(app, "vjjj");
  assert.equal(terminal.text.filter((row) => row.startsWith("┃ ")).length, 4, "the gutter marks the picked lines");
  await press(app, "kn");
  assert.ok(terminal.has("── Note on: ts const a = 1; const b = 2;"));
  await press(app, "?\r");
  assert.equal((api.added[0] as { quote: string }).quote, "ts\nconst a = 1;\nconst b = 2;");
});

test("notes sit under their block, or in the margin when the pane is wide", async () => {
  const comments = [note({ id: 7, block_index: 1, quote: "it runs on both routes", body: "why both?" })];
  const narrow = await start(new FakeApi([reply(2, REPLY_TWO)], comments));
  const rows = narrow.terminal.text;
  const item = rows.findIndex((row) => row.includes("• it runs on both routes"));
  assert.match(rows[item + 1]!, /^ {4}│ ❝ it runs on both routes/);
  assert.match(rows[item + 2]!, /^ {4}│ why both\?/);
  assert.match(rows[item + 4]!, /• it compares in constant time/);

  const wide = await start(new FakeApi([reply(2, REPLY_TWO)], comments), new FakeTerminal(140, 30));
  const line = wide.terminal.text.find((row) => row.includes("• it runs on both routes"))!;
  assert.match(line, /• it runs on both routes +│ ❝ it runs on both routes/, "level with its block");
});

test("a note opens its thread in place of the feed, and Esc goes back", async () => {
  const answer = reply(3, "", { note_answers: { "7": "Both routes **need** it." } });
  const comments = [
    note({
      id: 7,
      block_index: 1,
      quote: "it runs on both routes",
      body: "why both?",
      delivered_at: 1,
      answered_by: 3,
    }),
  ];
  const api = new FakeApi([reply(2, REPLY_TWO), answer], comments);
  const { app, terminal } = await start(api);
  assert.ok(terminal.has("↳ Claude answered 1 note"), "an answer-only reply is a short row");
  assert.ok(terminal.has("│ Claude Both routes need it."), "the note previews the answer in plain text");
  assert.deepEqual(terminal.selected, ["› why both?"]);
  await press(app, "\r");
  assert.match(terminal.text[1]!, /Thread · on the reply from/);
  assert.ok(terminal.has("▌ it runs on both routes"));
  assert.ok(terminal.has("Your note · Sent"));
  assert.ok(terminal.has("Both routes need it."));
  assert.match(terminal.text.at(-1)!, /r reply · x delete unsent · f show in feed · esc back/);
  await press(app, "rand?\r");
  assert.deepEqual(api.added.at(-1), { parent_id: 7, body: "and?" });
  assert.ok(terminal.has("Your follow-up · Pending"));
  await press(app, "\x1b");
  assert.ok(terminal.has("── "), "back in the feed");
  assert.equal(terminal.selected[0], "  ┃ ❝ it runs on both routes", "on the note whose thread was open");
});

test("an unsent note is deleted only after a second x", async () => {
  const api = new FakeApi([reply(2, REPLY_TWO)], [note({ id: 7, block_index: 0, body: "typo" })]);
  const { app, terminal } = await start(api);
  await press(app, "j");
  assert.equal(terminal.selected[0], "  ┃ typo", "a selected note's bar is heavier");
  await press(app, "x");
  assert.ok(terminal.has("Press x again to delete this note"));
  assert.deepEqual(api.deleted, []);
  await press(app, "x");
  assert.deepEqual(api.deleted, [7]);
  assert.ok(!terminal.has("typo"));
});

test("diffs over several files fold open from their header with Enter", async () => {
  const diff = (path: string, line: string): string =>
    ["```diff", `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", `-old ${line}`, `+new ${line}`, "```"].join("\n");
  const { app, terminal } = await start(
    new FakeApi([reply(2, `Two files:\n\n${diff("a.ts", "a")}\n\n${diff("b.ts", "b")}`)]),
  );
  assert.ok(terminal.has("▾ a.ts") && terminal.has("+ new a") && terminal.has("▸ b.ts"));
  assert.ok(!terminal.has("+ new b"));
  await press(app, "jj");
  assert.deepEqual(terminal.selected, ["▸ b.ts  +1 −1"]);
  assert.match(terminal.text.at(-1)!, /⏎ fold/);
  await press(app, "\r");
  assert.ok(terminal.has("+ new b"));
});

test("follows a new reply when the cursor is on the latest one, and not while writing", async () => {
  const api = new FakeApi([reply(1, REPLY_ONE)]);
  const { app, terminal } = await start(api, new FakeTerminal(80, 12));
  api.change({ responses: [...api.snapshot.responses, reply(2, REPLY_TWO)] });
  await app.refresh();
  assert.deepEqual(terminal.selected, ["I moved the check into verifyToken."]);

  await press(app, "n");
  api.change({ responses: [...api.snapshot.responses, reply(3, "Third reply.")] });
  await app.refresh();
  await press(app, "\x1b");
  assert.ok(terminal.has("↓ new reply: G"));
  await press(app, "G");
  assert.deepEqual(terminal.selected, ["Third reply."]);
});

test("without a session, waits for one in this folder", async () => {
  const api = new FakeApi([reply(1, REPLY_ONE)]);
  const terminal = new FakeTerminal();
  const app = new App({ api, terminal, ansi: { color: true, hyperlinks: true }, sessionId: null, cwd: "/w/demo" });
  await app.refresh();
  assert.ok(terminal.has("Waiting for a Claude Code session in demo."));
  api.sessionList = [{ id: "other", name: "", cwd: "/w/elsewhere", last_active: 2 }];
  await app.refresh();
  assert.equal(app.sessionId, null, "a session in another folder isn't this one");
  api.sessionList.push({ id: SESSION, name: "", cwd: "/w/demo", last_active: 1 });
  await app.refresh();
  assert.equal(app.sessionId, SESSION);
  assert.deepEqual(terminal.selected, ["First reply."]);
});

test("text from the server can't put escape sequences on the screen", async () => {
  const api = new FakeApi([reply(2, "Hi \x1b]0;pwned\x07 there")], [note({ id: 7, body: "\x1b[2Jnote" })]);
  api.snapshot.session!.name = "\x1b]52;c;aGk=\x07name";
  const { app, terminal } = await start(api);
  await press(app, "j\r");
  for (const row of terminal.text) assert.doesNotMatch(row, /[\u0000-\u001f\u007f-\u009f]/);
  assert.ok(terminal.has("␛]52;c;aGk=␇name"));
});

test("asks for a bigger pane rather than drawing a broken one", async () => {
  const { terminal } = await start(new FakeApi([reply(1, REPLY_ONE)]), new FakeTerminal(20, 5));
  assert.deepEqual(terminal.text, ["Make this pane larg…"]);
});

test("q quits", async () => {
  const { app, terminal } = await start(new FakeApi([reply(1, REPLY_ONE)]));
  await press(app, "q");
  assert.equal(terminal.quitted, true);
});

// ---- sidenote chat ---------------------------------------------------------------------------

/** The session host's side: what the app sent, and the conversation it shows. */
class FakeChat implements ChatApi {
  view: ConversationView = {
    version: 1,
    session_id: SESSION,
    agent: "Claude Code",
    model: "claude-test",
    state: "idle",
    live: null,
    queued: [],
    permission: null,
    context: { used: 25_000, limit: 200_000 },
    error: "",
  };
  readonly messages: string[] = [];
  readonly answers: string[] = [];
  interrupts = 0;
  queuedOnInterrupt: string[] = [];

  async conversation(known: number): Promise<ConversationView | null> {
    return known === this.view.version ? null : structuredClone(this.view);
  }
  async message(_session: string, text: string): Promise<void> {
    this.messages.push(text);
  }
  async interrupt(): Promise<string[]> {
    this.interrupts += 1;
    return this.queuedOnInterrupt;
  }
  async answer(_session: string, requestId: string, decision: string): Promise<void> {
    this.answers.push(`${requestId}:${decision}`);
    this.change({ permission: null, state: "working" });
  }
  change(fields: Partial<ConversationView>): void {
    this.view = { ...this.view, ...fields, version: this.view.version + 1 };
  }
}

async function startChat(api: FakeApi, chat = new FakeChat(), terminal = new FakeTerminal(130, 30)) {
  const app = new App({
    api,
    chat,
    terminal,
    ansi: { color: true, hyperlinks: true },
    sessionId: SESSION,
    cwd: "/w/demo",
  });
  await app.refresh();
  await app.refreshConversation();
  return { app, chat, terminal };
}

test("chat: a new session opens on the prompt line, and Enter sends the message", async () => {
  const api = new FakeApi([]);
  const { app, chat, terminal } = await startChat(api);
  assert.match(terminal.text[0]!, /^sidenote · auth-refactor · Claude Code · claude-test +13% context · ● ready$/);
  assert.ok(terminal.has("A new session in demo. Type a message for Claude below."));
  assert.equal(terminal.text.at(-2), "you › Message Claude…");
  assert.deepEqual(terminal.cursor, { row: terminal.frame.length - 2, column: 6 }, "the cursor waits on the prompt");

  await press(app, "Hello");
  assert.equal(terminal.text.at(-2), "you › Hello");
  await press(app, "\r");
  assert.deepEqual(chat.messages, ["Hello"]);
  assert.equal(terminal.text.at(-2), "you › Message Claude…", "the prompt line clears");
  await press(app, "\r");
  assert.ok(terminal.has("Type a message for Claude first"));
  assert.deepEqual(chat.messages, ["Hello"]);
});

test("chat: the turn in progress streams in under the conversation, and Esc interrupts it", async () => {
  const api = new FakeApi([reply(1, REPLY_ONE)]);
  const { app, chat, terminal } = await startChat(api);
  chat.change({
    state: "working",
    live: {
      prompt: "Fix the tests",
      notes_sent: 2,
      started_at: 0,
      parts: [
        { kind: "text", text: "Looking at the **tests**." },
        { kind: "tool", id: "t1", tool: "Bash", summary: "npm test", failed: null },
      ],
    },
    queued: ["And the docs"],
  });
  await app.refreshConversation();
  assert.match(terminal.text[0]!, /◐ working$/);
  const rows = terminal.text.map((row) => row.trimEnd());
  const at = rows.indexOf("  you › Fix the tests  + 2 notes");
  assert.ok(at > 0, "the prompt shows above the turn, with the notes that rode along");
  assert.match(rows[at + 1]!, /^ {2}── Claude Code ─+$/);
  assert.equal(rows[at + 2], "  Looking at the tests.");
  assert.equal(rows[at + 3], "    ◌ Bash npm test");
  assert.equal(rows[at + 4], "    …");
  assert.equal(rows[at + 5], "  queued › And the docs");
  assert.match(terminal.text.at(-1)!, /esc interrupt/);

  chat.queuedOnInterrupt = ["And the docs"];
  await press(app, "\x1b");
  assert.equal(chat.interrupts, 1);
  assert.equal(terminal.text.at(-2), "you › And the docs", "queued messages come back to the prompt");
});

test("chat: y, a and n answer a permission prompt, even from the prompt line", async () => {
  const api = new FakeApi([reply(1, REPLY_ONE)]);
  const { app, chat, terminal } = await startChat(api);
  chat.change({
    state: "waiting",
    live: { prompt: "Edit it", notes_sent: 0, started_at: 0, parts: [] },
    permission: { request_id: "p1", tool: "Edit", summary: "a.ts", detail: "a.ts\n- old\n+ new" },
  });
  await app.refreshConversation();
  assert.match(terminal.text[0]!, /◆ needs your answer$/);
  assert.ok(terminal.has("┃ Allow Edit?"));
  assert.ok(terminal.has("┃ - old"));
  assert.ok(terminal.has("┃ y allow  a always allow this  n deny"));
  assert.equal(terminal.text.at(-1), "Claude is waiting: y allow · a always allow · n deny");
  await press(app, "a");
  assert.deepEqual(chat.answers, ["p1:always"]);
  assert.equal(terminal.text.at(-2), "you › Message Claude; it goes when this turn ends…", "the key wasn't typed");
  await press(app, "y");
  assert.equal(terminal.text.at(-2), "you › y", "with no prompt waiting, y is just a letter");
});

test("chat: stored turns show what the user typed, their tool calls and how they ended", async () => {
  const api = new FakeApi([
    reply(1, "Looked.\n\nChanged it.", {
      prompt: "Change it",
      notes_sent: 1,
      steps: [
        { tool: "Read", summary: "a.ts", after_block: -1, failed: false },
        { tool: "Edit", summary: "a.ts", after_block: 0, failed: true },
      ],
      ended: "interrupted",
    }),
  ]);
  const { terminal } = await startChat(api);
  const rows = terminal.text.map((row) => row.trimEnd()).filter(Boolean);
  const at = rows.indexOf("  you › Change it  + 1 note");
  assert.ok(at > 0);
  assert.match(rows[at + 1]!, /^ {2}── /);
  assert.deepEqual(rows.slice(at + 2, at + 7), [
    "    ⏺ Read a.ts",
    "  Looked.",
    "    ✗ Edit a.ts",
    "  Changed it.",
    "    ⏹ Interrupted",
  ]);
});

test("chat: notes wait for the next message, and Tab moves between the prompt and the conversation", async () => {
  const api = new FakeApi([reply(2, REPLY_TWO)]);
  const { app, terminal } = await startChat(api);
  assert.deepEqual(terminal.selected, [], "no cursor in the conversation while typing");
  await press(app, "\t");
  assert.equal(terminal.cursor, null);
  assert.ok(terminal.selected.length > 0, "the cursor starts at the bottom of what is in view");
  assert.match(terminal.text.at(-1)!, /tab message/);
  await press(app, "gnLooks good\r");
  assert.equal(api.sends, 0, "Enter saves the note; it doesn't send it on its own");
  assert.ok(terminal.has("Saved. It goes with your next message, or press S to send it now"));
  assert.match(terminal.text.at(-2)!, /^you › Message Claude… {3}1 note rides along$/);
  await press(app, "i");
  assert.notEqual(terminal.cursor, null, "i goes back to the prompt");
});
