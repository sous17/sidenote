// Which parts of a reply notes can attach to, and their numbers. A note stores its block's
// number (Note.block_index), so the page and the terminal must number a reply the same way.
//
// The page numbers the elements matched by BLOCK_SELECTOR in src/web/feed.ts, in document order:
// top-level paragraphs, code blocks, quotes, tables and headings, and every list item at any
// depth. This walks marked's tokens with the same rules; test/blocks.test.ts checks the two agree.
import { Lexer, type Token } from "marked";

const TOP_LEVEL_BLOCKS: ReadonlySet<string> = new Set(["paragraph", "code", "blockquote", "table", "heading"]);

/** Splits a reply into marked's tokens, with the options the page renders it with. */
export function lexReply(markdown: string): Token[] {
  return Lexer.lex(markdown, { gfm: true });
}

/** The tokens notes can attach to, in block-number order: the token at index i is block i. */
export function replyBlocks(tokens: readonly Token[]): Token[] {
  const blocks: Token[] = [];
  for (const token of tokens) {
    if (TOP_LEVEL_BLOCKS.has(token.type)) blocks.push(token);
    collectListItems(token, blocks);
  }
  return blocks;
}

/** List items count wherever they are, including inside quotes and other list items. */
function collectListItems(token: Token, blocks: Token[]): void {
  if (token.type === "list") {
    for (const item of token.items) {
      blocks.push(item);
      collectListItems(item, blocks);
    }
  } else if (token.type === "list_item" || token.type === "blockquote") {
    for (const child of token.tokens ?? []) collectListItems(child, blocks);
  }
}
