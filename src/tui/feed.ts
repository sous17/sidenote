// The feed as rows of text: each reply with its notes under the blocks they are about, or in a
// margin beside them when the pane is wide, and the targets the cursor moves between.
import { answeredNoteIds, isAnswered, type Model } from "../shared/model.ts";
import { formatTime, plainText, plural } from "../shared/text.ts";
import type { Note, StoredResponse } from "../shared/types.ts";
import { PLAIN, type Span, type Style } from "./lines.ts";
import { markLines, noteMarks } from "./marks.ts";
import type { RenderedReply } from "./render.ts";
import { terminalSafe } from "./sanitize.ts";
import { graphemes, graphemeWidth } from "./width.ts";
import { spansWidth, wrapSpans } from "./wrap.ts";

/** From this width notes move into a margin beside the reply, like the page's wide layout. */
export const MARGIN_MIN_WIDTH = 110;
const MARGIN_WIDTH = 36;
const MARGIN_GAP = 3;
const INLINE_INDENT = 2;
const NOTE_BODY_ROWS = 4;
const NOTE_ANSWER_ROWS = 2;

const MUTED: Style = { tone: "muted" };

export type TargetKind = "reply" | "block" | "note" | "answer";

/** Something the cursor can rest on: a reply's header, a block, a note, or an answered note. */
export interface Target {
  key: string;
  kind: TargetKind;
  responseId: number;
  /** The block a note would attach to; -1 for the whole reply. */
  block: number;
  /** For notes and answers: the root note of the thread. */
  rootId?: number;
  /** For a file of a diff that folds: the file's number within the reply. */
  file?: number;
  /** Rows [start, end) of the feed. */
  start: number;
  end: number;
  side: "left" | "right";
  /** Code and diffs can be noted line by line. */
  code: boolean;
  quote: string;
}

export interface FeedRow {
  /** Drawn before the cursor's column: the conversation's speaker and time. */
  lead?: Span[];
  left: Span[];
  right: Span[];
}

export interface FeedView {
  rows: FeedRow[];
  /** In reading order: top to bottom, a block before the margin note beside it. */
  targets: Target[];
  /** The first row of each reply. */
  replyStarts: Map<number, number>;
  leftWidth: number;
  /** Columns of each row's lead; 0 without one. */
  leadWidth?: number;
  /** Draw a rule between the text and the margin, on every row. */
  marginRule?: boolean;
}

export interface FeedOptions {
  width: number;
  selectedKey: string | null;
  render: (response: StoredResponse, width: number) => RenderedReply;
}

export function buildFeed(model: Model, options: FeedOptions): FeedView {
  const margin = options.width >= MARGIN_MIN_WIDTH;
  const leftWidth = margin ? options.width - MARGIN_WIDTH - MARGIN_GAP : options.width;
  const view: FeedView = { rows: [], targets: [], replyStarts: new Map(), leftWidth };
  for (const response of model.responses) {
    if (view.rows.length) view.rows.push(emptyRow());
    view.replyStarts.set(response.id, view.rows.length);
    const onlyAnswers = !response.text.trim() && Object.keys(response.note_answers).length > 0;
    if (onlyAnswers) addAnswered(model, response, view, `${formatTime(response.created_at)} `);
    else addReply(model, response, view, { ...options, margin, leftWidth });
  }
  view.targets.sort((a, b) => a.start - b.start || (a.side === "left" ? -1 : 1));
  return view;
}

interface ReplyLayout extends FeedOptions {
  margin: boolean;
  leftWidth: number;
}

function addReply(model: Model, response: StoredResponse, view: FeedView, layout: ReplyLayout): void {
  const { rows, targets } = view;
  const rendered = layout.render(response, layout.leftWidth);
  const notes = model.notes.filter((note) => note.response_id === response.id);
  const roots = notes.filter((note) => note.parent_id === null).sort((a, b) => a.created_at - b.created_at);
  // A note on a block the reply no longer has (older numbering) shows with the whole reply's.
  const blockOf = (note: Note): number => (note.block_index < rendered.blocks.length ? note.block_index : -1);
  const byBlock = new Map<number, Note[]>();
  for (const root of roots) byBlock.set(blockOf(root), [...(byBlock.get(blockOf(root)) ?? []), root]);
  const marks = noteMarks(roots);
  const lines = markLines(rendered.lines, roots, marks);

  const headerRow = rows.length;
  rows.push({ left: replyHeader(response, notes, roots.length, layout.leftWidth), right: [] });
  targets.push({
    key: `r:${response.id}`,
    kind: "reply",
    responseId: response.id,
    block: -1,
    start: headerRow,
    end: headerRow + 1,
    side: "left",
    code: false,
    quote: "",
  });

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
    rows.push({ left: line.spans, right: [] });
    if (!layout.margin && line.block >= 0 && lastLine.get(line.block) === i && byBlock.has(line.block)) {
      closeRun();
      for (const root of byBlock.get(line.block)!) addInlineNote(model, root, view, layout, marks.get(root.id));
    }
  });
  closeRun();

  if (layout.margin) {
    // Each note level with its block; notes that would overlap stack downwards, as on the page.
    let nextFree = headerRow;
    const placed = roots
      .map((root) => ({ root, wanted: blockOf(root) < 0 ? headerRow : (firstRow.get(blockOf(root)) ?? headerRow) }))
      .sort((a, b) => a.wanted - b.wanted || a.root.created_at - b.root.created_at);
    for (const { root, wanted } of placed) {
      const at = Math.max(wanted, nextFree);
      const box = noteBox(model, root, MARGIN_WIDTH, `n:${root.id}` === layout.selectedKey, marks.get(root.id));
      while (rows.length < at + box.length) rows.push(emptyRow());
      box.forEach((spans, k) => (rows[at + k]!.right = spans));
      targets.push(noteTarget(root, response.id, blockOf(root), at, at + box.length, "right"));
      nextFree = at + box.length + 1;
    }
  } else {
    for (const root of byBlock.get(-1) ?? []) addInlineNote(model, root, view, layout, marks.get(root.id));
  }
  addAnswered(model, response, view, "");
}

function addInlineNote(model: Model, root: Note, view: FeedView, layout: ReplyLayout, mark: number | undefined): void {
  const box = noteBox(model, root, layout.leftWidth - INLINE_INDENT, `n:${root.id}` === layout.selectedKey, mark);
  const start = view.rows.length;
  for (const spans of box)
    view.rows.push({ left: [{ text: " ".repeat(INLINE_INDENT), style: PLAIN }, ...spans], right: [] });
  view.targets.push(noteTarget(root, root.response_id, root.block_index, start, view.rows.length, "left"));
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

/** "↳ Claude answered 2 notes", then a row per thread that opens it. */
export function addAnswered(model: Model, response: StoredResponse, view: FeedView, prefix: string): void {
  const rootIds = new Set<number>();
  const noteIds = answeredNoteIds(model, response);
  for (const id of noteIds) {
    const note = model.note(id);
    const rootId = note && (note.parent_id ?? note.id);
    if (rootId !== undefined && model.note(rootId)) rootIds.add(rootId);
  }
  if (!rootIds.size) return;
  view.rows.push({
    left: [{ text: `${prefix}↳ Claude answered ${plural(noteIds.size, "note", "notes")}`, style: MUTED }],
    right: [],
  });
  for (const rootId of rootIds) {
    const start = view.rows.length;
    const body = terminalSafe(model.note(rootId)!.body).replace(/\s+/g, " ");
    view.rows.push({
      left: oneLine(
        [
          { text: "  › ", style: MUTED },
          { text: body, style: PLAIN },
        ],
        view.leftWidth,
      ),
      right: [],
    });
    view.targets.push({
      key: `a:${response.id}:${rootId}`,
      kind: "answer",
      responseId: response.id,
      block: -1,
      rootId,
      start,
      end: start + 1,
      side: "left",
      code: false,
      quote: "",
    });
  }
}

/** "── 14:02 · 2 notes · 1 pending ─────" */
function replyHeader(response: StoredResponse, notes: Note[], roots: number, width: number): Span[] {
  const pending = notes.filter((note) => note.delivered_at === null).length;
  const spans: Span[] = [{ text: `── ${formatTime(response.created_at)}`, style: MUTED }];
  if (roots) spans.push({ text: ` · ${plural(roots, "note", "notes")}`, style: MUTED });
  if (pending) spans.push({ text: ` · ${pending} pending`, style: { tone: "accent" } });
  const used = spansWidth(spans) + 1;
  if (used < width) spans.push({ text: ` ${"─".repeat(width - used)}`, style: MUTED });
  return spans;
}

/** A note in the feed: its quote, text, the latest answer, and whether it was sent. */
export function noteBox(model: Model, root: Note, width: number, selected: boolean, mark?: number): Span[][] {
  const thread = model.thread(root.id);
  const pending = thread.some((note) => note.delivered_at === null);
  const inner = Math.max(8, width - 2);
  const rows: Span[][] = [];
  if (root.quote) {
    const quote = terminalSafe(root.quote).replace(/\s+/g, " ");
    rows.push(oneLine([{ text: `❝ ${quote}`, style: { tone: "muted", italic: true } }], inner));
  }
  const body = wrapSpans([{ text: terminalSafe(root.body), style: selected ? { bold: true } : PLAIN }], inner);
  rows.push(...limitRows(body, NOTE_BODY_ROWS, inner));
  const answer = thread.map((note) => model.answerText(note)).findLast(Boolean);
  if (answer) {
    const snippet = [
      { text: "Claude ", style: { bold: true } },
      { text: terminalSafe(plainText(answer)), style: MUTED },
    ];
    rows.push(...limitRows(wrapSpans(snippet, inner), NOTE_ANSWER_ROWS, inner));
  }
  const queued = thread.some((note) => model.isQueued(note));
  const lastSent = Math.max(...thread.map((note) => note.delivered_at ?? 0));
  const status = queued ? "Sending…" : pending ? "Pending" : `Sent ${formatTime(lastSent)}`;
  const replies = new Set(thread.filter(isAnswered).map((note) => note.answered_by)).size + thread.length - 1;
  const footer = replies ? `${status} · ${plural(replies, "reply", "replies")}` : status;
  rows.push([{ text: footer, style: pending ? { tone: "accent" } : MUTED }]);

  const bar: Span = {
    text: selected ? "┃ " : "│ ",
    style: {
      ...(selected ? { tone: "accent", bold: true } : { tone: pending ? "accent" : "muted" }),
      ...(mark === undefined ? {} : { mark }),
    },
  };
  return rows.map((spans) => [bar, ...spans]);
}

function emptyRow(): FeedRow {
  return { left: [], right: [] };
}

/** The first row of wrapped text, with "…" when there was more. */
export function oneLine(spans: Span[], width: number): Span[] {
  return limitRows(wrapSpans(spans, width), 1, width)[0] ?? [];
}

export function limitRows(rows: Span[][], max: number, width: number): Span[][] {
  if (rows.length <= max) return rows;
  const kept = rows.slice(0, max);
  const last = kept[max - 1]!;
  // Make room for the ellipsis when the row is full.
  while (last.length && spansWidth(last) > width - 1) {
    const span = last[last.length - 1]!;
    const chars = graphemes(span.text);
    const removed = chars.pop() ?? "";
    span.text = chars.join("");
    if (!span.text) last.pop();
    if (!removed || graphemeWidth(removed) === 0) break;
  }
  last.push({ text: "…", style: last[last.length - 1]?.style ?? PLAIN });
  return kept;
}

/** A code or diff row as a note quotes it: without the gutter or fold arrow drawn around it. */
export function codeQuoteLine(row: string): string {
  return row.replace(/^(?:[│┆] |[▾▸] )/, "");
}
