// Draws a reply's markdown as terminal lines: headings, lists, quotes, tables, code, and
// ```diff blocks as diffs with the edited words marked, folding per file like the page when the
// reply touches several files. Every line records its block, so notes land where the page puts them.
import type { Token, Tokens } from "marked";
import { lexReply, replyBlocks } from "../shared/blocks.ts";
import { looksLikeDiff, parseUnifiedDiff, type DiffFile, type DiffLine } from "../shared/diff.ts";
import { PLAIN, type Line, type Span, type Style, type Tone } from "./lines.ts";
import { terminalSafe } from "./sanitize.ts";
import { displayWidth } from "./width.ts";
import { spansWidth, wrapSpans } from "./wrap.ts";

export interface RenderOptions {
  /** Columns available. Narrower than MIN_WIDTH is drawn at MIN_WIDTH. */
  width: number;
  /** Whether a foldable diff file is open; by default only the reply's first file is, as on the page. */
  isFileOpen?: (file: number) => boolean;
}

/** What a note on a block needs: whether it is code, and the text it quotes. */
export interface BlockInfo {
  /** Code and diffs can be noted line by line. */
  code: boolean;
  /** The block's own text, like the page's quote of a whole block. */
  quote: string;
}

export interface RenderedReply {
  lines: Line[];
  /** One per block, by block number. */
  blocks: BlockInfo[];
  /** Files in the reply's diffs; header lines carry their number in Line.file. */
  fileCount: number;
  /** True when the diffs touch more than one path, so each file folds open from its header. */
  foldable: boolean;
}

const MIN_WIDTH = 20;
const MIN_TABLE_COLUMN = 4;
const TAB = "    ";
const BULLETS = ["•", "◦", "▪"];
const DIFF_LANGUAGES: ReadonlySet<string> = new Set(["diff", "patch"]);
const DIFF_SIGNS: Readonly<Record<Exclude<DiffLine["kind"], "hunk">, string>> = { add: "+ ", del: "− ", context: "  " };
const DIFF_TONES: Readonly<Record<"add" | "del", [Tone, Tone]>> = { add: ["add", "addMark"], del: ["del", "delMark"] };

const MUTED: Style = { tone: "muted" };
const BOLD: Style = { bold: true };
const HEADINGS: readonly Style[] = [
  { bold: true, underline: true, tone: "accent" },
  { bold: true, tone: "accent" },
  BOLD,
];
const ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
]);

export function renderReply(markdown: string, options: RenderOptions): RenderedReply {
  const tokens = lexReply(terminalSafe(markdown));
  const blocks = replyBlocks(tokens);
  const renderer = new ReplyRenderer(tokens, blocks, options);
  const lines = renderer.blocks(tokens, Math.max(MIN_WIDTH, options.width), -1, 0, true);
  return {
    lines,
    blocks: blocks.map(blockInfo),
    fileCount: renderer.fileCount,
    foldable: renderer.foldable,
  };
}

function blockInfo(token: Token): BlockInfo {
  // A table's text is its rows as written; every other block keeps its source text.
  const text = token.type === "table" || !("text" in token) ? token.raw : String(token.text);
  return { code: token.type === "code", quote: text.trim() };
}

class ReplyRenderer {
  readonly foldable: boolean;
  readonly #blockOf: Map<Token, number>;
  readonly #isFileOpen: (file: number) => boolean;
  #nextFile = 0;

  constructor(tokens: Token[], blocks: Token[], options: RenderOptions) {
    this.#blockOf = new Map(blocks.map((token, index) => [token, index]));
    const paths = new Set(codeTokens(tokens).flatMap((code) => diffFiles(code).map((file) => file.path)));
    this.foldable = paths.size > 1;
    this.#isFileOpen = options.isFileOpen ?? ((file) => file === 0);
  }

  get fileCount(): number {
    return this.#nextFile;
  }

  /** A run of blocks; children that aren't blocks themselves belong to the enclosing one. */
  blocks(tokens: readonly Token[], width: number, enclosing: number, depth: number, gap: boolean): Line[] {
    const out: Line[] = [];
    for (const token of tokens) {
      const lines = this.#block(token, width, this.#blockOf.get(token) ?? enclosing, depth);
      if (!lines.length) continue;
      if (gap && out.length) out.push({ spans: [], block: enclosing });
      out.push(...lines);
    }
    return out;
  }

  #block(token: Token, width: number, block: number, depth: number): Line[] {
    switch (token.type) {
      case "space":
      case "def":
        return [];
      case "paragraph":
        return prose(this.#inline(token.tokens ?? []), width, block);
      case "heading":
        return prose(this.#inline(token.tokens ?? [], HEADINGS[Math.min(token.depth, 3) - 1]), width, block);
      case "code": {
        const files = diffFiles(token as Tokens.Code);
        return files.length ? this.#diff(files, width, block) : code(token as Tokens.Code, width, block);
      }
      case "blockquote": {
        const inner = this.blocks(token.tokens ?? [], width - 2, block, depth, true);
        return prefixed(inner, [{ text: "▌ ", style: MUTED }]);
      }
      case "list":
        return this.#list(token as Tokens.List, width, depth);
      case "table":
        return this.#table(token as Tokens.Table, width, block);
      case "hr":
        return [{ spans: [{ text: "─".repeat(width), style: MUTED }], block }];
      case "html":
        // Shown as text, like the page does: HTML in a reply is almost always an example.
        return prose([{ text: token.text.replace(/\n+$/, ""), style: PLAIN }], width, block);
      default:
        if ("tokens" in token && token.tokens) return prose(this.#inline(token.tokens), width, block);
        if ("text" in token && typeof token.text === "string") return prose([plain(token.text)], width, block);
        return [];
    }
  }

  #list(list: Tokens.List, width: number, depth: number): Line[] {
    const out: Line[] = [];
    const start = typeof list.start === "number" ? list.start : 1;
    list.items.forEach((item, i) => {
      const block = this.#blockOf.get(item) ?? -1;
      let marker = list.ordered ? `${start + i}.` : BULLETS[Math.min(depth, BULLETS.length - 1)]!;
      if (item.task) marker += item.checked ? " ☑" : " ☐";
      const indent = displayWidth(marker) + 1;
      const children = item.tokens.filter((child) => child.type !== "checkbox");
      const body = this.blocks(children, width - indent, block, depth + 1, item.loose);
      if (list.loose && out.length) out.push({ spans: [], block: -1 });
      const first: Span[] = [{ text: `${marker} `, style: list.ordered ? PLAIN : MUTED }];
      out.push(...prefixed(body.length ? body : [{ spans: [], block }], first, [plain(" ".repeat(indent))]));
    });
    return out;
  }

  #diff(files: DiffFile[], width: number, block: number): Line[] {
    const out: Line[] = [];
    for (const file of files) {
      const number = this.#nextFile++;
      const open = !this.foldable || this.#isFileOpen(number);
      const header: Span[] = [
        ...(this.foldable ? [{ text: open ? "▾ " : "▸ ", style: MUTED }] : []),
        { text: file.path || "Change", style: BOLD },
        plain("  "),
        { text: `+${file.additions}`, style: { tone: "add" } },
        plain(" "),
        { text: `−${file.deletions}`, style: { tone: "del" } },
      ];
      for (const spans of wrapSpans(header, width)) out.push({ spans, block, file: number });
      if (!open) continue;
      for (const line of file.lines) out.push(...diffLine(line, width, block));
    }
    return out;
  }

  #table(table: Tokens.Table, width: number, block: number): Line[] {
    const header = table.header.map((cell) => this.#inline(cell.tokens, BOLD));
    const rows = table.rows.map((row) => row.map((cell) => this.#inline(cell.tokens)));
    const columns = header.length;
    const natural = header.map((_, c) => Math.max(1, ...[header, ...rows].map((row) => spansWidth(row[c] ?? []))));
    const widths = shrink(natural, width - (3 * columns + 1));
    if (!widths) return stackedTable(header, rows, width, block);

    const border = (left: string, middle: string, right: string): Line => ({
      spans: [{ text: left + widths.map((w) => "─".repeat(w + 2)).join(middle) + right, style: MUTED }],
      block,
    });
    const aligns = table.align;
    return [
      border("┌", "┬", "┐"),
      ...tableRow(header, widths, aligns, block),
      border("├", "┼", "┤"),
      ...rows.flatMap((row) => tableRow(row, widths, aligns, block)),
      border("└", "┴", "┘"),
    ];
  }

  #inline(tokens: readonly Token[], base: Style = PLAIN): Span[] {
    // marked decodes entities in inline text itself, so "&#27;" arrives here as a real ESC:
    // inline text is made safe as it becomes a span, not only when the reply comes in.
    const out: Span[] = [];
    const push = (text: string, style: Style): void => {
      out.push({ text: terminalSafe(text), style });
    };
    for (const token of tokens) {
      switch (token.type) {
        case "text":
          if ("tokens" in token && token.tokens?.length) out.push(...this.#inline(token.tokens, base));
          else push(decodeEntities(token.text), base);
          break;
        case "escape":
        case "html": // inline HTML is shown as text, like the page does
          push(token.text, base);
          break;
        case "strong":
          out.push(...this.#inline(token.tokens ?? [], { ...base, bold: true }));
          break;
        case "em":
          out.push(...this.#inline(token.tokens ?? [], { ...base, italic: true }));
          break;
        case "del":
          out.push(...this.#inline(token.tokens ?? [], { ...base, strike: true }));
          break;
        case "codespan":
          push(token.text, { ...base, tone: "code" });
          break;
        case "br":
          push("\n", base);
          break;
        case "link": {
          const label = this.#inline(token.tokens ?? [], { ...base, tone: "link", underline: true, href: token.href });
          out.push(...label);
          // Link text can claim to be anything, so the real target is always shown beside it.
          const text = label.map((span) => span.text).join("");
          if (text !== token.href && `mailto:${text}` !== token.href) {
            push(` (${token.href})`, { ...base, tone: "muted" });
          }
          break;
        }
        case "image":
          push(`[image: ${token.text || token.href}]`, { ...base, tone: "muted" });
          break;
        case "checkbox":
          break;
        default:
          if ("tokens" in token && token.tokens) out.push(...this.#inline(token.tokens, base));
          else if ("text" in token && typeof token.text === "string") push(token.text, base);
      }
    }
    return out;
  }
}

function plain(text: string): Span {
  return { text, style: PLAIN };
}

function prose(spans: Span[], width: number, block: number): Line[] {
  const flat = spans.map((span) => ({ ...span, text: span.text.replace(/\t/g, " ") }));
  return wrapSpans(flat, width).map((line) => ({ spans: line, block }));
}

/** Puts first in front of the first line and rest (default: spaces as wide) in front of the others. */
function prefixed(lines: Line[], first: Span[], rest?: Span[]): Line[] {
  const others = rest ?? first;
  return lines.map((line, i) => ({ ...line, spans: [...(i ? others : first), ...line.spans] }));
}

function code(token: Tokens.Code, width: number, block: number): Line[] {
  const out: Line[] = [];
  const language = languageOf(token);
  if (language) out.push({ spans: [{ text: language, style: MUTED }], block });
  for (const raw of terminalSafe(token.text).split("\n")) {
    const chunks = wrapSpans([plain(raw.replace(/\t/g, TAB))], width - 2, "anywhere");
    // A line too long for the window continues under a dotted gutter.
    chunks.forEach((spans, i) => out.push({ spans: [{ text: i ? "┆ " : "│ ", style: MUTED }, ...spans], block }));
  }
  return out;
}

function diffLine(line: DiffLine, width: number, block: number): Line[] {
  if (line.kind === "hunk") {
    return wrapSpans([{ text: line.text || "⋯", style: { tone: "hunk" } }], width).map((spans) => ({ spans, block }));
  }
  const [tone, mark]: [Tone | undefined, Tone | undefined] =
    line.kind === "context" ? [undefined, undefined] : DIFF_TONES[line.kind];
  const style: Style = tone ? { tone } : PLAIN;
  const detab = (text: string): string => text.replace(/\t/g, TAB);
  const spans: Span[] = line.parts?.[1]
    ? [
        { text: detab(line.parts[0]), style },
        { text: detab(line.parts[1]), style: mark ? { tone: mark } : PLAIN },
        { text: detab(line.parts[2]), style },
      ]
    : [{ text: detab(line.text), style }];
  const sign: Span = { text: DIFF_SIGNS[line.kind], style };
  return wrapSpans(spans, width - 2, "anywhere").map((chunk, i) => ({
    spans: [i ? plain("  ") : sign, ...chunk],
    block,
  }));
}

/** The files a code block shows as a diff, by the page's rules; none for ordinary code. */
function diffFiles(token: Tokens.Code): DiffFile[] {
  const language = languageOf(token);
  const isDiff = DIFF_LANGUAGES.has(language) || (!language && looksLikeDiff(token.text));
  return isDiff ? parseUnifiedDiff(terminalSafe(token.text)) : [];
}

/** The first word of a fence's info string, which is what the page's language-* class holds. */
function languageOf(token: Tokens.Code): string {
  return /^\S*/.exec(token.lang ?? "")?.[0] ?? "";
}

/** Every code block in the reply, wherever it sits, in document order. */
function codeTokens(tokens: readonly Token[]): Tokens.Code[] {
  const found: Tokens.Code[] = [];
  const visit = (token: Token): void => {
    if (token.type === "code") found.push(token as Tokens.Code);
    if (token.type === "list") token.items.forEach(visit);
    if ("tokens" in token && token.tokens) token.tokens.forEach(visit);
  };
  tokens.forEach(visit);
  return found;
}

/** Narrows the widest columns until the table fits; null when even the narrowest won't. */
function shrink(natural: number[], available: number): number[] | null {
  const widths = [...natural];
  let total = widths.reduce((sum, w) => sum + w, 0);
  while (total > available) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest]! <= MIN_TABLE_COLUMN) return null;
    widths[widest]! -= 1;
    total -= 1;
  }
  return widths;
}

function tableRow(cells: Span[][], widths: number[], aligns: Tokens.Table["align"], block: number): Line[] {
  const wrapped = widths.map((w, c) => wrapSpans(cells[c] ?? [], w));
  const height = Math.max(...wrapped.map((lines) => lines.length));
  const out: Line[] = [];
  for (let k = 0; k < height; k++) {
    const spans: Span[] = [{ text: "│ ", style: MUTED }];
    widths.forEach((w, c) => {
      const content = wrapped[c]![k] ?? [];
      const pad = w - spansWidth(content);
      const left = aligns[c] === "right" ? pad : aligns[c] === "center" ? Math.floor(pad / 2) : 0;
      spans.push(plain(" ".repeat(left)), ...content, plain(" ".repeat(pad - left)));
      spans.push({ text: c === widths.length - 1 ? " │" : " │ ", style: MUTED });
    });
    out.push({ spans, block });
  }
  return out;
}

/** A table too wide for the window: each row as "header: value" lines. */
function stackedTable(header: Span[][], rows: Span[][][], width: number, block: number): Line[] {
  const out: Line[] = [];
  for (const row of rows) {
    if (out.length) out.push({ spans: [], block });
    header.forEach((title, c) => {
      const label = title.map((span) => span.text).join("");
      const spans = [{ text: `${label}: `, style: { ...MUTED, bold: true } }, ...(row[c] ?? [])];
      out.push(...prose(spans, width, block));
    });
  }
  return out;
}

/** Entities marked leaves in text for the browser to decode. */
function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  const decoded = text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] !== "#") return ENTITIES.get(name.toLowerCase()) ?? entity;
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : entity;
  });
  return decoded;
}
