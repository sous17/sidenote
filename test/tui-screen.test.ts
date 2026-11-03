import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Screen } from "../src/tui/screen.ts";

class FakeInput extends EventEmitter {
  setRawMode(): this {
    return this;
  }
  setEncoding(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
}

class FakeOutput extends EventEmitter {
  columns = 10;
  rows = 3;
  written = "";
  write(data: string): boolean {
    this.written += data;
    return true;
  }
}

function start(): { screen: Screen; output: FakeOutput } {
  const output = new FakeOutput();
  const screen = new Screen(new FakeInput() as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
  screen.start(
    () => {},
    () => {},
  );
  output.written = "";
  return { screen, output };
}

test("a full-width row keeps its last character", () => {
  const { screen, output } = start();
  screen.draw(["0123456789", "short"], null);
  // Clearing after a row that fills the width would erase its last column, where the cursor stays.
  assert.ok(output.written.includes("\x1b[1;1H\x1b[0m\x1b[2K0123456789\x1b[0m"));
  assert.doesNotMatch(output.written, /\x1b\[K/);
});

test("only rows that changed are written again", () => {
  const { screen, output } = start();
  screen.draw(["one", "two", "three"], null);
  output.written = "";
  screen.draw(["one", "TWO", "three"], { row: 1, column: 2 });
  assert.ok(output.written.includes("\x1b[2;1H"));
  assert.ok(!output.written.includes("\x1b[1;1H") && !output.written.includes("\x1b[3;1H"));
  assert.ok(output.written.includes("\x1b[2;3H\x1b[?25h"), "the text cursor is shown where the editor needs it");
});
