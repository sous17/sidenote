// A session sidenote runs, laid out as the "Margin" design: a narrow left column with who spoke
// and when, the conversation in the middle, and notes in a margin on the right, level with the
// text they are about. Below 120 columns notes go under their block instead, and below 60 the
// speaker column folds into the rows. The turn in progress streams in at the bottom.
//
// The result has the feed's shape (rows and the targets the cursor moves between), so the app
// moves, notes and picks lines in it the same way.
import { isAnswered, type Model } from "../shared/model.ts";
import { formatTime, plainText, plural } from "../shared/text.ts";
import type { ConversationView, LivePart, Note, StoredResponse, TurnStep } from "../shared/types.ts";
import { addAnswered, codeQuoteLine, limitRows, type FeedRow, type FeedView, type Target } from "./feed.ts";
import { PLAIN, type Span, type Style } from "./lines.ts";
import { markLines, noteMarks } from "./marks.ts";
import type { RenderedReply } from "./render.ts";
import { terminalSafe } from "./sanitize.ts";
import { endedRows, permissionRows, promptRows, stepRows, type StepView } from "./turn.ts";
import { wrapSpans } from "./wrap.ts";

/** From this width notes sit in a margin beside the conversation. */
export const CONVERSATION_MARGIN_MIN_WIDTH = 120;
/** Below this width there is no speaker column. */
const LEAD_MIN_WIDTH = 60;
const LEAD_WIDTH = 10;
/** The app's cursor column, between the speaker column and the text. */
const CURSOR_WIDTH = 2;
export const MARGIN_WIDTH = 36;
/** " │ " between the text and the margin. */
const MARGIN_GAP = 3;
const INLINE_INDENT = 2;
const NOTE_BODY_ROWS = 4;
const NOTE_ANSWER_ROWS = 2;

const MUTED: Style = { tone: "muted" };
const ACCENT: Style = { tone: "accent" };

export interface ConversationOptions {
  /** The view's columns, the cursor's included. */
  width: number;
  selectedKey: string | null;
  render: (response: StoredResponse, width: number) => RenderedReply;
  renderMarkdown: (markdown: string, width: number) => RenderedReply;
  /** The turn in progress, and what waits on the user. */
  live: ConversationView | null;
}

export interface ConversationLayout {
  lead: number;
  text: number;
  margin: boolean;
}

export function conversationLayout(width: number): ConversationLayout {
  const lead = width >= LEAD_MIN_WIDTH ? LEAD_WIDTH : 0;
  const margin = width >= CONVERSATION_MARGIN_MIN_WIDTH;
  return { lead, margin, text: width - lead - CURSOR_WIDTH - (margin ? MARGIN_GAP + MARGIN_WIDTH : 0) };
}

export function buildConversation(model: Model, options: ConversationOptions): FeedView {
  const layout = conversationLayout(options.width);
  const view: FeedView = {
    rows: [],
    targets: [],
    replyStarts: new Map(),
    leftWidth: layout.text,
    leadWidth: layout.lead,
    marginRule: layout.margin,
  };
  const builder = new Builder(model, view, layout, options);
  for (const response of model.responses) builder.turn(response);
  if (options.live) builder.live(options.live);
  view.targets.sort((a, b) => a.start - b.start || (a.side === "left" ? -1 : 1));
  return view;
}

class Builder {
  readonly #model: Model;
  readonly #view: FeedView;
  readonly #layout: ConversationLayout;
  readonly #options: ConversationOptions;

  constructor(model: Model, view: FeedView, layout: ConversationLayout, options: ConversationOptions) {
    this.#model = model;
    this.#view = view;
    this.#layout = layout;
    this.#options = options;
  }

  get #rows(): FeedRow[] {
    return this.#view.rows;
  }

  /** One stored turn: what the user typed, then the reply with its tool calls and notes. */
  turn(response: StoredResponse): void {
    this.#gap();
    this.#view.replyStarts.set(response.id, this.#rows.length);
    if (response.prompt !== undefined && this.#prompt(response.prompt, response.notes_sent ?? 0, response.created_at)) {
      this.#push([]);
    }
    const onlyAnswers = !response.text.trim() && Object.keys(response.note_answers).length > 0;
    this.#speaker("claude", response.prompt === undefined ? formatTime(response.created_at) : "");
    if (onlyAnswers) {
      addAnswered(this.#model, response, this.#view, "");
      return;
    }
    this.#reply(response);
  }

  /** The turn in progress, then a permission prompt, queued messages, or why the agent stopped. */
  live(view: ConversationView): void {
    const width = this.#layout.text;
    const turn = view.live;
    if (turn) {
      this.#gap();
      if (this.#prompt(turn.prompt, turn.notes_sent, null)) this.#push([]);
      this.#speaker("claude", "now");
      const start = this.#rows.length;
      this.#parts(turn.parts);
      if (view.state === "working" && turn.parts.at(-1)?.kind !== "text") this.#push([{ text: "…", style: MUTED }]);
      if (this.#rows.length === start) this.#push([]);
    }
    if (view.permission) {
      this.#push([]);
      for (const spans of permissionRows(view.permission, width)) this.#push(spans);
    }
    for (const text of view.queued) {
      const label = terminalSafe(text).replace(/\s+/g, " ") || "notes (Send now)";
      this.#push([{ text: `queued › ${label}`, style: MUTED }]);
    }
    if (!turn && view.error) {
      this.#gap();
      for (const spans of wrapSpans([{ text: terminalSafe(view.error), style: { tone: "del" } }], width)) {
        this.#push(spans);
      }
    }
  }

  #parts(parts: readonly LivePart[]): void {
    let tools: StepView[] = [];
    const flush = (): void => {
      if (tools.length) for (const spans of stepRows(tools, this.#layout.text)) this.#push(spans);
      tools = [];
    };
    for (const part of parts) {
      if (part.kind === "tool") {
        tools.push(part);
        continue;
      }
      if (!part.text.trim()) continue;
      flush();
      for (const line of this.#options.renderMarkdown(part.text, this.#layout.text).lines) this.#push(line.spans);
    }
    flush();
  }

  /** The user's message, with "you" and its time beside it. False when there is nothing to show. */
  #prompt(prompt: string, notesSent: number, at: number | null): boolean {
    const rows = promptRows(prompt, notesSent, this.#layout.text);
    if (!rows.length) return false;
    this.#speaker("you", at === null ? "now" : formatTime(at));
    for (const spans of rows) this.#push(spans);
    return true;
  }

  /**
   * Names who speaks from the next row: in the speaker column, with the time on the row under
   * it, or, with no speaker column, on a row of its own.
   */
  #speaker(name: string, time: string): void {
    const style: Style = { tone: name === "you" ? "link" : "accent", bold: true };
    if (!this.#layout.lead) {
      this.#rows.push({
        left: [{ text: name, style }, ...(time ? [{ text: ` · ${time}`, style: MUTED }] : [])],
        right: [],
      });
      return;
    }
    this.#leads.set(this.#rows.length, [{ text: name, style }]);
    if (time) this.#leads.set(this.#rows.length + 1, [{ text: time, style: MUTED }]);
  }

  /** Speaker column contents, by row. */
  readonly #leads = new Map<number, Span[]>();

  #push(spans: Span[], right: Span[] = []): void {
    const lead = this.#leads.get(this.#rows.length);
    this.#leads.delete(this.#rows.length);
    this.#rows.push(lead ? { lead, left: spans, right } : { left: spans, right });
  }

  #gap(): void {
    if (this.#rows.length) this.#push([]);
  }

  /** The reply's blocks, its tool calls between them, and its notes in the margin or inline. */
  #reply(response: StoredResponse): void {
    const model = this.#model;
    const rows = this.#rows;
    const targets = this.#view.targets;
    const rendered = this.#options.render(response, this.#layout.text);
    const roots = model.notes
      .filter((note) => note.response_id === response.id && note.parent_id === null)
      .sort((a, b) => a.created_at - b.created_at);
    const blockOf = (note: Note): number => (note.block_index < rendered.blocks.length ? note.block_index : -1);
    const byBlock = new Map<number, Note[]>();
    for (const root of roots) byBlock.set(blockOf(root), [...(byBlock.get(blockOf(root)) ?? []), root]);
    const marks = noteMarks(roots);
    const lines = markLines(rendered.lines, roots, marks);

    const stepsAfter = new Map<number, TurnStep[]>();
    for (const step of response.steps ?? []) {
      const block = Math.min(step.after_block, rendered.blocks.length - 1);
      stepsAfter.set(block, [...(stepsAfter.get(block) ?? []), step]);
    }
    const addSteps = (block: number): void => {
      const steps = stepsAfter.get(block);
      stepsAfter.delete(block);
      if (steps) for (const spans of stepRows(steps, this.#layout.text)) this.#push(spans);
    };

    const replyStart = rows.length;
    addSteps(-1);
    const lastLine = new Map<number, number>();
    rendered.lines.forEach((line, i) => {
      if (line.block >= 0) lastLine.set(line.block, i);
    });
    const firstRow = new Map<number, number>();
    let run: { block: number; file: number | undefined; start: number; rows: string[] } | null = null;
    const runCounts = new Map<string, number>();
    const closeRun = (): void => {
      if (!run) return;
      const id = `${response.id}:${run.block}:${run.file ?? ""}`;
      const count = runCounts.get(id) ?? 0;
      runCounts.set(id, count + 1);
      const info = rendered.blocks[run.block]!;
      targets.push({
        key: `b:${id}:${count}`,
        kind: "block",
        responseId: response.id,
        block: run.block,
        ...(run.file !== undefined && rendered.foldable ? { file: run.file } : {}),
        start: run.start,
        end: rows.length,
        side: "left",
        code: info.code,
        quote: info.code ? run.rows.map(codeQuoteLine).join("\n") : info.quote,
      });
      run = null;
    };

    let file: number | undefined;
    let previousBlock = -1;
    lines.forEach((line, i) => {
      if (line.block !== previousBlock) file = undefined;
      previousBlock = line.block;
      if (line.file !== undefined) file = line.file;
      if (line.block < 0) closeRun();
      else if (!run || run.block !== line.block || run.file !== file) {
        closeRun();
        run = { block: line.block, file, start: rows.length, rows: [] };
      }
      if (line.block >= 0 && !firstRow.has(line.block)) firstRow.set(line.block, rows.length);
      run?.rows.push(line.spans.map((span) => span.text).join(""));
      this.#push(line.spans);
      const endsBlock = line.block >= 0 && lastLine.get(line.block) === i;
      const inlineNotes = !this.#layout.margin && byBlock.has(line.block);
      if (endsBlock && (stepsAfter.has(line.block) || inlineNotes)) {
        closeRun();
        addSteps(line.block);
        if (inlineNotes) for (const root of byBlock.get(line.block)!) this.#inlineNote(root, marks.get(root.id));
      }
    });
    closeRun();
    for (const block of [...stepsAfter.keys()].sort((a, b) => a - b)) addSteps(block);
    for (const spans of endedRows(response, this.#layout.text)) this.#push(spans);
    if (rows.length === replyStart) this.#push([]);

    if (this.#layout.margin) {
      // Each note level with its block; notes that would overlap stack downwards.
      let nextFree = replyStart;
      const placed = roots
        .map((root) => ({ root, wanted: blockOf(root) < 0 ? replyStart : (firstRow.get(blockOf(root)) ?? replyStart) }))
        .sort((a, b) => a.wanted - b.wanted || a.root.created_at - b.root.created_at);
      for (const { root, wanted } of placed) {
        const at = Math.max(wanted, nextFree);
        const selected = `n:${root.id}` === this.#options.selectedKey;
        const box = marginNote(model, root, MARGIN_WIDTH, selected, marks.get(root.id));
        while (rows.length < at + box.length) this.#push([]);
        box.forEach((spans, k) => (rows[at + k]!.right = spans));
        targets.push(noteTarget(root, response.id, blockOf(root), at, at + box.length, "right"));
        nextFree = at + box.length + 1;
      }
    } else {
      for (const root of byBlock.get(-1) ?? []) this.#inlineNote(root, marks.get(root.id));
    }
    addAnswered(model, response, this.#view, "");
  }

  #inlineNote(root: Note, mark: number | undefined): void {
    const width = this.#layout.text - INLINE_INDENT;
    const box = marginNote(this.#model, root, width, `n:${root.id}` === this.#options.selectedKey, mark);
    const start = this.#rows.length;
    for (const spans of box) this.#push([{ text: " ".repeat(INLINE_INDENT), style: PLAIN }, ...spans]);
    this.#view.targets.push(noteTarget(root, root.response_id, root.block_index, start, this.#rows.length, "left"));
  }
}

function noteTarget(
  root: Note,
  responseId: number,
  block: number,
  start: number,
  end: number,
  side: "left" | "right",
): Target {
  return {
    key: `n:${root.id}`,
    kind: "note",
    responseId,
    block,
    rootId: root.id,
    start,
    end,
    side,
    code: false,
    quote: root.quote,
  };
}

/**
 * A note in the margin: ◆ while it waits to be sent, ◇ once sent, with the start of Claude's
 * answer and how many replies its thread has. Its first column is a strip in the note's color.
 */
export function marginNote(model: Model, root: Note, width: number, selected: boolean, mark?: number): Span[][] {
  const thread = model.thread(root.id);
  const pending = thread.some((note) => note.delivered_at === null);
  const inner = Math.max(8, width - 2);
  const marker: Span = {
    text: pending ? "◆ " : "◇ ",
    style: selected ? { tone: "accent", bold: true } : pending ? ACCENT : MUTED,
  };
  const indent: Span = { text: "  ", style: PLAIN };
  const bodyStyle: Style = selected ? { bold: true, ...(pending ? ACCENT : {}) } : pending ? ACCENT : PLAIN;
  const body = limitRows(
    wrapSpans([{ text: terminalSafe(root.body), style: bodyStyle }], inner),
    NOTE_BODY_ROWS,
    inner,
  );
  const rows: Span[][] = body.map((spans, i) => [i ? indent : marker, ...spans]);

  const answer = thread.map((note) => model.answerText(note)).findLast(Boolean);
  if (answer) {
    const snippet = wrapSpans([{ text: `↳ ${terminalSafe(plainText(answer))}`, style: MUTED }], inner);
    for (const spans of limitRows(snippet, NOTE_ANSWER_ROWS, inner)) rows.push([indent, ...spans]);
  }
  const replies = new Set(thread.filter(isAnswered).map((note) => note.answered_by)).size + thread.length - 1;
  const status = thread.some((note) => model.isQueued(note))
    ? "sending…"
    : pending
      ? "waits for your next message"
      : thread.some((note) => note.answered_by === null)
        ? "sent, waiting for Claude"
        : "";
  const footer = [status, replies ? plural(replies, "reply", "replies") : "", selected ? "⏎ open" : ""].filter(Boolean);
  if (footer.length) rows.push([indent, { text: footer.join(" · "), style: MUTED }]);
  if (mark === undefined) return rows;
  return rows.map(([first, ...rest]) => [{ ...first!, style: { ...first!.style, mark } }, ...rest]);
}
