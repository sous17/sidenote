// The terminal window's controller: one session's feed or one note's thread, a cursor that moves
// between blocks and notes, and a note editor at the bottom. It reaches the server and the
// terminal only through TuiApi and Terminal, so tests drive it with keys and read its frames.
import { Model } from "../shared/model.ts";
import { projectName, plural, truncate } from "../shared/text.ts";
import type { NewNoteRequest, SessionSummary, StateSnapshot, StoredResponse } from "../shared/types.ts";
import { lineToAnsi, type AnsiOptions } from "./ansi.ts";
import { NoteText } from "./editor.ts";
import { buildFeed, type FeedView, type Target } from "./feed.ts";
import type { Key } from "./keys.ts";
import { PLAIN, type Span, type Style } from "./lines.ts";
import { renderReply, type RenderedReply } from "./render.ts";
import { terminalSafe } from "./sanitize.ts";
import { buildThread } from "./thread.ts";
import { clipSpans, spansWidth } from "./wrap.ts";

export interface TuiApi {
  sessions(): Promise<SessionSummary[]>;
  /** The session's state, or null when nothing changed since knownVersion. */
  state(knownVersion: number, sessionId: string): Promise<StateSnapshot | null>;
  addNote(note: NewNoteRequest): Promise<void>;
  deleteNote(id: number): Promise<void>;
  send(sessionId: string): Promise<void>;
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
}

/** Same limit as the page's editor: enough context for Claude without the whole reply. */
const MAX_QUOTE_CHARS = 600;
const GUTTER = 2;
const EDITOR_MAX_ROWS = 6;
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
  #model: Model | null = null;
  #reachable = true;

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
    this.#ansi = options.ansi;
    this.#cwd = options.cwd;
    if (options.sessionId) this.#model = new Model(options.sessionId);
  }

  get sessionId(): string | null {
    return this.#model?.sessionId ?? null;
  }

  // ---- Server ---------------------------------------------------------------------------

  /** Fetches the latest state, then draws. Called once a second, and after every change. */
  async refresh(): Promise<void> {
    try {
      if (!this.#model) {
        const sessions = await this.#api.sessions();
        const here = sessions.find((session) => session.cwd === this.#cwd);
        if (here) this.#model = new Model(here.id);
      }
      if (this.#model) {
        const snapshot = await this.#api.state(this.#model.snapshot.version, this.#model.sessionId);
        if (snapshot) this.#update(snapshot);
      }
      this.#reachable = true;
    } catch {
      this.#reachable = false;
    }
    this.render();
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
    if (firstLoad) {
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
    const confirming = this.#confirmDelete;
    this.#confirmDelete = null;
    this.#message = null;
    try {
      if (key.ctrl && key.name === "c") return this.#terminal.quit();
      if (this.#editor) await this.#editorKey(this.#editor, key);
      else if (this.#lines) this.#linesKey(this.#lines, key);
      else if (this.#view === "thread") await this.#threadKey(key, confirming);
      else await this.#feedKey(key, confirming);
    } catch (error) {
      this.#message = { text: errorText(error), style: { tone: "del" } };
    }
    this.render();
  }

  async #feedKey(key: Key, confirming: number | null): Promise<void> {
    const target = this.#selectedTarget();
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
        const latest = this.#model?.responses.at(-1);
        if (latest) this.#showReply = latest.id;
        this.#newBelow = false;
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
      this.#startNote({ ...target, quote });
      return;
    }
    this.#keepRowVisible(lines[1]);
  }

  async #threadKey(key: Key, confirming: number | null): Promise<void> {
    const height = this.#bodyHeight();
    switch (key.name) {
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
    const { text } = editing;
    const width = this.#editorWidth();
    if (key.name === "escape") return this.#closeEditor();
    if (key.name === "enter" && (key.alt || key.shift)) return text.insert("\n");
    if (key.name === "enter") return this.#submit(editing, this.#model?.canSend() ?? false);
    if (key.ctrl && key.name === "s") return this.#submit(editing, false);
    if (key.ctrl && key.name === "e") {
      const edited = await this.#terminal.editText(text.text);
      if (edited !== null) editing.text = new NoteText(edited.replace(/\n+$/, ""));
      return;
    }
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

  #startNote(target: Target): void {
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
  }

  #startReply(rootId: number): void {
    this.#openEditor({ parent_id: rootId }, `t:${rootId}`, "Reply in this thread");
  }

  #openEditor(request: NoteRequest, draftKey: string, title: string): void {
    this.#editor = { text: new NoteText(this.#drafts.get(draftKey) ?? ""), request, draftKey, title, scroll: 0 };
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
    const bottom = this.#editor ? this.#editorRows(this.#editor, columns) : null;
    const height = this.#bodyHeight();
    const body = this.#view === "thread" ? this.#threadBody(columns, height) : this.#feedBody(columns, height);
    frame.push(...body.map((spans) => this.#ansiRow(clipSpans(spans, columns))));
    let cursor: { row: number; column: number } | null = null;
    if (bottom) {
      cursor = { row: frame.length + bottom.cursor.row, column: bottom.cursor.column };
      frame.push(...bottom.rows.map((spans) => this.#ansiRow(spans)));
    } else {
      frame.push(this.#ansiRow(clipSpans(this.#hint(), columns)));
    }
    this.#terminal.draw(frame, cursor);
  }

  #bodyHeight(): number {
    const { columns, rows } = this.#terminal.size();
    const bottom = this.#editor ? this.#editorRows(this.#editor, columns).rows.length : 1;
    return Math.max(1, rows - 1 - bottom);
  }

  #topBar(columns: number): Span[] {
    const model = this.#model;
    const session = model?.snapshot.session;
    const name = terminalSafe(session ? session.name || projectName(session.cwd) : projectName(this.#cwd));
    const left: Span[] = [
      { text: "sidenote", style: { bold: true } },
      { text: " · ", style: MUTED },
      { text: name, style: PLAIN },
    ];
    const right: Span[] = [];
    if (!this.#reachable) {
      right.push({ text: "can't reach sidenote, retrying", style: { tone: "del" } });
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
    if (!model || !model.responses.length) return emptyState(this.#emptyText(), height);
    const width = columns - GUTTER;
    if (width !== this.#renderWidth) {
      this.#renders.clear();
      this.#renderWidth = width;
    }
    const before = this.#selectedTarget();
    const feed = buildFeed(model, { width, selectedKey: this.#selected, render: (r, w) => this.#render(r, w) });
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
    this.#scroll = this.#clampScroll(this.#scroll);
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
      const onTarget = target?.side === "left" && row >= target.start && row < target.end;
      const gutter: Span =
        row >= lineFrom && row <= lineTo
          ? { text: "┃ ", style: { tone: "accent", bold: true } }
          : onTarget && !lines
            ? { text: "▌ ", style: ACCENT }
            : { text: "  ", style: PLAIN };
      const spans = [gutter, ...content.left];
      if (content.right.length) {
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
    const hint = canSend
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
    return Math.max(10, this.#terminal.size().columns - 3);
  }

  #hint(): Span[] {
    if (this.#message) return [{ text: this.#message.text, style: this.#message.style }];
    const parts: string[] = [];
    if (this.#lines) {
      parts.push("j/k pick lines", "n note on these lines", "esc cancel");
    } else if (this.#view === "thread") {
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
    }
    if (this.#model?.pendingCount() && this.#model.canSend()) parts.push("S send now");
    parts.push("q quit");
    const spans: Span[] = [];
    if (this.#newBelow) spans.push({ text: "↓ new reply: G · ", style: ACCENT });
    spans.push({ text: parts.join(" · "), style: MUTED });
    return spans;
  }

  #emptyText(): string {
    if (!this.#reachable) return "Can't reach the sidenote server. Retrying…";
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

function emptyState(text: string, height: number): Span[][] {
  const rows: Span[][] = Array.from({ length: height }, () => []);
  rows[Math.min(1, height - 1)] = [{ text: `  ${text}`, style: MUTED }];
  return rows;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return `Couldn't do that: ${text.replace(/\s+/g, " ")}`;
}
