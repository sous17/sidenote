import assert from "node:assert/strict";
import { test } from "node:test";
import { NoteText } from "../src/tui/editor.ts";
import { parseKeys } from "../src/tui/keys.ts";

const names = (data: string): string[] =>
  parseKeys(data).map((key) => `${key.ctrl ? "C-" : ""}${key.alt ? "M-" : ""}${key.shift ? "S-" : ""}${key.name}`);

test("reads characters, control keys and escape sequences", () => {
  assert.deepEqual(names("ab日👍"), ["a", "b", "日", "👍"]);
  assert.deepEqual(names("\r\t\x7f\x03\x13\x05"), ["enter", "tab", "backspace", "C-c", "C-s", "C-e"]);
  assert.deepEqual(names("\x1b[A\x1b[B\x1bOC\x1b[D\x1b[H\x1b[F"), ["up", "down", "right", "left", "home", "end"]);
  assert.deepEqual(names("\x1b[3~\x1b[5~\x1b[6~\x1b[1;5A"), ["delete", "pageup", "pagedown", "C-up"]);
  assert.deepEqual(names("\x1b"), ["escape"]);
  assert.deepEqual(names("\x1b\r\x1bx"), ["M-enter", "M-x"], "Alt sends ESC first");
  assert.deepEqual(names("\x1b[13;2u"), ["S-enter"], "Shift+Enter in the kitty keyboard protocol");
  assert.equal(parseKeys("x")[0]!.text, "x");
  assert.equal(parseKeys("\x1b[A")[0]!.text, "", "special keys insert nothing");
});

test("a paste is one event, so its newlines can't send the note", () => {
  const keys = parseKeys("\x1b[200~line one\r\nline two\r\x1b[201~z");
  assert.deepEqual(
    keys.map((key) => [key.name, key.text]),
    [
      ["paste", "line one\nline two\n"],
      ["z", "z"],
    ],
  );
});

test("the note text edits by whole characters", () => {
  const text = new NoteText();
  text.insert("hi 👍🏽");
  text.backspace();
  assert.equal(text.text, "hi ", "an emoji with a skin tone is deleted at once");
  text.insert("there friend");
  text.deleteWord();
  assert.equal(text.text, "hi there ");
  text.left();
  text.left();
  text.insert("!");
  assert.equal(text.text, "hi ther!e ");
  text.home();
  text.deleteForward();
  assert.equal(text.text, "i ther!e ");
  text.end();
  assert.equal(text.cursor, 9);
});

test("the note text wraps to the editor, with the cursor where it is typed", () => {
  const text = new NoteText("abcdefgh\nxy");
  assert.deepEqual(text.layout(5), { rows: ["abcde", "fgh", "xy"], cursorRow: 2, cursorColumn: 2 });
  text.cursor = 5;
  assert.deepEqual(text.layout(5).cursorRow, 1, "a cursor on a wrap point starts the next row");
  text.cursor = 8;
  text.vertical(1, 5);
  assert.equal(text.cursor, 11, "down to the end of a shorter row");
  text.vertical(-1, 5);
  assert.equal(text.cursor, 7, "and up again, in the same column");
  const full = new NoteText("abcde");
  assert.deepEqual(full.layout(5), { rows: ["abcde", ""], cursorRow: 1, cursorColumn: 0 });
  const wide = new NoteText("日本語");
  assert.deepEqual(wide.layout(4), { rows: ["日本", "語"], cursorRow: 1, cursorColumn: 2 });
});

test("the wheel is read with the pointer's column, and other mouse reports do nothing", () => {
  assert.deepEqual(names("\x1b[<64;10;5M\x1b[<65;10;5M"), ["wheelup", "wheeldown"]);
  assert.equal(parseKeys("\x1b[<65;10;5M")[0]!.column, 9, "columns are reported from 1");
  assert.deepEqual(names("\x1b[<68;1;1M"), ["wheelup"], "with Shift held");
  assert.deepEqual(names("\x1b[<66;1;1M\x1b[<67;1;1M"), ["mouse", "mouse"], "sideways");
  assert.deepEqual(names("\x1b[<0;3;4M\x1b[<0;3;4m\x1b[<2;3;4M"), ["mouse", "mouse", "mouse"], "clicks");
  assert.deepEqual(names("a\x1b[<64;1;1Mb"), ["a", "wheelup", "b"]);
  assert.equal(parseKeys("\x1b[<0;3;4M")[0]!.text, "", "a click inserts nothing");
});

test("the terminal's answer about its background is read, and never typed", () => {
  const light = (data: string): boolean | undefined => parseKeys(data)[0]!.light;
  assert.equal(light("\x1b]11;rgb:ffff/ffff/ffff\x1b\\"), true);
  assert.equal(light("\x1b]11;rgb:0d0d/1111/1717\x07"), false, "ended by BEL");
  assert.equal(light("\x1b]11;rgb:ff/fa/f0\x07"), true, "two digits a channel");
  assert.equal(light("\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\"), false);
  assert.equal(light("\x1b]11;rgba:ffff/ffff/ffff/ffff\x1b\\"), true);
  assert.equal(light("\x1b]11;nonsense\x07"), undefined);
  assert.deepEqual(names("a\x1b]11;rgb:ffff/ffff/ffff\x1b\\b"), ["a", "background", "b"]);
  assert.equal(parseKeys("\x1b]11;rgb:ffff/ffff/ffff\x07")[0]!.text, "");
});
