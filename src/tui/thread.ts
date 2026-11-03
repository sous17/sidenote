// A note's thread as rows of text: what it is about, the note and its follow-ups, and Claude's
// answers. It replaces the feed in the pane, so the screen never holds more than two panes.
import { isAnswered, type Model } from "../shared/model.ts";
import { formatTime } from "../shared/text.ts";
import type { Note } from "../shared/types.ts";
import { PLAIN, type Span, type Style } from "./lines.ts";
import { renderReply } from "./render.ts";
import { terminalSafe } from "./sanitize.ts";
import { wrapSpans } from "./wrap.ts";

const MUTED: Style = { tone: "muted" };
const INDENT: Span = { text: "  ", style: PLAIN };
const QUOTE_ROWS = 6;

/** The thread's rows, or null when its note or reply is gone. */
export function buildThread(model: Model, rootId: number, width: number): Span[][] | null {
  const root = model.note(rootId);
  const response = model.response(root?.response_id);
  if (!root || !response) return null;
  const rows: Span[][] = [];
  const blank = (): void => {
    rows.push([]);
  };

  rows.push([
    { text: "Thread", style: { bold: true } },
    { text: ` · on the reply from ${formatTime(response.created_at)}`, style: MUTED },
  ]);
  blank();
  if (root.quote) {
    const quote = wrapSpans([{ text: terminalSafe(root.quote), style: { tone: "muted", italic: true } }], width - 2);
    for (const spans of quote.slice(0, QUOTE_ROWS)) rows.push([{ text: "▌ ", style: MUTED }, ...spans]);
    if (quote.length > QUOTE_ROWS) rows.push([{ text: "▌ …", style: MUTED }]);
  } else {
    rows.push([{ text: "On the whole reply", style: { tone: "muted", italic: true } }]);
  }

  const entries = model.thread(root.id);
  entries.forEach((note, index) => {
    blank();
    rows.push(...entry(model, note, width));
    const next = entries[index + 1];
    // One reply from Claude can answer several notes in a row; show it once, after the last.
    if (isAnswered(note) && next?.answered_by !== note.answered_by) {
      blank();
      const group = entries.filter((other) => other.answered_by === note.answered_by);
      rows.push(...answer(model, note.answered_by, group, width));
    } else if (note.delivered_at !== null && note.answered_by === null && !next) {
      blank();
      rows.push([{ text: "Sent. Claude's reply will appear here.", style: MUTED }]);
    }
  });
  return rows;
}

function entry(model: Model, note: Note, width: number): Span[][] {
  const status =
    note.delivered_at !== null
      ? `Sent ${formatTime(note.delivered_at)}`
      : model.isQueued(note)
        ? "Sending…"
        : "Pending";
  const head: Span[] = [
    { text: note.parent_id === null ? "Your note" : "Your follow-up", style: { bold: true } },
    { text: ` · ${status}`, style: note.delivered_at === null ? { tone: "accent" } : MUTED },
  ];
  const body = wrapSpans([{ text: terminalSafe(note.body), style: PLAIN }], width - 2);
  return [head, ...body.map((spans) => [INDENT, ...spans])];
}

/**
 * Claude's answer to a group of notes: the sections it wrote for them, or, when it wrote no
 * marked sections, a pointer to the reply in the feed rather than a copy of it.
 */
function answer(model: Model, responseId: number, group: Note[], width: number): Span[][] {
  const response = model.response(responseId);
  const head: Span[] = [{ text: "Claude", style: { bold: true, tone: "accent" } }];
  if (!response) return [[...head, { text: " · answered in a reply that is no longer stored", style: MUTED }]];
  head.push({ text: ` · ${formatTime(response.created_at)}`, style: MUTED });
  const texts = [...new Set(group.map((note) => model.answerText(note)).filter(Boolean))];
  if (!texts.length) return [head, [INDENT, { text: "Answered in the reply in the feed: f shows it", style: MUTED }]];
  const rows: Span[][] = [head];
  texts.forEach((text, i) => {
    if (i) rows.push([]);
    // The thread is the place to read an answer in full, so every file of a diff starts open.
    const rendered = renderReply(text, { width: width - 2, isFileOpen: () => true });
    for (const line of rendered.lines) rows.push([INDENT, ...line.spans]);
  });
  return rows;
}
