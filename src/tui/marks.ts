// Ties a note to the text it is about: the words it quotes are highlighted in the reply, in the
// color of the strip beside the note. Rendered rows are wrapped, carry gutters, and show no
// markdown, while a quote is what the user picked or the block's source, so the two are compared
// without their whitespace and gutters. A quote that can't be found marks its whole block.
import type { Note } from "../shared/types.ts";
import { MARK_COUNT, type Line, type Span } from "./lines.ts";
import { graphemes } from "./width.ts";

const GUTTER = /^[│┆▾▸] $/;
/** What truncate() leaves on a quote too long to keep whole. */
const TRUNCATED = /…$/;

/**
 * Each note's color: by order in the reply, so neighbours differ, except that notes on the same
 * words share one, or the later highlight would leave the earlier note with no match. Notes on
 * the whole reply have no words to mark, so they have no color.
 */
export function noteMarks(roots: readonly Note[]): Map<number, number> {
  const marks = new Map<number, number>();
  const byText = new Map<string, number>();
  for (const root of [...roots].sort((a, b) => a.created_at - b.created_at || a.id - b.id)) {
    if (root.block_index < 0) continue;
    const text = `${root.block_index}\n${root.quote}`;
    const mark = byText.get(text) ?? byText.size % MARK_COUNT;
    byText.set(text, mark);
    marks.set(root.id, mark);
  }
  return marks;
}

/** The reply's lines with each note's words marked. Where notes overlap, the latest shows. */
export function markLines(lines: readonly Line[], roots: readonly Note[], marks: ReadonlyMap<number, number>): Line[] {
  const marked = [...lines];
  for (const root of [...roots].sort((a, b) => a.created_at - b.created_at || a.id - b.id)) {
    const mark = marks.get(root.id);
    if (mark !== undefined) markQuote(marked, root.block_index, root.quote, mark);
  }
  return marked;
}

/** A character of a block's rows, for each code unit of its text without whitespace. */
interface Position {
  line: number;
  /** Grapheme index within the line. */
  at: number;
}

function markQuote(lines: Line[], block: number, quote: string, mark: number): void {
  const positions: Position[] = [];
  let text = "";
  lines.forEach((line, index) => {
    if (line.block !== block) return;
    let at = 0;
    line.spans.forEach((span, spanIndex) => {
      const chars = graphemes(span.text);
      if (spanIndex > 0 || !GUTTER.test(span.text)) {
        chars.forEach((char, offset) => {
          if (!char.trim()) return;
          text += char;
          for (let unit = 0; unit < char.length; unit += 1) positions.push({ line: index, at: at + offset });
        });
      }
      at += chars.length;
    });
  });
  if (!positions.length) return;

  const range = findQuote(text, quote) ?? { start: 0, end: text.length };
  const rows = new Map<number, { from: number; to: number }>();
  for (const { line, at } of positions.slice(range.start, range.end)) {
    const row = rows.get(line);
    if (row) row.to = at + 1;
    else rows.set(line, { from: at, to: at + 1 });
  }
  for (const [index, { from, to }] of rows) {
    lines[index] = { ...lines[index]!, spans: markSpans(lines[index]!.spans, from, to, mark) };
  }
}

function findQuote(text: string, quote: string): { start: number; end: number } | null {
  const whole = quote.replace(/\s+/g, "");
  for (const wanted of [whole, whole.replace(TRUNCATED, "")]) {
    const start = wanted ? text.indexOf(wanted) : -1;
    if (start >= 0) return { start, end: start + wanted.length };
  }
  return null;
}

/** The spans with the graphemes from..to of their text marked, split where the mark starts and ends. */
function markSpans(spans: readonly Span[], from: number, to: number, mark: number): Span[] {
  const out: Span[] = [];
  let at = 0;
  for (const span of spans) {
    const chars = graphemes(span.text);
    const start = Math.min(Math.max(from - at, 0), chars.length);
    const end = Math.min(Math.max(to - at, 0), chars.length);
    at += chars.length;
    const pieces: Span[] = [
      { text: chars.slice(0, start).join(""), style: span.style },
      { text: chars.slice(start, end).join(""), style: { ...span.style, mark } },
      { text: chars.slice(end).join(""), style: span.style },
    ];
    out.push(...pieces.filter((piece) => piece.text));
  }
  return out;
}
