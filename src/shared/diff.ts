// Parsing unified diffs, as Claude writes them in ```diff blocks. Pure, so it is shared by the
// page and the tests. Tolerant: hand-written diffs often lack headers or get line counts wrong.

export type DiffLineKind = "add" | "del" | "context" | "hunk";

export interface DiffLine {
  kind: DiffLineKind;
  /** The line without its +/-/space prefix; for hunks, the text after the @@ ... @@ range. */
  text: string;
  /** For a changed line paired with its counterpart: [before, changed, after] around the edit. */
  parts?: [string, string, string];
}

export interface DiffFile {
  /** The file's path, or "" when the diff names none. */
  path: string;
  lines: DiffLine[];
  additions: number;
  deletions: number;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$/;
const METADATA =
  /^(?:diff --git |index |new file mode |deleted file mode |similarity index |rename (?:from|to) |\\ No newline)/;

/**
 * Whether unlabeled text is clearly a unified diff: it has a git header, a ---/+++ file header
 * or an @@ hunk header, and at least one changed line. Plain code never has those headers.
 */
export function looksLikeDiff(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const hasHeader = lines.some(
    (line, i) =>
      line.startsWith("diff --git ") ||
      HUNK.test(line) ||
      (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")),
  );
  return hasHeader && lines.some((line) => /^[+-](?![+-]{2} )/.test(line));
}

/** Splits a unified diff into files; text before any file header belongs to an unnamed file. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  if (!text.trim()) return [];
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  const lines = text.replace(/\n$/, "").split(/\r?\n/);

  const start = (path: string): DiffFile => {
    const file: DiffFile = { path, lines: [], additions: 0, deletions: 0 };
    files.push(file);
    return file;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      current = start(pathFrom(lines[i + 1]!.slice(4), line.slice(4)));
      i += 1;
      continue;
    }
    if (METADATA.test(line)) continue;
    current ??= start("");
    const hunk = HUNK.exec(line);
    if (hunk) {
      current.lines.push({ kind: "hunk", text: hunk[1]!.trim() });
    } else if (line.startsWith("+")) {
      current.lines.push({ kind: "add", text: line.slice(1) });
      current.additions += 1;
    } else if (line.startsWith("-")) {
      current.lines.push({ kind: "del", text: line.slice(1) });
      current.deletions += 1;
    } else {
      current.lines.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line });
    }
  }
  for (const file of files) pairChangedLines(file.lines);
  return files.filter((file) => file.lines.length > 0);
}

/** "b/src/x.ts" -> "src/x.ts"; a deleted file (+++ /dev/null) keeps its old path. */
function pathFrom(newPath: string, oldPath: string): string {
  const clean = (path: string): string =>
    path
      .replace(/\t.*$/, "")
      .trim()
      .replace(/^[ab]\//, "");
  const target = clean(newPath);
  return target === "/dev/null" ? clean(oldPath) : target;
}

/**
 * Marks the edited part of changed lines: a run of deletions followed by the same number of
 * additions is read as those lines edited in place, so each pair gets a word-level highlight.
 */
function pairChangedLines(lines: DiffLine[]): void {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.kind !== "del") continue;
    let firstAdd = i;
    while (lines[firstAdd]?.kind === "del") firstAdd++;
    let end = firstAdd;
    while (lines[end]?.kind === "add") end++;
    if (firstAdd - i === end - firstAdd) {
      for (let k = 0; k < firstAdd - i; k++) {
        const [before, after] = editedParts(lines[i + k]!.text, lines[firstAdd + k]!.text);
        lines[i + k]!.parts = before;
        lines[firstAdd + k]!.parts = after;
      }
    }
    i = end - 1;
  }
}

/** The common prefix and suffix of two lines, and what differs between them. */
export function editedParts(before: string, after: string): [[string, string, string], [string, string, string]] {
  let prefix = 0;
  while (prefix < before.length && before[prefix] === after[prefix]) prefix++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > prefix && endAfter > prefix && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  return [
    [before.slice(0, prefix), before.slice(prefix, endBefore), before.slice(endBefore)],
    [after.slice(0, prefix), after.slice(prefix, endAfter), after.slice(endAfter)],
  ];
}
