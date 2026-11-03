// Reads keypresses from what a terminal sends in raw mode: plain characters, control keys,
// Alt (ESC followed by the key), and CSI sequences for arrows and the like. Bracketed paste
// arrives as one event, so a pasted newline never sends a note.

export interface Key {
  /** The character typed, or a name: enter, tab, backspace, delete, escape, up, down, left,
   * right, home, end, pageup, pagedown, paste. Ctrl+letter is the letter with ctrl set. */
  name: string;
  /** What to insert into text: the character typed, or the pasted text. */
  text: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const CSI = /^\x1b[[O]([0-9;]*)([A-Za-z~])/;

const CSI_LETTERS: ReadonlyMap<string, string> = new Map([
  ["A", "up"],
  ["B", "down"],
  ["C", "right"],
  ["D", "left"],
  ["H", "home"],
  ["F", "end"],
  ["Z", "tab"], // Shift+Tab
]);
const CSI_TILDES: ReadonlyMap<string, string> = new Map([
  ["1", "home"],
  ["7", "home"],
  ["4", "end"],
  ["8", "end"],
  ["3", "delete"],
  ["5", "pageup"],
  ["6", "pagedown"],
]);
/** Keys the kitty keyboard protocol reports as CSI <code> u, such as Shift+Enter. */
const CSI_U_CODES: ReadonlyMap<number, string> = new Map([
  [13, "enter"],
  [9, "tab"],
  [27, "escape"],
  [127, "backspace"],
]);

function key(name: string, fields: Partial<Key> = {}): Key {
  return { name, text: "", ctrl: false, alt: false, shift: false, ...fields };
}

export function parseKeys(data: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < data.length) {
    if (data.startsWith(PASTE_START, i)) {
      const end = data.indexOf(PASTE_END, i + PASTE_START.length);
      const text = data.slice(i + PASTE_START.length, end < 0 ? undefined : end);
      keys.push(key("paste", { text: text.replace(/\r\n?/g, "\n") }));
      i = end < 0 ? data.length : end + PASTE_END.length;
      continue;
    }
    if (data[i] === "\x1b") {
      const sequence = CSI.exec(data.slice(i));
      if (sequence) {
        keys.push(fromCsi(sequence[1]!, sequence[2]!));
        i += sequence[0].length;
        continue;
      }
      const next = data.codePointAt(i + 1);
      if (next === undefined || next === 0x1b) {
        keys.push(key("escape"));
        i += 1;
        continue;
      }
      // Alt+key: the terminal sends ESC, then the key.
      const char = String.fromCodePoint(next);
      keys.push({ ...single(char), alt: true });
      i += 1 + char.length;
      continue;
    }
    const char = String.fromCodePoint(data.codePointAt(i)!);
    keys.push(single(char));
    i += char.length;
  }
  return keys;
}

function single(char: string): Key {
  const code = char.codePointAt(0)!;
  if (char === "\r" || char === "\n") return key("enter");
  if (char === "\t") return key("tab");
  if (code === 0x7f || code === 0x08) return key("backspace");
  if (code >= 0x01 && code <= 0x1a) return key(String.fromCharCode(code + 0x60), { ctrl: true });
  if (code < 0x20) return key("unknown");
  return key(char, { text: char });
}

function fromCsi(params: string, final: string): Key {
  const [first = "", modifier = "1"] = params.split(";");
  const bits = Math.max(0, Number(modifier) - 1);
  const mods = { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
  if (final === "~") return key(CSI_TILDES.get(first) ?? "unknown", mods);
  if (final === "u") {
    const code = Number(first);
    const name = CSI_U_CODES.get(code);
    if (name) return key(name, mods);
    const char = String.fromCodePoint(code);
    return key(char, { ...mods, text: mods.ctrl || mods.alt ? "" : char });
  }
  if (final === "Z") return key("tab", { ...mods, shift: true });
  return key(CSI_LETTERS.get(final) ?? "unknown", mods);
}
