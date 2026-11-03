// Turns styled lines into terminal escape sequences. This is the only place sidenote's terminal
// output gets escape codes, and the text is made safe again here, whatever produced the line.
import type { Line, Style, Tone } from "./lines.ts";
import { terminalSafe } from "./sanitize.ts";

export interface AnsiOptions {
  /** False under NO_COLOR or a dumb terminal: bold, italics and underlines stay. */
  color: boolean;
  /** OSC 8 hyperlinks; terminals that lack them ignore the sequence. */
  hyperlinks: boolean;
}

const TONES = {
  accent: "35",
  muted: "2",
  link: "34",
  code: "36",
  add: "32",
  del: "31",
  addMark: "32;7",
  delMark: "31;7",
  hunk: "36",
} satisfies Record<Tone, string>;

/** Without color, the edited words of a diff line still stand out. */
const UNCOLORED_TONES: Partial<Record<Tone, string>> = { addMark: "7", delMark: "7" };

/** Only plain web links become clickable, and only with printable ASCII, which can't hold ESC. */
const LINKABLE = /^https?:\/\/[!-~]+$/;

export function lineToAnsi(line: Line, options: AnsiOptions): string {
  let out = "";
  for (const span of line.spans) {
    const text = terminalSafe(span.text).replace(/[\t\n]/g, " ");
    if (!text) continue;
    const codes = sgr(span.style, options.color);
    let piece = codes ? `\x1b[${codes}m${text}\x1b[0m` : text;
    const href = span.style.href;
    if (options.hyperlinks && href && LINKABLE.test(href)) piece = `\x1b]8;;${href}\x1b\\${piece}\x1b]8;;\x1b\\`;
    out += piece;
  }
  return out;
}

function sgr(style: Style, color: boolean): string {
  const codes: string[] = [];
  if (style.bold) codes.push("1");
  if (style.italic) codes.push("3");
  if (style.underline) codes.push("4");
  if (style.strike) codes.push("9");
  const tone = style.tone && (color ? TONES[style.tone] : UNCOLORED_TONES[style.tone]);
  if (tone) codes.push(tone);
  return codes.join(";");
}
