import assert from "node:assert/strict";
import { test } from "node:test";
import { lineToAnsi, type AnsiOptions } from "../src/tui/ansi.ts";
import { MARK_COUNT, PLAIN, type Line, type Span, type Style } from "../src/tui/lines.ts";
import { terminalOptions } from "../src/tui/main.ts";
import { terminalSafe } from "../src/tui/sanitize.ts";
import { displayWidth } from "../src/tui/width.ts";
import { spansWidth, wrapSpans } from "../src/tui/wrap.ts";

const COLOR: AnsiOptions = { color: true, hyperlinks: true };
const texts = (lines: Span[][]): string[] => lines.map((line) => line.map((span) => span.text).join(""));

test("escape sequences and other controls can't reach the terminal", () => {
  const hostile = "a\x1b]52;c;aGk=\x07b\x1b[2Jc\u009b31md\re‮evil‬\x7f";
  const safe = terminalSafe(hostile);
  assert.doesNotMatch(safe, /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/);
  assert.equal(safe, "a␛]52;c;aGk=␇b␛[2Jc31md\neevil␡", "C0 controls stay visible, as Control Pictures");
  assert.equal(terminalSafe("tab\tand\nnewline\r\n"), "tab\tand\nnewline\n");
});

test("measures text the way terminals draw it", () => {
  assert.equal(displayWidth("plain"), 5);
  assert.equal(displayWidth("日本語"), 6);
  assert.equal(displayWidth("👍"), 2);
  assert.equal(displayWidth("👍🏽"), 2, "a skin-tone modifier joins the emoji");
  assert.equal(displayWidth("é"), 1, "a combining accent takes no column");
  assert.equal(displayWidth("한국어"), 6);
});

test("prose wraps between words and never past the width", () => {
  const style = { bold: true };
  const spans: Span[] = [
    { text: "The quick brown ", style: PLAIN },
    { text: "fox jumps", style },
    { text: " over the lazy dog", style: PLAIN },
  ];
  const lines = wrapSpans(spans, 12);
  assert.deepEqual(texts(lines), ["The quick", "brown fox", "jumps over", "the lazy dog"]);
  assert.ok(lines.every((line) => spansWidth(line) <= 12));
  assert.deepEqual(
    lines[1]!.map((span) => span.style),
    [PLAIN, style],
    "styles survive wrapping",
  );
  assert.deepEqual(texts(wrapSpans([{ text: "a\nb", style: PLAIN }], 10)), ["a", "b"]);
  assert.deepEqual(texts(wrapSpans([{ text: "abcdefghij", style: PLAIN }], 4)), ["abcd", "efgh", "ij"]);
  assert.deepEqual(texts(wrapSpans([{ text: "日本語の文", style: PLAIN }], 5)), ["日本", "語の", "文"]);
});

test("code wraps anywhere and keeps its indentation", () => {
  const lines = wrapSpans([{ text: "    if (x) {", style: PLAIN }], 8, "anywhere");
  assert.deepEqual(texts(lines), ["    if (", "x) {"]);
});

test("styles become escape codes, with links only for http and https", () => {
  const line = (spans: Span[]): Line => ({ spans, block: 0 });
  assert.equal(lineToAnsi(line([{ text: "hi", style: { bold: true, tone: "add" } }]), COLOR), "\x1b[1;32mhi\x1b[0m");
  assert.equal(lineToAnsi(line([{ text: "hi", style: { tone: "add" } }]), { ...COLOR, color: false }), "hi");
  assert.equal(
    lineToAnsi(line([{ text: "x", style: { tone: "addMark" } }]), { ...COLOR, color: false }),
    "\x1b[7mx\x1b[0m",
  );

  const link = (href: string): string => lineToAnsi(line([{ text: "go", style: { href } }]), COLOR);
  assert.equal(link("https://example.com/a"), "\x1b]8;;https://example.com/a\x1b\\go\x1b]8;;\x1b\\");
  assert.equal(link("javascript:alert(1)"), "go");
  assert.equal(link("https://example.com/\x1b\\x"), "go", "an ESC in a link would end the sequence early");
  assert.equal(link("file:///etc/passwd"), "go");
});

test("the accent is the mockups' amber, never the terminal's magenta", () => {
  const accent = (options: AnsiOptions): string =>
    lineToAnsi({ spans: [{ text: "◆", style: { tone: "accent" } }], block: 0 }, options);
  assert.equal(accent({ ...COLOR, truecolor: true }), "\x1b[38;2;227;179;65m◆\x1b[0m", "#e3b341");
  assert.equal(accent(COLOR), "\x1b[33m◆\x1b[0m", "yellow from the terminal's own palette");
  const prompt = lineToAnsi(
    { spans: [{ text: "›", style: { tone: "link", bold: true } }], block: 0 },
    { ...COLOR, truecolor: true },
  );
  assert.equal(prompt, "\x1b[1;38;2;121;192;255m›\x1b[0m", "the user's words in #79c0ff");
});

test("sidenote's palettes on terminals that draw 24-bit color", () => {
  const palette = (env: NodeJS.ProcessEnv): boolean | undefined => terminalOptions(env).truecolor;
  assert.equal(palette({ COLORTERM: "truecolor" }), true);
  assert.equal(palette({ TERM_PROGRAM: "iTerm.app" }), true);
  assert.equal(palette({ TERM_PROGRAM: "Apple_Terminal" }), false, "Terminal.app has 256 colors at most");
  assert.equal(palette({ COLORTERM: "truecolor", COLORFGBG: "0;15" }), true, "a light background has its own");
  assert.equal(palette({ SIDENOTE_COLOR: "basic", COLORTERM: "truecolor" }), false);
  assert.equal(palette({ SIDENOTE_COLOR: "truecolor" }), true);
  assert.equal(palette({ SIDENOTE_COLOR: "light" }), true);
  assert.equal(palette({ SIDENOTE_COLOR: "dark" }), true);
});

test("the theme starts from COLORFGBG, and SIDENOTE_COLOR fixes it", () => {
  const options = (env: NodeJS.ProcessEnv): [boolean?, boolean?] => {
    const { light, themeFixed } = terminalOptions(env);
    return [light, themeFixed];
  };
  assert.deepEqual(options({}), [false, false]);
  assert.deepEqual(options({ COLORFGBG: "0;15" }), [true, false]);
  assert.deepEqual(options({ COLORFGBG: "0;7" }), [true, false]);
  assert.deepEqual(options({ COLORFGBG: "15;0" }), [false, false]);
  assert.deepEqual(options({ SIDENOTE_COLOR: "light", COLORFGBG: "15;0" }), [true, true]);
  assert.deepEqual(options({ SIDENOTE_COLOR: "dark", COLORFGBG: "0;15" }), [false, true]);
});

/** WCAG contrast of two colors given as the 38;2;r;g;b or 48;2;r;g;b the palette writes. */
function contrast(a: number[], b: number[]): number {
  const luminance = (rgb: number[]): number => {
    const [r, g, bl] = rgb.map((value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

const channels = (out: string, code: 38 | 48): number[] => {
  const found = new RegExp(`${code};2;(\\d+);(\\d+);(\\d+)`).exec(out);
  assert.ok(found, `no ${code} color in ${JSON.stringify(out)}`);
  return found.slice(1).map(Number);
};

for (const [theme, light, page, text] of [
  ["light", true, [255, 255, 255], [31, 35, 40]],
  ["dark", false, [13, 17, 23], [230, 237, 243]],
] as const) {
  test(`the ${theme} palette stays readable on its background and on every note color`, () => {
    const options: AnsiOptions = { ...COLOR, truecolor: true, light };
    const paint = (style: Style): string => lineToAnsi({ spans: [{ text: "x", style }], block: 0 }, options);
    const tones = ["accent", "muted", "link", "code", "add", "del", "hunk"] as const;
    for (const tone of tones) {
      const color = channels(paint({ tone }), 38);
      assert.ok(contrast(color, [...page]) >= 4.5, `${tone} on the background`);
    }
    for (let mark = 0; mark < MARK_COUNT; mark += 1) {
      const fill = channels(paint({ mark }), 48);
      assert.ok(contrast([...text], fill) >= 4.5, `text on mark ${mark}`);
      assert.ok(contrast(fill, [...page]) >= 1.1, `mark ${mark} shows against the background`);
      if (light) {
        for (const tone of tones) {
          const color = channels(paint({ tone }), 38);
          assert.ok(contrast(color, fill) >= 3, `${tone} on mark ${mark}`);
        }
      }
    }
  });
}

test("the two themes use different colors, and the note colors keep their order", () => {
  const paint = (style: Style, light: boolean): string =>
    lineToAnsi({ spans: [{ text: "x", style }], block: 0 }, { ...COLOR, truecolor: true, light });
  assert.notEqual(paint({ tone: "accent" }, true), paint({ tone: "accent" }, false));
  const hues = (light: boolean): number[] =>
    Array.from({ length: MARK_COUNT }, (_, mark) => {
      const [r, g, b] = channels(paint({ mark }, light), 48) as [number, number, number];
      return Math.round((Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180) / Math.PI);
    });
  hues(true).forEach((hue, mark) => {
    const difference = Math.abs(hue - hues(false)[mark]!);
    assert.ok(Math.min(difference, 360 - difference) < 40, `mark ${mark} keeps its hue`);
  });
});

test("a line with hostile text comes out with only sidenote's own escape codes", () => {
  const out = lineToAnsi({ spans: [{ text: "x\x1b]0;title\x07\ty\nz", style: { italic: true } }], block: 0 }, COLOR);
  assert.equal(out, "\x1b[3mx␛]0;title␇ y z\x1b[0m");
});
