import assert from "node:assert/strict";
import { test } from "node:test";
import { Model } from "../src/shared/model.ts";
import type { Note, StoredResponse } from "../src/shared/types.ts";
import { lineToAnsi } from "../src/tui/ansi.ts";
import { buildConversation } from "../src/tui/conversation.ts";
import { buildFeed } from "../src/tui/feed.ts";
import { MARK_COUNT, lineText, type Line, type Span } from "../src/tui/lines.ts";
import { markLines, noteMarks } from "../src/tui/marks.ts";
import { renderReply } from "../src/tui/render.ts";
import { buildThread } from "../src/tui/thread.ts";

function note(id: number, block_index: number, quote: string): Note {
  return {
    id,
    response_id: 1,
    block_index,
    quote,
    body: `Note ${id}`,
    parent_id: null,
    created_at: id,
    delivered_at: null,
    answered_by: null,
  };
}

/** The text marked with each color, row by row. */
function markedText(lines: readonly Line[]): Array<[number, string]> {
  return lines.flatMap((line) =>
    line.spans.flatMap((span): Array<[number, string]> =>
      span.style.mark === undefined ? [] : [[span.style.mark, span.text]],
    ),
  );
}

function marked(markdown: string, notes: Note[], width = 80): Array<[number, string]> {
  const { lines } = renderReply(markdown, { width });
  return markedText(markLines(lines, notes, noteMarks(notes)));
}

test("only the quoted words are marked, and the text itself doesn't change", () => {
  const { lines } = renderReply("Keep the cache small and warm.", { width: 80 });
  const notes = [note(5, 0, "cache small")];
  const result = markLines(lines, notes, noteMarks(notes));
  assert.deepEqual(markedText(result), [[0, "cache small"]]);
  assert.deepEqual(result.map(lineText), lines.map(lineText));
  assert.equal(markedText(lines).length, 0, "rendered replies are cached, so they stay as they were");
});

test("a quote is found across wrapped rows, and each row is marked only where it holds the words", () => {
  const text = "one two three four five six seven eight nine ten eleven twelve";
  const rows = marked(text, [note(5, 0, "five six seven eight nine ten")], 24);
  assert.ok(rows.length > 1, "the quote wraps");
  assert.equal(rows.map(([, words]) => words).join(" "), "five six seven eight nine ten");
});

test("formatting in the reply doesn't hide words from a quote", () => {
  assert.deepEqual(
    marked("Use **the fast** path.", [note(5, 0, "the fast path")]).map(([, words]) => words),
    ["the fast", " path"],
  );
});

test("a block's source quote with markdown in it marks the block", () => {
  const rows = marked("First.\n\nUse **the fast** path.", [note(5, 1, "Use **the fast** path.")]);
  assert.equal(rows.map(([, words]) => words).join(""), "Use the fast path.");
});

test("a quote that is no longer there marks its block, not nothing", () => {
  assert.equal(
    marked("Some words.", [note(5, 0, "gone")])
      .map(([, words]) => words)
      .join(""),
    "Some words.",
  );
});

test("a quote cut short is found by what was kept", () => {
  assert.deepEqual(marked("Alpha beta gamma delta.", [note(5, 0, "Alpha beta…")]), [[0, "Alpha beta"]]);
});

test("picked code lines are marked without the gutter, across rows", () => {
  const rows = marked("```js\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```", [
    note(5, 0, "const b = 2;\nconst c = 3;"),
  ]);
  assert.equal(
    rows
      .map(([, words]) => words)
      .join("|")
      .replace(/\s+/g, " "),
    "const b = 2;|const c = 3;",
  );
});

test("a word the quote shares with another block stays with the note's own block", () => {
  assert.deepEqual(marked("Same word.\n\nSame word.", [note(5, 1, "Same word.")]).length, 1);
  const { lines } = renderReply("Same word.\n\nSame word.", { width: 80 });
  const notes = [note(5, 1, "Same word.")];
  const result = markLines(lines, notes, noteMarks(notes));
  assert.deepEqual([...new Set(result.filter((line) => markedText([line]).length).map((line) => line.block))], [1]);
});

test("notes take the colors in turn, oldest first, and the whole reply takes none", () => {
  const notes = [note(9, 2, "c"), note(5, 0, "a"), note(6, -1, ""), note(7, 1, "b")];
  assert.deepEqual(
    [...noteMarks(notes)].sort(([a], [b]) => a - b),
    [
      [5, 0],
      [7, 1],
      [9, 2],
    ],
  );
  const many = Array.from({ length: MARK_COUNT + 1 }, (_, i) => note(i + 1, i, "x"));
  assert.equal(noteMarks(many).get(MARK_COUNT + 1), 0, "colors come round again");
});

test("notes on the same words share a color, so neither loses its match", () => {
  const marks = noteMarks([note(5, 0, "same"), note(6, 1, "other"), note(7, 0, "same")]);
  assert.equal(marks.get(7), marks.get(5));
  assert.notEqual(marks.get(6), marks.get(5));
});

test("where notes overlap the latest shows, and the rest of the older one stays", () => {
  const rows = marked("one two three four", [note(5, 0, "one two three"), note(6, 0, "three four")]);
  const words = (mark: number): string =>
    rows
      .filter(([color]) => color === mark)
      .map(([, text]) => text)
      .join("");
  assert.equal(words(0), "one two ");
  assert.equal(words(1), "three four");
});

test("a mark keeps the text's own style, and wide characters stay whole", () => {
  const { lines } = renderReply("Say **日本語** now", { width: 80 });
  const notes = [note(5, 0, "本語")];
  const spans = markLines(lines, notes, noteMarks(notes)).flatMap((line) => line.spans);
  assert.deepEqual(
    spans.find((span) => span.style.mark === 0),
    { text: "本語", style: { bold: true, mark: 0 } },
  );
});

test("each color is its own background, and without color the words are underlined", () => {
  const ansi = (span: Span, options: Parameters<typeof lineToAnsi>[1]): string =>
    lineToAnsi({ spans: [span], block: -1 }, options);
  const color = { color: true, hyperlinks: false };
  const seen = new Set<string>();
  for (const truecolor of [true, false]) {
    for (let mark = 0; mark < MARK_COUNT; mark += 1)
      seen.add(ansi({ text: "x", style: { mark } }, { ...color, truecolor }));
  }
  assert.equal(seen.size, MARK_COUNT * 2);
  assert.match(ansi({ text: "x", style: { mark: 0 } }, { ...color, truecolor: true }), /\x1b\[48;2;90;69;16mx/);
  assert.equal(ansi({ text: "x", style: { tone: "muted", mark: 0 } }, color), "\x1b[2;30;43mx\x1b[0m");
  const plain = { color: false, hyperlinks: false };
  assert.equal(ansi({ text: "x", style: { mark: 0 } }, plain), "\x1b[4mx\x1b[0m");
  assert.equal(ansi({ text: "  ", style: { mark: 0 } }, plain), "  ", "a strip of spaces stays blank");
});

function modelWith(notes: Note[]): { model: Model; response: StoredResponse } {
  const response: StoredResponse = {
    id: 1,
    session_id: "s",
    cwd: "/w",
    text: "First point here.\n\nSecond point here.",
    created_at: 1,
    note_answers: {},
  };
  const model = new Model("s");
  model.snapshot = {
    version: 1,
    session: null,
    folder: "w",
    sessions: [],
    can_start_sessions: false,
    responses: [response],
    comments: notes,
    messages: [],
  };
  return { model, response };
}

const NOTES = [note(5, 0, "First point"), note(6, 1, "Second point"), note(7, -1, "")];

/** Which color each note's rows lead with, and which words carry that color. */
function pairs(rows: Span[][]): Map<number, { words: string; strip: boolean }> {
  const found = new Map<number, { words: string; strip: boolean }>();
  for (const row of rows) {
    for (const span of row) {
      if (span.style.mark === undefined) continue;
      const entry = found.get(span.style.mark) ?? { words: "", strip: false };
      if (/^[◆◇│ ]+$/.test(span.text)) entry.strip = true;
      else entry.words += span.text;
      found.set(span.style.mark, entry);
    }
  }
  return found;
}

for (const width of [140, 90]) {
  test(`chat at ${width} columns: a note's strip has the color of its words`, () => {
    const { model } = modelWith(NOTES);
    const view = buildConversation(model, {
      width,
      selectedKey: null,
      render: (response, w) => renderReply(response.text, { width: w }),
      renderMarkdown: (markdown, w) => renderReply(markdown, { width: w }),
      live: null,
    });
    const found = pairs(view.rows.flatMap((row) => [row.left, row.right]));
    assert.deepEqual(found.get(0), { words: "First point", strip: true });
    assert.deepEqual(found.get(1), { words: "Second point", strip: true });
    assert.equal(found.size, 2, "the note on the whole reply has no color");
  });

  test(`tui at ${width} columns: a note's bar has the color of its words`, () => {
    const { model } = modelWith(NOTES);
    const view = buildFeed(model, {
      width,
      selectedKey: null,
      render: (response, w) => renderReply(response.text, { width: w }),
    });
    const found = pairs(view.rows.flatMap((row) => [row.left, row.right]));
    assert.deepEqual(found.get(0), { words: "First point", strip: true });
    assert.deepEqual(found.get(1), { words: "Second point", strip: true });
  });
}

test("an open thread's quote carries the note's color", () => {
  const { model } = modelWith(NOTES);
  const bar = (id: number): number | undefined =>
    buildThread(model, id, 60)!
      .flat()
      .find((span) => span.text === "▌ ")?.style.mark;
  assert.equal(bar(5), 0);
  assert.equal(bar(6), 1);
});
