// Draws ```diff blocks in rendered markdown as diffs: a file header with line counts, then the
// changed lines with a +/- gutter and the edited words highlighted. When the text around them
// touches more than one file, each file folds open from its header, the first one open.
//
// It runs after sanitizing and builds everything with DOM calls and textContent, so the diff's
// text can never become markup.
import { looksLikeDiff, parseUnifiedDiff, type DiffFile, type DiffLine } from "../shared/diff.ts";
import { el } from "./dom.ts";

/** Code blocks labeled as diffs are always drawn as diffs; unlabeled ones when they clearly are one. */
const LABELED = "pre > code.language-diff, pre > code.language-patch";
const UNLABELED = "pre > code:not([class])";
const SIGNS: Readonly<Record<DiffLine["kind"], string>> = { add: "+", del: "−", context: " ", hunk: "" };

/** Replaces each diff block under root with a rendered diff. */
export function renderDiffs(root: HTMLElement): void {
  // One query keeps document order, so "the first file starts open" means the first on the page.
  const candidates = [...root.querySelectorAll<HTMLElement>(`${LABELED}, ${UNLABELED}`)].filter(
    (code) => code.matches(LABELED) || looksLikeDiff(code.textContent ?? ""),
  );
  const blocks = candidates.flatMap((code) => {
    const pre = code.parentElement;
    const files = parseUnifiedDiff(code.textContent ?? "");
    return pre && files.length ? [{ pre, files }] : [];
  });
  const paths = new Set(blocks.flatMap(({ files }) => files.map((file) => file.path)));
  const foldable = paths.size > 1;
  let first = true;
  for (const { pre, files } of blocks) {
    const view = el("div", "diffview");
    for (const file of files) {
      view.append(foldable ? foldableFile(file, first) : plainFile(file));
      first = false;
    }
    pre.replaceWith(view);
  }
}

function plainFile(file: DiffFile): HTMLElement {
  const section = el("div", "diff-file");
  section.append(fileHeader(file, "div"), linesTable(file));
  return section;
}

function foldableFile(file: DiffFile, open: boolean): HTMLElement {
  const details = el("details", "diff-file");
  details.open = open;
  details.append(fileHeader(file, "summary"), linesTable(file));
  return details;
}

function fileHeader(file: DiffFile, tag: "div" | "summary"): HTMLElement {
  const header = el(tag, "diff-head");
  const path = el("span", "diff-path", file.path || "Change");
  path.title = file.path;
  const stats = el("span", "diff-stats");
  stats.append(el("span", "diff-added", `+${file.additions}`), " ", el("span", "diff-removed", `−${file.deletions}`));
  header.append(path, stats);
  return header;
}

function linesTable(file: DiffFile): HTMLElement {
  const table = el("table", "diff-lines");
  for (const line of file.lines) {
    const row = el("tr", `diff-${line.kind}`);
    if (line.kind === "hunk") {
      const cell = el("td", "", line.text || "⋯");
      cell.colSpan = 2;
      row.append(cell);
    } else {
      row.append(el("td", "diff-sign", SIGNS[line.kind]), codeCell(line));
    }
    table.append(row);
  }
  const scroller = el("div", "diff-scroll");
  scroller.append(table);
  return scroller;
}

function codeCell(line: DiffLine): HTMLElement {
  const cell = el("td", "diff-code");
  if (line.parts?.[1]) {
    const [before, changed, after] = line.parts;
    cell.append(before, el("mark", "", changed), after);
  } else {
    cell.textContent = line.text;
  }
  return cell;
}
