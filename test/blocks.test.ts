import assert from "node:assert/strict";
import { test } from "node:test";
import { Marked, type Token } from "marked";
import { lexReply, replyBlocks } from "../src/shared/blocks.ts";

// The page renders replies like this (src/web/markdown.ts) and then numbers the elements its
// BLOCK_SELECTOR matches (src/web/feed.ts). This reproduces that without a DOM: marked's output
// is well-formed, so a tag scanner can find the same elements in the same order.
const page = new Marked({
  async: false,
  gfm: true,
  renderer: { html: ({ text }) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") },
});
const TOP_LEVEL = new Set(["p", "pre", "blockquote", "table", "h1", "h2", "h3", "h4", "h5", "h6"]);
const VOID = new Set(["br", "hr", "img", "input"]);

function pageBlocks(markdown: string): string[] {
  const found: string[] = [];
  const open: string[] = [];
  for (const [, closing, name] of (page.parse(markdown) as string).matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/g)) {
    if (closing) {
      assert.equal(open.pop(), name, "marked's HTML is well-formed");
      continue;
    }
    if ((open.length === 0 && TOP_LEVEL.has(name!)) || name === "li") found.push(name!);
    if (!VOID.has(name!)) open.push(name!);
  }
  return found;
}

function tagOf(token: Token): string {
  if (token.type === "heading") return `h${token.depth}`;
  const tags: Record<string, string> = { paragraph: "p", code: "pre", list_item: "li" };
  return tags[token.type] ?? token.type;
}

const REPLIES = [
  "Just one paragraph.",
  "# Title\n\nText under it.\n\n## Part\n\n### Smaller\n\n#### Four\n\nSetext heading\n---",
  "- one\n- two\n  - nested\n    - deeper\n- three",
  "1. loose\n\n   with a second paragraph\n\n2. item\n\n   ```ts\n   code in a list\n   ```",
  "- [x] done\n- [ ] todo",
  "> quoted\n>\n> - item in a quote\n>   - nested in a quote\n>\n> > deeper quote",
  "| a | b |\n|---|:-:|\n| 1 | 2 |\n\nafter the table",
  "```diff\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n```\n\n```\nplain code\n```\n\n    indented code",
  "<div>raw html</div>\n\nA paragraph with <i>inline</i> html.\n\n<details>\n<summary>x</summary>\n</details>",
  "Text\n\n---\n\n* * *\n\nmore text  \nwith a hard break\n\n[ref]: https://example.com",
  "- item\n\n  > quote in an item\n\n  | t |\n  |---|\n  | 1 |",
  "",
];

test("blocks are numbered the way the page numbers them", () => {
  for (const markdown of REPLIES) {
    const blocks = replyBlocks(lexReply(markdown)).map(tagOf);
    assert.deepEqual(blocks, pageBlocks(markdown), JSON.stringify(markdown));
  }
});

test("a quote is one block, and list items inside it are blocks of their own", () => {
  const blocks = replyBlocks(lexReply("> quoted\n>\n> - a\n>   - b")).map(tagOf);
  assert.deepEqual(blocks, ["blockquote", "li", "li"]);
});
