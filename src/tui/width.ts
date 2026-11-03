// How many terminal columns text takes. Terminals draw CJK characters and most emoji two
// columns wide and combining marks in zero, so string length can't be used for layout.

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]+$/u;
const EMOJI = /\p{Emoji_Presentation}|️|\p{Regional_Indicator}/u;

/** East Asian Wide and Fullwidth ranges, the ones terminals draw two columns wide. */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x3fffd],
];

/** The user-perceived characters of text: an emoji with modifiers or a letter with accents is one. */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

export function graphemeWidth(grapheme: string): number {
  if (ZERO_WIDTH.test(grapheme)) return 0;
  if (EMOJI.test(grapheme)) return 2;
  const code = grapheme.codePointAt(0) ?? 0;
  return WIDE_RANGES.some(([low, high]) => code >= low && code <= high) ? 2 : 1;
}

export function displayWidth(text: string): number {
  // Plain ASCII is the common case and needs no segmenting.
  if (/^[\x20-\x7e]*$/.test(text)) return text.length;
  let width = 0;
  for (const grapheme of graphemes(text)) width += graphemeWidth(grapheme);
  return width;
}
