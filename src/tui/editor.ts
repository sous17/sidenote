// The text of a note being written: a cursor that moves by whole characters (an emoji with
// modifiers is one), and a layout that wraps the text to the editor's width.
import { graphemes, graphemeWidth } from "./width.ts";

export interface EditorLayout {
  rows: string[];
  cursorRow: number;
  cursorColumn: number;
}

/** Where each character of a laid-out row starts, to move the cursor up and down. */
interface RowCells {
  /** Text offsets of the row's characters, then the offset just past its last. */
  offsets: number[];
  /** The column each of those offsets starts at. */
  columns: number[];
}

export class NoteText {
  text: string;
  /** An offset into text, always on a character boundary. */
  cursor: number;

  constructor(text = "") {
    this.text = text;
    this.cursor = text.length;
  }

  get isBlank(): boolean {
    return !this.text.trim();
  }

  insert(text: string): void {
    this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
    this.cursor += text.length;
  }

  backspace(): void {
    const start = this.#previousBoundary();
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
    this.cursor = start;
  }

  deleteForward(): void {
    this.text = this.text.slice(0, this.cursor) + this.text.slice(this.#nextBoundary());
  }

  /** Ctrl+W: deletes back to the start of the word, and the spaces after it. */
  deleteWord(): void {
    const before = this.text.slice(0, this.cursor);
    const start = before.replace(/\S*\s*$/, "").length;
    this.text = before.slice(0, start) + this.text.slice(this.cursor);
    this.cursor = start;
  }

  left(): void {
    this.cursor = this.#previousBoundary();
  }

  right(): void {
    this.cursor = this.#nextBoundary();
  }

  /** Start and end of the current line of text, not of the wrapped row. */
  home(): void {
    this.cursor = this.text.lastIndexOf("\n", this.cursor - 1) + 1;
  }

  end(): void {
    const newline = this.text.indexOf("\n", this.cursor);
    this.cursor = newline < 0 ? this.text.length : newline;
  }

  /** Moves to the row above or below in the wrapped layout, keeping the column where it can. */
  vertical(direction: -1 | 1, width: number): void {
    const { cursorRow, cursorColumn } = this.layout(width);
    const cells = this.#cells(width)[cursorRow + direction];
    if (!cells) {
      this.cursor = direction < 0 ? 0 : this.text.length;
      return;
    }
    let best = cells.offsets[0]!;
    cells.columns.forEach((column, i) => {
      if (column <= cursorColumn) best = cells.offsets[i]!;
    });
    this.cursor = best;
  }

  layout(width: number): EditorLayout {
    const cells = this.#cells(width);
    const rows: string[] = [];
    let cursorRow = 0;
    let cursorColumn = 0;
    cells.forEach((row, r) => {
      const start = row.offsets[0]!;
      const end = row.offsets[row.offsets.length - 1]!;
      rows.push(this.text.slice(start, end));
      const at = row.offsets.indexOf(this.cursor);
      // A cursor on the boundary of two wrapped rows belongs to the second one.
      if (at >= 0 && !(at === row.offsets.length - 1 && cells[r + 1]?.offsets[0] === this.cursor)) {
        cursorRow = r;
        cursorColumn = row.columns[at]!;
      }
    });
    // The cursor sits just past a full row: show it on a fresh row below.
    if (cursorColumn >= width) {
      rows.splice(cursorRow + 1, 0, "");
      cursorRow += 1;
      cursorColumn = 0;
    }
    return { rows, cursorRow, cursorColumn };
  }

  #cells(width: number): RowCells[] {
    const limit = Math.max(1, width);
    const rows: RowCells[] = [];
    let offset = 0;
    for (const line of this.text.split("\n")) {
      let row: RowCells = { offsets: [offset], columns: [0] };
      let column = 0;
      for (const grapheme of graphemes(line)) {
        const size = graphemeWidth(grapheme);
        if (column + size > limit && column > 0) {
          rows.push(row);
          row = { offsets: [offset], columns: [0] };
          column = 0;
        }
        offset += grapheme.length;
        column += size;
        row.offsets.push(offset);
        row.columns.push(column);
      }
      rows.push(row);
      offset += 1; // the newline
    }
    return rows;
  }

  #previousBoundary(): number {
    let previous = 0;
    let offset = 0;
    for (const grapheme of graphemes(this.text)) {
      if (offset >= this.cursor) break;
      previous = offset;
      offset += grapheme.length;
    }
    return this.cursor === 0 ? 0 : previous;
  }

  #nextBoundary(): number {
    let offset = 0;
    for (const grapheme of graphemes(this.text)) {
      offset += grapheme.length;
      if (offset > this.cursor) return offset;
    }
    return this.text.length;
  }
}
