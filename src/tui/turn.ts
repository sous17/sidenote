// Rows for the parts of a turn sidenote ran: what the user typed, one-line tool calls, the
// permission prompt, and the turn still in progress at the bottom of the conversation.
import { plural } from "../shared/text.ts";
import type { ConversationView, LivePart, PermissionPrompt, StoredResponse, TurnStep } from "../shared/types.ts";
import { PLAIN, type Span, type Style } from "./lines.ts";
import type { RenderedReply } from "./render.ts";
import { terminalSafe } from "./sanitize.ts";
import { spansWidth, wrapSpans } from "./wrap.ts";

const MUTED: Style = { tone: "muted" };
const ACCENT: Style = { tone: "accent" };
const YOU = "you › ";
const PERMISSION_DETAIL_ROWS = 12;

/** "you › Fix the failing test", wrapped under itself, with the notes that rode along. */
export function promptRows(prompt: string, notesSent: number, width: number): Span[][] {
  const notes = notesSent ? `+ ${plural(notesSent, "note", "notes")}` : "";
  const text = terminalSafe(prompt).trim();
  if (!text && !notes) return [];
  const indent = { text: " ".repeat(YOU.length), style: PLAIN };
  const body = text ? wrapSpans([{ text, style: { bold: true } }], Math.max(10, width - YOU.length)) : [[]];
  const rows = body.map((spans, i) => [i ? indent : { text: YOU, style: { ...ACCENT, bold: true } }, ...spans]);
  if (notes) {
    const last = rows.at(-1)!;
    if (text && spansWidth(last) + notes.length + 2 <= width) last.push({ text: `  ${notes}`, style: MUTED });
    else rows.push([text ? indent : { text: YOU, style: { ...ACCENT, bold: true } }, { text: notes, style: MUTED }]);
  }
  return rows;
}

/** "  ⏺ Edit src/app.ts", with ✗ when the call failed and ◌ while it runs. */
export function stepRow(step: Pick<TurnStep, "tool" | "summary"> & { failed: boolean | null }): Span[] {
  const mark: Span =
    step.failed === null
      ? { text: "  ◌ ", style: ACCENT }
      : step.failed
        ? { text: "  ✗ ", style: { tone: "del" } }
        : { text: "  ⏺ ", style: MUTED };
  const spans: Span[] = [mark, { text: terminalSafe(step.tool), style: { tone: "muted", bold: true } }];
  if (step.summary) spans.push({ text: ` ${terminalSafe(step.summary).replace(/\s+/g, " ")}`, style: MUTED });
  return spans;
}

/** How a turn that didn't finish ended, or nothing. */
export function endedRows(response: Pick<StoredResponse, "ended" | "error">, width: number): Span[][] {
  if (response.ended === "interrupted") return [[{ text: "  ⏹ Interrupted", style: MUTED }]];
  if (response.ended !== "error") return [];
  const text = `  ✗ ${terminalSafe(response.error ?? "").replace(/\s+/g, " ") || "The turn failed"}`;
  return wrapSpans([{ text, style: { tone: "del" } }], width);
}

/** The prompt that waits for an answer: the call in full, then the keys. */
export function permissionRows(permission: PermissionPrompt, width: number): Span[][] {
  const bar: Span = { text: "┃ ", style: { tone: "accent", bold: true } };
  const inner = Math.max(10, width - 2);
  const rows: Span[][] = [
    [
      bar,
      { text: "Allow ", style: { bold: true } },
      { text: terminalSafe(permission.tool), style: { ...ACCENT, bold: true } },
      { text: "?", style: { bold: true } },
    ],
  ];
  const detail = terminalSafe(permission.detail).split("\n");
  for (const line of detail.slice(0, PERMISSION_DETAIL_ROWS)) {
    const tone = line.startsWith("+ ") ? "add" : line.startsWith("- ") ? "del" : "code";
    for (const spans of wrapSpans([{ text: line || " ", style: { tone } }], inner, "anywhere"))
      rows.push([bar, ...spans]);
  }
  if (detail.length > PERMISSION_DETAIL_ROWS) {
    rows.push([bar, { text: `… ${detail.length - PERMISSION_DETAIL_ROWS} more lines`, style: MUTED }]);
  }
  rows.push([
    bar,
    { text: "y", style: { ...ACCENT, bold: true } },
    { text: " allow  ", style: PLAIN },
    { text: "a", style: { ...ACCENT, bold: true } },
    { text: " always allow this  ", style: PLAIN },
    { text: "n", style: { ...ACCENT, bold: true } },
    { text: " deny", style: PLAIN },
  ]);
  return rows;
}

export interface LiveOptions {
  width: number;
  render: (markdown: string, width: number) => RenderedReply;
}

/** The turn in progress, as it streams in, then what waits: a permission prompt, queued messages. */
export function liveRows(view: ConversationView, options: LiveOptions): Span[][] {
  const { width } = options;
  const rows: Span[][] = [];
  const live = view.live;
  if (live) {
    rows.push(...promptRows(live.prompt, live.notes_sent, width));
    rows.push(rule(view.agent, width));
    rows.push(...partRows(live.parts, options));
    if (view.state === "working" && live.parts.at(-1)?.kind !== "text") {
      rows.push([{ text: "  …", style: MUTED }]);
    }
  }
  if (view.permission) {
    rows.push([], ...permissionRows(view.permission, width));
  }
  for (const text of view.queued) {
    rows.push([
      { text: "queued › ", style: MUTED },
      { text: terminalSafe(text).replace(/\s+/g, " ") || "notes (Send now)", style: MUTED },
    ]);
  }
  if (!live && view.error) {
    rows.push(...wrapSpans([{ text: terminalSafe(view.error), style: { tone: "del" } }], width));
  }
  return rows;
}

function partRows(parts: readonly LivePart[], options: LiveOptions): Span[][] {
  const rows: Span[][] = [];
  for (const part of parts) {
    if (part.kind === "tool") rows.push(stepRow(part));
    else if (part.text.trim()) rows.push(...options.render(part.text, options.width).lines.map((line) => line.spans));
  }
  return rows;
}

function rule(label: string, width: number): Span[] {
  const head = `── ${label} `;
  return [{ text: head + "─".repeat(Math.max(0, width - head.length)), style: MUTED }];
}
