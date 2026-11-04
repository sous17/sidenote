// What the terminal renderer produces: lines of styled text, each tagged with the block it
// belongs to. The styles are roles, not escape codes, so layout can be tested as plain text and
// ansi.ts alone decides how they look.

/** A role, not a color: ansi.ts picks sidenote's palette or the terminal's own colors for it. */
export type Tone = "accent" | "muted" | "link" | "code" | "add" | "del" | "addMark" | "delMark" | "hunk";

/** How many colors notes take turns on: ansi.ts has one background for each. */
export const MARK_COUNT = 6;

export interface Style {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  tone?: Tone;
  /** A note's color, for the words it quotes and the strip beside it. See marks.ts. */
  mark?: number;
  /** A link's target; ansi.ts makes it clickable only for http and https. */
  href?: string;
}

export interface Span {
  text: string;
  style: Style;
}

export interface Line {
  spans: Span[];
  /** The block (see src/shared/blocks.ts) this line shows, or -1 for spacing and rules. */
  block: number;
  /** Set on the header line of a file in a diff: that file's number within the reply. */
  file?: number;
}

export const PLAIN: Style = {};

export function lineText(line: Line): string {
  return line.spans.map((span) => span.text).join("");
}
