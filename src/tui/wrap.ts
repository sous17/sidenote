// Fits styled text into a width: prose wraps between words, code wraps anywhere so its
// indentation and spacing survive. A "\n" in the text always starts a new line.
import type { Span, Style } from "./lines.ts";
import { displayWidth, graphemes, graphemeWidth } from "./width.ts";

export type WrapMode = "words" | "anywhere";

const WORDS = /\n| +|[^ \n]+/g;
const RUNS = /\n|[^\n]+/g;

export function spansWidth(spans: readonly Span[]): number {
  return spans.reduce((width, span) => width + displayWidth(span.text), 0);
}

export function wrapSpans(spans: readonly Span[], width: number, mode: WrapMode = "words"): Span[][] {
  const limit = Math.max(1, width);
  const lines: Span[][] = [[]];
  let column = 0;

  const push = (text: string, style: Style): void => {
    const line = lines[lines.length - 1]!;
    const last = line[line.length - 1];
    if (last && last.style === style) last.text += text;
    else line.push({ text, style });
  };
  const newLine = (): void => {
    trimEnd(lines[lines.length - 1]!);
    lines.push([]);
    column = 0;
  };

  for (const span of spans) {
    for (const piece of span.text.match(mode === "words" ? WORDS : RUNS) ?? []) {
      if (piece === "\n") {
        newLine();
        continue;
      }
      const width = displayWidth(piece);
      if (mode === "words" && piece[0] === " ") {
        // Spaces never start a wrapped line, and a space that doesn't fit is the line break.
        if (column === 0) continue;
        if (column + width > limit) newLine();
        else {
          push(piece, span.style);
          column += width;
        }
        continue;
      }
      if (column + width <= limit) {
        push(piece, span.style);
        column += width;
        continue;
      }
      if (mode === "words" && width <= limit) {
        newLine();
        push(piece, span.style);
        column = width;
        continue;
      }
      // Longer than a whole line (or code): break it between characters.
      for (const grapheme of graphemes(piece)) {
        const size = graphemeWidth(grapheme);
        if (column + size > limit && column > 0) newLine();
        push(grapheme, span.style);
        column += size;
      }
    }
  }
  trimEnd(lines[lines.length - 1]!);
  return lines;
}

function trimEnd(line: Span[]): void {
  while (line.length) {
    const last = line[line.length - 1]!;
    last.text = last.text.replace(/ +$/, "");
    if (last.text) return;
    line.pop();
  }
}

/** Cuts styled text to a width, ending in "…" when something was cut. */
export function clipSpans(spans: readonly Span[], width: number): Span[] {
  if (spansWidth(spans) <= width) return [...spans];
  const out: Span[] = [];
  let column = 0;
  for (const span of spans) {
    let text = "";
    for (const grapheme of graphemes(span.text)) {
      const size = graphemeWidth(grapheme);
      if (column + size > width - 1) {
        if (text) out.push({ text, style: span.style });
        out.push({ text: "…", style: span.style });
        return out;
      }
      text += grapheme;
      column += size;
    }
    if (text) out.push({ text, style: span.style });
  }
  return out;
}
