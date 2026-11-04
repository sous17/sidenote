// The terminal window's controller: one session's feed or one note's thread, a cursor that moves
// between blocks and notes, and a note editor at the bottom. With a ChatApi it is the whole
// session (sidenote chat): a prompt line to message the agent, the turn in progress streaming in
// below the feed, and permission prompts to answer. It reaches the server and the terminal only
// through its APIs and Terminal, so tests drive it with keys and read its frames.
import { Model } from "../shared/model.ts";
import { projectName, plural, truncate } from "../shared/text.ts";
import type {
  ConversationView,
  NewNoteRequest,
  PermissionAnswerRequest,
  SessionSummary,
  StateSnapshot,
  StoredResponse,
} from "../shared/types.ts";
import { lineToAnsi, type AnsiOptions } from "./ansi.ts";
import { NoteText } from "./editor.ts";
import { buildFeed, type FeedView, type Target } from "./feed.ts";
import type { Key } from "./keys.ts";
import { PLAIN, type Span, type Style } from "./lines.ts";
import { renderReply, type RenderedReply } from "./render.ts";
import { terminalSafe } from "./sanitize.ts";
import { buildThread } from "./thread.ts";
import { CONVERSATION_MARGIN_MIN_WIDTH, MARGIN_WIDTH, buildConversation, conversationLayout } from "./conversation.ts";
import { clipSpans, spansWidth } from "./wrap.ts";

export interface TuiApi {
  sessions(): Promise<SessionSummary[]>;
  /** The session's state, or null when nothing changed since knownVersion; wait holds out for a change. */
  state(knownVersion: number, sessionId: string, wait?: boolean): Promise<StateSnapshot | null>;
  addNote(note: NewNoteRequest): Promise<void>;
  deleteNote(id: number): Promise<void>;
  send(sessionId: string): Promise<void>;
}

/** A session sidenote runs (see src/server/host.ts). */
export interface ChatApi {
  /** The conversation, or null when nothing changed since knownVersion; wait holds out for a change. */
  conversation(knownVersion: number, sessionId: string, wait: boolean): Promise<ConversationView | null>;
  message(sessionId: string, text: string): Promise<void>;
  /** Stops the turn; resolves with the queued messages it dropped. */
  interrupt(sessionId: string): Promise<string[]>;
  answer(sessionId: string, requestId: string, decision: PermissionAnswerRequest["decision"]): Promise<void>;
}

export interface Terminal {
  size(): { columns: number; rows: number };
  /** Draws a whole frame, one string per row, with the text cursor shown at cursor if given. */
  draw(rows: string[], cursor: { row: number; column: number } | null): void;
  /** Hands the terminal to $EDITOR to write a note; resolves with the new text, or null. */
  editText(text: string): Promise<string | null>;
  quit(): void;
}

export interface AppOptions {
  api: TuiApi;
  terminal: Terminal;
  ansi: AnsiOptions;
  /** The session to show; null picks the most recently active one in cwd, waiting for one. */
  sessionId: string | null;
  cwd: string;
  /** Set for a session sidenote runs, which the user messages from here. */
  chat?: ChatApi;
  /** The home folder, shown as ~ in folder names. */
  home?: string;
  /** Seconds since the epoch; tests pass their own. */
  now?: () => number;
}

/** Same limit as the page's editor: enough context for Claude without the whole reply. */
const MAX_QUOTE_CHARS = 600;
const GUTTER = 2;
/** Rows one notch of the mouse wheel scrolls, the usual three. */
const WHEEL_ROWS = 3;
const EDITOR_MAX_ROWS = 6;
const PROMPT_LABEL = "you › ";
const REPLY_LABEL = "reply › ";
const MIN_COLUMNS = 30;
const MIN_ROWS = 8;

const MUTED: Style = { tone: "muted" };
const ACCENT: Style = { tone: "accent" };

type NoteRequest = { response_id: number; block_index: number; quote: string } | { parent_id: number };

interface Editing {
  text: NoteText;
  request: NoteRequest;
  /** Unsent text is kept per target when the editor closes. */
  draftKey: string;
  title: string;
  scroll: number;
  /** In chat with a margin, the note is written in a box beside these rows of this target. */
  anchor: { key: string; offset: number; label: string } | null;
}

interface Message {
  text: string;
  style: Style;
}

export class App {
  readonly #api: TuiApi;
  readonly #terminal: Terminal;
  readonly #ansi: AnsiOptions;
  readonly #cwd: string;
  readonly #chat: ChatApi | null;
  readonly #home: string;
  readonly #now: () => number;
  #model: Model | null = null;
  #reachable = true;

  #conversation: ConversationView | null = null;
  /** Where the text cursor goes while a note is written in the margin. */
  #composerCursor: { row: number; column: number } | null = null;
  /** The message being typed. */
  #prompt = new NoteText();
  #promptScroll = 0;
  /** In chat, keys go to the prompt line or to the conversation above it. */
  #focus: "prompt" | "feed" = "prompt";
  /** Keep the bottom of the conversation in view as it grows. */
  #follow = true;
  /** With the thread in the right half, which half takes the keys. */
  #half: "thread" | "conversation" = "thread";
  /** Where the text cursor goes while a reply is written in the thread's half. */
  #paneCursor: { row: number; column: number } | null = null;

  #view: "feed" | "thread" = "feed";
  #threadRoot: number | null = null;
  #threadScroll = 0;

  #feed: FeedView | null = null;
  #selected: string | null = null;
  #scroll = 0;
  /** Scroll so the selection is in view at the next render. */
  #reveal = false;
  /** Put this reply's header at the top at the next render, and select its first block. */
  #showReply: number | null = null;
  #newBelow = false;
  /** Rows of a code block picked with v: [anchor, cursor]. */
  #lines: [number, number] | null = null;

  #editor: Editing | null = null;
  readonly #drafts = new Map<string, string>();
  #message: Message | null = null;
  #confirmDelete: number | null = null;

  /** Open files of each reply's diffs, once the user folds or unfolds one. */
  readonly #openFiles = new Map<number, Set<number>>();
  readonly #renders = new Map<string, RenderedReply>();
  #renderWidth = 0;

  constructor(options: AppOptions) {
    this.#api = options.api;
    this.#terminal = options.terminal;
    this.#ansi = { ...options.ansi };
    this.#cwd = options.cwd;
    this.#chat = options.chat ?? null;
    this.#home = options.home ?? "";
    this.#now = options.now ?? (() => Date.now() / 1000);
    if (options.sessionId) this.#model = new Model(options.sessionId);
  }

  get sessionId(): string | null {
    return this.#model?.sessionId ?? null;
  }

  // ---- Server ---------------------------------------------------------------------------

  /** Fetches the latest state, then draws. Called in a loop, and after every change. */
  async refresh(options: { wait?: boolean } = {}): Promise<void> {
    try {
      if (!this.#model) {
        const sessions = await this.#api.sessions();
        const here = sessions.find((session) => session.cwd === this.#cwd);
        if (here) this.#model = new Model(here.id);
      }
      if (this.#model) {
        const snapshot = await this.#api.state(this.#model.snapshot.version, this.#model.sessionId, options.wait);
        if (snapshot) this.#update(snapshot);
      }
      this.#reachable = true;
    } catch (error) {
      this.#reachable = false;
      if (options.wait) throw error;
    }
    this.render();
  }

  /** Fetches the turn in progress of a session sidenote runs, then draws. */
  async refreshConversation(options: { wait?: boolean } = {}): Promise<void> {
    if (!this.#chat || !this.#model) return;
    try {
      const known = this.#conversation?.version ?? -1;
      const view = await this.#chat.conversation(known, this.#model.sessionId, options.wait ?? false);
      if (view) this.#conversation = view;
      this.#reachable = true;
    } catch (error) {
      this.#reachable = false;
      if (options.wait) throw error;
    }
    this.render();
  }

  get #working(): boolean {
    const state = this.#conversation?.state;
    return state === "working" || state === "waiting";
  }

  #update(snapshot: StateSnapshot): void {
    const model = this.#model!;
    const known = new Set(model.responses.map((response) => response.id));
    const firstLoad = model.snapshot.version < 0;
    const latestBefore = model.responses.at(-1)?.id;
    const followingLatest = this.#selectedTarget()?.responseId === latestBefore || this.#selected === null;
    model.snapshot = snapshot;
    const latest = model.responses.at(-1);
    if (!latest) return;
    if (this.#chat) {
      // In chat the bottom of the conversation stays in view, unless the user scrolled away.
      if (!firstLoad && !known.has(latest.id) && !this.#follow) this.#newBelow = true;
    } else if (firstLoad) {
      this.#showReply = latest.id;
    } else if (!known.has(latest.id)) {
      // A new reply: follow it if the cursor was on the latest one and nothing is being written.
      if (followingLatest && !this.#editor && !this.#lines && this.#view === "feed") this.#showReply = latest.id;
      else this.#newBelow = true;
    }
    if (this.#threadRoot !== null && !model.note(this.#threadRoot)) this.#closeThread();
  }

  // ---- Keys -----------------------------------------------------------------------------

  async handleKey(key: Key): Promise<void> {
    // Before anything is reset: looking around doesn't cancel a delete being confirmed.
    if (key.name === "mouse") return;
    if (key.name === "background") {
      if (this.#ansi.themeFixed || key.light === undefined || key.light === Boolean(this.#ansi.light)) return;
      this.#ansi.light = key.light;
      this.render();
      return;
    }
    if (key.name === "wheelup" || key.name === "wheeldown") {
      this.#wheel(key.name === "wheelup" ? -WHEEL_ROWS : WHEEL_ROWS, key.column ?? 0);
      return;
    }
    const confirming = this.#confirmDelete;
    this.#confirmDelete = null;
    this.#message = null;
    try {
      if (key.ctrl && key.name === "c") return this.#terminal.quit();
      if (this.#editor) await this.#editorKey(this.#editor, key);
      else if (await this.#permissionKey(key)) return;
      else if (this.#lines) this.#linesKey(this.#lines, key);
      else if (this.#chat && this.#view === "feed" && this.#focus === "prompt") await this.#promptKey(key);
      else if (this.#view === "thread" && !(this.#split() && this.#half === "conversation")) {
        await this.#threadKey(key, confirming);
      } else await this.#feedKey(key, confirming);
    } catch (error) {
      this.#message = { text: errorText(error), style: { tone: "del" } };
    }
    this.render();
  }

  async #feedKey(key: Key, confirming: number | null): Promise<void> {
    const target = this.#selectedTarget();
    if (this.#view === "thread") {
      // The conversation's half, beside an open thread.
      if (key.name === "tab") {
        this.#half = "thread";
        return;
      }
      if (key.name === "escape" || key.name === "i") {
        this.#closeThread();
        if (key.name === "i") this.#focus = "prompt";
        return;
      }
    }
    if (key.name === "]" || key.name === "[") return this.#nextNote(key.name === "]" ? 1 : -1);
    if (this.#chat && (key.name === "tab" || key.name === "i")) {
      this.#focus = "prompt";
      return;
    }
    if (this.#chat && key.name === "escape") {
      if (this.#working) return this.#interrupt();
      this.#focus = "prompt";
      return;
    }
    if (["j", "k", "up", "down", "g", "home", " ", "b", "pageup", "pagedown"].includes(key.name)) this.#follow = false;
    if (key.ctrl && (key.name === "d" || key.name === "u")) this.#follow = false;
    switch (key.name) {
      case "j":
      case "down":
        return this.#move(1);
      case "k":
      case "up":
        return this.#move(-1);
      case "g":
      case "home":
        this.#select(this.#feed?.targets[0]?.key ?? null);
        return;
      case "G":
      case "end": {
        this.#newBelow = false;
        if (this.#chat) {
          this.#follow = true;
          return;
        }
        const latest = this.#model?.responses.at(-1);
        if (latest) this.#showReply = latest.id;
        return;
      }
      case " ":
      case "pagedown":
        return this.#page(1);
      case "b":
      case "pageup":
        return this.#page(-1);
      case "d":
      case "u":
        if (key.ctrl) this.#page(key.name === "d" ? 0.5 : -0.5);
        return;
      case "enter":
        if (!target) return;
        if (target.kind === "note" || target.kind === "answer") return this.#openThread(target.rootId!);
        if (target.file !== undefined) return this.#toggleFile(target.responseId, target.file);
        return this.#startNote(target);
      case "n":
        if (!target) return;
        if (target.kind === "note" || target.kind === "answer") return this.#startReply(target.rootId!);
        return this.#startNote(target);
      case "N":
        if (target) this.#startNote({ ...target, kind: "reply", block: -1 });
        return;
      case "v":
        if (!target) return;
        if (target.kind === "block" && target.code) this.#lines = [target.start, target.start];
        else this.#message = { text: "Line notes are for code and diffs; n notes the whole block", style: MUTED };
        return;
      case "x":
        if (target?.kind === "note") await this.#deleteNote(target.rootId!, confirming);
        return;
      case "S":
        return this.#sendPending();
      case "q":
        return this.#terminal.quit();
    }
  }

  #linesKey(lines: [number, number], key: Key): void {
    const target = this.#selectedTarget();
    if (!target) {
      this.#lines = null;
      return;
    }
    if (key.name === "j" || key.name === "down") lines[1] = Math.min(target.end - 1, lines[1] + 1);
    else if (key.name === "k" || key.name === "up") lines[1] = Math.max(target.start, lines[1] - 1);
    else if (key.name === "escape" || key.name === "v" || key.name === "q") this.#lines = null;
    else if (key.name === "n" || key.name === "enter") {
      const [from, to] = [Math.min(...lines), Math.max(...lines)];
      const quote = target.quote
        .split("\n")
        .slice(from - target.start, to - target.start + 1)
        .join("\n");
      this.#lines = null;
      const count = to - from + 1;
      this.#startNote(
        { ...target, quote },
        { offset: from - target.start, label: plural(count, "picked line", "picked lines") },
      );
      return;
    }
    this.#keepRowVisible(lines[1]);
  }

  async #threadKey(key: Key, confirming: number | null): Promise<void> {
    const height = this.#bodyHeight();
    switch (key.name) {
      case "tab":
        if (this.#split()) this.#half = "conversation";
        return;
      case "]":
      case "[":
        return this.#nextThread(key.name === "]" ? 1 : -1);
      case "j":
      case "down":
        this.#threadScroll += 1;
        return;
      case "k":
      case "up":
        this.#threadScroll -= 1;
        return;
      case " ":
      case "pagedown":
        this.#threadScroll += Math.max(1, height - 2);
        return;
      case "b":
      case "pageup":
        this.#threadScroll -= Math.max(1, height - 2);
        return;
      case "g":
      case "home":
        this.#threadScroll = 0;
        return;
      case "G":
      case "end":
        this.#threadScroll = Number.MAX_SAFE_INTEGER;
        return;
      case "r":
      case "n":
      case "enter":
        return this.#startReply(this.#threadRoot!);
      case "x": {
        const pending = this.#model?.thread(this.#threadRoot!).findLast((note) => note.delivered_at === null);
        if (pending) await this.#deleteNote(pending.id, confirming);
        else this.#message = { text: "Nothing unsent in this thread to delete", style: MUTED };
        return;
      }
      case "f":
        return this.#showInFeed();
      case "S":
        return this.#sendPending();
      case "escape":
      case "left":
      case "h":
        return this.#closeThread();
      case "q":
        return this.#terminal.quit();
    }
  }

  async #editorKey(editing: Editing, key: Key): Promise<void> {
    if (key.name === "escape") return this.#closeEditor();
    if (key.name === "enter" && !(key.alt || key.shift)) {
      // In chat, notes wait for the next message, and S sends them on their own; a reply in a
      // thread beside the conversation is a question, so it goes now.
      const now = this.#chat ? this.#inThreadPane(editing) : (this.#model?.canSend() ?? false);
      return this.#submit(editing, now);
    }
    if (key.ctrl && key.name === "s") return this.#submit(editing, false);
    const edited = await this.#editText(editing.text, key, this.#editorWidth());
    if (edited) editing.text = edited;
  }

  /** Keys while the prompt line has focus: type, send with Enter, Esc to interrupt or leave. */
  async #promptKey(key: Key): Promise<void> {
    if (key.name === "escape") {
      if (this.#working) return this.#interrupt();
      this.#focusFeed();
      return;
    }
    if (key.name === "tab") return this.#focusFeed();
    if (key.name === "pageup" || key.name === "pagedown") {
      const page = Math.max(1, this.#bodyHeight() - 2);
      return this.#scrollFeed(key.name === "pageup" ? -page : page);
    }
    if (key.name === "enter" && !(key.alt || key.shift)) return this.#sendMessage();
    const edited = await this.#editText(this.#prompt, key, this.#promptWidth());
    if (edited) this.#prompt = edited;
  }

  /** y, a or n answer a permission prompt, unless a note is being written. */
  async #permissionKey(key: Key): Promise<boolean> {
    const permission = this.#conversation?.permission;
    if (!this.#chat || !permission || this.#view !== "feed" || key.ctrl || key.alt) return false;
    const decision = ({ y: "allow", a: "always", n: "deny" } as const)[key.name as "y" | "a" | "n"];
    if (!decision) return false;
    await this.#chat.answer(this.#model!.sessionId, permission.request_id, decision);
    this.#message = {
      text: decision === "deny" ? `Denied ${permission.tool}` : `Allowed ${permission.tool}`,
      style: MUTED,
    };
    this.#follow = true;
    await this.refreshConversation();
    return true;
  }

  /** Editing keys shared by the note editor and the prompt line; a new text when $EDITOR replaced it. */
  async #editText(text: NoteText, key: Key, width: number): Promise<NoteText | null> {
    if (key.name === "enter") {
      text.insert("\n");
      return null;
    }
    if (key.ctrl && key.name === "e") {
      const edited = await this.#terminal.editText(text.text);
      return edited === null ? null : new NoteText(edited.replace(/\n+$/, ""));
    }
    this.#editKey(text, key, width);
    return null;
  }

  #editKey(text: NoteText, key: Key, width: number): void {
    if (key.name === "paste") return text.insert(key.text);
    if (key.name === "backspace") return key.alt || key.ctrl ? text.deleteWord() : text.backspace();
    if (key.ctrl && key.name === "w") return text.deleteWord();
    if (key.name === "delete") return text.deleteForward();
    if (key.name === "left") return text.left();
    if (key.name === "right") return text.right();
    if (key.name === "up") return text.vertical(-1, width);
    if (key.name === "down") return text.vertical(1, width);
    if (key.name === "home" || (key.ctrl && key.name === "a")) return text.home();
    if (key.name === "end") return text.end();
    if (key.text && !key.ctrl && !key.alt) text.insert(key.text);
  }

  // ---- Actions --------------------------------------------------------------------------

  async #sendMessage(): Promise<void> {
    const model = this.#model;
    if (!this.#chat || !model) return;
    if (this.#prompt.isBlank && !model.pendingCount()) {
      this.#message = { text: "Type a message for Claude first", style: MUTED };
      return;
    }
    await this.#chat.message(model.sessionId, this.#prompt.isBlank ? "" : this.#prompt.text);
    this.#prompt = new NoteText();
    this.#promptScroll = 0;
    this.#follow = true;
    this.#newBelow = false;
    await this.refreshConversation();
  }

  async #interrupt(): Promise<void> {
    if (!this.#chat || !this.#model) return;
    const queued = await this.#chat.interrupt(this.#model.sessionId);
    // Messages that were waiting come back to the prompt line, to send again or drop.
    if (queued.length && this.#prompt.isBlank) {
      this.#prompt = new NoteText(queued.join("\n\n"));
      this.#prompt.end();
    }
    this.#message = {
      text: queued.length ? "Interrupted. Queued messages are back in the prompt" : "Interrupted",
      style: MUTED,
    };
    await this.refreshConversation();
  }

  #focusFeed(): void {
    this.#focus = "feed";
    // Put the cursor on what is in view at the bottom, where the user was reading.
    const height = this.#bodyHeight();
    const visible = this.#feed?.targets.filter((t) => t.start < this.#scroll + height && t.end > this.#scroll);
    const last = visible?.at(-1);
    if (last && (this.#follow || !visible?.some((t) => t.key === this.#selected))) this.#selected = last.key;
  }

  #move(direction: 1 | -1): void {
    const targets = this.#feed?.targets ?? [];
    const index = targets.findIndex((target) => target.key === this.#selected);
    const current = targets[index];
    const height = this.#bodyHeight();
    // A block taller than the pane scrolls through before the cursor leaves it.
    const step = Math.max(1, Math.floor(height / 2));
    if (current && direction > 0 && current.end > this.#scroll + height) {
      this.#scroll = Math.min(this.#scroll + step, current.end - height);
      return;
    }
    if (current && direction < 0 && current.start < this.#scroll) {
      this.#scroll = Math.max(this.#scroll - step, current.start);
      return;
    }
    const next = index < 0 ? targets[0] : targets[index + direction];
    if (next) this.#select(next.key);
  }

  /** Scrolls by pages, and puts the cursor on the first thing in view. */
  #page(pages: number): void {
    const height = this.#bodyHeight();
    this.#scroll += Math.trunc(pages * Math.max(1, height - 2)) || (pages > 0 ? 1 : -1);
    this.#scroll = this.#clampScroll(this.#scroll);
    const first = this.#feed?.targets.find((target) => target.end > this.#scroll);
    if (first) this.#selected = first.key;
  }

  /** The wheel scrolls the pane under the pointer, wherever the keys are going. */
  #wheel(rows: number, column: number): void {
    // A note being written pins the view to it, and picked lines to the cursor.
    if (this.#editor || this.#lines) return;
    const inThread = this.#view === "thread" && (!this.#split() || column > this.#halves().left);
    if (inThread) this.#threadScroll += rows;
    else this.#scrollFeed(rows);
    this.render();
  }

  /**
   * Scrolls without taking the keys from the prompt line. Following stops away from the bottom and
   * starts again there, since G can't be typed from the prompt line. The cursor stays in view.
   */
  #scrollFeed(rows: number): void {
    const height = this.#bodyHeight();
    this.#scroll = this.#clampScroll(this.#scroll + rows);
    this.#follow = this.#scroll + height >= (this.#feed?.rows.length ?? 0);
    const target = this.#selectedTarget();
    if (target && target.start < this.#scroll + height && target.end > this.#scroll) return;
    const first = this.#feed?.targets.find((candidate) => candidate.end > this.#scroll);
    if (first) this.#selected = first.key;
  }

  #select(key: string | null): void {
    this.#selected = key;
    this.#reveal = true;
  }

  #toggleFile(responseId: number, file: number): void {
    const open = new Set(this.#openFiles.get(responseId) ?? [0]);
    if (open.has(file)) open.delete(file);
    else open.add(file);
    this.#openFiles.set(responseId, open);
  }

  #startNote(target: Target, picked?: { offset: number; label: string }): void {
    const whole = target.kind === "reply" || target.block < 0;
    const quote = whole ? "" : target.quote;
    const draftKey = whole ? `r:${target.responseId}` : `${target.key}:${quote}`;
    const title = whole ? "Note on the whole reply" : `Note on: ${quote.replace(/\s+/g, " ")}`;
    this.#openEditor(
      {
        response_id: target.responseId,
        block_index: whole ? -1 : target.block,
        quote: truncate(quote, MAX_QUOTE_CHARS),
      },
      draftKey,
      title,
    );
    const label = picked?.label ?? (whole ? "the whole reply" : target.code ? "this code" : "this block");
    this.#editor!.anchor = { key: target.key, offset: picked?.offset ?? 0, label: `note on ${label}` };
    // Writing beside the text: keep that part of the conversation still.
    if (this.#chat) this.#follow = false;
  }

  #startReply(rootId: number): void {
    this.#openEditor({ parent_id: rootId }, `t:${rootId}`, "Reply in this thread");
  }

  #openEditor(request: NoteRequest, draftKey: string, title: string): void {
    this.#editor = {
      text: new NoteText(this.#drafts.get(draftKey) ?? ""),
      request,
      draftKey,
      title,
      scroll: 0,
      anchor: null,
    };
  }

  #closeEditor(): void {
    const editing = this.#editor;
    this.#editor = null;
    if (!editing) return;
    if (editing.text.isBlank) {
      this.#drafts.delete(editing.draftKey);
    } else {
      this.#drafts.set(editing.draftKey, editing.text.text);
      this.#message = { text: "Draft kept: open the note again to finish it", style: MUTED };
    }
  }

  async #submit(editing: Editing, sendNow: boolean): Promise<void> {
    const model = this.#model;
    if (!model) return;
    if (editing.text.isBlank) {
      this.#message = { text: "Write something first, or press Esc", style: MUTED };
      return;
    }
    await this.#api.addNote({ ...editing.request, body: editing.text.text } as NewNoteRequest);
    this.#drafts.delete(editing.draftKey);
    this.#editor = null;
    if (sendNow) {
      await this.#api.send(model.sessionId);
      this.#message =
        model.sendStatus().status === "busy"
          ? { text: "Saved. Claude is working; it goes as soon as it finishes", style: ACCENT }
          : { text: "Sent to Claude", style: ACCENT };
    } else if (this.#chat) {
      this.#message = { text: "Saved. It goes with your next message, or press S to send it now", style: MUTED };
    } else {
      this.#message = model.canSend()
        ? { text: "Saved. It goes with your next prompt, or press S to send now", style: MUTED }
        : { text: "Saved. Claude isn't listening here, so it goes with your next prompt", style: MUTED };
    }
    await this.refresh();
  }

  async #sendPending(): Promise<void> {
    const model = this.#model;
    if (!model) return;
    const pending = model.pendingCount();
    if (!pending) {
      this.#message = { text: "No pending notes to send", style: MUTED };
    } else if (!model.canSend()) {
      this.#message = { text: "Claude isn't listening: pending notes go with your next prompt there", style: MUTED };
    } else {
      await this.#api.send(model.sessionId);
      this.#message = { text: `Sending ${plural(pending, "note", "notes")} to Claude`, style: ACCENT };
      await this.refresh();
    }
  }

  async #deleteNote(noteId: number, confirming: number | null): Promise<void> {
    const note = this.#model?.note(noteId);
    if (!note) return;
    if (note.delivered_at !== null) {
      this.#message = { text: "Only notes that haven't been sent can be deleted", style: MUTED };
      return;
    }
    if (confirming !== noteId) {
      this.#confirmDelete = noteId;
      this.#message = { text: "Press x again to delete this note", style: { tone: "del" } };
      return;
    }
    await this.#api.deleteNote(noteId);
    this.#message = { text: "Note deleted", style: MUTED };
    await this.refresh();
  }

  #openThread(rootId: number): void {
    this.#view = "thread";
    this.#threadRoot = rootId;
    this.#threadScroll = 0;
    this.#half = "thread";
  }

  /** The notes in the conversation's order: the cursor's targets that are notes. */
  #noteTargets(): Target[] {
    return (this.#feed?.targets ?? []).filter((target) => target.kind === "note");
  }

  /** ] and [ in the conversation: the cursor to the next or previous note. */
  #nextNote(direction: 1 | -1): void {
    const notes = this.#noteTargets();
    const current = this.#selectedTarget();
    const start = current?.start ?? -1;
    const next =
      direction > 0
        ? notes.find((t) => t.start > start || (t.start === start && t.key !== current?.key && t.side === "right"))
        : notes.findLast((t) => t.start < start);
    if (!next) {
      this.#message = { text: direction > 0 ? "No more notes below" : "No more notes above", style: MUTED };
      return;
    }
    if (this.#chat) this.#follow = false;
    this.#select(next.key);
  }

  /** ] and [ in a thread: the next or previous note's thread. */
  #nextThread(direction: 1 | -1): void {
    const notes = this.#noteTargets();
    const index = notes.findIndex((t) => t.rootId === this.#threadRoot);
    const next = notes[index + direction];
    if (!next) {
      this.#message = { text: direction > 0 ? "This is the last thread" : "This is the first thread", style: MUTED };
      return;
    }
    this.#select(next.key);
    this.#openThread(next.rootId!);
  }

  #closeThread(): void {
    const rootId = this.#threadRoot;
    this.#view = "feed";
    this.#threadRoot = null;
    if (rootId !== null && this.#model?.note(rootId)) this.#select(`n:${rootId}`);
  }

  /** Back to the feed, on the block the thread's note is about. */
  #showInFeed(): void {
    const root = this.#model?.note(this.#threadRoot);
    this.#closeThread();
    if (!root) return;
    const block = this.#feed?.targets.find(
      (target) =>
        target.kind === "block" && target.responseId === root.response_id && target.block === root.block_index,
    );
    this.#select(block?.key ?? `r:${root.response_id}`);
  }

  // ---- Drawing --------------------------------------------------------------------------

  render(): void {
    const { columns, rows } = this.#terminal.size();
    if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
      this.#terminal.draw(
        [this.#ansiRow(clipSpans([{ text: "Make this pane larger for sidenote", style: MUTED }], columns))],
        null,
      );
      return;
    }
    const frame: string[] = [this.#ansiRow(this.#topBar(columns))];
    const height = this.#bodyHeight();
    this.#paneCursor = null;
    const body =
      this.#view === "feed"
        ? this.#feedBody(columns, height)
        : this.#split()
          ? this.#splitBody(columns, height)
          : this.#threadBody(columns, height);
    frame.push(...body.map((spans) => this.#ansiRow(clipSpans(spans, columns))));
    // After the body, which settles the selection the key hints describe.
    const bottom = this.#bottom(columns);
    const cursor = bottom.cursor
      ? { row: frame.length + bottom.cursor.row, column: bottom.cursor.column }
      : (this.#composerCursor ?? this.#paneCursor);
    frame.push(...bottom.rows.map((spans) => this.#ansiRow(spans)));
    this.#terminal.draw(frame, cursor);
  }

  /** The rows under the conversation: a note editor, or the prompt line, then the key hints. */
  #bottom(columns: number): { rows: Span[][]; cursor: { row: number; column: number } | null } {
    const editor = this.#editor;
    if (editor && !this.#inMargin(editor) && !this.#inThreadPane(editor)) return this.#editorRows(editor, columns);
    const hint = clipSpans(this.#hint(), columns);
    if (!this.#chat) return { rows: [hint], cursor: null };
    const prompt = this.#promptRows(columns);
    const focused = this.#focus === "prompt" && this.#view === "feed" && !this.#lines && !this.#editor;
    const rule: Span[] = [{ text: "─".repeat(columns), style: MUTED }];
    const cursor = prompt.cursor && { row: prompt.cursor.row + 1, column: prompt.cursor.column };
    return { rows: [rule, ...prompt.rows, hint], cursor: focused ? cursor : null };
  }

  #bodyHeight(): number {
    const { columns, rows } = this.#terminal.size();
    return Math.max(1, rows - 1 - this.#bottom(columns).rows.length);
  }

  /** The session's folder, with the home folder as ~. */
  #folder(cwd: string): string {
    let folder = this.#home && cwd.startsWith(`${this.#home}/`) ? `~${cwd.slice(this.#home.length)}` : cwd;
    // A deep folder keeps its last two names, so the agent and model still fit.
    const parts = folder.split("/");
    if (folder.length > 40 && parts.length > 3) folder = `…/${parts.slice(-2).join("/")}`;
    return terminalSafe(folder);
  }

  #promptRows(columns: number): { rows: Span[][]; cursor: { row: number; column: number } } {
    const width = this.#promptWidth();
    const layout = this.#prompt.layout(width);
    const visible = Math.min(EDITOR_MAX_ROWS, layout.rows.length);
    this.#promptScroll = Math.min(Math.max(this.#promptScroll, layout.cursorRow - visible + 1), layout.cursorRow);
    const focused = this.#focus === "prompt" && this.#view === "feed";
    const label: Span = { text: PROMPT_LABEL, style: focused ? { tone: "accent", bold: true } : MUTED };
    const indent: Span = { text: " ".repeat(PROMPT_LABEL.length), style: PLAIN };
    const rows: Span[][] = [];
    for (let i = 0; i < visible; i++) {
      rows.push([i ? indent : label, { text: layout.rows[this.#promptScroll + i] ?? "", style: PLAIN }]);
    }
    if (this.#prompt.text === "") {
      const pending = this.#model?.pendingCount() ?? 0;
      const placeholder = this.#working ? "Message Claude; it goes when this turn ends…" : "Message Claude…";
      rows[0] = [label, { text: placeholder, style: MUTED }];
      const along = `${plural(pending, "note rides", "notes ride")} along`;
      const gap = columns - spansWidth(rows[0]) - along.length;
      if (pending && gap >= 3) rows[0].push({ text: " ".repeat(gap), style: PLAIN }, { text: along, style: ACCENT });
    }
    return {
      rows: rows.map((spans) => clipSpans(spans, columns)),
      cursor: { row: layout.cursorRow - this.#promptScroll, column: PROMPT_LABEL.length + layout.cursorColumn },
    };
  }

  #promptWidth(): number {
    return Math.max(10, this.#terminal.size().columns - PROMPT_LABEL.length - 1);
  }

  #topBar(columns: number): Span[] {
    const model = this.#model;
    const session = model?.snapshot.session;
    const name = terminalSafe(session ? session.name || projectName(session.cwd) : projectName(this.#cwd));
    const conversation = this.#conversation;
    const left: Span[] = conversation
      ? [
          { text: "[", style: { tone: "accent", bold: true } },
          { text: "sidenote", style: { bold: true } },
          { text: "]", style: { tone: "accent", bold: true } },
          { text: `  ${name}`, style: PLAIN },
          { text: `  ${this.#folder(session?.cwd ?? this.#cwd)} · ${conversation.agent}`, style: MUTED },
          ...(conversation.model ? [{ text: ` · ${terminalSafe(conversation.model)}`, style: MUTED }] : []),
        ]
      : [
          { text: "sidenote", style: { bold: true } },
          { text: " · ", style: MUTED },
          { text: name, style: PLAIN },
        ];
    const right: Span[] = [];
    if (!this.#reachable) {
      right.push({ text: "can't reach sidenote, retrying", style: { tone: "del" } });
    } else if (conversation) {
      const elapsed = conversation.live ? ` ${duration(this.#now() - conversation.live.started_at)}` : "";
      right.push(
        conversation.state === "working"
          ? { text: `◐ working${elapsed}`, style: ACCENT }
          : conversation.state === "waiting"
            ? { text: "◆ needs your answer", style: { tone: "accent", bold: true } }
            : conversation.state === "stopped"
              ? { text: "○ stopped", style: MUTED }
              : { text: "● your turn", style: { tone: "add" } },
      );
      if (conversation.context) {
        const percent = Math.round((100 * conversation.context.used) / conversation.context.limit);
        right.push({ text: `   context ${percent}%`, style: MUTED });
      }
    } else if (model && session) {
      const pending = model.pendingCount();
      const { status, send_requested: queued } = model.sendStatus();
      if (pending) right.push({ text: queued ? `${pending} sending… · ` : `${pending} pending · `, style: ACCENT });
      right.push(
        status === "listening"
          ? { text: "● listening", style: { tone: "add" } }
          : status === "busy"
            ? { text: "◐ Claude is working", style: ACCENT }
            : { text: "○ not listening", style: MUTED },
      );
    }
    const rightWidth = spansWidth(right);
    const leftClipped = clipSpans(left, Math.max(10, columns - rightWidth - 2));
    const gap = columns - spansWidth(leftClipped) - rightWidth;
    return gap > 0 ? [...leftClipped, { text: " ".repeat(gap), style: PLAIN }, ...right] : leftClipped;
  }

  #feedBody(columns: number, height: number): Span[][] {
    const model = this.#model;
    const conversation = this.#conversation;
    const waiting = conversation && (conversation.live || conversation.permission || conversation.error);
    if (!model || (!model.responses.length && !waiting)) return emptyState(this.#emptyText(), height);
    if (columns !== this.#renderWidth) {
      this.#renders.clear();
      this.#renderWidth = columns;
    }
    const before = this.#selectedTarget();
    const render = (response: StoredResponse, width: number): RenderedReply => this.#render(response, width);
    const feed = this.#chat
      ? buildConversation(model, {
          width: columns,
          selectedKey: this.#selected,
          render,
          renderMarkdown: (markdown, width) => renderReply(markdown, { width }),
          live: conversation,
        })
      : buildFeed(model, { width: columns - GUTTER, selectedKey: this.#selected, render });
    this.#feed = feed;

    if (this.#showReply !== null && feed.replyStarts.has(this.#showReply)) {
      const id = this.#showReply;
      this.#showReply = null;
      this.#newBelow = false;
      const first =
        feed.targets.find((t) => t.responseId === id && t.kind === "block") ??
        feed.targets.find((t) => t.responseId === id);
      this.#selected = first?.key ?? null;
      this.#scroll = feed.replyStarts.get(id)!;
      this.#reveal = false;
    }
    let target = this.#selectedTarget();
    if (!target && feed.targets.length) {
      // The selection went away (a deleted note, say): take what is now in its place.
      const fallback = feed.targets.find((t) => t.start >= (before?.start ?? 0)) ?? feed.targets.at(-1)!;
      this.#selected = fallback.key;
      target = fallback;
      this.#reveal = true;
    } else if (target && before && !this.#reveal) {
      // Content above the cursor grew or shrank: keep the cursor where it was on screen.
      this.#scroll += target.start - before.start;
    }
    if (target && this.#reveal) this.#revealTarget(target, height);
    this.#reveal = false;
    if (this.#follow && this.#chat) this.#scroll = feed.rows.length;
    this.#scroll = this.#clampScroll(this.#scroll);
    this.#composerCursor = null;
    if (this.#editor && this.#inMargin(this.#editor)) this.#placeComposer(feed, this.#editor, height);
    if (this.#scroll + height >= feed.rows.length) this.#newBelow = false;

    const lines = this.#lines;
    const [lineFrom, lineTo] = lines ? [Math.min(...lines), Math.max(...lines)] : [-1, -1];
    const out: Span[][] = [];
    for (let row = this.#scroll; row < this.#scroll + height; row++) {
      const content = feed.rows[row];
      if (!content) {
        out.push([]);
        continue;
      }
      const cursorShown =
        !this.#chat || (this.#view === "thread" ? this.#half === "conversation" : this.#focus === "feed");
      const onTarget = cursorShown && target?.side === "left" && row >= target.start && row < target.end;
      const gutter: Span =
        row >= lineFrom && row <= lineTo
          ? { text: "┃ ", style: { tone: "accent", bold: true } }
          : onTarget && !lines
            ? { text: "▌ ", style: ACCENT }
            : { text: "  ", style: PLAIN };
      const leadWidth = feed.leadWidth ?? 0;
      const spans = [...leadSpans(content.lead ?? [], leadWidth), gutter, ...content.left];
      if (feed.marginRule) {
        const pad = leadWidth + GUTTER + feed.leftWidth + 1 - spansWidth(spans);
        spans.push(
          { text: " ".repeat(Math.max(1, pad)), style: PLAIN },
          { text: "│ ", style: MUTED },
          ...content.right,
        );
      } else if (content.right.length) {
        const pad = GUTTER + feed.leftWidth + 3 - spansWidth(spans);
        spans.push({ text: " ".repeat(Math.max(1, pad)), style: PLAIN }, ...content.right);
      }
      out.push(spans);
    }
    return out;
  }

  #threadBody(columns: number, height: number): Span[][] {
    const rows =
      this.#model && this.#threadRoot !== null ? buildThread(this.#model, this.#threadRoot, columns - GUTTER) : null;
    if (!rows) {
      this.#closeThread();
      return this.#feedBody(columns, height);
    }
    this.#threadScroll = Math.max(0, Math.min(this.#threadScroll, rows.length - height));
    return Array.from({ length: height }, (_, i) => {
      const spans = rows[this.#threadScroll + i];
      return spans ? [{ text: "  ", style: PLAIN }, ...spans] : [];
    });
  }

  #editorRows(editing: Editing, columns: number): { rows: Span[][]; cursor: { row: number; column: number } } {
    const width = this.#editorWidth();
    const layout = editing.text.layout(width);
    const visible = Math.min(EDITOR_MAX_ROWS, layout.rows.length);
    editing.scroll = Math.min(Math.max(editing.scroll, layout.cursorRow - visible + 1), layout.cursorRow);
    const title = clipSpans([{ text: `── ${terminalSafe(editing.title)} `, style: MUTED }], columns);
    const rule = Math.max(0, columns - spansWidth(title));
    const rows: Span[][] = [[...title, { text: "─".repeat(rule), style: MUTED }]];
    for (let i = 0; i < visible; i++) {
      const text = layout.rows[editing.scroll + i] ?? "";
      rows.push([
        { text: "  ", style: PLAIN },
        { text, style: PLAIN },
      ]);
    }
    if (editing.text.text === "") {
      const placeholder = "parent_id" in editing.request ? "Your follow-up for Claude…" : "Your note for Claude…";
      rows[1] = [
        { text: "  ", style: PLAIN },
        { text: placeholder, style: MUTED },
      ];
    }
    const canSend = this.#model?.canSend() ?? false;
    const hint = this.#chat
      ? "⏎ save: it goes with your next message · ⌥⏎ new line · ^E $EDITOR · esc close"
      : canSend
        ? "⏎ send now · ^S save for later · ⌥⏎ new line · ^E $EDITOR · esc close"
        : "⏎ save: Claude isn't listening, so it goes with your next prompt · ⌥⏎ new line · esc close";
    rows.push(
      this.#message ? [{ text: this.#message.text, style: this.#message.style }] : [{ text: hint, style: MUTED }],
    );
    return {
      rows: rows.map((spans) => clipSpans(spans, columns)),
      cursor: { row: 1 + layout.cursorRow - editing.scroll, column: 2 + layout.cursorColumn },
    };
  }

  #editorWidth(): number {
    if (this.#editor && this.#inMargin(this.#editor)) return MARGIN_WIDTH - 4;
    if (this.#editor && this.#inThreadPane(this.#editor))
      return Math.max(10, this.#halves().right - REPLY_LABEL.length - 1);
    return Math.max(10, this.#terminal.size().columns - 3);
  }

  /** In chat, wide enough for the thread to take the right half beside the conversation. */
  #split(): boolean {
    return (
      this.#chat !== null && this.#view === "thread" && this.#terminal.size().columns >= CONVERSATION_MARGIN_MIN_WIDTH
    );
  }

  /** Columns of the conversation's half and the thread's, the rule between them aside. */
  #halves(): { left: number; right: number } {
    const columns = this.#terminal.size().columns;
    const left = Math.floor(columns / 2);
    return { left, right: columns - left - 2 };
  }

  /** Whether this is a reply written at the bottom of the thread's half. */
  #inThreadPane(editing: Editing): boolean {
    return this.#split() && "parent_id" in editing.request && editing.request.parent_id === this.#threadRoot;
  }

  /** The conversation on the left, the open thread on the right. */
  #splitBody(columns: number, height: number): Span[][] {
    const { left, right } = this.#halves();
    const pane = this.#threadPane(right, height, left + 2);
    if (!pane) {
      this.#closeThread();
      return this.#feedBody(columns, height);
    }
    const conversation = this.#feedBody(left, height);
    const rule: Span = { text: "│ ", style: this.#half === "thread" ? ACCENT : MUTED };
    return conversation.map((spans, i) => {
      const clipped = clipSpans(spans, left);
      const pad: Span = { text: " ".repeat(Math.max(0, left - spansWidth(clipped))), style: PLAIN };
      return [...clipped, pad, rule, ...(pane[i] ?? [])];
    });
  }

  /**
   * The thread's half: what it is about, the note and Claude's answers, then its reply line.
   * column is where the half starts, for the text cursor of a reply being written.
   */
  #threadPane(width: number, height: number, column: number): Span[][] | null {
    const model = this.#model;
    const root = model?.note(this.#threadRoot);
    const rows = model && root ? buildThread(model, root.id, width - 1) : null;
    if (!rows || !root) return null;
    const about = root.quote ? `note on: ${terminalSafe(root.quote).replace(/\s+/g, " ")}` : "note on the whole reply";
    const close = this.#half === "thread" ? "esc close" : "tab thread";
    const head = clipSpans(
      [
        { text: "thread", style: { tone: "accent", bold: true } },
        { text: ` · ${about}`, style: MUTED },
      ],
      Math.max(10, width - close.length - 2),
    );
    const header: Span[] = [
      ...head,
      { text: " ".repeat(Math.max(1, width - spansWidth(head) - close.length)), style: PLAIN },
      { text: close, style: MUTED },
    ];

    const editing = this.#editor && this.#inThreadPane(this.#editor) ? this.#editor : null;
    const reply = this.#replyRows(editing, width);
    // buildThread's own heading is replaced by the header above.
    const body = rows.slice(2);
    const room = Math.max(1, height - 1 - reply.rows.length);
    this.#threadScroll = Math.max(0, Math.min(this.#threadScroll, body.length - room));
    const out: Span[][] = [header];
    for (let i = 0; i < room; i++) out.push(body[this.#threadScroll + i] ?? []);
    if (reply.cursor)
      this.#paneCursor = { row: 1 + out.length + reply.cursor.row, column: column + reply.cursor.column };
    out.push(...reply.rows);
    return out.slice(0, height);
  }

  /** "reply › …" at the bottom of the thread's half, as an editor while a reply is written. */
  #replyRows(
    editing: Editing | null,
    width: number,
  ): { rows: Span[][]; cursor: { row: number; column: number } | null } {
    const rule: Span[] = [{ text: "─".repeat(width), style: MUTED }];
    const label: Span = { text: REPLY_LABEL, style: { tone: "accent", bold: true } };
    const indent: Span = { text: " ".repeat(REPLY_LABEL.length), style: PLAIN };
    if (!editing) {
      return {
        rows: [
          rule,
          [label, { text: this.#half === "thread" ? "r to reply…" : "tab, then r to reply…", style: MUTED }],
        ],
        cursor: null,
      };
    }
    const layout = editing.text.layout(this.#editorWidth());
    const visible = Math.min(EDITOR_MAX_ROWS, layout.rows.length);
    editing.scroll = Math.min(Math.max(editing.scroll, layout.cursorRow - visible + 1), layout.cursorRow);
    const rows: Span[][] = [rule];
    for (let i = 0; i < visible; i++) {
      rows.push([i ? indent : label, { text: layout.rows[editing.scroll + i] ?? "", style: PLAIN }]);
    }
    if (editing.text.text === "") rows[1] = [label, { text: "Your follow-up…", style: MUTED }];
    rows.push([{ text: "⏎ ask now · ^S keep for later · esc close", style: MUTED }]);
    return {
      rows,
      cursor: {
        row: 1 + layout.cursorRow - editing.scroll,
        column: REPLY_LABEL.length + layout.cursorColumn,
      },
    };
  }

  /** Whether this note is written in a box in the margin, beside its text. */
  #inMargin(editing: Editing): boolean {
    return (
      this.#chat !== null &&
      this.#view === "feed" &&
      editing.anchor !== null &&
      conversationLayout(this.#terminal.size().columns).margin
    );
  }

  /**
   * Draws the note being written as a box in the margin, beside the rows it is about, and
   * scrolls so the box is in view. Sets where the text cursor goes.
   */
  #placeComposer(feed: FeedView, editing: Editing, height: number): void {
    const target = feed.targets.find((t) => t.key === editing.anchor!.key);
    if (!target) return;
    const width = this.#editorWidth();
    const layout = editing.text.layout(width);
    const visible = Math.min(EDITOR_MAX_ROWS, layout.rows.length);
    editing.scroll = Math.min(Math.max(editing.scroll, layout.cursorRow - visible + 1), layout.cursorRow);
    const accent: Style = { tone: "accent" };
    const edge = (left: string, label: string, right: string): Span[] => {
      const text = terminalSafe(label);
      const fill = Math.max(0, MARGIN_WIDTH - 2 - spansWidth([{ text: `─ ${text} `, style: PLAIN }]));
      return [
        { text: `${left}─ `, style: accent },
        { text, style: label.startsWith("⏎") ? MUTED : accent },
        { text: ` ${"─".repeat(fill)}${right}`, style: accent },
      ];
    };
    const box: Span[][] = [edge("╭", editing.anchor!.label, "╮")];
    for (let i = 0; i < Math.max(2, visible); i++) {
      const text = layout.rows[editing.scroll + i] ?? "";
      const shown: Span =
        i === 0 && editing.text.text === ""
          ? { text: "Your note for Claude…", style: MUTED }
          : { text, style: { bold: true } };
      const pad = Math.max(0, width - spansWidth([shown]));
      box.push([{ text: "│ ", style: accent }, shown, { text: `${" ".repeat(pad)} │`, style: accent }]);
    }
    box.push(edge("╰", "⏎ save · esc close", "╯"));

    const at = Math.min(target.start + editing.anchor!.offset, target.end - 1);
    while (feed.rows.length < at + box.length) feed.rows.push({ left: [], right: [] });
    box.forEach((spans, k) => (feed.rows[at + k]!.right = spans));
    if (at < this.#scroll) this.#scroll = at;
    else if (at + box.length > this.#scroll + height) this.#scroll = at + box.length - height;
    this.#scroll = this.#clampScroll(this.#scroll);
    const marginColumn = (feed.leadWidth ?? 0) + GUTTER + feed.leftWidth + 1 + 2;
    this.#composerCursor = {
      row: 1 + at + 1 + layout.cursorRow - editing.scroll - this.#scroll,
      column: marginColumn + 2 + layout.cursorColumn,
    };
  }

  #hint(): Span[] {
    if (this.#message) return [{ text: this.#message.text, style: this.#message.style }];
    if (this.#editor) {
      const text = this.#inThreadPane(this.#editor)
        ? "⏎ ask now: your other pending notes go too · ^S keep for later · ⌥⏎ new line · esc close"
        : "⏎ save: it goes with your next message · ⌥⏎ new line · ^E $EDITOR · esc close";
      return [{ text, style: MUTED }];
    }
    const parts: string[] = [];
    if (this.#conversation?.permission && this.#view === "feed" && !this.#lines) {
      return [{ text: "Claude is waiting: y allow · a always allow · n deny", style: { tone: "accent", bold: true } }];
    }
    if (this.#chat && this.#view === "feed" && this.#focus === "prompt" && !this.#lines) {
      parts.push("⏎ send", "⌥⏎ new line");
      if (this.#working) parts.push("esc interrupt");
      parts.push("tab conversation", "pgup/pgdn scroll");
      if (this.#model?.pendingCount()) parts.push("notes go with your message");
      parts.push("^C quit");
      return [{ text: parts.join(" · "), style: MUTED }];
    }
    if (this.#lines) {
      parts.push("j/k pick lines", "n note on these lines", "esc cancel");
    } else if (this.#split() && this.#half === "thread") {
      parts.push("tab conversation", "j/k scroll", "r reply", "]/[ next/prev thread", "f show in conversation");
      parts.push("x delete unsent", "esc close");
    } else if (this.#view === "thread" && !this.#split()) {
      parts.push("j/k scroll", "r reply", "x delete unsent", "f show in feed", "esc back");
    } else {
      const target = this.#selectedTarget();
      parts.push("j/k move");
      if (target?.kind === "note" || target?.kind === "answer") parts.push("⏎ open thread", "n reply");
      else if (target?.file !== undefined) parts.push("⏎ fold", "n note");
      else if (target) parts.push("n note");
      if (target?.kind === "note") parts.push("x delete");
      if (target?.code) parts.push("v pick lines");
      parts.push("N note on reply");
      if (this.#chat) parts.push("]/[ next/prev note");
      if (this.#split()) parts.push("tab thread", "esc close thread");
      else if (this.#chat) parts.push("tab message");
      if (this.#chat && this.#working) parts.push("esc interrupt");
    }
    if (this.#model?.pendingCount() && this.#model.canSend()) parts.push("S send now");
    parts.push("q quit");
    const spans: Span[] = [];
    if (this.#newBelow) spans.push({ text: this.#chat ? "↓ more below: G · " : "↓ new reply: G · ", style: ACCENT });
    spans.push({ text: parts.join(" · "), style: MUTED });
    return spans;
  }

  #emptyText(): string {
    if (!this.#reachable) return "Can't reach the sidenote server. Retrying…";
    if (this.#chat) return `A new session in ${projectName(this.#cwd)}. Type a message for Claude below.`;
    if (!this.#model)
      return `Waiting for a Claude Code session in ${projectName(this.#cwd)}. Its replies appear here as Claude finishes them.`;
    return "No replies in this session yet. They appear here as Claude finishes them.";
  }

  #render(response: StoredResponse, width: number): RenderedReply {
    const open = this.#openFiles.get(response.id);
    const key = `${response.id}:${width}:${open ? [...open].sort().join(",") : "default"}`;
    let rendered = this.#renders.get(key);
    if (!rendered) {
      rendered = renderReply(response.text, {
        width,
        ...(open ? { isFileOpen: (file: number) => open.has(file) } : {}),
      });
      this.#renders.set(key, rendered);
    }
    return rendered;
  }

  #selectedTarget(): Target | undefined {
    return this.#feed?.targets.find((target) => target.key === this.#selected);
  }

  #revealTarget(target: Target, height: number): void {
    const size = target.end - target.start;
    if (size > height) {
      if (this.#scroll < target.start || this.#scroll + height > target.end) this.#scroll = target.start;
    } else if (target.start < this.#scroll) {
      this.#scroll = target.start;
    } else if (target.end > this.#scroll + height) {
      this.#scroll = target.end - height;
    }
  }

  #keepRowVisible(row: number): void {
    const height = this.#bodyHeight();
    if (row < this.#scroll) this.#scroll = row;
    else if (row >= this.#scroll + height) this.#scroll = row - height + 1;
  }

  #clampScroll(scroll: number): number {
    const rows = this.#feed?.rows.length ?? 0;
    return Math.max(0, Math.min(scroll, rows - this.#bodyHeight()));
  }

  #ansiRow(spans: Span[]): string {
    return lineToAnsi({ spans, block: -1 }, this.#ansi);
  }
}

/** The speaker column: right-aligned, two columns short of its width. */
function leadSpans(lead: Span[], width: number): Span[] {
  if (!width) return [];
  const clipped = clipSpans(lead, width - 2);
  return [
    { text: " ".repeat(width - 2 - spansWidth(clipped)), style: PLAIN },
    ...clipped,
    { text: "  ", style: PLAIN },
  ];
}

/** "0:07", "12:30", "1:02:03". */
export function duration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function emptyState(text: string, height: number): Span[][] {
  const rows: Span[][] = Array.from({ length: height }, () => []);
  rows[Math.min(1, height - 1)] = [{ text: `  ${text}`, style: MUTED }];
  return rows;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return `Couldn't do that: ${text.replace(/\s+/g, " ")}`;
}
