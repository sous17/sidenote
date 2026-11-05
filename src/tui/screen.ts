// The terminal itself: raw input, the alternate screen, and drawing frames. Only rows that
// changed are redrawn, inside a synchronized update where the terminal supports one, so typing
// doesn't flicker. Autowrap is off, so a row can never spill onto the next.
import { KeyReader, type Key } from "./keys.ts";

// Mouse reports, for the wheel. Terminals otherwise turn the wheel into arrow keys here or send
// nothing, which can't scroll from the prompt line. Selecting text then needs Option or Shift.
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";
// Asks for the background color, the one way to know a light terminal in all of them. The answer
// comes in as a key, so nothing waits for terminals that never answer.
const ASK_BACKGROUND = "\x1b]11;?\x1b\\";
const ENTER = `\x1b[?1049h\x1b[?7l\x1b[?2004h${MOUSE_ON}\x1b[?25l\x1b[2J${ASK_BACKGROUND}`;
const LEAVE = `${MOUSE_OFF}\x1b[?2004l\x1b[?7h\x1b[?25h\x1b[?1049l`;
const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

export class Screen {
  readonly #input: NodeJS.ReadStream;
  readonly #output: NodeJS.WriteStream;
  #previous: string[] = [];
  #active = false;
  #onData: ((data: string) => void) | null = null;
  #reader = new KeyReader();
  #flushTimer: NodeJS.Timeout | undefined;

  constructor(input: NodeJS.ReadStream, output: NodeJS.WriteStream) {
    this.#input = input;
    this.#output = output;
  }

  size(): { columns: number; rows: number } {
    return { columns: this.#output.columns || 80, rows: this.#output.rows || 24 };
  }

  start(onKeys: (keys: Key[]) => void, onResize: () => void): void {
    this.#onData = (data) => this.#read(data, onKeys);
    this.#input.setEncoding("utf8");
    this.#input.on("data", this.#onData);
    this.#output.on("resize", () => {
      this.#previous = [];
      this.#output.write("\x1b[2J");
      onResize();
    });
    this.#enter();
  }

  /** Puts the terminal back as it was. Safe to call more than once. */
  stop(): void {
    if (!this.#active) return;
    this.#active = false;
    clearTimeout(this.#flushTimer);
    this.#reader = new KeyReader();
    this.#output.write(LEAVE);
    this.#input.setRawMode(false);
    this.#input.pause();
  }

  draw(rows: string[], cursor: { row: number; column: number } | null): void {
    if (!this.#active) return;
    let out = `${SYNC_START}\x1b[?25l`;
    const count = Math.max(rows.length, this.#previous.length);
    for (let i = 0; i < count; i++) {
      const row = rows[i] ?? "";
      // Clear the row before writing it: with autowrap off, a full row leaves the cursor on its
      // last column, and clearing after the text would erase that column's character.
      if (row !== this.#previous[i]) out += `\x1b[${i + 1};1H\x1b[0m\x1b[2K${row}\x1b[0m`;
    }
    if (cursor) out += `\x1b[${cursor.row + 1};${cursor.column + 1}H\x1b[?25h`;
    this.#output.write(out + SYNC_END);
    this.#previous = rows;
  }

  /** Lends the terminal to another program, such as $EDITOR, then takes it back. */
  suspend<T>(run: () => T): T {
    this.stop();
    try {
      return run();
    } finally {
      this.#input.resume();
      this.#enter();
    }
  }

  #read(data: string, onKeys: (keys: Key[]) => void): void {
    clearTimeout(this.#flushTimer);
    const keys = this.#reader.read(data);
    if (keys.length) onKeys(keys);
    const wait = this.#reader.waitMs;
    if (wait === null) return;
    this.#flushTimer = setTimeout(() => onKeys(this.#reader.flush()), wait);
    this.#flushTimer.unref();
  }

  #enter(): void {
    this.#input.setRawMode(true);
    this.#input.resume();
    this.#output.write(ENTER);
    this.#previous = [];
    this.#active = true;
  }
}
