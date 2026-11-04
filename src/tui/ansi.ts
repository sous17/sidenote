// Turns styled lines into terminal escape sequences. This is the only place sidenote's terminal
// output gets escape codes, and the text is made safe again here, whatever produced the line.
import type { Line, Style, Tone } from "./lines.ts";
import { terminalSafe } from "./sanitize.ts";

export interface AnsiOptions {
  /** False under NO_COLOR or a dumb terminal: bold, italics and underlines stay. */
  color: boolean;
  /** OSC 8 hyperlinks; terminals that lack them ignore the sequence. */
  hyperlinks: boolean;
  /**
   * The terminal draws 24-bit color on a dark background, so sidenote can use its own palette
   * (the one in the Margin mockups). Otherwise the terminal's 16 colors are used, which follow
   * its light or dark theme.
   */
  truecolor?: boolean;
}

const rgb = (hex: string): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `38;2;${n >> 16};${(n >> 8) & 255};${n & 255}`;
};

/** Amber accent, blue for the user's words, GitHub-dark greens and reds, as in the mockups. */
const PALETTE = {
  accent: rgb("#e3b341"),
  muted: rgb("#8b949e"),
  link: rgb("#79c0ff"),
  code: rgb("#79c0ff"),
  add: rgb("#7ee787"),
  del: rgb("#ffa198"),
  addMark: `${rgb("#7ee787")};7`,
  delMark: `${rgb("#ffa198")};7`,
  hunk: rgb("#8b949e"),
} satisfies Record<Tone, string>;

/** The nearest of the terminal's own colors. Yellow, not magenta: most themes draw 35 pink. */
const TONES = {
  accent: "33",
  muted: "2",
  link: "94",
  code: "36",
  add: "32",
  del: "31",
  addMark: "32;7",
  delMark: "31;7",
  hunk: "36",
} satisfies Record<Tone, string>;

/** Without color, the edited words of a diff line still stand out. */
const UNCOLORED_TONES: Partial<Record<Tone, string>> = { addMark: "7", delMark: "7" };

const background = (hex: string): string => rgb(hex).replace("38;", "48;");

/** Dark enough for the palette's text to stay readable on them, and far enough apart to tell. */
const MARKS = ["#5a4510", "#0f4a52", "#54265a", "#1e4d2b", "#5e2435", "#2c3a75"].map(background);

/** The terminal's own colors change with its theme, so these set the text color as well. */
const BASIC_MARKS = ["30;43", "30;46", "30;45", "30;42", "97;44", "97;41"];

/** Only plain web links become clickable, and only with printable ASCII, which can't hold ESC. */
const LINKABLE = /^https?:\/\/[!-~]+$/;

export function lineToAnsi(line: Line, options: AnsiOptions): string {
  let out = "";
  for (const span of line.spans) {
    const text = terminalSafe(span.text).replace(/[\t\n]/g, " ");
    if (!text) continue;
    const codes = sgr(span.style, options, text);
    let piece = codes ? `\x1b[${codes}m${text}\x1b[0m` : text;
    const href = span.style.href;
    if (options.hyperlinks && href && LINKABLE.test(href)) piece = `\x1b]8;;${href}\x1b\\${piece}\x1b]8;;\x1b\\`;
    out += piece;
  }
  return out;
}

function sgr(style: Style, options: AnsiOptions, text: string): string {
  const codes: string[] = [];
  if (style.bold) codes.push("1");
  if (style.italic) codes.push("3");
  if (style.underline) codes.push("4");
  if (style.strike) codes.push("9");
  const tones = options.truecolor ? PALETTE : TONES;
  const tone = style.tone && (options.color ? tones[style.tone] : UNCOLORED_TONES[style.tone]);
  if (tone) codes.push(tone);
  if (style.mark !== undefined) {
    const marks = options.truecolor ? MARKS : BASIC_MARKS;
    if (options.color) codes.push(marks[style.mark % marks.length]!);
    // Without color the words are underlined, and a strip of spaces shouldn't be.
    else if (text.trim() && !style.underline) codes.push("4");
  }
  return codes.join(";");
}
