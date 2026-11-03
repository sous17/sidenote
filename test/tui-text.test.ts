import assert from "node:assert/strict";
import { test } from "node:test";
import { lineToAnsi, type AnsiOptions } from "../src/tui/ansi.ts";
import { PLAIN, type Line, type Span } from "../src/tui/lines.ts";
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

test("a line with hostile text comes out with only sidenote's own escape codes", () => {
  const out = lineToAnsi({ spans: [{ text: "x\x1b]0;title\x07\ty\nz", style: { italic: true } }], block: 0 }, COLOR);
  assert.equal(out, "\x1b[3mx␛]0;title␇ y z\x1b[0m");
});
