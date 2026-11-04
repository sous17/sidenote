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
      session: {
        id: SESSION,
        name: "auth-refactor",
        label: "",
        cwd: "/w/demo",
        last_active: 0,
        status,
        send_requested: false,
      },
      folder: "demo",
      sessions: [],
      can_start_sessions: false,
      responses,
      comments,
      messages: [],
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
  api.sessionList = [{ id: "other", name: "", label: "", cwd: "/w/elsewhere", last_active: 2 }];
  await app.refresh();
  assert.equal(app.sessionId, null, "a session in another folder isn't this one");
  api.sessionList.push({ id: SESSION, name: "", label: "", cwd: "/w/demo", last_active: 1 });
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
    cwd: "/home/me/w/demo",
    home: "/home/me",
    now: () => 1_000,
  });
  await app.refresh();
  await app.refreshConversation();
  return { app, chat, terminal };
}

/** Rows without trailing spaces or the margin rule, so the conversation column reads plainly. */
function conversationRows(terminal: FakeTerminal): string[] {
  const wide = terminal.columns >= 120;
  return terminal.text.map((row) => (wide && row.includes("│") ? row.slice(0, row.lastIndexOf("│")) : row).trimEnd());
}

/** Rows the cursor is on, in the conversation column after the speaker column. */
function picked(terminal: FakeTerminal): string[] {
  return conversationRows(terminal)
    .filter((row) => row.slice(10, 12) === "▌ ")
    .map((row) => row.slice(12));
}

test("chat: a new session opens on the prompt line, and Enter sends the message", async () => {
  const api = new FakeApi([]);
  api.snapshot.session!.cwd = "/home/me/w/demo";
  const { app, chat, terminal } = await startChat(api);
  assert.match(
    terminal.text[0]!,
    /^\[sidenote\] {2}auth-refactor {2}~\/w\/demo · Claude Code · claude-test +● your turn {3}context 13%$/,
  );
  assert.ok(terminal.has("A new session in demo. Type a message for Claude below."));
  assert.match(terminal.text.at(-3)!, /^─+$/);
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

test("chat: the turn in progress streams in at the bottom, and Esc interrupts it", async () => {
  const api = new FakeApi([reply(1, REPLY_ONE)]);
  const { app, chat, terminal } = await startChat(api);
  chat.change({
    state: "working",
    live: {
      prompt: "Fix the tests",
      notes_sent: 2,
      started_at: 993,
      parts: [
        { kind: "tool", id: "t0", tool: "Read", summary: "a.test.ts", failed: false },
        { kind: "text", text: "Looking at the **tests**." },
        { kind: "tool", id: "t1", tool: "Bash", summary: "npm test", failed: null },
        { kind: "tool", id: "t2", tool: "Edit", summary: "a.ts", failed: true },
      ],
    },
    queued: ["And the docs"],
  });
  await app.refreshConversation();
  assert.match(terminal.text[0]!, /◐ working 0:07 {3}context 13%$/);
  const rows = conversationRows(terminal);
  const at = rows.indexOf("     you    › Fix the tests  + 2 notes");
  assert.ok(at > 0, "you, then the prompt, with the notes that rode along");
  assert.deepEqual(rows.slice(at + 1, at + 8), [
    "     now",
    "  claude    ✓ read a.test.ts",
    "     now    Looking at the tests.",
    "            ◐ npm test   ✗ edit a.ts",
    "            …",
    "            queued › And the docs",
    "",
  ]);
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
  assert.match(terminal.text[0]!, /◆ needs your answer {3}context 13%$/);
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

test("chat: stored turns show who spoke, the tool calls between the text, and how they ended", async () => {
  const api = new FakeApi([
    reply(1, "Looked.\n\nChanged it.", {
      prompt: "Change it",
      notes_sent: 1,
      steps: [
        { tool: "Read", summary: "a.ts", after_block: -1, failed: false },
        { tool: "Grep", summary: "TODO", after_block: -1, failed: false },
        { tool: "Edit", summary: "a.ts", after_block: 0, failed: true },
      ],
      ended: "interrupted",
    }),
  ]);
  const { terminal } = await startChat(api);
  const rows = conversationRows(terminal);
  const at = rows.findIndex((row) => row.includes("› Change it"));
  assert.deepEqual(rows.slice(at, at + 9), [
    "     you    › Change it  + 1 note",
    rows[at + 1], // the time, in the local format
    "  claude    ✓ read a.ts   ✓ grep TODO",
    "            Looked.",
    "            ✗ edit a.ts",
    "",
    "            Changed it.",
    "            ⏹ interrupted",
    "",
  ]);
  assert.match(rows[at + 1]!, /^ *\d{1,2}[:.]\d\d/);
});

test("chat: notes sit in the margin beside their block, and wait for the next message", async () => {
  const api = new FakeApi([reply(2, REPLY_TWO)], [note({ id: 7, body: "Why constant time?", block_index: 2 })]);
  const { app, terminal } = await startChat(api);
  const row = terminal.text.find(
    (text) => text.includes("- it compares in constant time") || text.includes("• it compares"),
  )!;
  assert.match(row, /it compares in constant time +│ ◆ Why constant time\?$/, "level with its block");
  assert.ok(terminal.has("│   waits for your next message"));
  assert.match(terminal.text.at(-2)!, /^you › Message Claude… +1 note rides along$/);

  assert.deepEqual(picked(terminal), [], "no cursor in the conversation while typing");
  await press(app, "\t");
  assert.equal(terminal.cursor, null);
  assert.ok(picked(terminal).length > 0, "the cursor starts at the bottom of what is in view");
  assert.match(terminal.text.at(-1)!, /tab message/);
  await press(app, "gnLooks good\r");
  assert.equal(api.sends, 0, "Enter saves the note; it doesn't send it on its own");
  assert.ok(terminal.has("Saved. It goes with your next message, or press S to send it now"));
  await press(app, "i");
  assert.notEqual(terminal.cursor, null, "i goes back to the prompt");
});

test("chat: under 120 columns notes go under their block, and under 60 the speaker gets its own row", async () => {
  const api = new FakeApi(
    [reply(2, REPLY_TWO, { prompt: "Check it" })],
    [note({ id: 7, body: "Why?", block_index: 0 })],
  );
  const { terminal } = await startChat(api, new FakeChat(), new FakeTerminal(90, 30));
  const rows = conversationRows(terminal);
  const at = rows.findIndex((row) => row.includes("I moved the check"));
  assert.equal(rows[at + 1], "              ◆ Why?");
  assert.ok(!terminal.has("│ ◆"), "no margin");

  const narrow = await startChat(api, new FakeChat(), new FakeTerminal(50, 30));
  const small = conversationRows(narrow.terminal);
  const you = small.findIndex((row) => /^ {2}you · /.test(row));
  assert.equal(small[you + 1], "  › Check it");
  assert.equal(small[you + 3], "  claude");
});

test("chat: a note is written in a box in the margin, beside the lines it is about", async () => {
  const api = new FakeApi([reply(2, REPLY_TWO)]);
  const { app, terminal } = await startChat(api);
  await press(app, "\tG");
  for (let i = 0; i < 10 && !picked(terminal).some((row) => row.includes("const a = 1;")); i++) {
    await press(app, "k");
  }
  // Picking starts on the block's first row, its language label.
  await press(app, "vjjnDrop b?");
  const boxTop = terminal.text.findIndex((row) => row.includes("╭─ note on 3 picked lines "));
  assert.ok(boxTop > 0);
  assert.match(terminal.text[boxTop]!, / ts +│ ╭─ note on 3 picked lines ─+╮$/, "level with the first picked row");
  assert.match(terminal.text[boxTop + 1]!, /const a = 1; +│ │ Drop b\? +│$/);
  assert.match(terminal.text[boxTop + 3]!, /const c = 3; +│ ╰─ ⏎ save · esc close ─+╯$/);
  const column = terminal.text[boxTop + 1]!.indexOf("Drop b?") + "Drop b?".length;
  assert.deepEqual(terminal.cursor, { row: boxTop + 1, column }, "the text cursor is in the box");
  assert.equal(terminal.text.at(-2), "you › Message Claude…", "the prompt line stays where it is");

  await press(app, "\r");
  assert.deepEqual(api.added, [
    { response_id: 2, block_index: 3, quote: "ts\nconst a = 1;\nconst b = 2;", body: "Drop b?" },
  ]);
  assert.ok(terminal.has("│ ◆ Drop b?"));
});

test("chat: narrower than the margin, notes are still written at the bottom", async () => {
  const api = new FakeApi([reply(2, REPLY_TWO)]);
  const { app, terminal } = await startChat(api, new FakeChat(), new FakeTerminal(100, 30));
  await press(app, "\tn");
  assert.ok(!terminal.has("╭─ note on"));
  assert.match(
    terminal.text.find((row) => row.startsWith("── Note on"))!,
    /^── Note on: /,
  );
});

test("chat: a thread opens in the right half, with its own reply line", async () => {
  const api = new FakeApi(
    [reply(2, REPLY_TWO)],
    [note({ id: 7, body: "Why constant time?", block_index: 2, quote: "it compares in constant time" })],
  );
  const { app, terminal } = await startChat(api, new FakeChat(), new FakeTerminal(130, 30));
  await press(app, "\tg]");
  assert.match(terminal.text.at(-1)!, /\]\/\[ next\/prev note/);
  await press(app, "\r");
  const header = terminal.text[1]!;
  assert.match(header, /^.{65}│ thread · note on: it compares in constant time +esc close$/, "the right half");
  assert.ok(terminal.text.some((row) => /^.{65}│ {3}Why constant time\?/.test(row)));
  assert.ok(
    terminal.text.some((row) => /I moved the check into verifyToken\. +│/.test(row)),
    "the conversation stays",
  );
  assert.match(terminal.text.at(-4)!, /│ reply › r to reply…$/);

  await press(app, "rAnd timing?");
  const row = terminal.text.findIndex((text) => text.includes("reply › And timing?"));
  assert.deepEqual(terminal.cursor, { row, column: terminal.text[row]!.indexOf("And timing?") + "And timing?".length });
  await press(app, "\r");
  assert.deepEqual(api.added.at(-1), { parent_id: 7, body: "And timing?" });
  assert.equal(api.sends, 1, "a reply in the thread is asked now");

  await press(app, "\t");
  assert.match(terminal.text.at(-1)!, /tab thread · esc close thread/);
  await press(app, "\x1b");
  assert.ok(!terminal.has("│ thread ·"), "Esc in the conversation's half closes the thread");
});

test("chat: ] and [ move between threads, and narrow windows show the thread full width", async () => {
  const api = new FakeApi(
    [reply(2, REPLY_TWO)],
    [note({ id: 7, body: "First note", block_index: 0 }), note({ id: 8, body: "Second note", block_index: 2 })],
  );
  const { app, terminal } = await startChat(api);
  await press(app, "\tg]\r");
  assert.ok(terminal.text.some((row) => row.includes("│   First note")));
  await press(app, "]");
  assert.ok(terminal.text.some((row) => row.includes("│   Second note")));
  await press(app, "]");
  assert.ok(terminal.has("This is the last thread"));

  const narrow = await startChat(api, new FakeChat(), new FakeTerminal(100, 30));
  await press(narrow.app, "\tg]\r");
  assert.ok(narrow.terminal.has("Thread · on the reply from"), "the thread replaces the conversation");
  assert.ok(!narrow.terminal.has("│ thread ·"));
});

const LONG_REPLY = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n");
const WHEEL_UP = "\x1b[<64;5;5M";
const WHEEL_DOWN = "\x1b[<65;5;5M";

test("chat: the wheel scrolls from the prompt line, and leaves the message being typed alone", async () => {
  const { app, terminal } = await startChat(
    new FakeApi([reply(1, LONG_REPLY)]),
    new FakeChat(),
    new FakeTerminal(130, 14),
  );
  await press(app, "draft");
  assert.ok(terminal.has("Paragraph 30."), "opens at the latest");

  await press(app, WHEEL_UP.repeat(3));
  assert.ok(!terminal.has("Paragraph 30."));
  assert.ok(terminal.has("Paragraph 23."));

  await press(app, " more");
  assert.ok(terminal.has("you › draft more"), "the keys still go to the prompt line");
  assert.ok(!terminal.has("Paragraph 30."), "typing doesn't jump back");

  await press(app, WHEEL_DOWN.repeat(3));
  assert.ok(terminal.has("Paragraph 30."));
});

test("chat: the wheel stops at both ends", async () => {
  const { app, terminal } = await startChat(
    new FakeApi([reply(1, LONG_REPLY)]),
    new FakeChat(),
    new FakeTerminal(130, 14),
  );
  await press(app, WHEEL_DOWN.repeat(5));
  assert.ok(terminal.has("Paragraph 30."));
  await press(app, WHEEL_UP.repeat(50));
  assert.ok(terminal.has("Paragraph 1."));
  await press(app, WHEEL_DOWN);
  assert.ok(!terminal.has("Paragraph 1."), "one notch is enough to come back from the top");
});

test("chat: scrolling up stops following Claude, and reaching the bottom starts it again", async () => {
  const { app, chat, terminal } = await startChat(
    new FakeApi([reply(1, LONG_REPLY)]),
    new FakeChat(),
    new FakeTerminal(130, 14),
  );
  const stream = async (text: string): Promise<void> => {
    chat.change({
      state: "working",
      live: { prompt: "Go on", notes_sent: 0, started_at: 993, parts: [{ kind: "text", text }] },
    });
    await app.refreshConversation();
  };
  await stream("First words.");
  assert.ok(terminal.has("First words."), "following");

  await press(app, WHEEL_UP.repeat(4));
  await stream("Second words.");
  assert.ok(!terminal.has("Second words."), "what is being read stays put");
  assert.ok(terminal.has("Paragraph 2") || terminal.has("Paragraph 1"));

  await press(app, WHEEL_DOWN.repeat(10));
  await stream("Third words.");
  assert.ok(terminal.has("Third words."), "following again, without pressing anything");
});

test("chat: PgUp and PgDn scroll from the prompt line", async () => {
  const { app, terminal } = await startChat(
    new FakeApi([reply(1, LONG_REPLY)]),
    new FakeChat(),
    new FakeTerminal(130, 14),
  );
  await press(app, "draft\x1b[5~");
  assert.ok(!terminal.has("Paragraph 30."));
  assert.ok(terminal.has("you › draft"));
  assert.match(terminal.text.at(-1)!, /pgup\/pgdn scroll/);
  await press(app, "\x1b[6~\x1b[6~");
  assert.ok(terminal.has("Paragraph 30."));
  assert.ok(terminal.has("you › draft"), "the page keys type nothing");
});

test("the wheel keeps the cursor in view, so the next key doesn't jump back", async () => {
  const { app, terminal } = await start(new FakeApi([reply(1, LONG_REPLY)]), new FakeTerminal(80, 12));
  await press(app, WHEEL_DOWN.repeat(6));
  assert.equal(terminal.selected.length, 1, "the cursor is on a row in view");
  const [before] = terminal.selected;
  await press(app, "j");
  assert.notEqual(terminal.selected[0], before);
  assert.ok(!terminal.has("Paragraph 1."), "moving carries on from here");
});

test("beside a thread, the wheel scrolls the half under the pointer", async () => {
  const body = Array.from({ length: 40 }, (_, i) => `Thread line ${i + 1}`).join("\n");
  const api = new FakeApi([reply(2, LONG_REPLY)], [note({ id: 7, body, block_index: 29, quote: "Paragraph 30." })]);
  const { app, terminal } = await startChat(api, new FakeChat(), new FakeTerminal(130, 16));
  await press(app, "\tG]\r");
  assert.ok(terminal.has("Thread line 1"), "the thread is open");
  const left = (): string[] => terminal.text.map((row) => row.slice(0, 65));

  const conversation = left();
  await press(app, "\x1b[<65;100;5M".repeat(3));
  assert.ok(!terminal.text.some((row) => row.trimEnd().endsWith("Thread line 1")), "the thread moved");
  assert.deepEqual(left(), conversation, "the conversation didn't");

  const thread = terminal.text.map((row) => row.slice(66));
  await press(app, "\x1b[<64;10;5M".repeat(3));
  assert.notDeepEqual(left(), conversation, "the conversation moved");
  assert.deepEqual(
    terminal.text.map((row) => row.slice(66)),
    thread,
    "the thread didn't",
  );
});

test("a full-width thread scrolls with the wheel wherever the pointer is", async () => {
  const body = Array.from({ length: 40 }, (_, i) => `Thread line ${i + 1}`).join("\n");
  const api = new FakeApi([reply(2, "One block.")], [note({ id: 7, body })]);
  const { app, terminal } = await start(api, new FakeTerminal(70, 14));
  await press(app, "j\r");
  assert.ok(terminal.has("Thread line 1"));
  await press(app, WHEEL_DOWN.repeat(4));
  assert.ok(!terminal.text.some((row) => row.trimEnd().endsWith("Thread line 1")));
});

test("the wheel leaves a note being written, and picked lines, where they are", async () => {
  const code = `\`\`\`js\n${Array.from({ length: 30 }, (_, i) => `line${i + 1}();`).join("\n")}\n\`\`\``;
  const { app, terminal } = await start(new FakeApi([reply(1, LONG_REPLY), reply(2, code)]), new FakeTerminal(80, 14));
  await press(app, "n");
  const writing = [...terminal.frame];
  await press(app, WHEEL_DOWN.repeat(3));
  assert.deepEqual(terminal.frame, writing);
  await press(app, "\x1b\x1b");

  await press(app, "Gv");
  const picking = [...terminal.frame];
  await press(app, WHEEL_DOWN.repeat(3));
  assert.deepEqual(terminal.frame, picking);
});

test("clicks do nothing: no text, no lost message, and a delete stays armed", async () => {
  const { app, terminal } = await startChat(new FakeApi([reply(1, "Hello.")]), new FakeChat());
  await press(app, "hi\x1b[<0;5;5M\x1b[<0;5;5m there");
  assert.ok(terminal.has("you › hi there"));

  const api = new FakeApi([reply(2, "Hello.")], [note({ id: 7, body: "Why?" })]);
  const tui = await start(api, new FakeTerminal(80, 20));
  await press(tui.app, "jx");
  await press(tui.app, "\x1b[<0;5;5M\x1b[<0;5;5m" + WHEEL_DOWN);
  await press(tui.app, "x");
  assert.deepEqual(api.deleted, [7], "the second x still confirms");
});

test("the app takes on the theme of the background the terminal reports, without losing what is typed", async () => {
  const api = new FakeApi([reply(1, "Hello.")]);
  const terminal = new FakeTerminal(130, 20);
  const app = new App({
    api,
    chat: new FakeChat(),
    terminal,
    ansi: { color: true, hyperlinks: false, truecolor: true },
    sessionId: SESSION,
    cwd: "/home/me/w/demo",
    home: "/home/me",
    now: () => 1_000,
  });
  await app.refresh();
  await app.refreshConversation();
  await press(app, "half");
  const dark = terminal.frame.join("\n");
  assert.ok(dark.includes("38;2;227;179;65"), "the dark accent");

  await press(app, "\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
  const light = terminal.frame.join("\n");
  assert.ok(light.includes("38;2;125;83;0"), "the light accent");
  assert.ok(!light.includes("38;2;227;179;65"));
  assert.ok(terminal.has("you › half"), "nothing typed, nothing lost");

  await press(app, "\x1b]11;rgb:0000/0000/0000\x1b\\");
  assert.ok(terminal.frame.join("\n").includes("38;2;227;179;65"), "and back");
});

test("a theme the user chose isn't changed by the terminal's answer", async () => {
  const terminal = new FakeTerminal(100, 20);
  const app = new App({
    api: new FakeApi([reply(1, "Hello.")]),
    terminal,
    ansi: { color: true, hyperlinks: false, truecolor: true, light: false, themeFixed: true },
    sessionId: SESSION,
    cwd: "/w/demo",
  });
  await app.refresh();
  const before = [...terminal.frame];
  await press(app, "\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
  assert.deepEqual(terminal.frame, before);
});
