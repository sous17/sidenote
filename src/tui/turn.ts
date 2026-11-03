// Rows for the parts of a turn sidenote ran: what the user typed, the tool calls, the
// permission prompt, and how a turn ended. src/tui/conversation.ts lays them out.
import { plural } from "../shared/text.ts";
import type { PermissionPrompt, StoredResponse } from "../shared/types.ts";
import { PLAIN, type Span, type Style } from "./lines.ts";
import { terminalSafe } from "./sanitize.ts";
import { spansWidth, wrapSpans } from "./wrap.ts";

const MUTED: Style = { tone: "muted" };
const ACCENT: Style = { tone: "accent" };
const PROMPT_MARK = "› ";
const PERMISSION_DETAIL_ROWS = 12;
const STEP_GAP = "   ";

/** "› Fix the failing test", wrapped under itself, with the notes that rode along. */
export function promptRows(prompt: string, notesSent: number, width: number): Span[][] {
  const notes = notesSent ? `+ ${plural(notesSent, "note", "notes")}` : "";
  const text = terminalSafe(prompt).trim();
  if (!text && !notes) return [];
  const mark: Span = { text: PROMPT_MARK, style: { tone: "link", bold: true } };
  const indent: Span = { text: " ".repeat(PROMPT_MARK.length), style: PLAIN };
  const body = text ? wrapSpans([{ text, style: { tone: "link" } }], Math.max(10, width - PROMPT_MARK.length)) : [[]];
  const rows = body.map((spans, i) => [i ? indent : mark, ...spans]);
  if (notes) {
    const last = rows.at(-1)!;
    if (text && spansWidth(last) + notes.length + 2 <= width) last.push({ text: `  ${notes}`, style: MUTED });
    else rows.push([text ? indent : mark, { text: notes, style: MUTED }]);
  }
  return rows;
}

/** A tool call: done (failed false), failed, or still running (failed null). */
export interface StepView {
  tool: string;
  summary: string;
  failed: boolean | null;
}

/** Tool calls in a row, wrapped: "✓ read app.py   ✓ npm test   ◐ edit app.py". */
export function stepRows(steps: readonly StepView[], width: number): Span[][] {
  const spans: Span[] = [];
  steps.forEach((step, i) => {
    if (i) spans.push({ text: STEP_GAP, style: PLAIN });
    const mark =
      step.failed === null
        ? { text: "◐ ", style: ACCENT }
        : step.failed
          ? { text: "✗ ", style: { tone: "del" as const } }
          : { text: "✓ ", style: MUTED };
    spans.push(mark, { text: stepLabel(step).replace(/ /g, " "), style: step.failed ? { tone: "del" } : MUTED });
  });
  // Each call is kept whole on a row (no-break spaces), unless it is wider than a row by itself.
  return wrapSpans(spans, width).map((row) => row.map((span) => ({ ...span, text: span.text.replace(/ /g, " ") })));
}

/** "npm test" for a command, "edit src/app.ts" for the rest. */
function stepLabel(step: StepView): string {
  const summary = terminalSafe(step.summary).replace(/\s+/g, " ");
  if (step.tool === "Bash" && summary) return summary;
  const tool = terminalSafe(step.tool);
  const name = /^[A-Z][a-z]+$/.test(tool) ? tool.toLowerCase() : tool;
  return summary ? `${name} ${summary}` : name;
}

/** How a turn that didn't finish ended, or nothing. */
export function endedRows(response: Pick<StoredResponse, "ended" | "error">, width: number): Span[][] {
  if (response.ended === "interrupted") return [[{ text: "⏹ interrupted", style: MUTED }]];
  if (response.ended !== "error") return [];
  const text = `✗ ${terminalSafe(response.error ?? "").replace(/\s+/g, " ") || "The turn failed"}`;
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
