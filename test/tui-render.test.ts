import assert from "node:assert/strict";
import { test } from "node:test";
import { lexReply, replyBlocks } from "../src/shared/blocks.ts";
import { lineText, type Line } from "../src/tui/lines.ts";
import { renderReply } from "../src/tui/render.ts";
import { spansWidth } from "../src/tui/wrap.ts";

const text = (lines: Line[]): string[] => lines.map(lineText);
const render = (markdown: string, width = 40) => renderReply(markdown, { width });

const TWO_FILES = [
  "Both files change:",
  "",
  "```diff",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@ function f() {",
  " keep",
  "-  return check(token);",
  "+  return verifyToken(token);",
  "```",
  "",
  "```diff",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1 +1 @@",
  "-x",
  "+y",
  "```",
].join("\n");

test("draws prose, headings and inline styles", () => {
  const { lines } = render("# Title\n\nSome **bold** and `code` here.");
  assert.deepEqual(text(lines), ["Title", "", "Some bold and code here."]);
  assert.equal(lines[0]!.spans[0]!.style.bold, true);
  const spans = lines[2]!.spans;
  assert.equal(spans.find((span) => span.text === "bold")?.style.bold, true);
  assert.equal(spans.find((span) => span.text === "code")?.style.tone, "code");
});

test("every line stays within the width", () => {
  const markdown = `${"word ".repeat(40)}\n\n- ${"item ".repeat(20)}\n\n> ${"quote ".repeat(20)}\n\n\`\`\`\n${"x".repeat(100)}\n\`\`\`\n\n${TWO_FILES}\n\n| a | b |\n|---|---|\n| ${"long ".repeat(10)} | ${"cell ".repeat(10)} |`;
  for (const width of [20, 33, 60]) {
    for (const line of render(markdown, width).lines) {
      assert.ok(spansWidth(line.spans) <= width, `${width}: ${lineText(line)}`);
    }
  }
});

test("lines carry the block numbers notes are stored with", () => {
  const markdown = "Intro\n\n1. one\n   - nested\n2. two\n\n> quote\n> - in quote\n\n```\ncode\n```";
  const { lines, blocks } = render(markdown);
  assert.equal(blocks.length, replyBlocks(lexReply(markdown)).length);
  assert.deepEqual(
    blocks.map((block) => block.code),
    [false, false, false, false, false, false, true],
  );
  assert.equal(blocks[0]!.quote, "Intro");
  assert.equal(blocks[6]!.quote, "code");
  const blockOf = (wanted: string): number => lines.find((line) => lineText(line).includes(wanted))!.block;
  assert.deepEqual(
    ["Intro", "1. one", "◦ nested", "2. two", "▌ quote", "• in quote", "│ code"].map(blockOf),
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.ok(
    lines.filter((line) => lineText(line) === "").every((line) => line.block === -1),
    "blank lines between blocks belong to none",
  );
});

test("lists show bullets by depth, numbers and task boxes", () => {
  const { lines } = render("- a\n  - b\n    - c\n\n3. x\n4. y\n\n- [x] done\n- [ ] todo");
  assert.deepEqual(text(lines), ["• a", "  ◦ b", "    ▪ c", "", "3. x", "4. y", "", "• ☑ done", "• ☐ todo"]);
});

test("wrapped list items hang under their text", () => {
  const { lines } = render("- one two three four five six seven", 20);
  assert.deepEqual(text(lines), ["• one two three four", "  five six seven"]);
});

test("a link always shows where it really goes", () => {
  const { lines } = render("[the docs](https://evil.example) and <https://example.com> and a@b.co");
  assert.deepEqual(text(lines), ["the docs (https://evil.example) and", "https://example.com and a@b.co"]);
  assert.equal(lines[0]!.spans[0]!.style.href, "https://evil.example");
});

test("raw HTML is shown as text, and entities are decoded outside code", () => {
  assert.deepEqual(text(render("<div>raw</div>").lines), ["<div>raw</div>"]);
  assert.deepEqual(text(render("Tom &amp; Jerry &#x41; `&amp;` <b>x</b>").lines), ["Tom & Jerry A &amp; <b>x</b>"]);
});

test("hostile text in a reply can't produce controls, even through entities", () => {
  const { lines } = render("evil \x1b]52;c;aGk=\x07 and &#27;[2J and &#x9b; and `\x1b[31m`\n\n```\n\x1b[0m\n```");
  for (const line of lines) assert.doesNotMatch(lineText(line), /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
});

test("code keeps its spacing, with a gutter and the language", () => {
  const { lines } = render("```ts\nif (a) {\n\treturn b;\n}\n```");
  assert.deepEqual(text(lines), ["ts", "│ if (a) {", "│     return b;", "│ }"]);
});

test("long code lines continue under a dotted gutter", () => {
  const { lines } = render(`\`\`\`\n${"a".repeat(30)}\n\`\`\``, 20);
  assert.deepEqual(text(lines), [`│ ${"a".repeat(18)}`, `┆ ${"a".repeat(12)}`]);
});

test("diffs over several files fold per file, the first one open", () => {
  const { lines, fileCount, foldable } = render(TWO_FILES);
  assert.equal(fileCount, 2);
  assert.equal(foldable, true);
  assert.deepEqual(text(lines), [
    "Both files change:",
    "",
    "▾ src/a.ts  +1 −1",
    "function f() {",
    "  keep",
    "−   return check(token);",
    "+   return verifyToken(token);",
    "",
    "▸ src/b.ts  +1 −1",
  ]);
  assert.deepEqual(
    lines.filter((line) => line.file !== undefined).map((line) => line.file),
    [0, 1],
  );

  const opened = renderReply(TWO_FILES, { width: 40, isFileOpen: (file) => file === 1 });
  assert.deepEqual(text(opened.lines).slice(2), ["▸ src/a.ts  +1 −1", "", "▾ src/b.ts  +1 −1", "⋯", "− x", "+ y"]);
});

test("a diff of one file doesn't fold, and edited words are marked", () => {
  const { lines, foldable } = render("```diff\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a(x)\n+a(Math.ceil(x))\n```");
  assert.equal(foldable, false);
  assert.deepEqual(text(lines), ["x.ts  +1 −1", "⋯", "− a(x)", "+ a(Math.ceil(x))"]);
  const added = lines[3]!.spans;
  assert.deepEqual(
    added.map((span) => [span.text, span.style.tone]),
    [
      ["+ ", "add"],
      ["a(", "add"],
      ["Math.ceil(x)", "addMark"],
      [")", "add"],
    ],
  );
});

test("an unlabeled block is a diff only when it clearly is one", () => {
  assert.deepEqual(text(render("```\n@@ -1 +1 @@\n-a\n+b\n```").lines), ["Change  +1 −1", "⋯", "− a", "+ b"]);
  assert.deepEqual(text(render("```\n- item\n- item\n```").lines), ["│ - item", "│ - item"]);
});

test("tables fit the width, and fall back to rows of fields when they can't", () => {
  const table = "| Name | Value |\n|------|------:|\n| timeout | 30 |";
  assert.deepEqual(text(render(table).lines), [
    "┌─────────┬───────┐",
    "│ Name    │ Value │",
    "├─────────┼───────┤",
    "│ timeout │    30 │",
    "└─────────┴───────┘",
  ]);
  const wide = `| ${["a", "b", "c", "d", "e"].join(" | ")} |\n|${"---|".repeat(5)}\n| ${"wordy ".repeat(5).split(" ").slice(0, 5).join(" | ")} |`;
  assert.deepEqual(text(render(wide, 20).lines), ["a: wordy", "b: wordy", "c: wordy", "d: wordy", "e: wordy"]);
});

test("a rule spans the width", () => {
  assert.deepEqual(text(render("a\n\n---\n\nb", 20).lines), ["a", "", "─".repeat(20), "", "b"]);
});
