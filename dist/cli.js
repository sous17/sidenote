var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/node/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
var stateDir, paths;
var init_paths = __esm({
  "src/node/paths.ts"() {
    "use strict";
    stateDir = () => join(homedir(), ".sidenote");
    paths = {
      stateDir,
      storeFile: () => join(stateDir(), "store.json"),
      serverFile: () => join(stateDir(), "server.json"),
      portFile: () => join(stateDir(), "port"),
      logFile: () => join(stateDir(), "server.log"),
      enabledFlag: () => join(stateDir(), "enabled"),
      /** Whether sessions open in the browser or a terminal pane. */
      configFile: () => join(stateDir(), "config.json"),
      /** One file per running sidenote tui, holding its pid, so a second pane isn't opened. */
      panesDir: () => join(stateDir(), "panes"),
      transcriptsDir: () => join(homedir(), ".claude", "projects")
    };
  }
});

// src/shared/types.ts
var TOKEN_HEADER, LAUNCH_FRAGMENT_KEY, SESSION_ID_PATTERN;
var init_types = __esm({
  "src/shared/types.ts"() {
    "use strict";
    TOKEN_HEADER = "X-Review-Token";
    LAUNCH_FRAGMENT_KEY = "launch";
    SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
  }
});

// src/cli/client.ts
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join as join2 } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
function readServerInfo() {
  try {
    return JSON.parse(readFileSync(paths.serverFile(), "utf8"));
  } catch {
    return null;
  }
}
function serverPid() {
  return readServerInfo()?.pid ?? null;
}
async function startServer() {
  mkdirSync(paths.stateDir(), { recursive: true, mode: 448 });
  rmSync(paths.serverFile(), { force: true });
  const log = openSync(paths.logFile(), "a", 384);
  spawn(process.execPath, [SERVER_SCRIPT], { detached: true, stdio: ["ignore", log, log] }).unref();
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const client = await SidenoteClient.connect();
    if (client) return client;
    await sleep(100);
  }
  throw new Error(`the sidenote server did not start; see ${paths.logFile()}`);
}
function openBrowser(url) {
  const [command2, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  const child = spawn(command2, args, { detached: true, stdio: "ignore" });
  child.on("error", () => console.error(`Couldn't open a browser. Open this link instead (valid once): ${url}`));
  child.unref();
}
var SERVER_START_TIMEOUT_MS, REQUEST_TIMEOUT_MS, SERVER_SCRIPT, ApiError, SidenoteClient;
var init_client = __esm({
  "src/cli/client.ts"() {
    "use strict";
    init_paths();
    init_types();
    SERVER_START_TIMEOUT_MS = 1e4;
    REQUEST_TIMEOUT_MS = 3e3;
    SERVER_SCRIPT = join2(dirname(fileURLToPath(import.meta.url)), "server.js");
    ApiError = class extends Error {
      status;
      constructor(status, message) {
        super(message);
        this.status = status;
      }
    };
    SidenoteClient = class _SidenoteClient {
      #server;
      constructor(server) {
        this.#server = server;
      }
      /** The running server, or null when none answers. */
      static async connect() {
        const server = readServerInfo();
        if (!server) return null;
        const client = new _SidenoteClient(server);
        try {
          await client.get("/api/health");
          return client;
        } catch {
          return null;
        }
      }
      /** The running server, starting one if needed; `started` says whether this call started it. */
      static async ensure() {
        const running = await _SidenoteClient.connect();
        if (running) return { client: running, started: false };
        return { client: await startServer(), started: true };
      }
      get origin() {
        return `http://127.0.0.1:${this.#server.port}`;
      }
      get(path) {
        return this.#request("GET", path);
      }
      post(path, body) {
        return this.#request("POST", path, body);
      }
      delete(path) {
        return this.#request("DELETE", path);
      }
      /**
       * A one-time link to a session's window. The launch code sits in the URL fragment, which the
       * browser never sends to the server; the page trades it for the token once.
       */
      async windowUrl(sessionId) {
        const { code: code2 } = await this.post("/api/launch", {});
        const query = sessionId ? `?s=${encodeURIComponent(sessionId)}` : "";
        return `${this.origin}/${query}#${LAUNCH_FRAGMENT_KEY}=${code2}`;
      }
      async #request(method, path, body) {
        const response = await fetch(this.origin + path, {
          method,
          headers: { [TOKEN_HEADER]: this.#server.token, "Content-Type": "application/json" },
          body: body === void 0 ? void 0 : JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        const text = await response.text();
        if (!response.ok) {
          const detail = text ? JSON.parse(text).error : void 0;
          throw new ApiError(
            response.status,
            `${method} ${path} failed with ${response.status}${detail ? `: ${detail}` : ""}`
          );
        }
        return text ? JSON.parse(text) : null;
      }
    };
  }
});

// src/cli/panes.ts
import { spawn as spawn2 } from "node:child_process";
import { mkdirSync as mkdirSync3, readFileSync as readFileSync3, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function shellQuote(text) {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
function tuiCommand(sessionId) {
  return [LAUNCHER, "tui", ...sessionId ? [sessionId] : []];
}
function panePlan(env, command2, cwd) {
  const tmuxPane = env["TMUX_PANE"] ?? "";
  if (env["TMUX"] && /^%\d+$/.test(tmuxPane)) {
    const directory = cwd ? ["-c", cwd] : [];
    const split = ["split-window", "-h", "-d", "-l", `${PANE_PERCENT}%`, "-t", tmuxPane, ...directory, ...command2];
    return { terminal: "tmux", steps: [{ command: "tmux", args: split }] };
  }
  const wezPane = env["WEZTERM_PANE"] ?? "";
  if (/^\d+$/.test(wezPane)) {
    const directory = cwd ? ["--cwd", cwd] : [];
    const split = ["cli", "split-pane", "--pane-id", wezPane, "--right", "--percent", `${PANE_PERCENT}`, ...directory];
    return {
      terminal: "WezTerm",
      steps: [
        { command: "wezterm", args: [...split, "--", ...command2] },
        // The docs don't promise where focus goes after a split, so give it back to Claude.
        { command: "wezterm", args: ["cli", "activate-pane", "--pane-id", wezPane] }
      ]
    };
  }
  const kittyWindow = env["KITTY_WINDOW_ID"] ?? "";
  if (env["KITTY_LISTEN_ON"] && /^\d+$/.test(kittyWindow)) {
    const launch = [
      "@",
      "launch",
      "--type=window",
      "--location=vsplit",
      "--keep-focus",
      `--bias=${PANE_PERCENT}`,
      `--next-to=id:${kittyWindow}`,
      ...cwd ? [`--cwd=${cwd}`] : [],
      ...command2
    ];
    return { terminal: "kitty", steps: [{ command: "kitten", args: launch }] };
  }
  const iTermSession = ITERM_SESSION.exec(env["ITERM_SESSION_ID"] ?? "");
  if (env["TERM_PROGRAM"] === "iTerm.app" && iTermSession) {
    const line = command2.map(shellQuote).join(" ");
    const script = ITERM_SPLIT.flatMap((statement) => ["-e", statement]);
    return { terminal: "iTerm2", steps: [{ command: "osascript", args: [...script, iTermSession[1], line] }] };
  }
  return null;
}
async function openPane(plan) {
  const [split, ...rest] = plan.steps;
  if (!split || !await run(split)) return false;
  for (const step of rest) await run(step);
  return true;
}
function run({ command: command2, args }) {
  return new Promise((resolve) => {
    const child = spawn2(command2, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, SPLIT_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code2) => {
      clearTimeout(timer);
      resolve(code2 === 0);
    });
  });
}
function paneFile(sessionId) {
  return SESSION_ID_PATTERN.test(sessionId) ? join3(paths.panesDir(), `${sessionId}.pid`) : null;
}
function hasLivePane(sessionId) {
  const file = paneFile(sessionId);
  if (!file) return false;
  let pid;
  try {
    pid = Number(readFileSync3(file, "utf8").trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function claimPane(sessionId) {
  const file = paneFile(sessionId);
  if (!file) return () => {
  };
  mkdirSync3(dirname2(file), { recursive: true, mode: 448 });
  writeFileSync2(file, `${process.pid}
`, { mode: 384 });
  return () => {
    try {
      if (readFileSync3(file, "utf8").trim() === String(process.pid)) rmSync2(file, { force: true });
    } catch {
    }
  };
}
async function openTerminal(sessionId, cwd, env) {
  if (sessionId && hasLivePane(sessionId)) {
    return { opened: true, message: "sidenote is already open in a terminal pane for this session." };
  }
  const command2 = tuiCommand(sessionId);
  const plan = panePlan(env, command2, cwd);
  if (plan && await openPane(plan)) {
    return { opened: true, message: `Opened sidenote in a ${plan.terminal} pane beside this one.` };
  }
  return {
    opened: false,
    message: `To read replies and leave notes in the terminal, run this in another pane: ${command2.map((part, i) => i ? part : shellQuote(part)).join(" ")} (sidenote opens the pane itself in tmux, WezTerm, iTerm2, or kitty with remote control.)`
  };
}
var LAUNCHER, PANE_PERCENT, ITERM_SESSION, ITERM_SPLIT, SPLIT_TIMEOUT_MS;
var init_panes = __esm({
  "src/cli/panes.ts"() {
    "use strict";
    init_paths();
    init_types();
    LAUNCHER = join3(dirname2(fileURLToPath2(import.meta.url)), "..", "bin", "sidenote");
    PANE_PERCENT = 45;
    ITERM_SESSION = /^w\d+t\d+p\d+:([0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12})$/;
    ITERM_SPLIT = [
      "on run argv",
      "set targetId to item 1 of argv",
      "set paneCommand to item 2 of argv",
      'tell application id "com.googlecode.iterm2"',
      "repeat with aWindow in windows",
      "repeat with aTab in tabs of aWindow",
      "repeat with aSession in sessions of aTab",
      "if (id of aSession) is targetId then",
      "tell aSession to split vertically with default profile command paneCommand",
      "tell aSession to select",
      "return",
      "end if",
      "end repeat",
      "end repeat",
      "end repeat",
      "end tell",
      'error "sidenote: iTerm2 session not found"',
      "end run"
    ];
    SPLIT_TIMEOUT_MS = 5e3;
  }
});

// src/tui/api.ts
var ClientApi;
var init_api = __esm({
  "src/tui/api.ts"() {
    "use strict";
    init_client();
    ClientApi = class {
      #client;
      constructor(client) {
        this.#client = client;
      }
      async sessions() {
        return (await this.#call((client) => client.get("/api/sessions"))).sessions;
      }
      state(knownVersion, sessionId) {
        return this.#call(
          (client) => client.get(`/api/state?v=${knownVersion}&s=${encodeURIComponent(sessionId)}`)
        );
      }
      async addNote(note) {
        await this.#call((client) => client.post("/api/comments", note));
      }
      async deleteNote(id) {
        await this.#call((client) => client.delete(`/api/comments/${id}`));
      }
      async send(sessionId) {
        await this.#call((client) => client.post("/api/send", { session_ids: [sessionId] }));
      }
      async #call(request) {
        if (this.#client) {
          try {
            return await request(this.#client);
          } catch (error) {
            if (error instanceof ApiError) throw error;
          }
        }
        this.#client = await SidenoteClient.connect();
        if (!this.#client) throw new Error("the sidenote server isn't running");
        return request(this.#client);
      }
    };
  }
});

// src/shared/model.ts
function isAnswered(note) {
  return note.answered_by !== null && note.answered_by > 0;
}
function answeredNoteIds(model, response) {
  const ids = new Set(Object.keys(response.note_answers).map(Number));
  for (const note of model.notes) if (note.answered_by === response.id) ids.add(note.id);
  return ids;
}
var Model;
var init_model = __esm({
  "src/shared/model.ts"() {
    "use strict";
    Model = class {
      sessionId;
      snapshot = { version: -1, session: null, responses: [], comments: [] };
      /** The root note whose thread is open in the pane, if any. */
      openThreadId = null;
      constructor(sessionId) {
        this.sessionId = sessionId;
      }
      get notes() {
        return this.snapshot.comments;
      }
      get responses() {
        return this.snapshot.responses;
      }
      note(id) {
        return id == null ? void 0 : this.notes.find((note) => note.id === id);
      }
      response(id) {
        return id == null ? void 0 : this.responses.find((response) => response.id === id);
      }
      /** The note and its follow-ups, oldest first. */
      thread(rootId) {
        return this.notes.filter((note) => note.id === rootId || note.parent_id === rootId).sort((a3, b) => a3.created_at - b.created_at);
      }
      /** What Claude wrote for this note under its marker, or "" if it didn't. */
      answerText(note) {
        if (!isAnswered(note)) return "";
        return this.response(note.answered_by)?.note_answers[String(note.id)] ?? "";
      }
      sendStatus() {
        return this.snapshot.session ?? { status: "offline", send_requested: false };
      }
      canSend() {
        return this.sendStatus().status !== "offline";
      }
      pendingCount() {
        return this.notes.filter((note) => note.delivered_at === null).length;
      }
      /** Unsent, but Send now was clicked: it goes as soon as the session can take it. */
      isQueued(note) {
        return note.delivered_at === null && this.sendStatus().send_requested;
      }
    };
  }
});

// src/shared/text.ts
function plainText(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, " [code] ").replace(/[#>*_`~]|\[([^\]]*)\]\([^)]*\)/g, (_match, linkText) => linkText ?? "").replace(/\s+/g, " ").trim();
}
function truncate(text, maxChars) {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\u2026` : text;
}
function formatTime(epochSeconds) {
  return new Date(epochSeconds * 1e3).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function projectName(cwd) {
  return cwd.split("/").filter(Boolean).pop() ?? "unknown";
}
function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}
var init_text = __esm({
  "src/shared/text.ts"() {
    "use strict";
  }
});

// src/tui/sanitize.ts
function terminalSafe(text) {
  return text.replace(/\r\n?/g, "\n").replace(C0_AND_DEL, (char) => char === "\x7F" ? "\u2421" : String.fromCharCode(9216 + char.charCodeAt(0))).replace(C1_AND_BIDI, "");
}
var C0_AND_DEL, C1_AND_BIDI;
var init_sanitize = __esm({
  "src/tui/sanitize.ts"() {
    "use strict";
    C0_AND_DEL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
    C1_AND_BIDI = /[\u0080-\u009F‪-‮⁦-⁩]/g;
  }
});

// src/tui/ansi.ts
function lineToAnsi(line, options) {
  let out = "";
  for (const span of line.spans) {
    const text = terminalSafe(span.text).replace(/[\t\n]/g, " ");
    if (!text) continue;
    const codes = sgr(span.style, options.color);
    let piece = codes ? `\x1B[${codes}m${text}\x1B[0m` : text;
    const href = span.style.href;
    if (options.hyperlinks && href && LINKABLE.test(href)) piece = `\x1B]8;;${href}\x1B\\${piece}\x1B]8;;\x1B\\`;
    out += piece;
  }
  return out;
}
function sgr(style, color) {
  const codes = [];
  if (style.bold) codes.push("1");
  if (style.italic) codes.push("3");
  if (style.underline) codes.push("4");
  if (style.strike) codes.push("9");
  const tone = style.tone && (color ? TONES[style.tone] : UNCOLORED_TONES[style.tone]);
  if (tone) codes.push(tone);
  return codes.join(";");
}
var TONES, UNCOLORED_TONES, LINKABLE;
var init_ansi = __esm({
  "src/tui/ansi.ts"() {
    "use strict";
    init_sanitize();
    TONES = {
      accent: "35",
      muted: "2",
      link: "34",
      code: "36",
      add: "32",
      del: "31",
      addMark: "32;7",
      delMark: "31;7",
      hunk: "36"
    };
    UNCOLORED_TONES = { addMark: "7", delMark: "7" };
    LINKABLE = /^https?:\/\/[!-~]+$/;
  }
});

// src/tui/width.ts
function graphemes(text) {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}
function graphemeWidth(grapheme) {
  if (ZERO_WIDTH.test(grapheme)) return 0;
  if (EMOJI.test(grapheme)) return 2;
  const code2 = grapheme.codePointAt(0) ?? 0;
  return WIDE_RANGES.some(([low, high]) => code2 >= low && code2 <= high) ? 2 : 1;
}
function displayWidth(text) {
  if (/^[\x20-\x7e]*$/.test(text)) return text.length;
  let width = 0;
  for (const grapheme of graphemes(text)) width += graphemeWidth(grapheme);
  return width;
}
var segmenter, ZERO_WIDTH, EMOJI, WIDE_RANGES;
var init_width = __esm({
  "src/tui/width.ts"() {
    "use strict";
    segmenter = new Intl.Segmenter(void 0, { granularity: "grapheme" });
    ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]+$/u;
    EMOJI = new RegExp("\\p{Emoji_Presentation}|\uFE0F|\\p{Regional_Indicator}", "u");
    WIDE_RANGES = [
      [4352, 4447],
      [11904, 12350],
      [12353, 13311],
      [13312, 19903],
      [19968, 40959],
      [40960, 42191],
      [44032, 55203],
      [63744, 64255],
      [65072, 65103],
      [65280, 65376],
      [65504, 65510],
      [131072, 262141]
    ];
  }
});

// src/tui/editor.ts
var NoteText;
var init_editor = __esm({
  "src/tui/editor.ts"() {
    "use strict";
    init_width();
    NoteText = class {
      text;
      /** An offset into text, always on a character boundary. */
      cursor;
      constructor(text = "") {
        this.text = text;
        this.cursor = text.length;
      }
      get isBlank() {
        return !this.text.trim();
      }
      insert(text) {
        this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
        this.cursor += text.length;
      }
      backspace() {
        const start = this.#previousBoundary();
        this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
        this.cursor = start;
      }
      deleteForward() {
        this.text = this.text.slice(0, this.cursor) + this.text.slice(this.#nextBoundary());
      }
      /** Ctrl+W: deletes back to the start of the word, and the spaces after it. */
      deleteWord() {
        const before = this.text.slice(0, this.cursor);
        const start = before.replace(/\S*\s*$/, "").length;
        this.text = before.slice(0, start) + this.text.slice(this.cursor);
        this.cursor = start;
      }
      left() {
        this.cursor = this.#previousBoundary();
      }
      right() {
        this.cursor = this.#nextBoundary();
      }
      /** Start and end of the current line of text, not of the wrapped row. */
      home() {
        this.cursor = this.text.lastIndexOf("\n", this.cursor - 1) + 1;
      }
      end() {
        const newline = this.text.indexOf("\n", this.cursor);
        this.cursor = newline < 0 ? this.text.length : newline;
      }
      /** Moves to the row above or below in the wrapped layout, keeping the column where it can. */
      vertical(direction, width) {
        const { cursorRow, cursorColumn } = this.layout(width);
        const cells = this.#cells(width)[cursorRow + direction];
        if (!cells) {
          this.cursor = direction < 0 ? 0 : this.text.length;
          return;
        }
        let best = cells.offsets[0];
        cells.columns.forEach((column, i) => {
          if (column <= cursorColumn) best = cells.offsets[i];
        });
        this.cursor = best;
      }
      layout(width) {
        const cells = this.#cells(width);
        const rows = [];
        let cursorRow = 0;
        let cursorColumn = 0;
        cells.forEach((row, r) => {
          const start = row.offsets[0];
          const end = row.offsets[row.offsets.length - 1];
          rows.push(this.text.slice(start, end));
          const at2 = row.offsets.indexOf(this.cursor);
          if (at2 >= 0 && !(at2 === row.offsets.length - 1 && cells[r + 1]?.offsets[0] === this.cursor)) {
            cursorRow = r;
            cursorColumn = row.columns[at2];
          }
        });
        if (cursorColumn >= width) {
          rows.splice(cursorRow + 1, 0, "");
          cursorRow += 1;
          cursorColumn = 0;
        }
        return { rows, cursorRow, cursorColumn };
      }
      #cells(width) {
        const limit = Math.max(1, width);
        const rows = [];
        let offset = 0;
        for (const line of this.text.split("\n")) {
          let row = { offsets: [offset], columns: [0] };
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
          offset += 1;
        }
        return rows;
      }
      #previousBoundary() {
        let previous = 0;
        let offset = 0;
        for (const grapheme of graphemes(this.text)) {
          if (offset >= this.cursor) break;
          previous = offset;
          offset += grapheme.length;
        }
        return this.cursor === 0 ? 0 : previous;
      }
      #nextBoundary() {
        let offset = 0;
        for (const grapheme of graphemes(this.text)) {
          offset += grapheme.length;
          if (offset > this.cursor) return offset;
        }
        return this.text.length;
      }
    };
  }
});

// src/tui/lines.ts
var PLAIN;
var init_lines = __esm({
  "src/tui/lines.ts"() {
    "use strict";
    PLAIN = {};
  }
});

// src/tui/wrap.ts
function spansWidth(spans) {
  return spans.reduce((width, span) => width + displayWidth(span.text), 0);
}
function wrapSpans(spans, width, mode = "words") {
  const limit = Math.max(1, width);
  const lines = [[]];
  let column = 0;
  const push = (text, style) => {
    const line = lines[lines.length - 1];
    const last = line[line.length - 1];
    if (last && last.style === style) last.text += text;
    else line.push({ text, style });
  };
  const newLine = () => {
    trimEnd(lines[lines.length - 1]);
    lines.push([]);
    column = 0;
  };
  for (const span of spans) {
    for (const piece of span.text.match(mode === "words" ? WORDS : RUNS) ?? []) {
      if (piece === "\n") {
        newLine();
        continue;
      }
      const width2 = displayWidth(piece);
      if (mode === "words" && piece[0] === " ") {
        if (column === 0) continue;
        if (column + width2 > limit) newLine();
        else {
          push(piece, span.style);
          column += width2;
        }
        continue;
      }
      if (column + width2 <= limit) {
        push(piece, span.style);
        column += width2;
        continue;
      }
      if (mode === "words" && width2 <= limit) {
        newLine();
        push(piece, span.style);
        column = width2;
        continue;
      }
      for (const grapheme of graphemes(piece)) {
        const size = graphemeWidth(grapheme);
        if (column + size > limit && column > 0) newLine();
        push(grapheme, span.style);
        column += size;
      }
    }
  }
  trimEnd(lines[lines.length - 1]);
  return lines;
}
function trimEnd(line) {
  while (line.length) {
    const last = line[line.length - 1];
    last.text = last.text.replace(/ +$/, "");
    if (last.text) return;
    line.pop();
  }
}
function clipSpans(spans, width) {
  if (spansWidth(spans) <= width) return [...spans];
  const out = [];
  let column = 0;
  for (const span of spans) {
    let text = "";
    for (const grapheme of graphemes(span.text)) {
      const size = graphemeWidth(grapheme);
      if (column + size > width - 1) {
        if (text) out.push({ text, style: span.style });
        out.push({ text: "\u2026", style: span.style });
        return out;
      }
      text += grapheme;
      column += size;
    }
    if (text) out.push({ text, style: span.style });
  }
  return out;
}
var WORDS, RUNS;
var init_wrap = __esm({
  "src/tui/wrap.ts"() {
    "use strict";
    init_width();
    WORDS = /\n| +|[^ \n]+/g;
    RUNS = /\n|[^\n]+/g;
  }
});

// src/tui/feed.ts
function buildFeed(model, options) {
  const margin = options.width >= MARGIN_MIN_WIDTH;
  const leftWidth = margin ? options.width - MARGIN_WIDTH - MARGIN_GAP : options.width;
  const view = { rows: [], targets: [], replyStarts: /* @__PURE__ */ new Map(), leftWidth };
  for (const response of model.responses) {
    if (view.rows.length) view.rows.push(emptyRow());
    view.replyStarts.set(response.id, view.rows.length);
    const onlyAnswers = !response.text.trim() && Object.keys(response.note_answers).length > 0;
    if (onlyAnswers) addAnswered(model, response, view, `${formatTime(response.created_at)} `);
    else addReply(model, response, view, { ...options, margin, leftWidth });
  }
  view.targets.sort((a3, b) => a3.start - b.start || (a3.side === "left" ? -1 : 1));
  return view;
}
function addReply(model, response, view, layout) {
  const { rows, targets } = view;
  const rendered = layout.render(response, layout.leftWidth);
  const notes = model.notes.filter((note) => note.response_id === response.id);
  const roots = notes.filter((note) => note.parent_id === null).sort((a3, b) => a3.created_at - b.created_at);
  const blockOf = (note) => note.block_index < rendered.blocks.length ? note.block_index : -1;
  const byBlock = /* @__PURE__ */ new Map();
  for (const root of roots) byBlock.set(blockOf(root), [...byBlock.get(blockOf(root)) ?? [], root]);
  const headerRow = rows.length;
  rows.push({ left: replyHeader(response, notes, roots.length, layout.leftWidth), right: [] });
  targets.push({
    key: `r:${response.id}`,
    kind: "reply",
    responseId: response.id,
    block: -1,
    start: headerRow,
    end: headerRow + 1,
    side: "left",
    code: false,
    quote: ""
  });
  const lastLine = /* @__PURE__ */ new Map();
  rendered.lines.forEach((line, i) => {
    if (line.block >= 0) lastLine.set(line.block, i);
  });
  const firstRow = /* @__PURE__ */ new Map();
  let run2 = null;
  const runCounts = /* @__PURE__ */ new Map();
  const closeRun = () => {
    if (!run2) return;
    const id = `${response.id}:${run2.block}:${run2.file ?? ""}`;
    const count = runCounts.get(id) ?? 0;
    runCounts.set(id, count + 1);
    const info = rendered.blocks[run2.block];
    targets.push({
      key: `b:${id}:${count}`,
      kind: "block",
      responseId: response.id,
      block: run2.block,
      ...run2.file !== void 0 && rendered.foldable ? { file: run2.file } : {},
      start: run2.start,
      end: rows.length,
      side: "left",
      code: info.code,
      quote: info.code ? run2.rows.map(codeQuoteLine).join("\n") : info.quote
    });
    run2 = null;
  };
  let file;
  let previousBlock = -1;
  rendered.lines.forEach((line, i) => {
    if (line.block !== previousBlock) file = void 0;
    previousBlock = line.block;
    if (line.file !== void 0) file = line.file;
    if (line.block < 0) closeRun();
    else if (!run2 || run2.block !== line.block || run2.file !== file) {
      closeRun();
      run2 = { block: line.block, file, start: rows.length, rows: [] };
    }
    if (line.block >= 0 && !firstRow.has(line.block)) firstRow.set(line.block, rows.length);
    run2?.rows.push(line.spans.map((span) => span.text).join(""));
    rows.push({ left: line.spans, right: [] });
    if (!layout.margin && line.block >= 0 && lastLine.get(line.block) === i && byBlock.has(line.block)) {
      closeRun();
      for (const root of byBlock.get(line.block)) addInlineNote(model, root, view, layout);
    }
  });
  closeRun();
  if (layout.margin) {
    let nextFree = headerRow;
    const placed = roots.map((root) => ({ root, wanted: blockOf(root) < 0 ? headerRow : firstRow.get(blockOf(root)) ?? headerRow })).sort((a3, b) => a3.wanted - b.wanted || a3.root.created_at - b.root.created_at);
    for (const { root, wanted } of placed) {
      const at2 = Math.max(wanted, nextFree);
      const box = noteBox(model, root, MARGIN_WIDTH, `n:${root.id}` === layout.selectedKey);
      while (rows.length < at2 + box.length) rows.push(emptyRow());
      box.forEach((spans, k) => rows[at2 + k].right = spans);
      targets.push(noteTarget(root, response.id, blockOf(root), at2, at2 + box.length, "right"));
      nextFree = at2 + box.length + 1;
    }
  } else {
    for (const root of byBlock.get(-1) ?? []) addInlineNote(model, root, view, layout);
  }
  addAnswered(model, response, view, "");
}
function addInlineNote(model, root, view, layout) {
  const box = noteBox(model, root, layout.leftWidth - INLINE_INDENT, `n:${root.id}` === layout.selectedKey);
  const start = view.rows.length;
  for (const spans of box)
    view.rows.push({ left: [{ text: " ".repeat(INLINE_INDENT), style: PLAIN }, ...spans], right: [] });
  view.targets.push(noteTarget(root, root.response_id, root.block_index, start, view.rows.length, "left"));
}
function noteTarget(root, responseId, block, start, end, side) {
  return {
    key: `n:${root.id}`,
    kind: "note",
    responseId,
    block,
    rootId: root.id,
    start,
    end,
    side,
    code: false,
    quote: root.quote
  };
}
function addAnswered(model, response, view, prefix) {
  const rootIds = /* @__PURE__ */ new Set();
  const noteIds = answeredNoteIds(model, response);
  for (const id of noteIds) {
    const note = model.note(id);
    const rootId = note && (note.parent_id ?? note.id);
    if (rootId !== void 0 && model.note(rootId)) rootIds.add(rootId);
  }
  if (!rootIds.size) return;
  view.rows.push({
    left: [{ text: `${prefix}\u21B3 Claude answered ${plural(noteIds.size, "note", "notes")}`, style: MUTED }],
    right: []
  });
  for (const rootId of rootIds) {
    const start = view.rows.length;
    const body = terminalSafe(model.note(rootId).body).replace(/\s+/g, " ");
    view.rows.push({
      left: oneLine(
        [
          { text: "  \u203A ", style: MUTED },
          { text: body, style: PLAIN }
        ],
        view.leftWidth
      ),
      right: []
    });
    view.targets.push({
      key: `a:${response.id}:${rootId}`,
      kind: "answer",
      responseId: response.id,
      block: -1,
      rootId,
      start,
      end: start + 1,
      side: "left",
      code: false,
      quote: ""
    });
  }
}
function replyHeader(response, notes, roots, width) {
  const pending = notes.filter((note) => note.delivered_at === null).length;
  const spans = [{ text: `\u2500\u2500 ${formatTime(response.created_at)}`, style: MUTED }];
  if (roots) spans.push({ text: ` \xB7 ${plural(roots, "note", "notes")}`, style: MUTED });
  if (pending) spans.push({ text: ` \xB7 ${pending} pending`, style: { tone: "accent" } });
  const used = spansWidth(spans) + 1;
  if (used < width) spans.push({ text: ` ${"\u2500".repeat(width - used)}`, style: MUTED });
  return spans;
}
function noteBox(model, root, width, selected) {
  const thread = model.thread(root.id);
  const pending = thread.some((note) => note.delivered_at === null);
  const inner = Math.max(8, width - 2);
  const rows = [];
  if (root.quote) {
    const quote = terminalSafe(root.quote).replace(/\s+/g, " ");
    rows.push(oneLine([{ text: `\u275D ${quote}`, style: { tone: "muted", italic: true } }], inner));
  }
  const body = wrapSpans([{ text: terminalSafe(root.body), style: selected ? { bold: true } : PLAIN }], inner);
  rows.push(...limitRows(body, NOTE_BODY_ROWS, inner));
  const answer2 = thread.map((note) => model.answerText(note)).findLast(Boolean);
  if (answer2) {
    const snippet = [
      { text: "Claude ", style: { bold: true } },
      { text: terminalSafe(plainText(answer2)), style: MUTED }
    ];
    rows.push(...limitRows(wrapSpans(snippet, inner), NOTE_ANSWER_ROWS, inner));
  }
  const queued = thread.some((note) => model.isQueued(note));
  const lastSent = Math.max(...thread.map((note) => note.delivered_at ?? 0));
  const status = queued ? "Sending\u2026" : pending ? "Pending" : `Sent ${formatTime(lastSent)}`;
  const replies = new Set(thread.filter(isAnswered).map((note) => note.answered_by)).size + thread.length - 1;
  const footer = replies ? `${status} \xB7 ${plural(replies, "reply", "replies")}` : status;
  rows.push([{ text: footer, style: pending ? { tone: "accent" } : MUTED }]);
  const bar = {
    text: selected ? "\u2503 " : "\u2502 ",
    style: selected ? { tone: "accent", bold: true } : { tone: pending ? "accent" : "muted" }
  };
  return rows.map((spans) => [bar, ...spans]);
}
function emptyRow() {
  return { left: [], right: [] };
}
function oneLine(spans, width) {
  return limitRows(wrapSpans(spans, width), 1, width)[0] ?? [];
}
function limitRows(rows, max, width) {
  if (rows.length <= max) return rows;
  const kept = rows.slice(0, max);
  const last = kept[max - 1];
  while (last.length && spansWidth(last) > width - 1) {
    const span = last[last.length - 1];
    const chars = graphemes(span.text);
    const removed = chars.pop() ?? "";
    span.text = chars.join("");
    if (!span.text) last.pop();
    if (!removed || graphemeWidth(removed) === 0) break;
  }
  last.push({ text: "\u2026", style: last[last.length - 1]?.style ?? PLAIN });
  return kept;
}
function codeQuoteLine(row) {
  return row.replace(/^(?:[│┆] |[▾▸] )/, "");
}
var MARGIN_MIN_WIDTH, MARGIN_WIDTH, MARGIN_GAP, INLINE_INDENT, NOTE_BODY_ROWS, NOTE_ANSWER_ROWS, MUTED;
var init_feed = __esm({
  "src/tui/feed.ts"() {
    "use strict";
    init_model();
    init_text();
    init_lines();
    init_sanitize();
    init_width();
    init_wrap();
    MARGIN_MIN_WIDTH = 110;
    MARGIN_WIDTH = 36;
    MARGIN_GAP = 3;
    INLINE_INDENT = 2;
    NOTE_BODY_ROWS = 4;
    NOTE_ANSWER_ROWS = 2;
    MUTED = { tone: "muted" };
  }
});

// node_modules/marked/lib/marked.esm.js
function v() {
  return { async: false, breaks: false, extensions: null, gfm: true, hooks: null, pedantic: false, renderer: null, silent: false, tokenizer: null, walkTokens: null };
}
function ee(a3) {
  y = a3;
}
function I(a3) {
  let e = [];
  return (t) => {
    let n = Math.max(0, Math.min(3, t - 1)), s = e[n];
    return s || (s = a3(n), e[n] = s), s;
  };
}
function c(a3, e = "") {
  let t = typeof a3 == "string" ? a3 : a3.source, n = { replace: (s, r) => {
    let o = typeof r == "string" ? r : r.source;
    return o = o.replace(T.caret, "$1"), t = t.replace(s, o), n;
  }, getRegex: () => new RegExp(t, e) };
  return n;
}
function P(a3, e) {
  if (e) {
    if (T.escapeTest.test(a3)) return a3.replace(T.escapeReplace, ye);
  } else if (T.escapeTestNoEncode.test(a3)) return a3.replace(T.escapeReplaceNoEncode, ye);
  return a3;
}
function Se(a3) {
  return T.numericCharacterReference.test(a3) ? a3.replace(T.numericCharacterReferenceOrAmpersand, (e, t, n) => {
    if (t === void 0 && n === void 0) return "&amp;";
    let s = t === void 0 ? Number.parseInt(n, 16) : Number.parseInt(t, 10);
    return s === 0 || s > 1114111 || s >= 55296 && s <= 57343 ? "\uFFFD" : s === 38 ? "&amp;" : String.fromCodePoint(s);
  }) : a3;
}
function le(a3) {
  try {
    a3 = encodeURI(a3).replace(T.percentDecode, "%");
  } catch {
    return null;
  }
  return a3;
}
function ue(a3, e) {
  let t = a3.replace(T.findPipe, (r, o, i) => {
    let l = false, u = o;
    for (; --u >= 0 && i[u] === "\\"; ) l = !l;
    return l ? "|" : " |";
  }), n = t.split(T.splitPipe), s = 0;
  if (n[0].trim() || n.shift(), n.length > 0 && !n.at(-1)?.trim() && n.pop(), e) if (n.length > e) n.splice(e);
  else for (; n.length < e; ) n.push("");
  for (; s < n.length; s++) n[s] = n[s].trim().replace(T.slashPipe, "|");
  return n;
}
function z(a3, e, t) {
  let n = a3.length;
  if (n === 0) return "";
  let s = 0;
  for (; s < n; ) {
    let r = a3.charAt(n - s - 1);
    if (r === e && !t) s++;
    else if (r !== e && t) s++;
    else break;
  }
  return a3.slice(0, n - s);
}
function pe(a3) {
  let e = a3.split(`
`), t = e.length - 1;
  for (; t >= 0 && T.blankLine.test(e[t]); ) t--;
  return e.length - t <= 2 ? a3 : e.slice(0, t + 1).join(`
`);
}
function N(a3) {
  return a3.trim().toLowerCase().toUpperCase().toLowerCase();
}
function ce(a3, e) {
  if (a3.indexOf(e[0]) === -1 && a3.indexOf(e[1]) === -1) return -1;
  let t = 0;
  for (let n = 0; n < a3.length; n++) if (a3[n] === "\\") n++;
  else if (a3[n] === e[0]) t++;
  else if (a3[n] === e[1] && (t--, t < 0)) return n;
  return t > 0 ? -2 : -1;
}
function V(a3, e = 0) {
  let t = e, n = "";
  for (let s of a3) if (s === "	") {
    let r = 4 - t % 4;
    n += " ".repeat(r), t += r;
  } else n += s, t++;
  return n;
}
function _e(a3, e, t, n, s) {
  let r = e.href, o = e.title || null, i = a3[1].replace(s.other.outputLinkReplace, "$1"), l = a3[0].charAt(0) === "!", u = n.state.inLink, h = n.state.linkEmitted, p = n.state.inRawBlock;
  n.state.inLink = true, n.state.linkEmitted = false;
  let d = n.inlineTokens(i), g = n.state.linkEmitted;
  if (n.state.linkEmitted = h, n.state.inLink = u, !l) {
    if (g) {
      n.state.inRawBlock = p;
      return;
    }
    n.state.linkEmitted = true;
  }
  return { type: l ? "image" : "link", raw: t, href: r, title: o, text: i, tokens: d };
}
function At(a3, e, t) {
  let n = a3.match(t.other.indentCodeCompensation);
  if (n === null) return e;
  let s = n[1];
  return e.split(`
`).map((r) => {
    let o = r.match(t.other.beginningSpace);
    if (o === null) return r;
    let [i] = o;
    return r.slice(Math.min(i.length, s.length));
  }).join(`
`);
}
function $e(a3, e, t, n) {
  if (!e.includes("<")) return false;
  for (let s = 0; s < e.length; s++) {
    if (e[s] === "\\") {
      s++;
      continue;
    }
    if (e[s] === "`") {
      let i = n.inline.code.exec(e.slice(s));
      if (i) {
        s += i[0].length - 1;
        continue;
      }
    }
    if (e[s] !== "<") continue;
    let r = a3.slice(t + s), o = n.inline.tag.exec(r) || n.inline.autolink.exec(r);
    if (o) {
      if (o[0].length > e.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}
function D(a3, e) {
  if (Array.isArray(e)) for (let t = 0; t < e.length; t++) a3.push(e[t]);
  else a3.push(e);
}
function m(a3, e) {
  return q.parse(a3, e);
}
function zt(...a3) {
  return q.use(...a3), m.defaults = q.defaults, ee(m.defaults), m;
}
var y, B, Me, T, Ce, Ee, Ie, U, Be, ne, me, xe, De, re, qe, se, Ze, ve, K, ie, He, be, Ge, Ne, Qe, oe, ke, je, Fe, Ue, Ke, Re, We, $, H, W, Xe, Ve, Te, Je, Ye, et, Oe, tt, nt, rt, st, we, it, ot, at, lt, ut, pt, ct, ht, dt, kt, gt, ft, mt, xt, bt, Pe, Y, Rt, Tt, Ot, ge, wt, Pt, fe, yt, St, ae, _t, te, $t, X, G, Lt, ye, _, O, L, M, w, A, J, q, Tn, On, wn, Pn, Sn, _n;
var init_marked_esm = __esm({
  "node_modules/marked/lib/marked.esm.js"() {
    y = v();
    B = { exec: () => null };
    Me = ((a3 = "") => {
      try {
        return !!new RegExp("(?<=1)(?<!1)" + a3);
      } catch {
        return false;
      }
    })();
    T = { codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm, outputLinkReplace: /\\([\[\]])/g, indentCodeCompensation: /^(\s+)(?:```)/, beginningSpace: /^\s+/, endingHash: /#$/, startingSpaceChar: /^ /, endingSpaceChar: / $/, endingSpaceTabChar: /[ \t]$/, nonSpaceChar: /[^ ]/, newLineCharGlobal: /\n/g, tabCharGlobal: /\t/g, leadingSpaceTab: /^[ \t]+/, multipleSpaceGlobal: /\s+/g, blankLine: /^[ \t]*$/, doubleBlankLine: /\n[ \t]*\n[ \t]*$/, blockquoteStart: /^ {0,3}>/, blockquoteSetextReplace: /\n {0,3}((?:=+|-+) *)(?=\n|$)/g, blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm, blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm, listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g, listIsTask: /^\[[ xX]\] +\S/, listReplaceTask: /^\[[ xX]\] +/, listTaskCheckbox: /\[[ xX]\]/, anyLine: /\n.*\n/, hrefBrackets: /^<(.*)>$/, tableDelimiter: /[:|]/, tableAlignChars: /^\||\| *$/g, tableRowBlankLine: /\n[ \t]*$/, tableAlignRight: /^ *-+: *$/, tableAlignCenter: /^ *:-+: *$/, tableAlignLeft: /^ *:-+ *$/, startATag: /^<a /i, endATag: /^<\/a>/i, startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i, endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i, startAngleBracket: /^</, endAngleBracket: />$/, pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/, unicodeAlphaNumeric: /[\p{L}\p{N}]/u, numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/, numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, escapeTest: /[&<>"']/, escapeReplace: /[&<>"']/g, escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/, escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, caret: /(^|[^\[])\^/g, percentDecode: /%25/g, findPipe: /\|/g, splitPipe: / \|/, slashPipe: /\\\|/g, carriageReturn: /\r\n|\r/g, spaceLine: /^ +$/gm, notSpaceStart: /^\S*/, endingNewline: /\n$/, listItemRegex: (a3) => new RegExp(`^( {0,3}${a3})((?:[	 ][^\\n]*)?(?:\\n|$))`), nextBulletRegex: I((a3) => new RegExp(`^ {0,${a3}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`)), hrRegex: I((a3) => new RegExp(`^ {0,${a3}}((?:-[ 	]*){3,}|(?:_[ 	]*){3,}|(?:\\*[ 	]*){3,})(?:\\n+|$)`)), fencesBeginRegex: I((a3) => new RegExp(`^ {0,${a3}}(?:\`\`\`|~~~)`)), headingBeginRegex: I((a3) => new RegExp(`^ {0,${a3}}#{1,6}(?:\\s|$)`)), pedanticHeadingBeginRegex: I((a3) => new RegExp(`^ {0,${a3}}#`)), htmlBeginRegex: I((a3) => new RegExp(`^ {0,${a3}}(?:</?(?:${K})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, "i")), blockquoteBeginRegex: I((a3) => new RegExp(`^ {0,${a3}}>`)) };
    Ce = /^(?:[ \t]*(?:\n|$))+/;
    Ee = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
    Ie = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/;
    U = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
    Be = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
    ne = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
    me = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/;
    xe = c(me).replace(/bull/g, ne).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/).replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/\|table/g, "").getRegex();
    De = c(me).replace(/bull/g, ne).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/).replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex();
    re = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
    qe = /^[^\n]+/;
    se = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/;
    Ze = c(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label", se).replace("title", /(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex();
    ve = c(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, ne).getRegex();
    K = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
    ie = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
    He = c("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))", "i").replace("comment", ie).replace("tag", K).replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex();
    be = (a3) => c(re).replace("hr", U).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("|table", "").replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", a3).replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", K).getRegex();
    Ge = be(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
    Ne = be(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
    Qe = c(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace("paragraph", Ne).getRegex();
    oe = { blockquote: Qe, code: Ee, def: Ze, fences: Ie, heading: Be, hr: U, html: He, lheading: xe, list: ve, newline: Ce, paragraph: Ge, table: B, text: qe };
    ke = c("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr", U).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("blockquote", " {0,3}>").replace("code", "(?: {4}| {0,3}	)[^\\n]").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", K).getRegex();
    je = { ...oe, lheading: De, table: ke, paragraph: c(re).replace("hr", U).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("table", ke).replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]").replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", K).getRegex() };
    Fe = { ...oe, html: c(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment", ie).replace(/tag/g, "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(), def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/, heading: /^(#{1,6})(.*)(?:\n+|$)/, fences: B, lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/, paragraph: c(re).replace("hr", U).replace("heading", ` *#{1,6} *[^
]`).replace("lheading", xe).replace("|table", "").replace("blockquote", " {0,3}>").replace("|fences", "").replace("|list", "").replace("|html", "").replace("|tag", "").getRegex() };
    Ue = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
    Ke = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
    Re = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
    We = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
    $ = /[\p{P}\p{S}]/u;
    H = /[\s\p{P}\p{S}]/u;
    W = /[^\s\p{P}\p{S}]/u;
    Xe = c(/^((?![*_])punctSpace)/, "u").replace(/punctSpace/g, H).getRegex();
    Ve = /[\p{Pi}\p{Ps}"']/u;
    Te = /(?!~)[\p{P}\p{S}]/u;
    Je = /(?!~)[\s\p{P}\p{S}]/u;
    Ye = /(?:[^\s\p{P}\p{S}]|~)/u;
    et = c(/link|precode-code|html/, "g").replace("link", /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-", Me ? "(?<!`)()" : "(^^|[^`])").replace("code", /(?<b>`+)[^`]+\k<b>(?!`)/).replace("html", /<(?! )[^<>]*?>/).getRegex();
    Oe = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
    tt = c(Oe, "u").replace(/punct/g, $).getRegex();
    nt = c(Oe, "u").replace(/punct/g, Te).getRegex();
    rt = /^(?:\*+(?:((?!\*)(?!openQuote)punct)|([^\s*]))?)|^_+(?:((?!_)(?!openQuote)punct)|([^\s_]))?/;
    st = c(rt, "u").replace(/openQuote/g, Ve).replace(/punct/g, $).getRegex();
    we = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
    it = c(we, "gu").replace(/notPunctSpace/g, W).replace(/punctSpace/g, H).replace(/punct/g, $).getRegex();
    ot = c(we, "gu").replace(/notPunctSpace/g, Ye).replace(/punctSpace/g, Je).replace(/punct/g, Te).getRegex();
    at = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)[\\s](\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|(?:(?!\\*)punct|notPunctSpace)(\\*+)(?!\\*)(?=notPunctSpace)";
    lt = c(at, "gu").replace(/notPunctSpace/g, W).replace(/punctSpace/g, H).replace(/punct/g, $).getRegex();
    ut = c("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)", "gu").replace(/notPunctSpace/g, W).replace(/punctSpace/g, H).replace(/punct/g, $).getRegex();
    pt = "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)[\\s](_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)|(?:(?!_)punct|notPunctSpace)(_+)(?!_)(?=notPunctSpace)";
    ct = c(pt, "gu").replace(/notPunctSpace/g, W).replace(/punctSpace/g, H).replace(/punct/g, $).getRegex();
    ht = c(/^~~?(?:((?!~)punct)|[^\s~])/, "u").replace(/punct/g, $).getRegex();
    dt = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
    kt = c(dt, "gu").replace(/notPunctSpace/g, W).replace(/punctSpace/g, H).replace(/punct/g, $).getRegex();
    gt = c(/\\(punct)/, "gu").replace(/punct/g, $).getRegex();
    ft = c(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, "gu").replace(/punct/g, $).getRegex();
    mt = c(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email", /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex();
    xt = c(ie).replace("(?:-->|$)", "-->").getRegex();
    bt = c("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment", xt).replace("attribute", /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex();
    Pe = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
    Y = c(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace("brackets", Pe).getRegex();
    Rt = c(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/).replace("label", Y).replace("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/).replace("title", /"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex();
    Tt = c(/^!?\[(label)\]\[(ref)\]/).replace("label", Y).replace("ref", se).getRegex();
    Ot = c(/^!?\[(ref)\](?:\[\])?/).replace("ref", se).getRegex();
    ge = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
    wt = c(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace("brackets", Pe).getRegex();
    Pt = c("reflink|nolink(?!\\()", "g").replace("reflink", c(/^!?\[(label)\]\[(ref)\]/).replace("label", wt).replace("ref", ge).getRegex()).replace("nolink", c(/^!?\[(ref)\](?:\[\])?/).replace("ref", ge).getRegex()).getRegex();
    fe = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
    yt = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
    St = c(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, yt).getRegex();
    ae = { _backpedal: B, anyPunctuation: gt, anyPunctuationOutsideCode: ft, autolink: mt, blockSkip: et, br: Re, code: Ke, del: B, delLDelim: B, delRDelim: B, emStrongLDelim: tt, emStrongRDelimAst: it, emStrongRDelimUnd: ut, escape: Ue, link: Rt, nolink: Ot, punctuation: Xe, reflink: Tt, reflinkSearch: Pt, tag: bt, text: We, url: B };
    _t = { ...ae, emStrongLDelim: st, emStrongRDelimAst: lt, emStrongRDelimUnd: ct, link: c(/^!?\[(label)\]\((.*?)\)/).replace("label", Y).getRegex(), reflink: c(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label", Y).getRegex() };
    te = { ...ae, emStrongRDelimAst: ot, emStrongLDelim: nt, delLDelim: ht, delRDelim: kt, url: c(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("emailProtocol", St).replace("protocol", fe).replace("email", /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).getRegex(), _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/, del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/, text: c(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/).replace("protocol", fe).replace(/emailProtocol/g, /(?:mailto|xmpp):/).getRegex() };
    $t = { ...te, br: c(Re).replace("{2,}", "*").getRegex(), text: c(te.text).replace("\\b_", "\\b_| {2,}\\n").replace(/\{2,\}/g, "*").getRegex() };
    X = { normal: oe, gfm: je, pedantic: Fe };
    G = { normal: ae, gfm: te, breaks: $t, pedantic: _t };
    Lt = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    ye = (a3) => Lt[a3];
    _ = class {
      options;
      rules;
      lexer;
      constructor(e) {
        this.options = e || y;
      }
      space(e) {
        let t = this.rules.block.newline.exec(e);
        if (t && t[0].length > 0) return { type: "space", raw: t[0] };
      }
      code(e) {
        let t = this.rules.block.code.exec(e);
        if (t) {
          let n = this.options.pedantic ? t[0] : pe(t[0]), s = n.replace(this.rules.other.codeRemoveIndent, "");
          return { type: "code", raw: n, codeBlockStyle: "indented", text: s };
        }
      }
      fences(e) {
        let t = this.rules.block.fences.exec(e);
        if (t) {
          let n = t[0], s = At(n, t[3] || "", this.rules);
          return { type: "code", raw: n, lang: t[2] ? t[2].trim().replace(this.rules.inline.anyPunctuation, "$1") : t[2], text: s };
        }
      }
      heading(e) {
        let t = this.rules.block.heading.exec(e);
        if (t) {
          let n = t[2].trim();
          if (this.rules.other.endingHash.test(n)) {
            let s = z(n, "#");
            (this.options.pedantic || !s || this.rules.other.endingSpaceTabChar.test(s)) && (n = s.trim());
          }
          return { type: "heading", raw: z(t[0], `
`), depth: t[1].length, text: n, tokens: this.lexer.inline(n) };
        }
      }
      hr(e) {
        let t = this.rules.block.hr.exec(e);
        if (t) return { type: "hr", raw: z(t[0], `
`) };
      }
      blockquote(e) {
        let t = this.rules.block.blockquote.exec(e);
        if (t) {
          let n = z(t[0], `
`).split(`
`), s = "", r = "", o = [];
          for (; n.length > 0; ) {
            let i = false, l = [], u;
            for (u = 0; u < n.length; u++) if (this.rules.other.blockquoteStart.test(n[u])) l.push(n[u]), i = true;
            else if (!i) l.push(n[u]);
            else break;
            n = n.slice(u);
            let h = l.join(`
`), p = h.replace(this.rules.other.blockquoteMarkerWhitespace, (k, b, x) => b + V(x, b.length)).replace(this.rules.other.blockquoteSetextReplace, `
    $1`).replace(this.rules.other.blockquoteSetextReplace2, "");
            s = s ? `${s}
${h}` : h, r = r ? `${r}
${p}` : p;
            let d = this.lexer.state.top;
            if (this.lexer.state.top = true, this.lexer.blockTokens(p, o, true), this.lexer.state.top = d, n.length === 0) break;
            let g = o.at(-1);
            if (g?.type === "code" || g?.type === "heading" || g?.type === "hr" || g?.type === "html") break;
            if (g?.type === "blockquote") {
              let k = g, b = n.join(`
`), x = k.raw + `
` + b.replace(this.rules.other.blockquoteSetextReplace2, ""), f = this.blockquote(x);
              o[o.length - 1] = f;
              let S = x.substring(f.raw.length).replace(/^\n/, ""), R = S ? S.split(`
`).length : 0, C = R ? n.slice(0, -R) : n;
              C.length > 0 && (s = `${s}
${C.join(`
`)}`), r = r.substring(0, r.length - k.text.length) + f.text;
              break;
            } else if (g?.type === "list") {
              let k = g, b = k.raw + `
` + n.join(`
`), x = this.list(b);
              o[o.length - 1] = x;
              let f = x.raw.length > k.raw.length ? b.slice(k.raw.length + 1, x.raw.length).split(`
`).length : 0;
              if (f > 0) {
                let S = n.slice(0, f).join(`
`);
                s = `${s}
${S}`, r = `${r}
${S}`;
              }
              n = n.slice(f);
              continue;
            }
          }
          return { type: "blockquote", raw: s, tokens: o, text: r };
        }
      }
      list(e) {
        let t = this.rules.block.list.exec(e);
        if (t) {
          let n = e, s = () => n.length - e.length, r = t[1].trim(), o = r.length > 1, i = { type: "list", raw: "", ordered: o, start: o ? +r.slice(0, -1) : "", loose: false, items: [] };
          r = o ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`, this.options.pedantic && (r = o ? r : "[*+-]");
          let l = this.rules.other.listItemRegex(r), u = false;
          for (; e; ) {
            let p = false, d = "";
            if (!(t = l.exec(e)) || this.rules.block.hr.test(e)) break;
            let g = s();
            e = e.substring(t[0].length);
            let k = t[2].split(`
`, 1)[0], b = t[1].length, x = this.options.pedantic ? V(k, b) : k.replace(this.rules.other.leadingSpaceTab, (Q) => V(Q, b)), f = e.split(`
`, 1)[0], S = !x.trim(), R = 0;
            if (this.options.pedantic ? (R = 2, d = x.trimStart()) : S ? R = b + 1 : (R = x.search(this.rules.other.nonSpaceChar), R = R > 4 ? 1 : R, d = x.slice(R), R += b), S && this.rules.other.blankLine.test(f) && (e = e.substring(f.length + 1), p = true), !p) {
              let Q = this.rules.other.nextBulletRegex(R), E = this.rules.other.hrRegex(R), j = this.rules.other.fencesBeginRegex(R), F = this.options.pedantic ? this.rules.other.pedanticHeadingBeginRegex(R) : this.rules.other.headingBeginRegex(R), Le = this.rules.other.htmlBeginRegex(R), Ae = this.rules.other.blockquoteBeginRegex(R);
              for (; e; ) {
                let he = e.split(`
`, 1)[0], Z;
                if (f = he, this.options.pedantic ? (f = f.replace(this.rules.other.listReplaceNesting, "  "), Z = f) : Z = f.replace(this.rules.other.leadingSpaceTab, (de) => V(de)), j.test(f) || F.test(f) || Le.test(f) || Ae.test(f) || Q.test(f) || E.test(f)) break;
                if (Z.search(this.rules.other.nonSpaceChar) >= R || !f.trim()) d += `
` + Z.slice(R);
                else {
                  if (S || x.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4 || j.test(x) || F.test(x) || E.test(x)) break;
                  let ze = !this.options.pedantic && /^ {0,3}(?:=+|-+) *$/.test(f) && this.rules.block.lheading.test(`${x}
${f}`) ? `    ${Z.replace(/^ {0,3}/, "")}` : f;
                  d += `
` + ze;
                }
                S = !f.trim(), e = e.substring(he.length + 1), x = Z.slice(R);
              }
            }
            let C = n.slice(g, s());
            i.loose || (u ? i.loose = true : this.rules.other.doubleBlankLine.test(C) && (u = true)), i.items.push({ type: "list_item", raw: C, task: !!this.options.gfm && this.rules.other.listIsTask.test(d), loose: false, text: d, tokens: [] });
          }
          let h = i.items.at(-1);
          if (h) h.raw = h.raw.trimEnd(), h.text = h.text.trimEnd();
          else return;
          i.raw = n.slice(0, s()).trimEnd();
          for (let p of i.items) if (this.lexer.state.top = false, p.tokens = this.lexer.blockTokens(p.text, []), !i.loose) {
            let d = p.tokens.filter((k) => k.type === "space"), g = d.length > 0 && d.some((k) => this.rules.other.anyLine.test(k.raw));
            i.loose = g;
          }
          for (let p of i.items) {
            let d = p.tokens[0];
            if (p.task && (d?.type === "text" || d?.type === "paragraph")) {
              p.text = p.text.replace(this.rules.other.listReplaceTask, ""), d.raw = d.raw.replace(this.rules.other.listReplaceTask, ""), d.text = d.text.replace(this.rules.other.listReplaceTask, "");
              for (let k = this.lexer.inlineQueue.length - 1; k >= 0; k--) if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[k].src)) {
                this.lexer.inlineQueue[k].src = this.lexer.inlineQueue[k].src.replace(this.rules.other.listReplaceTask, "");
                break;
              }
              let g = this.rules.other.listTaskCheckbox.exec(p.raw);
              if (g) {
                let k = { type: "checkbox", raw: g[0] + " ", checked: g[0] !== "[ ]" };
                p.checked = k.checked, i.loose ? p.tokens[0] && ["paragraph", "text"].includes(p.tokens[0].type) && "tokens" in p.tokens[0] && p.tokens[0].tokens ? (p.tokens[0].raw = k.raw + p.tokens[0].raw, p.tokens[0].text = k.raw + p.tokens[0].text, p.tokens[0].tokens.unshift(k)) : p.tokens.unshift({ type: "paragraph", raw: k.raw, text: k.raw, tokens: [k] }) : p.tokens.unshift(k);
              }
            } else p.task && (p.task = false);
          }
          if (i.loose) for (let p of i.items) {
            p.loose = true;
            for (let d of p.tokens) d.type === "text" && (d.type = "paragraph");
          }
          return i;
        }
      }
      html(e) {
        let t = this.rules.block.html.exec(e);
        if (t) {
          let n = pe(t[0]);
          return { type: "html", block: true, raw: n, pre: t[1] === "pre" || t[1] === "script" || t[1] === "style", text: n };
        }
      }
      def(e) {
        let t = this.rules.block.def.exec(e);
        if (t) {
          if (!this.rules.other.startAngleBracket.test(t[2]) && ce(t[2], "()") !== -1) return;
          let n = N(t[1]).replace(this.rules.other.multipleSpaceGlobal, " "), s = t[2] ? t[2].replace(this.rules.other.hrefBrackets, "$1").replace(this.rules.inline.anyPunctuation, "$1") : "", r = t[3] ? t[3].substring(1, t[3].length - 1).replace(this.rules.inline.anyPunctuation, "$1") : t[3];
          return { type: "def", tag: n, raw: z(t[0], `
`), href: s, title: r };
        }
      }
      table(e) {
        let t = this.rules.block.table.exec(e);
        if (!t || !this.rules.other.tableDelimiter.test(t[2])) return;
        let n = ue(t[1]), s = t[2].replace(this.rules.other.tableAlignChars, "").split("|"), r = t[3]?.trim() ? t[3].replace(this.rules.other.tableRowBlankLine, "").split(`
`) : [], o = { type: "table", raw: z(t[0], `
`), header: [], align: [], rows: [] };
        if (n.length === s.length) {
          for (let i of s) this.rules.other.tableAlignRight.test(i) ? o.align.push("right") : this.rules.other.tableAlignCenter.test(i) ? o.align.push("center") : this.rules.other.tableAlignLeft.test(i) ? o.align.push("left") : o.align.push(null);
          for (let i = 0; i < n.length; i++) o.header.push({ text: n[i], tokens: this.lexer.inline(n[i]), header: true, align: o.align[i] });
          for (let i of r) o.rows.push(ue(i, o.header.length).map((l, u) => ({ text: l, tokens: this.lexer.inline(l), header: false, align: o.align[u] })));
          return o;
        }
      }
      lheading(e) {
        let t = this.rules.block.lheading.exec(e);
        if (t) {
          let n = t[1].trim();
          return { type: "heading", raw: z(t[0], `
`), depth: t[2].charAt(0) === "=" ? 1 : 2, text: n, tokens: this.lexer.inline(n) };
        }
      }
      paragraph(e) {
        let t = this.rules.block.paragraph.exec(e);
        if (t) {
          let n = t[1].charAt(t[1].length - 1) === `
` ? t[1].slice(0, -1) : t[1];
          return { type: "paragraph", raw: t[0], text: n, tokens: this.lexer.inline(n) };
        }
      }
      text(e) {
        let t = this.rules.block.text.exec(e);
        if (t) return { type: "text", raw: t[0], text: t[0], tokens: this.lexer.inline(t[0]) };
      }
      escape(e) {
        let t = this.rules.inline.escape.exec(e);
        if (t) return { type: "escape", raw: t[0], text: t[1] };
      }
      tag(e) {
        let t = this.rules.inline.tag.exec(e);
        if (t) return !this.lexer.state.inLink && this.rules.other.startATag.test(t[0]) ? this.lexer.state.inLink = true : this.lexer.state.inLink && this.rules.other.endATag.test(t[0]) && (this.lexer.state.inLink = false), !this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(t[0]) ? this.lexer.state.inRawBlock = true : this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(t[0]) && (this.lexer.state.inRawBlock = false), { type: "html", raw: t[0], inLink: this.lexer.state.inLink, inRawBlock: this.lexer.state.inRawBlock, block: false, text: t[0] };
      }
      link(e) {
        if (this.lexer.state.linkParenPossible === false) return;
        let t = this.rules.inline.link.exec(e);
        if (t) {
          let n = t[0].charAt(0) === "!" ? 2 : 1;
          if (!this.options.pedantic && $e(e, t[1], n, this.rules)) return;
          let s = t[2].trim();
          if (!this.options.pedantic && this.rules.other.startAngleBracket.test(s)) {
            if (!this.rules.other.endAngleBracket.test(s)) return;
            let i = z(s.slice(0, -1), "\\");
            if ((s.length - i.length) % 2 === 0) return;
          } else {
            let i = ce(t[2], "()");
            if (i === -2) return;
            if (i > -1) {
              let u = (t[0].indexOf("!") === 0 ? 5 : 4) + t[1].length + i;
              t[2] = t[2].substring(0, i), t[0] = t[0].substring(0, u).trim(), t[3] = "";
            }
          }
          let r = t[2], o = "";
          if (this.options.pedantic) {
            let i = this.rules.other.pedanticHrefTitle.exec(r);
            i && (r = i[1], o = i[3]);
          } else o = t[3] ? t[3].slice(1, -1) : "";
          return r = r.trim(), this.rules.other.startAngleBracket.test(r) && (this.options.pedantic && !this.rules.other.endAngleBracket.test(s) ? r = r.slice(1) : r = r.slice(1, -1)), _e(t, { href: r && r.replace(this.rules.inline.anyPunctuation, "$1"), title: o && o.replace(this.rules.inline.anyPunctuation, "$1") }, t[0], this.lexer, this.rules);
        }
      }
      reflink(e, t) {
        let n;
        if ((n = this.rules.inline.reflink.exec(e)) || (n = this.rules.inline.nolink.exec(e))) {
          let s = n[0].charAt(0) === "!" ? 2 : 1;
          if (!this.options.pedantic && $e(e, n[1], s, this.rules)) return;
          let r = (n[2] || n[1]).replace(this.rules.other.multipleSpaceGlobal, " "), o = t[N(r)];
          if (!o) {
            let i = n[0].charAt(0);
            return { type: "text", raw: i, text: i };
          }
          return _e(n, o, n[0], this.lexer, this.rules);
        }
      }
      emStrong(e, t, n = "") {
        let s = this.rules.inline.emStrongLDelim.exec(e);
        if (!s || !s[1] && !s[2] && !s[3] && !s[4]) return;
        let r = s[0][0], o = n === r, i = t.length - e.length, l = i;
        for (; !this.options.pedantic && l > 0 && t[l - 1] === r; ) l--;
        let u = [...t.slice(Math.max(0, l - 2), l)].at(-1) ?? "", h = u === "*" || u === "_" || !!this.rules.inline.punctuation.exec(u);
        l < i && (n = u);
        let p = l < i ? h : !!this.rules.inline.punctuation.exec(n);
        if (s[4] && n.match(this.rules.other.unicodeAlphaNumeric)) return;
        let d = s[1] || s[3] || "";
        if (!d || !n || p) {
          let g = [...s[0]].length - 1, k, b, x = g, f = 0, S = i - l + g, R = !this.options.pedantic && !!u.trim() && (!!d || r === "*" && !h), C = r === "*" ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
          for (C.lastIndex = 0, t = t.slice(-1 * e.length + g); (s = C.exec(t)) !== null; ) {
            if (k = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !k) continue;
            if (b = [...k].length, s[3] || s[4]) {
              x += b;
              continue;
            } else if (s[5] || s[6] || R) {
              if (o && (s[5] || s[6])) break;
              if (S % 3 && !((S + b) % 3)) {
                f += b;
                continue;
              }
            }
            if (x -= b, x > 0) continue;
            b = Math.min(b, b + x + f);
            let Q = [...s[0]][0].length, E = e.slice(0, g + s.index + Q + b);
            if (Math.min(g, b) % 2) {
              let F = E.slice(1, -1);
              return { type: "em", raw: E, text: F, tokens: this.lexer.inlineTokens(F) };
            }
            let j = E.slice(2, -2);
            return { type: "strong", raw: E, text: j, tokens: this.lexer.inlineTokens(j) };
          }
        }
      }
      codespan(e) {
        let t = this.rules.inline.code.exec(e);
        if (t) {
          let n = t[2].replace(this.rules.other.newLineCharGlobal, " "), s = this.rules.other.nonSpaceChar.test(n), r = this.rules.other.startingSpaceChar.test(n) && this.rules.other.endingSpaceChar.test(n);
          return s && r && (n = n.substring(1, n.length - 1)), { type: "codespan", raw: t[0], text: n };
        }
      }
      br(e) {
        let t = this.rules.inline.br.exec(e);
        if (t) return { type: "br", raw: t[0] };
      }
      del(e, t, n = "") {
        let s = this.rules.inline.delLDelim.exec(e);
        if (!s) return;
        if (!(s[1] || "") || !n || this.rules.inline.punctuation.exec(n)) {
          let o = [...s[0]].length - 1, i, l, u = o, h = this.rules.inline.delRDelim;
          for (h.lastIndex = 0, t = t.slice(-1 * e.length + o); (s = h.exec(t)) !== null; ) {
            if (i = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !i || (l = [...i].length, l !== o)) continue;
            if (s[3] || s[4]) {
              u += l;
              continue;
            }
            if (u -= l, u > 0) continue;
            l = Math.min(l, l + u);
            let p = [...s[0]][0].length, d = e.slice(0, o + s.index + p + l), g = d.slice(o, -o);
            return { type: "del", raw: d, text: g, tokens: this.lexer.inlineTokens(g) };
          }
        }
      }
      autolink(e) {
        let t = this.rules.inline.autolink.exec(e);
        if (t) {
          let n, s;
          return t[2] === "@" ? (n = t[1], s = "mailto:" + n) : (n = t[1], s = n), { type: "link", raw: t[0], text: n, href: s, autolink: true, tokens: [{ type: "text", raw: n, text: n }] };
        }
      }
      url(e) {
        let t;
        if (t = this.rules.inline.url.exec(e)) {
          let n, s;
          if (t[2] === "@") n = t[0], s = "mailto:" + n;
          else {
            let r;
            do
              r = t[0], t[0] = this.rules.inline._backpedal.exec(t[0])?.[0] ?? "";
            while (r !== t[0]);
            n = t[0], t[1] === "www." ? s = "http://" + t[0] : s = t[0];
          }
          return { type: "link", raw: t[0], text: n, href: s, autolink: true, tokens: [{ type: "text", raw: n, text: n }] };
        }
      }
      inlineText(e) {
        let t = this.rules.inline.text.exec(e);
        if (t) {
          let n = this.lexer.state.inRawBlock;
          return { type: "text", raw: t[0], text: n ? t[0] : Se(t[0]), escaped: n };
        }
      }
    };
    O = class a {
      tokens;
      options;
      state;
      inlineQueue;
      tokenizer;
      constructor(e) {
        this.tokens = [], this.tokens.links = /* @__PURE__ */ Object.create(null), this.options = e || y, this.options.tokenizer = this.options.tokenizer || new _(), this.tokenizer = this.options.tokenizer, this.tokenizer.options = this.options, this.tokenizer.lexer = this, this.inlineQueue = [], this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
        let t = { other: T, block: X.normal, inline: G.normal };
        this.options.pedantic ? (t.block = X.pedantic, t.inline = G.pedantic) : this.options.gfm && (t.block = X.gfm, this.options.breaks ? t.inline = G.breaks : t.inline = G.gfm), this.tokenizer.rules = t;
      }
      static get rules() {
        return { block: X, inline: G };
      }
      static lex(e, t) {
        return new a(t).lex(e);
      }
      static lexInline(e, t) {
        return new a(t).inlineTokens(e);
      }
      lex(e) {
        e = e.replace(T.carriageReturn, `
`), this.blockTokens(e, this.tokens);
        for (let t = 0; t < this.inlineQueue.length; t++) {
          let n = this.inlineQueue[t];
          this.state.inRawBlock = false, this.inlineTokens(n.src, n.tokens);
        }
        return this.inlineQueue = [], this.tokens;
      }
      blockTokens(e, t = [], n = false) {
        this.tokenizer.lexer = this, this.options.pedantic && (e = e.replace(T.tabCharGlobal, "    ").replace(T.spaceLine, ""));
        let s = 1 / 0;
        for (; e; ) {
          if (e.length < s) s = e.length;
          else {
            this.infiniteLoopError(e.charCodeAt(0));
            break;
          }
          let r;
          if (this.options.extensions?.block?.some((i) => (r = i.call({ lexer: this }, e, t)) ? (e = e.substring(r.raw.length), t.push(r), true) : false)) continue;
          if (r = this.tokenizer.space(e)) {
            e = e.substring(r.raw.length);
            let i = t.at(-1);
            r.raw.length === 1 && i !== void 0 ? i.raw += `
` : t.push(r);
            continue;
          }
          if (r = this.tokenizer.code(e)) {
            e = e.substring(r.raw.length);
            let i = t.at(-1);
            i?.type === "paragraph" || i?.type === "text" ? (i.raw += (i.raw.endsWith(`
`) ? "" : `
`) + r.raw, i.text += `
` + r.text, this.inlineQueue.at(-1).src = i.text) : t.push(r);
            continue;
          }
          if (r = this.tokenizer.fences(e)) {
            e = e.substring(r.raw.length), t.push(r);
            continue;
          }
          if (r = this.tokenizer.heading(e)) {
            e = e.substring(r.raw.length), t.push(r);
            continue;
          }
          if (r = this.tokenizer.hr(e)) {
            e = e.substring(r.raw.length), t.push(r);
            continue;
          }
          if (r = this.tokenizer.blockquote(e)) {
            e = e.substring(r.raw.length), t.push(r);
            continue;
          }
          if (r = this.tokenizer.list(e)) {
            e = e.substring(r.raw.length), t.push(r);
            continue;
          }
          if (r = this.tokenizer.html(e)) {
            e = e.substring(r.raw.length), t.push(r);
            continue;
          }
          if (r = this.tokenizer.def(e)) {
            e = e.substring(r.raw.length);
            let i = t.at(-1);
            i?.type === "paragraph" || i?.type === "text" ? (i.raw += (i.raw.endsWith(`
`) ? "" : `
`) + r.raw, i.text += `
` + r.raw, this.inlineQueue.at(-1).src = i.text) : (this.tokens.links[r.tag] || (this.tokens.links[r.tag] = { href: r.href, title: r.title }), t.push(r));
            continue;
          }
          if (r = this.tokenizer.table(e)) {
            e = e.substring(r.raw.length), t.push(r);
            continue;
          }
          if (r = this.tokenizer.lheading(e)) {
            e = e.substring(r.raw.length), t.push(r);
            continue;
          }
          let o = e;
          if (this.options.extensions?.startBlock) {
            let i = 1 / 0, l = e.slice(1), u;
            this.options.extensions.startBlock.forEach((h) => {
              u = h.call({ lexer: this }, l), typeof u == "number" && u >= 0 && (i = Math.min(i, u));
            }), i < 1 / 0 && i >= 0 && (o = e.substring(0, i + 1));
          }
          if (this.state.top && (r = this.tokenizer.paragraph(o))) {
            let i = t.at(-1);
            n && i?.type === "paragraph" ? (i.raw += (i.raw.endsWith(`
`) ? "" : `
`) + r.raw, i.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = i.text) : t.push(r), n = o.length !== e.length, e = e.substring(r.raw.length);
            continue;
          }
          if (r = this.tokenizer.text(e)) {
            e = e.substring(r.raw.length);
            let i = t.at(-1);
            i?.type === "text" ? (i.raw += (i.raw.endsWith(`
`) ? "" : `
`) + r.raw, i.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = i.text) : t.push(r);
            continue;
          }
          if (e) {
            this.infiniteLoopError(e.charCodeAt(0));
            break;
          }
        }
        return this.state.top = true, t;
      }
      inline(e, t = []) {
        return this.inlineQueue.push({ src: e, tokens: t }), t;
      }
      linkInText(e) {
        if (!e.includes("[")) return false;
        let t = this.tokenizer.rules.inline.link;
        for (let n of e.matchAll(this.tokenizer.rules.inline.blockSkip)) if (t.test(n[0]) && e.charAt(n.index - 1) !== "!") return true;
        for (let n of e.matchAll(this.tokenizer.rules.inline.reflinkSearch)) {
          let s = n[0], r = s.lastIndexOf("[");
          if (!(s.charAt(0) === "!" || !Object.hasOwn(this.tokens.links, N(s.slice(r + 1, -1)))) && !(r > 1 && this.linkInText(s.slice(1, r - 1)))) return true;
        }
        return false;
      }
      inlineTokens(e, t = []) {
        this.tokenizer.lexer = this;
        let n = this.state.linkParenPossible;
        this.state.linkParenPossible = n && e.includes(")");
        try {
          return this.#e(e, t);
        } finally {
          this.state.linkParenPossible = n;
        }
      }
      #e(e, t) {
        let n = e.includes("*") || e.includes("_") || e.includes("~") || this.options.hooks?.emStrongMask || this.tokenizer.emStrong !== _.prototype.emStrong || this.tokenizer.del !== _.prototype.del ? this.#t(e) : e, s = false, r = "", o = 1 / 0;
        for (; e; ) {
          if (e.length < o) o = e.length;
          else {
            this.infiniteLoopError(e.charCodeAt(0));
            break;
          }
          s || (r = ""), s = false;
          let i;
          if (this.options.extensions?.inline?.some((u) => (i = u.call({ lexer: this }, e, t)) ? (e = e.substring(i.raw.length), t.push(i), true) : false)) continue;
          if (i = this.tokenizer.escape(e)) {
            e = e.substring(i.raw.length), t.push(i);
            continue;
          }
          if (i = this.tokenizer.tag(e)) {
            e = e.substring(i.raw.length), t.push(i);
            continue;
          }
          if (i = this.tokenizer.link(e)) {
            e = e.substring(i.raw.length), t.push(i);
            continue;
          }
          if (i = this.tokenizer.reflink(e, this.tokens.links)) {
            e = e.substring(i.raw.length);
            let u = t.at(-1);
            i.type === "text" && u?.type === "text" ? (u.raw += i.raw, u.text += i.text) : t.push(i);
            continue;
          }
          if (i = this.tokenizer.emStrong(e, n, r)) {
            e = e.substring(i.raw.length), t.push(i);
            continue;
          }
          if (i = this.tokenizer.codespan(e)) {
            e = e.substring(i.raw.length), t.push(i);
            continue;
          }
          if (i = this.tokenizer.br(e)) {
            e = e.substring(i.raw.length), t.push(i);
            continue;
          }
          if (i = this.tokenizer.del(e, n, r)) {
            e = e.substring(i.raw.length), t.push(i);
            continue;
          }
          if (i = this.tokenizer.autolink(e)) {
            e = e.substring(i.raw.length), t.push(i);
            continue;
          }
          if (!this.state.inLink && (i = this.tokenizer.url(e))) {
            e = e.substring(i.raw.length), t.push(i);
            continue;
          }
          let l = e;
          if (this.options.extensions?.startInline) {
            let u = 1 / 0, h = e.slice(1), p;
            this.options.extensions.startInline.forEach((d) => {
              p = d.call({ lexer: this }, h), typeof p == "number" && p >= 0 && (u = Math.min(u, p));
            }), u < 1 / 0 && u >= 0 && (l = e.substring(0, u + 1));
          }
          if (i = this.tokenizer.inlineText(l)) {
            e = e.substring(i.raw.length), i.raw.slice(-1) !== "_" && (r = i.raw.slice(-1)), s = true;
            let u = t.at(-1);
            u?.type === "text" ? (u.raw += i.raw, u.text += i.text) : t.push(i);
            continue;
          }
          if (e) {
            this.infiniteLoopError(e.charCodeAt(0));
            break;
          }
        }
        return t;
      }
      #t(e) {
        let t = e;
        if (this.tokens.links && e.includes("[")) {
          let n = this.tokenizer.rules.inline.reflinkSearch, s = (r) => {
            let o = r.lastIndexOf("[");
            if (!Object.hasOwn(this.tokens.links, N(r.slice(o + 1, -1)))) return r;
            if (o > 1 && r.charAt(0) !== "!") {
              let i = r.slice(1, o - 1);
              if (this.linkInText(i)) return "[" + i.replace(n, s) + "][" + "a".repeat(r.length - o - 2) + "]";
            }
            return "[" + "a".repeat(r.length - 2) + "]";
          };
          t = t.replace(n, s);
        }
        return t = t.replace(this.tokenizer.rules.inline.anyPunctuationOutsideCode, (n, s, r) => r ? "+".repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, "+") + s : n), t = t.replace(this.tokenizer.rules.inline.blockSkip, (n, s, r) => {
          let o = r ? r.length : 0;
          return n.slice(0, o) + "[" + "a".repeat(n.length - o - 2) + "]";
        }), t = this.options.hooks?.emStrongMask?.call({ lexer: this }, t) ?? t, t;
      }
      infiniteLoopError(e) {
        let t = "Infinite loop on byte: " + e;
        if (this.options.silent) console.error(t);
        else throw new Error(t);
      }
    };
    L = class {
      options;
      parser;
      constructor(e) {
        this.options = e || y;
      }
      space(e) {
        return "";
      }
      code({ text: e, lang: t, escaped: n }) {
        let s = (t || "").match(T.notSpaceStart)?.[0], r = e ? e.replace(T.endingNewline, "") + `
` : "";
        return s ? '<pre><code class="language-' + P(s) + '">' + (n ? r : P(r, true)) + `</code></pre>
` : "<pre><code>" + (n ? r : P(r, true)) + `</code></pre>
`;
      }
      blockquote({ tokens: e }) {
        return `<blockquote>
${this.parser.parse(e)}</blockquote>
`;
      }
      html({ text: e }) {
        return e;
      }
      def(e) {
        return "";
      }
      heading({ tokens: e, depth: t }) {
        return `<h${t}>${this.parser.parseInline(e)}</h${t}>
`;
      }
      hr(e) {
        return `<hr>
`;
      }
      list(e) {
        let t = e.ordered, n = e.start, s = "";
        for (let i = 0; i < e.items.length; i++) {
          let l = e.items[i];
          s += this.listitem(l);
        }
        let r = t ? "ol" : "ul", o = t && n !== 1 ? ' start="' + n + '"' : "";
        return "<" + r + o + `>
` + s + "</" + r + `>
`;
      }
      listitem(e) {
        return `<li>${this.parser.parse(e.tokens)}</li>
`;
      }
      checkbox({ checked: e }) {
        return "<input " + (e ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
      }
      paragraph({ tokens: e }) {
        return `<p>${this.parser.parseInline(e)}</p>
`;
      }
      table(e) {
        let t = "", n = "";
        for (let r = 0; r < e.header.length; r++) n += this.tablecell(e.header[r]);
        t += this.tablerow({ text: n });
        let s = "";
        for (let r = 0; r < e.rows.length; r++) {
          let o = e.rows[r];
          n = "";
          for (let i = 0; i < o.length; i++) n += this.tablecell(o[i]);
          s += this.tablerow({ text: n });
        }
        return s && (s = `<tbody>${s}</tbody>`), `<table>
<thead>
` + t + `</thead>
` + s + `</table>
`;
      }
      tablerow({ text: e }) {
        return `<tr>
${e}</tr>
`;
      }
      tablecell(e) {
        let t = this.parser.parseInline(e.tokens), n = e.header ? "th" : "td";
        return (e.align ? `<${n} align="${e.align}">` : `<${n}>`) + t + `</${n}>
`;
      }
      strong({ tokens: e }) {
        return `<strong>${this.parser.parseInline(e)}</strong>`;
      }
      em({ tokens: e }) {
        return `<em>${this.parser.parseInline(e)}</em>`;
      }
      codespan({ text: e }) {
        return `<code>${P(e, true)}</code>`;
      }
      br(e) {
        return "<br>";
      }
      del({ tokens: e }) {
        return `<del>${this.parser.parseInline(e)}</del>`;
      }
      link({ href: e, title: t, text: n, tokens: s, autolink: r }) {
        let o = r ? P(n, true) : this.parser.parseInline(s), i = le(e);
        if (i === null) return o;
        e = P(i, r);
        let l = '<a href="' + e + '"';
        return t && (l += ' title="' + P(t) + '"'), l += ">" + o + "</a>", l;
      }
      image({ href: e, title: t, text: n, tokens: s }) {
        s && (n = this.parser.parseInline(s, this.parser.textRenderer));
        let r = le(e);
        if (r === null) return P(n);
        e = r;
        let o = `<img src="${P(e)}" alt="${P(n)}"`;
        return t && (o += ` title="${P(t)}"`), o += ">", o;
      }
      text(e) {
        return "tokens" in e && e.tokens ? this.parser.parseInline(e.tokens) : "escaped" in e && e.escaped ? e.text : P(e.text);
      }
    };
    M = class {
      parser;
      strong({ text: e, tokens: t }) {
        return t ? this.parser.parseInline(t, this) : e;
      }
      em({ text: e, tokens: t }) {
        return t ? this.parser.parseInline(t, this) : e;
      }
      codespan({ text: e }) {
        return e;
      }
      del({ text: e, tokens: t }) {
        return t ? this.parser.parseInline(t, this) : e;
      }
      html({ text: e }) {
        return e;
      }
      text({ text: e }) {
        return e;
      }
      link({ text: e, tokens: t }) {
        return t ? this.parser.parseInline(t, this) : e;
      }
      image({ text: e, tokens: t }) {
        return t ? this.parser.parseInline(t, this) : e;
      }
      br() {
        return "";
      }
      checkbox({ raw: e }) {
        return e;
      }
    };
    w = class a2 {
      options;
      renderer;
      textRenderer;
      constructor(e) {
        this.options = e || y, this.options.renderer = this.options.renderer || new L(), this.renderer = this.options.renderer, this.renderer.options = this.options, this.renderer.parser = this, this.textRenderer = new M(), this.textRenderer.parser = this;
      }
      static parse(e, t) {
        return new a2(t).parse(e);
      }
      static parseInline(e, t) {
        return new a2(t).parseInline(e);
      }
      parse(e) {
        this.renderer.parser = this;
        let t = "";
        for (let n = 0; n < e.length; n++) {
          let s = e[n];
          if (this.options.extensions?.renderers?.[s.type]) {
            let o = s, i = this.options.extensions.renderers[o.type].call({ parser: this }, o);
            if (i !== false || !["space", "hr", "heading", "code", "table", "blockquote", "list", "checkbox", "html", "def", "paragraph", "text"].includes(o.type)) {
              t += i || "";
              continue;
            }
          }
          let r = s;
          switch (r.type) {
            case "space": {
              t += this.renderer.space(r);
              break;
            }
            case "hr": {
              t += this.renderer.hr(r);
              break;
            }
            case "heading": {
              t += this.renderer.heading(r);
              break;
            }
            case "code": {
              t += this.renderer.code(r);
              break;
            }
            case "table": {
              t += this.renderer.table(r);
              break;
            }
            case "blockquote": {
              t += this.renderer.blockquote(r);
              break;
            }
            case "list": {
              t += this.renderer.list(r);
              break;
            }
            case "checkbox": {
              t += this.renderer.checkbox(r);
              break;
            }
            case "html": {
              t += this.renderer.html(r);
              break;
            }
            case "def": {
              t += this.renderer.def(r);
              break;
            }
            case "paragraph": {
              t += this.renderer.paragraph(r);
              break;
            }
            case "text": {
              t += this.renderer.text(r);
              break;
            }
            default: {
              let o = 'Token with "' + r.type + '" type was not found.';
              if (this.options.silent) return console.error(o), "";
              throw new Error(o);
            }
          }
        }
        return t;
      }
      parseInline(e, t = this.renderer) {
        this.renderer.parser = this;
        let n = "";
        for (let s = 0; s < e.length; s++) {
          let r = e[s];
          if (this.options.extensions?.renderers?.[r.type]) {
            let i = this.options.extensions.renderers[r.type].call({ parser: this }, r);
            if (i !== false || !["escape", "html", "link", "image", "checkbox", "strong", "em", "codespan", "br", "del", "text"].includes(r.type)) {
              n += i || "";
              continue;
            }
          }
          let o = r;
          switch (o.type) {
            case "escape": {
              n += t.text(o);
              break;
            }
            case "html": {
              n += t.html(o);
              break;
            }
            case "link": {
              n += t.link(o);
              break;
            }
            case "image": {
              n += t.image(o);
              break;
            }
            case "checkbox": {
              n += t.checkbox(o);
              break;
            }
            case "strong": {
              n += t.strong(o);
              break;
            }
            case "em": {
              n += t.em(o);
              break;
            }
            case "codespan": {
              n += t.codespan(o);
              break;
            }
            case "br": {
              n += t.br(o);
              break;
            }
            case "del": {
              n += t.del(o);
              break;
            }
            case "text": {
              n += t.text(o);
              break;
            }
            default: {
              let i = 'Token with "' + o.type + '" type was not found.';
              if (this.options.silent) return console.error(i), "";
              throw new Error(i);
            }
          }
        }
        return n;
      }
    };
    A = class {
      options;
      block;
      constructor(e) {
        this.options = e || y;
      }
      static passThroughHooks = /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens", "emStrongMask"]);
      static passThroughHooksRespectAsync = /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens"]);
      preprocess(e) {
        return e;
      }
      postprocess(e) {
        return e;
      }
      processAllTokens(e) {
        return e;
      }
      emStrongMask(e) {
        return e;
      }
      provideLexer(e = this.block) {
        return e ? O.lex : O.lexInline;
      }
      provideParser(e = this.block) {
        return e ? w.parse : w.parseInline;
      }
    };
    J = class {
      defaults = v();
      options = this.setOptions;
      parse = this.parseMarkdown(true);
      parseInline = this.parseMarkdown(false);
      Parser = w;
      Renderer = L;
      TextRenderer = M;
      Lexer = O;
      Tokenizer = _;
      Hooks = A;
      constructor(...e) {
        this.use(...e);
      }
      walkTokens(e, t) {
        let n = [];
        for (let s of e) switch (D(n, t.call(this, s)), s.type) {
          case "table": {
            let r = s;
            for (let o of r.header) D(n, this.walkTokens(o.tokens, t));
            for (let o of r.rows) for (let i of o) D(n, this.walkTokens(i.tokens, t));
            break;
          }
          case "list": {
            let r = s;
            D(n, this.walkTokens(r.items, t));
            break;
          }
          default: {
            let r = s;
            this.defaults.extensions?.childTokens?.[r.type] ? this.defaults.extensions.childTokens[r.type].forEach((o) => {
              let i = r[o].flat(1 / 0);
              D(n, this.walkTokens(i, t));
            }) : r.tokens && D(n, this.walkTokens(r.tokens, t));
          }
        }
        return n;
      }
      use(...e) {
        let t = this.defaults.extensions || { renderers: {}, childTokens: {} };
        return e.forEach((n) => {
          let s = { ...n };
          if (s.async = this.defaults.async || s.async || false, n.extensions && (n.extensions.forEach((r) => {
            if (!r.name) throw new Error("extension name required");
            if ("renderer" in r) {
              let o = t.renderers[r.name];
              o ? t.renderers[r.name] = function(...i) {
                let l = r.renderer.apply(this, i);
                return l === false && (l = o.apply(this, i)), l;
              } : t.renderers[r.name] = r.renderer;
            }
            if ("tokenizer" in r) {
              if (!r.level || r.level !== "block" && r.level !== "inline") throw new Error("extension level must be 'block' or 'inline'");
              let o = t[r.level];
              o ? o.unshift(r.tokenizer) : t[r.level] = [r.tokenizer], r.start && (r.level === "block" ? t.startBlock ? t.startBlock.push(r.start) : t.startBlock = [r.start] : r.level === "inline" && (t.startInline ? t.startInline.push(r.start) : t.startInline = [r.start]));
            }
            "childTokens" in r && r.childTokens && (t.childTokens[r.name] = r.childTokens);
          }), s.extensions = t), n.renderer) {
            let r = this.defaults.renderer || new L(this.defaults);
            for (let o in n.renderer) {
              if (!(o in r)) throw new Error(`renderer '${o}' does not exist`);
              if (["options", "parser"].includes(o)) continue;
              let i = o, l = n.renderer[i], u = r[i];
              r[i] = (...h) => {
                let p = l.apply(r, h);
                return p === false && (p = u.apply(r, h)), p || "";
              };
            }
            s.renderer = r;
          }
          if (n.tokenizer) {
            let r = this.defaults.tokenizer || new _(this.defaults);
            for (let o in n.tokenizer) {
              if (!(o in r)) throw new Error(`tokenizer '${o}' does not exist`);
              if (["options", "rules", "lexer"].includes(o)) continue;
              let i = o, l = n.tokenizer[i], u = r[i];
              r[i] = (...h) => {
                let p = l.apply(r, h);
                return p === false && (p = u.apply(r, h)), p;
              };
            }
            s.tokenizer = r;
          }
          if (n.hooks) {
            let r = this.defaults.hooks || new A();
            for (let o in n.hooks) {
              if (!(o in r)) throw new Error(`hook '${o}' does not exist`);
              if (["options", "block"].includes(o)) continue;
              let i = o, l = n.hooks[i], u = r[i];
              A.passThroughHooks.has(o) ? r[i] = (h) => {
                if (r.options.async && A.passThroughHooksRespectAsync.has(o)) return (async () => {
                  let d = await l.call(r, h);
                  return u.call(r, d);
                })();
                let p = l.call(r, h);
                return u.call(r, p);
              } : r[i] = (...h) => {
                if (r.options.async) return (async () => {
                  let d = await l.apply(r, h);
                  return d === false && (d = await u.apply(r, h)), d;
                })();
                let p = l.apply(r, h);
                return p === false && (p = u.apply(r, h)), p;
              };
            }
            s.hooks = r;
          }
          if (n.walkTokens) {
            let r = this.defaults.walkTokens, o = n.walkTokens;
            s.walkTokens = function(i) {
              let l = [];
              return l.push(o.call(this, i)), r && D(l, r.call(this, i)), l;
            };
          }
          this.defaults = { ...this.defaults, ...s };
        }), this;
      }
      setOptions(e) {
        return this.defaults = { ...this.defaults, ...e }, this;
      }
      lexer(e, t) {
        return O.lex(e, t ?? this.defaults);
      }
      parser(e, t) {
        return w.parse(e, t ?? this.defaults);
      }
      parseMarkdown(e) {
        return (n, s) => {
          let r = { ...s }, o = { ...this.defaults, ...r }, i = this.onError(!!o.silent, !!o.async);
          if (this.defaults.async === true && r.async === false) return i(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));
          if (typeof n > "u" || n === null) return i(new Error("marked(): input parameter is undefined or null"));
          if (typeof n != "string") return i(new Error("marked(): input parameter is of type " + Object.prototype.toString.call(n) + ", string expected"));
          if (o.hooks && (o.hooks.options = o, o.hooks.block = e), o.async) return (async () => {
            let l = o.hooks ? await o.hooks.preprocess(n) : n, h = await (o.hooks ? await o.hooks.provideLexer(e) : e ? O.lex : O.lexInline)(l, o), p = o.hooks ? await o.hooks.processAllTokens(h) : h;
            o.walkTokens && await Promise.all(this.walkTokens(p, o.walkTokens));
            let g = await (o.hooks ? await o.hooks.provideParser(e) : e ? w.parse : w.parseInline)(p, o);
            return o.hooks ? await o.hooks.postprocess(g) : g;
          })().catch(i);
          try {
            o.hooks && (n = o.hooks.preprocess(n));
            let u = (o.hooks ? o.hooks.provideLexer(e) : e ? O.lex : O.lexInline)(n, o);
            o.hooks && (u = o.hooks.processAllTokens(u)), o.walkTokens && this.walkTokens(u, o.walkTokens);
            let p = (o.hooks ? o.hooks.provideParser(e) : e ? w.parse : w.parseInline)(u, o);
            return o.hooks && (p = o.hooks.postprocess(p)), p;
          } catch (l) {
            return i(l);
          }
        };
      }
      onError(e, t) {
        return (n) => {
          if (n.message += `
Please report this to https://github.com/markedjs/marked.`, e) {
            let s = "<p>An error occurred:</p><pre>" + P(n.message + "", true) + "</pre>";
            return t ? Promise.resolve(s) : s;
          }
          if (t) return Promise.reject(n);
          throw n;
        };
      }
    };
    q = new J();
    m.options = m.setOptions = function(a3) {
      return q.setOptions(a3), m.defaults = q.defaults, ee(m.defaults), m;
    };
    m.getDefaults = v;
    m.defaults = y;
    m.use = zt;
    m.walkTokens = function(a3, e) {
      return q.walkTokens(a3, e);
    };
    m.parseInline = q.parseInline;
    m.Parser = w;
    m.parser = w.parse;
    m.Renderer = L;
    m.TextRenderer = M;
    m.Lexer = O;
    m.lexer = O.lex;
    m.Tokenizer = _;
    m.Hooks = A;
    m.parse = m;
    Tn = m.options;
    On = m.setOptions;
    wn = m.walkTokens;
    Pn = m.parseInline;
    Sn = w.parse;
    _n = O.lex;
  }
});

// src/shared/blocks.ts
function lexReply(markdown) {
  return O.lex(markdown, { gfm: true });
}
function replyBlocks(tokens) {
  const blocks = [];
  for (const token of tokens) {
    if (TOP_LEVEL_BLOCKS.has(token.type)) blocks.push(token);
    collectListItems(token, blocks);
  }
  return blocks;
}
function collectListItems(token, blocks) {
  if (token.type === "list") {
    for (const item of token.items) {
      blocks.push(item);
      collectListItems(item, blocks);
    }
  } else if (token.type === "list_item" || token.type === "blockquote") {
    for (const child of token.tokens ?? []) collectListItems(child, blocks);
  }
}
var TOP_LEVEL_BLOCKS;
var init_blocks = __esm({
  "src/shared/blocks.ts"() {
    "use strict";
    init_marked_esm();
    TOP_LEVEL_BLOCKS = /* @__PURE__ */ new Set(["paragraph", "code", "blockquote", "table", "heading"]);
  }
});

// src/shared/diff.ts
function looksLikeDiff(text) {
  const lines = text.split(/\r?\n/);
  const hasHeader = lines.some(
    (line, i) => line.startsWith("diff --git ") || HUNK.test(line) || line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")
  );
  return hasHeader && lines.some((line) => /^[+-](?![+-]{2} )/.test(line));
}
function parseUnifiedDiff(text) {
  if (!text.trim()) return [];
  const files = [];
  let current = null;
  const lines = text.replace(/\n$/, "").split(/\r?\n/);
  const start = (path) => {
    const file = { path, lines: [], additions: 0, deletions: 0 };
    files.push(file);
    return file;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      current = start(pathFrom(lines[i + 1].slice(4), line.slice(4)));
      i += 1;
      continue;
    }
    if (METADATA.test(line)) continue;
    current ??= start("");
    const hunk = HUNK.exec(line);
    if (hunk) {
      current.lines.push({ kind: "hunk", text: hunk[1].trim() });
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
function pathFrom(newPath, oldPath) {
  const clean = (path) => path.replace(/\t.*$/, "").trim().replace(/^[ab]\//, "");
  const target = clean(newPath);
  return target === "/dev/null" ? clean(oldPath) : target;
}
function pairChangedLines(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== "del") continue;
    let firstAdd = i;
    while (lines[firstAdd]?.kind === "del") firstAdd++;
    let end = firstAdd;
    while (lines[end]?.kind === "add") end++;
    if (firstAdd - i === end - firstAdd) {
      for (let k = 0; k < firstAdd - i; k++) {
        const [before, after] = editedParts(lines[i + k].text, lines[firstAdd + k].text);
        lines[i + k].parts = before;
        lines[firstAdd + k].parts = after;
      }
    }
    i = end - 1;
  }
}
function editedParts(before, after) {
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
    [after.slice(0, prefix), after.slice(prefix, endAfter), after.slice(endAfter)]
  ];
}
var HUNK, METADATA;
var init_diff = __esm({
  "src/shared/diff.ts"() {
    "use strict";
    HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$/;
    METADATA = /^(?:diff --git |index |new file mode |deleted file mode |similarity index |rename (?:from|to) |\\ No newline)/;
  }
});

// src/tui/render.ts
function renderReply(markdown, options) {
  const tokens = lexReply(terminalSafe(markdown));
  const blocks = replyBlocks(tokens);
  const renderer = new ReplyRenderer(tokens, blocks, options);
  const lines = renderer.blocks(tokens, Math.max(MIN_WIDTH, options.width), -1, 0, true);
  return {
    lines,
    blocks: blocks.map(blockInfo),
    fileCount: renderer.fileCount,
    foldable: renderer.foldable
  };
}
function blockInfo(token) {
  const text = token.type === "table" || !("text" in token) ? token.raw : String(token.text);
  return { code: token.type === "code", quote: text.trim() };
}
function plain(text) {
  return { text, style: PLAIN };
}
function prose(spans, width, block) {
  const flat = spans.map((span) => ({ ...span, text: span.text.replace(/\t/g, " ") }));
  return wrapSpans(flat, width).map((line) => ({ spans: line, block }));
}
function prefixed(lines, first, rest) {
  const others = rest ?? first;
  return lines.map((line, i) => ({ ...line, spans: [...i ? others : first, ...line.spans] }));
}
function code(token, width, block) {
  const out = [];
  const language = languageOf(token);
  if (language) out.push({ spans: [{ text: language, style: MUTED2 }], block });
  for (const raw of terminalSafe(token.text).split("\n")) {
    const chunks = wrapSpans([plain(raw.replace(/\t/g, TAB))], width - 2, "anywhere");
    chunks.forEach((spans, i) => out.push({ spans: [{ text: i ? "\u2506 " : "\u2502 ", style: MUTED2 }, ...spans], block }));
  }
  return out;
}
function diffLine(line, width, block) {
  if (line.kind === "hunk") {
    return wrapSpans([{ text: line.text || "\u22EF", style: { tone: "hunk" } }], width).map((spans2) => ({ spans: spans2, block }));
  }
  const [tone, mark] = line.kind === "context" ? [void 0, void 0] : DIFF_TONES[line.kind];
  const style = tone ? { tone } : PLAIN;
  const detab = (text) => text.replace(/\t/g, TAB);
  const spans = line.parts?.[1] ? [
    { text: detab(line.parts[0]), style },
    { text: detab(line.parts[1]), style: mark ? { tone: mark } : PLAIN },
    { text: detab(line.parts[2]), style }
  ] : [{ text: detab(line.text), style }];
  const sign = { text: DIFF_SIGNS[line.kind], style };
  return wrapSpans(spans, width - 2, "anywhere").map((chunk, i) => ({
    spans: [i ? plain("  ") : sign, ...chunk],
    block
  }));
}
function diffFiles(token) {
  const language = languageOf(token);
  const isDiff = DIFF_LANGUAGES.has(language) || !language && looksLikeDiff(token.text);
  return isDiff ? parseUnifiedDiff(terminalSafe(token.text)) : [];
}
function languageOf(token) {
  return /^\S*/.exec(token.lang ?? "")?.[0] ?? "";
}
function codeTokens(tokens) {
  const found = [];
  const visit = (token) => {
    if (token.type === "code") found.push(token);
    if (token.type === "list") token.items.forEach(visit);
    if ("tokens" in token && token.tokens) token.tokens.forEach(visit);
  };
  tokens.forEach(visit);
  return found;
}
function shrink(natural, available) {
  const widths = [...natural];
  let total = widths.reduce((sum, w2) => sum + w2, 0);
  while (total > available) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] <= MIN_TABLE_COLUMN) return null;
    widths[widest] -= 1;
    total -= 1;
  }
  return widths;
}
function tableRow(cells, widths, aligns, block) {
  const wrapped = widths.map((w2, c2) => wrapSpans(cells[c2] ?? [], w2));
  const height = Math.max(...wrapped.map((lines) => lines.length));
  const out = [];
  for (let k = 0; k < height; k++) {
    const spans = [{ text: "\u2502 ", style: MUTED2 }];
    widths.forEach((w2, c2) => {
      const content = wrapped[c2][k] ?? [];
      const pad = w2 - spansWidth(content);
      const left = aligns[c2] === "right" ? pad : aligns[c2] === "center" ? Math.floor(pad / 2) : 0;
      spans.push(plain(" ".repeat(left)), ...content, plain(" ".repeat(pad - left)));
      spans.push({ text: c2 === widths.length - 1 ? " \u2502" : " \u2502 ", style: MUTED2 });
    });
    out.push({ spans, block });
  }
  return out;
}
function stackedTable(header, rows, width, block) {
  const out = [];
  for (const row of rows) {
    if (out.length) out.push({ spans: [], block });
    header.forEach((title, c2) => {
      const label = title.map((span) => span.text).join("");
      const spans = [{ text: `${label}: `, style: { ...MUTED2, bold: true } }, ...row[c2] ?? []];
      out.push(...prose(spans, width, block));
    });
  }
  return out;
}
function decodeEntities(text) {
  if (!text.includes("&")) return text;
  const decoded = text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (entity, name) => {
    if (name[0] !== "#") return ENTITIES.get(name.toLowerCase()) ?? entity;
    const code2 = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    const valid = code2 > 0 && code2 <= 1114111 && (code2 < 55296 || code2 > 57343);
    return valid ? String.fromCodePoint(code2) : entity;
  });
  return decoded;
}
var MIN_WIDTH, MIN_TABLE_COLUMN, TAB, BULLETS, DIFF_LANGUAGES, DIFF_SIGNS, DIFF_TONES, MUTED2, BOLD, HEADINGS, ENTITIES, ReplyRenderer;
var init_render = __esm({
  "src/tui/render.ts"() {
    "use strict";
    init_blocks();
    init_diff();
    init_lines();
    init_sanitize();
    init_width();
    init_wrap();
    MIN_WIDTH = 20;
    MIN_TABLE_COLUMN = 4;
    TAB = "    ";
    BULLETS = ["\u2022", "\u25E6", "\u25AA"];
    DIFF_LANGUAGES = /* @__PURE__ */ new Set(["diff", "patch"]);
    DIFF_SIGNS = { add: "+ ", del: "\u2212 ", context: "  " };
    DIFF_TONES = { add: ["add", "addMark"], del: ["del", "delMark"] };
    MUTED2 = { tone: "muted" };
    BOLD = { bold: true };
    HEADINGS = [
      { bold: true, underline: true, tone: "accent" },
      { bold: true, tone: "accent" },
      BOLD
    ];
    ENTITIES = /* @__PURE__ */ new Map([
      ["amp", "&"],
      ["lt", "<"],
      ["gt", ">"],
      ["quot", '"'],
      ["apos", "'"],
      ["nbsp", "\xA0"]
    ]);
    ReplyRenderer = class {
      foldable;
      #blockOf;
      #isFileOpen;
      #nextFile = 0;
      constructor(tokens, blocks, options) {
        this.#blockOf = new Map(blocks.map((token, index) => [token, index]));
        const paths2 = new Set(codeTokens(tokens).flatMap((code2) => diffFiles(code2).map((file) => file.path)));
        this.foldable = paths2.size > 1;
        this.#isFileOpen = options.isFileOpen ?? ((file) => file === 0);
      }
      get fileCount() {
        return this.#nextFile;
      }
      /** A run of blocks; children that aren't blocks themselves belong to the enclosing one. */
      blocks(tokens, width, enclosing, depth, gap) {
        const out = [];
        for (const token of tokens) {
          const lines = this.#block(token, width, this.#blockOf.get(token) ?? enclosing, depth);
          if (!lines.length) continue;
          if (gap && out.length) out.push({ spans: [], block: enclosing });
          out.push(...lines);
        }
        return out;
      }
      #block(token, width, block, depth) {
        switch (token.type) {
          case "space":
          case "def":
            return [];
          case "paragraph":
            return prose(this.#inline(token.tokens ?? []), width, block);
          case "heading":
            return prose(this.#inline(token.tokens ?? [], HEADINGS[Math.min(token.depth, 3) - 1]), width, block);
          case "code": {
            const files = diffFiles(token);
            return files.length ? this.#diff(files, width, block) : code(token, width, block);
          }
          case "blockquote": {
            const inner = this.blocks(token.tokens ?? [], width - 2, block, depth, true);
            return prefixed(inner, [{ text: "\u258C ", style: MUTED2 }]);
          }
          case "list":
            return this.#list(token, width, depth);
          case "table":
            return this.#table(token, width, block);
          case "hr":
            return [{ spans: [{ text: "\u2500".repeat(width), style: MUTED2 }], block }];
          case "html":
            return prose([{ text: token.text.replace(/\n+$/, ""), style: PLAIN }], width, block);
          default:
            if ("tokens" in token && token.tokens) return prose(this.#inline(token.tokens), width, block);
            if ("text" in token && typeof token.text === "string") return prose([plain(token.text)], width, block);
            return [];
        }
      }
      #list(list, width, depth) {
        const out = [];
        const start = typeof list.start === "number" ? list.start : 1;
        list.items.forEach((item, i) => {
          const block = this.#blockOf.get(item) ?? -1;
          let marker = list.ordered ? `${start + i}.` : BULLETS[Math.min(depth, BULLETS.length - 1)];
          if (item.task) marker += item.checked ? " \u2611" : " \u2610";
          const indent = displayWidth(marker) + 1;
          const children = item.tokens.filter((child) => child.type !== "checkbox");
          const body = this.blocks(children, width - indent, block, depth + 1, item.loose);
          if (list.loose && out.length) out.push({ spans: [], block: -1 });
          const first = [{ text: `${marker} `, style: list.ordered ? PLAIN : MUTED2 }];
          out.push(...prefixed(body.length ? body : [{ spans: [], block }], first, [plain(" ".repeat(indent))]));
        });
        return out;
      }
      #diff(files, width, block) {
        const out = [];
        for (const file of files) {
          const number = this.#nextFile++;
          const open = !this.foldable || this.#isFileOpen(number);
          const header = [
            ...this.foldable ? [{ text: open ? "\u25BE " : "\u25B8 ", style: MUTED2 }] : [],
            { text: file.path || "Change", style: BOLD },
            plain("  "),
            { text: `+${file.additions}`, style: { tone: "add" } },
            plain(" "),
            { text: `\u2212${file.deletions}`, style: { tone: "del" } }
          ];
          for (const spans of wrapSpans(header, width)) out.push({ spans, block, file: number });
          if (!open) continue;
          for (const line of file.lines) out.push(...diffLine(line, width, block));
        }
        return out;
      }
      #table(table, width, block) {
        const header = table.header.map((cell) => this.#inline(cell.tokens, BOLD));
        const rows = table.rows.map((row) => row.map((cell) => this.#inline(cell.tokens)));
        const columns = header.length;
        const natural = header.map((_2, c2) => Math.max(1, ...[header, ...rows].map((row) => spansWidth(row[c2] ?? []))));
        const widths = shrink(natural, width - (3 * columns + 1));
        if (!widths) return stackedTable(header, rows, width, block);
        const border = (left, middle, right) => ({
          spans: [{ text: left + widths.map((w2) => "\u2500".repeat(w2 + 2)).join(middle) + right, style: MUTED2 }],
          block
        });
        const aligns = table.align;
        return [
          border("\u250C", "\u252C", "\u2510"),
          ...tableRow(header, widths, aligns, block),
          border("\u251C", "\u253C", "\u2524"),
          ...rows.flatMap((row) => tableRow(row, widths, aligns, block)),
          border("\u2514", "\u2534", "\u2518")
        ];
      }
      #inline(tokens, base = PLAIN) {
        const out = [];
        const push = (text, style) => {
          out.push({ text: terminalSafe(text), style });
        };
        for (const token of tokens) {
          switch (token.type) {
            case "text":
              if ("tokens" in token && token.tokens?.length) out.push(...this.#inline(token.tokens, base));
              else push(decodeEntities(token.text), base);
              break;
            case "escape":
            case "html":
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
    };
  }
});

// src/tui/thread.ts
function buildThread(model, rootId, width) {
  const root = model.note(rootId);
  const response = model.response(root?.response_id);
  if (!root || !response) return null;
  const rows = [];
  const blank = () => {
    rows.push([]);
  };
  rows.push([
    { text: "Thread", style: { bold: true } },
    { text: ` \xB7 on the reply from ${formatTime(response.created_at)}`, style: MUTED3 }
  ]);
  blank();
  if (root.quote) {
    const quote = wrapSpans([{ text: terminalSafe(root.quote), style: { tone: "muted", italic: true } }], width - 2);
    for (const spans of quote.slice(0, QUOTE_ROWS)) rows.push([{ text: "\u258C ", style: MUTED3 }, ...spans]);
    if (quote.length > QUOTE_ROWS) rows.push([{ text: "\u258C \u2026", style: MUTED3 }]);
  } else {
    rows.push([{ text: "On the whole reply", style: { tone: "muted", italic: true } }]);
  }
  const entries = model.thread(root.id);
  entries.forEach((note, index) => {
    blank();
    rows.push(...entry(model, note, width));
    const next = entries[index + 1];
    if (isAnswered(note) && next?.answered_by !== note.answered_by) {
      blank();
      const group = entries.filter((other) => other.answered_by === note.answered_by);
      rows.push(...answer(model, note.answered_by, group, width));
    } else if (note.delivered_at !== null && note.answered_by === null && !next) {
      blank();
      rows.push([{ text: "Sent. Claude's reply will appear here.", style: MUTED3 }]);
    }
  });
  return rows;
}
function entry(model, note, width) {
  const status = note.delivered_at !== null ? `Sent ${formatTime(note.delivered_at)}` : model.isQueued(note) ? "Sending\u2026" : "Pending";
  const head = [
    { text: note.parent_id === null ? "Your note" : "Your follow-up", style: { bold: true } },
    { text: ` \xB7 ${status}`, style: note.delivered_at === null ? { tone: "accent" } : MUTED3 }
  ];
  const body = wrapSpans([{ text: terminalSafe(note.body), style: PLAIN }], width - 2);
  return [head, ...body.map((spans) => [INDENT, ...spans])];
}
function answer(model, responseId, group, width) {
  const response = model.response(responseId);
  const head = [{ text: "Claude", style: { bold: true, tone: "accent" } }];
  if (!response) return [[...head, { text: " \xB7 answered in a reply that is no longer stored", style: MUTED3 }]];
  head.push({ text: ` \xB7 ${formatTime(response.created_at)}`, style: MUTED3 });
  const texts = [...new Set(group.map((note) => model.answerText(note)).filter(Boolean))];
  if (!texts.length) return [head, [INDENT, { text: "Answered in the reply in the feed: f shows it", style: MUTED3 }]];
  const rows = [head];
  texts.forEach((text, i) => {
    if (i) rows.push([]);
    const rendered = renderReply(text, { width: width - 2, isFileOpen: () => true });
    for (const line of rendered.lines) rows.push([INDENT, ...line.spans]);
  });
  return rows;
}
var MUTED3, INDENT, QUOTE_ROWS;
var init_thread = __esm({
  "src/tui/thread.ts"() {
    "use strict";
    init_model();
    init_text();
    init_lines();
    init_render();
    init_sanitize();
    init_wrap();
    MUTED3 = { tone: "muted" };
    INDENT = { text: "  ", style: PLAIN };
    QUOTE_ROWS = 6;
  }
});

// src/tui/app.ts
function emptyState(text, height) {
  const rows = Array.from({ length: height }, () => []);
  rows[Math.min(1, height - 1)] = [{ text: `  ${text}`, style: MUTED4 }];
  return rows;
}
function errorText(error) {
  const text = error instanceof Error ? error.message : String(error);
  return `Couldn't do that: ${text.replace(/\s+/g, " ")}`;
}
var MAX_QUOTE_CHARS, GUTTER, EDITOR_MAX_ROWS, MIN_COLUMNS, MIN_ROWS, MUTED4, ACCENT, App;
var init_app = __esm({
  "src/tui/app.ts"() {
    "use strict";
    init_model();
    init_text();
    init_ansi();
    init_editor();
    init_feed();
    init_lines();
    init_render();
    init_sanitize();
    init_thread();
    init_wrap();
    MAX_QUOTE_CHARS = 600;
    GUTTER = 2;
    EDITOR_MAX_ROWS = 6;
    MIN_COLUMNS = 30;
    MIN_ROWS = 8;
    MUTED4 = { tone: "muted" };
    ACCENT = { tone: "accent" };
    App = class {
      #api;
      #terminal;
      #ansi;
      #cwd;
      #model = null;
      #reachable = true;
      #view = "feed";
      #threadRoot = null;
      #threadScroll = 0;
      #feed = null;
      #selected = null;
      #scroll = 0;
      /** Scroll so the selection is in view at the next render. */
      #reveal = false;
      /** Put this reply's header at the top at the next render, and select its first block. */
      #showReply = null;
      #newBelow = false;
      /** Rows of a code block picked with v: [anchor, cursor]. */
      #lines = null;
      #editor = null;
      #drafts = /* @__PURE__ */ new Map();
      #message = null;
      #confirmDelete = null;
      /** Open files of each reply's diffs, once the user folds or unfolds one. */
      #openFiles = /* @__PURE__ */ new Map();
      #renders = /* @__PURE__ */ new Map();
      #renderWidth = 0;
      constructor(options) {
        this.#api = options.api;
        this.#terminal = options.terminal;
        this.#ansi = options.ansi;
        this.#cwd = options.cwd;
        if (options.sessionId) this.#model = new Model(options.sessionId);
      }
      get sessionId() {
        return this.#model?.sessionId ?? null;
      }
      // ---- Server ---------------------------------------------------------------------------
      /** Fetches the latest state, then draws. Called once a second, and after every change. */
      async refresh() {
        try {
          if (!this.#model) {
            const sessions = await this.#api.sessions();
            const here = sessions.find((session) => session.cwd === this.#cwd);
            if (here) this.#model = new Model(here.id);
          }
          if (this.#model) {
            const snapshot = await this.#api.state(this.#model.snapshot.version, this.#model.sessionId);
            if (snapshot) this.#update(snapshot);
          }
          this.#reachable = true;
        } catch {
          this.#reachable = false;
        }
        this.render();
      }
      #update(snapshot) {
        const model = this.#model;
        const known = new Set(model.responses.map((response) => response.id));
        const firstLoad = model.snapshot.version < 0;
        const latestBefore = model.responses.at(-1)?.id;
        const followingLatest = this.#selectedTarget()?.responseId === latestBefore || this.#selected === null;
        model.snapshot = snapshot;
        const latest = model.responses.at(-1);
        if (!latest) return;
        if (firstLoad) {
          this.#showReply = latest.id;
        } else if (!known.has(latest.id)) {
          if (followingLatest && !this.#editor && !this.#lines && this.#view === "feed") this.#showReply = latest.id;
          else this.#newBelow = true;
        }
        if (this.#threadRoot !== null && !model.note(this.#threadRoot)) this.#closeThread();
      }
      // ---- Keys -----------------------------------------------------------------------------
      async handleKey(key2) {
        const confirming = this.#confirmDelete;
        this.#confirmDelete = null;
        this.#message = null;
        try {
          if (key2.ctrl && key2.name === "c") return this.#terminal.quit();
          if (this.#editor) await this.#editorKey(this.#editor, key2);
          else if (this.#lines) this.#linesKey(this.#lines, key2);
          else if (this.#view === "thread") await this.#threadKey(key2, confirming);
          else await this.#feedKey(key2, confirming);
        } catch (error) {
          this.#message = { text: errorText(error), style: { tone: "del" } };
        }
        this.render();
      }
      async #feedKey(key2, confirming) {
        const target = this.#selectedTarget();
        switch (key2.name) {
          case "j":
          case "down":
            return this.#move(1);
          case "k":
          case "up":
            return this.#move(-1);
          case "g":
          case "home":
            this.#select(this.#feed?.targets[0]?.key ?? null);
            return;
          case "G":
          case "end": {
            const latest = this.#model?.responses.at(-1);
            if (latest) this.#showReply = latest.id;
            this.#newBelow = false;
            return;
          }
          case " ":
          case "pagedown":
            return this.#page(1);
          case "b":
          case "pageup":
            return this.#page(-1);
          case "d":
          case "u":
            if (key2.ctrl) this.#page(key2.name === "d" ? 0.5 : -0.5);
            return;
          case "enter":
            if (!target) return;
            if (target.kind === "note" || target.kind === "answer") return this.#openThread(target.rootId);
            if (target.file !== void 0) return this.#toggleFile(target.responseId, target.file);
            return this.#startNote(target);
          case "n":
            if (!target) return;
            if (target.kind === "note" || target.kind === "answer") return this.#startReply(target.rootId);
            return this.#startNote(target);
          case "N":
            if (target) this.#startNote({ ...target, kind: "reply", block: -1 });
            return;
          case "v":
            if (!target) return;
            if (target.kind === "block" && target.code) this.#lines = [target.start, target.start];
            else this.#message = { text: "Line notes are for code and diffs; n notes the whole block", style: MUTED4 };
            return;
          case "x":
            if (target?.kind === "note") await this.#deleteNote(target.rootId, confirming);
            return;
          case "S":
            return this.#sendPending();
          case "q":
            return this.#terminal.quit();
        }
      }
      #linesKey(lines, key2) {
        const target = this.#selectedTarget();
        if (!target) {
          this.#lines = null;
          return;
        }
        if (key2.name === "j" || key2.name === "down") lines[1] = Math.min(target.end - 1, lines[1] + 1);
        else if (key2.name === "k" || key2.name === "up") lines[1] = Math.max(target.start, lines[1] - 1);
        else if (key2.name === "escape" || key2.name === "v" || key2.name === "q") this.#lines = null;
        else if (key2.name === "n" || key2.name === "enter") {
          const [from, to] = [Math.min(...lines), Math.max(...lines)];
          const quote = target.quote.split("\n").slice(from - target.start, to - target.start + 1).join("\n");
          this.#lines = null;
          this.#startNote({ ...target, quote });
          return;
        }
        this.#keepRowVisible(lines[1]);
      }
      async #threadKey(key2, confirming) {
        const height = this.#bodyHeight();
        switch (key2.name) {
          case "j":
          case "down":
            this.#threadScroll += 1;
            return;
          case "k":
          case "up":
            this.#threadScroll -= 1;
            return;
          case " ":
          case "pagedown":
            this.#threadScroll += Math.max(1, height - 2);
            return;
          case "b":
          case "pageup":
            this.#threadScroll -= Math.max(1, height - 2);
            return;
          case "g":
          case "home":
            this.#threadScroll = 0;
            return;
          case "G":
          case "end":
            this.#threadScroll = Number.MAX_SAFE_INTEGER;
            return;
          case "r":
          case "n":
          case "enter":
            return this.#startReply(this.#threadRoot);
          case "x": {
            const pending = this.#model?.thread(this.#threadRoot).findLast((note) => note.delivered_at === null);
            if (pending) await this.#deleteNote(pending.id, confirming);
            else this.#message = { text: "Nothing unsent in this thread to delete", style: MUTED4 };
            return;
          }
          case "f":
            return this.#showInFeed();
          case "S":
            return this.#sendPending();
          case "escape":
          case "left":
          case "h":
            return this.#closeThread();
          case "q":
            return this.#terminal.quit();
        }
      }
      async #editorKey(editing, key2) {
        const { text } = editing;
        const width = this.#editorWidth();
        if (key2.name === "escape") return this.#closeEditor();
        if (key2.name === "enter" && (key2.alt || key2.shift)) return text.insert("\n");
        if (key2.name === "enter") return this.#submit(editing, this.#model?.canSend() ?? false);
        if (key2.ctrl && key2.name === "s") return this.#submit(editing, false);
        if (key2.ctrl && key2.name === "e") {
          const edited = await this.#terminal.editText(text.text);
          if (edited !== null) editing.text = new NoteText(edited.replace(/\n+$/, ""));
          return;
        }
        if (key2.name === "paste") return text.insert(key2.text);
        if (key2.name === "backspace") return key2.alt || key2.ctrl ? text.deleteWord() : text.backspace();
        if (key2.ctrl && key2.name === "w") return text.deleteWord();
        if (key2.name === "delete") return text.deleteForward();
        if (key2.name === "left") return text.left();
        if (key2.name === "right") return text.right();
        if (key2.name === "up") return text.vertical(-1, width);
        if (key2.name === "down") return text.vertical(1, width);
        if (key2.name === "home" || key2.ctrl && key2.name === "a") return text.home();
        if (key2.name === "end") return text.end();
        if (key2.text && !key2.ctrl && !key2.alt) text.insert(key2.text);
      }
      // ---- Actions --------------------------------------------------------------------------
      #move(direction) {
        const targets = this.#feed?.targets ?? [];
        const index = targets.findIndex((target) => target.key === this.#selected);
        const current = targets[index];
        const height = this.#bodyHeight();
        const step = Math.max(1, Math.floor(height / 2));
        if (current && direction > 0 && current.end > this.#scroll + height) {
          this.#scroll = Math.min(this.#scroll + step, current.end - height);
          return;
        }
        if (current && direction < 0 && current.start < this.#scroll) {
          this.#scroll = Math.max(this.#scroll - step, current.start);
          return;
        }
        const next = index < 0 ? targets[0] : targets[index + direction];
        if (next) this.#select(next.key);
      }
      /** Scrolls by pages, and puts the cursor on the first thing in view. */
      #page(pages) {
        const height = this.#bodyHeight();
        this.#scroll += Math.trunc(pages * Math.max(1, height - 2)) || (pages > 0 ? 1 : -1);
        this.#scroll = this.#clampScroll(this.#scroll);
        const first = this.#feed?.targets.find((target) => target.end > this.#scroll);
        if (first) this.#selected = first.key;
      }
      #select(key2) {
        this.#selected = key2;
        this.#reveal = true;
      }
      #toggleFile(responseId, file) {
        const open = new Set(this.#openFiles.get(responseId) ?? [0]);
        if (open.has(file)) open.delete(file);
        else open.add(file);
        this.#openFiles.set(responseId, open);
      }
      #startNote(target) {
        const whole = target.kind === "reply" || target.block < 0;
        const quote = whole ? "" : target.quote;
        const draftKey = whole ? `r:${target.responseId}` : `${target.key}:${quote}`;
        const title = whole ? "Note on the whole reply" : `Note on: ${quote.replace(/\s+/g, " ")}`;
        this.#openEditor(
          {
            response_id: target.responseId,
            block_index: whole ? -1 : target.block,
            quote: truncate(quote, MAX_QUOTE_CHARS)
          },
          draftKey,
          title
        );
      }
      #startReply(rootId) {
        this.#openEditor({ parent_id: rootId }, `t:${rootId}`, "Reply in this thread");
      }
      #openEditor(request, draftKey, title) {
        this.#editor = { text: new NoteText(this.#drafts.get(draftKey) ?? ""), request, draftKey, title, scroll: 0 };
      }
      #closeEditor() {
        const editing = this.#editor;
        this.#editor = null;
        if (!editing) return;
        if (editing.text.isBlank) {
          this.#drafts.delete(editing.draftKey);
        } else {
          this.#drafts.set(editing.draftKey, editing.text.text);
          this.#message = { text: "Draft kept: open the note again to finish it", style: MUTED4 };
        }
      }
      async #submit(editing, sendNow) {
        const model = this.#model;
        if (!model) return;
        if (editing.text.isBlank) {
          this.#message = { text: "Write something first, or press Esc", style: MUTED4 };
          return;
        }
        await this.#api.addNote({ ...editing.request, body: editing.text.text });
        this.#drafts.delete(editing.draftKey);
        this.#editor = null;
        if (sendNow) {
          await this.#api.send(model.sessionId);
          this.#message = model.sendStatus().status === "busy" ? { text: "Saved. Claude is working; it goes as soon as it finishes", style: ACCENT } : { text: "Sent to Claude", style: ACCENT };
        } else {
          this.#message = model.canSend() ? { text: "Saved. It goes with your next prompt, or press S to send now", style: MUTED4 } : { text: "Saved. Claude isn't listening here, so it goes with your next prompt", style: MUTED4 };
        }
        await this.refresh();
      }
      async #sendPending() {
        const model = this.#model;
        if (!model) return;
        const pending = model.pendingCount();
        if (!pending) {
          this.#message = { text: "No pending notes to send", style: MUTED4 };
        } else if (!model.canSend()) {
          this.#message = { text: "Claude isn't listening: pending notes go with your next prompt there", style: MUTED4 };
        } else {
          await this.#api.send(model.sessionId);
          this.#message = { text: `Sending ${plural(pending, "note", "notes")} to Claude`, style: ACCENT };
          await this.refresh();
        }
      }
      async #deleteNote(noteId, confirming) {
        const note = this.#model?.note(noteId);
        if (!note) return;
        if (note.delivered_at !== null) {
          this.#message = { text: "Only notes that haven't been sent can be deleted", style: MUTED4 };
          return;
        }
        if (confirming !== noteId) {
          this.#confirmDelete = noteId;
          this.#message = { text: "Press x again to delete this note", style: { tone: "del" } };
          return;
        }
        await this.#api.deleteNote(noteId);
        this.#message = { text: "Note deleted", style: MUTED4 };
        await this.refresh();
      }
      #openThread(rootId) {
        this.#view = "thread";
        this.#threadRoot = rootId;
        this.#threadScroll = 0;
      }
      #closeThread() {
        const rootId = this.#threadRoot;
        this.#view = "feed";
        this.#threadRoot = null;
        if (rootId !== null && this.#model?.note(rootId)) this.#select(`n:${rootId}`);
      }
      /** Back to the feed, on the block the thread's note is about. */
      #showInFeed() {
        const root = this.#model?.note(this.#threadRoot);
        this.#closeThread();
        if (!root) return;
        const block = this.#feed?.targets.find(
          (target) => target.kind === "block" && target.responseId === root.response_id && target.block === root.block_index
        );
        this.#select(block?.key ?? `r:${root.response_id}`);
      }
      // ---- Drawing --------------------------------------------------------------------------
      render() {
        const { columns, rows } = this.#terminal.size();
        if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
          this.#terminal.draw(
            [this.#ansiRow(clipSpans([{ text: "Make this pane larger for sidenote", style: MUTED4 }], columns))],
            null
          );
          return;
        }
        const frame = [this.#ansiRow(this.#topBar(columns))];
        const bottom = this.#editor ? this.#editorRows(this.#editor, columns) : null;
        const height = this.#bodyHeight();
        const body = this.#view === "thread" ? this.#threadBody(columns, height) : this.#feedBody(columns, height);
        frame.push(...body.map((spans) => this.#ansiRow(clipSpans(spans, columns))));
        let cursor = null;
        if (bottom) {
          cursor = { row: frame.length + bottom.cursor.row, column: bottom.cursor.column };
          frame.push(...bottom.rows.map((spans) => this.#ansiRow(spans)));
        } else {
          frame.push(this.#ansiRow(clipSpans(this.#hint(), columns)));
        }
        this.#terminal.draw(frame, cursor);
      }
      #bodyHeight() {
        const { columns, rows } = this.#terminal.size();
        const bottom = this.#editor ? this.#editorRows(this.#editor, columns).rows.length : 1;
        return Math.max(1, rows - 1 - bottom);
      }
      #topBar(columns) {
        const model = this.#model;
        const session = model?.snapshot.session;
        const name = terminalSafe(session ? session.name || projectName(session.cwd) : projectName(this.#cwd));
        const left = [
          { text: "sidenote", style: { bold: true } },
          { text: " \xB7 ", style: MUTED4 },
          { text: name, style: PLAIN }
        ];
        const right = [];
        if (!this.#reachable) {
          right.push({ text: "can't reach sidenote, retrying", style: { tone: "del" } });
        } else if (model && session) {
          const pending = model.pendingCount();
          const { status, send_requested: queued } = model.sendStatus();
          if (pending) right.push({ text: queued ? `${pending} sending\u2026 \xB7 ` : `${pending} pending \xB7 `, style: ACCENT });
          right.push(
            status === "listening" ? { text: "\u25CF listening", style: { tone: "add" } } : status === "busy" ? { text: "\u25D0 Claude is working", style: ACCENT } : { text: "\u25CB not listening", style: MUTED4 }
          );
        }
        const rightWidth = spansWidth(right);
        const leftClipped = clipSpans(left, Math.max(10, columns - rightWidth - 2));
        const gap = columns - spansWidth(leftClipped) - rightWidth;
        return gap > 0 ? [...leftClipped, { text: " ".repeat(gap), style: PLAIN }, ...right] : leftClipped;
      }
      #feedBody(columns, height) {
        const model = this.#model;
        if (!model || !model.responses.length) return emptyState(this.#emptyText(), height);
        const width = columns - GUTTER;
        if (width !== this.#renderWidth) {
          this.#renders.clear();
          this.#renderWidth = width;
        }
        const before = this.#selectedTarget();
        const feed = buildFeed(model, { width, selectedKey: this.#selected, render: (r, w2) => this.#render(r, w2) });
        this.#feed = feed;
        if (this.#showReply !== null && feed.replyStarts.has(this.#showReply)) {
          const id = this.#showReply;
          this.#showReply = null;
          this.#newBelow = false;
          const first = feed.targets.find((t) => t.responseId === id && t.kind === "block") ?? feed.targets.find((t) => t.responseId === id);
          this.#selected = first?.key ?? null;
          this.#scroll = feed.replyStarts.get(id);
          this.#reveal = false;
        }
        let target = this.#selectedTarget();
        if (!target && feed.targets.length) {
          const fallback = feed.targets.find((t) => t.start >= (before?.start ?? 0)) ?? feed.targets.at(-1);
          this.#selected = fallback.key;
          target = fallback;
          this.#reveal = true;
        } else if (target && before && !this.#reveal) {
          this.#scroll += target.start - before.start;
        }
        if (target && this.#reveal) this.#revealTarget(target, height);
        this.#reveal = false;
        this.#scroll = this.#clampScroll(this.#scroll);
        if (this.#scroll + height >= feed.rows.length) this.#newBelow = false;
        const lines = this.#lines;
        const [lineFrom, lineTo] = lines ? [Math.min(...lines), Math.max(...lines)] : [-1, -1];
        const out = [];
        for (let row = this.#scroll; row < this.#scroll + height; row++) {
          const content = feed.rows[row];
          if (!content) {
            out.push([]);
            continue;
          }
          const onTarget = target?.side === "left" && row >= target.start && row < target.end;
          const gutter = row >= lineFrom && row <= lineTo ? { text: "\u2503 ", style: { tone: "accent", bold: true } } : onTarget && !lines ? { text: "\u258C ", style: ACCENT } : { text: "  ", style: PLAIN };
          const spans = [gutter, ...content.left];
          if (content.right.length) {
            const pad = GUTTER + feed.leftWidth + 3 - spansWidth(spans);
            spans.push({ text: " ".repeat(Math.max(1, pad)), style: PLAIN }, ...content.right);
          }
          out.push(spans);
        }
        return out;
      }
      #threadBody(columns, height) {
        const rows = this.#model && this.#threadRoot !== null ? buildThread(this.#model, this.#threadRoot, columns - GUTTER) : null;
        if (!rows) {
          this.#closeThread();
          return this.#feedBody(columns, height);
        }
        this.#threadScroll = Math.max(0, Math.min(this.#threadScroll, rows.length - height));
        return Array.from({ length: height }, (_2, i) => {
          const spans = rows[this.#threadScroll + i];
          return spans ? [{ text: "  ", style: PLAIN }, ...spans] : [];
        });
      }
      #editorRows(editing, columns) {
        const width = this.#editorWidth();
        const layout = editing.text.layout(width);
        const visible = Math.min(EDITOR_MAX_ROWS, layout.rows.length);
        editing.scroll = Math.min(Math.max(editing.scroll, layout.cursorRow - visible + 1), layout.cursorRow);
        const title = clipSpans([{ text: `\u2500\u2500 ${terminalSafe(editing.title)} `, style: MUTED4 }], columns);
        const rule = Math.max(0, columns - spansWidth(title));
        const rows = [[...title, { text: "\u2500".repeat(rule), style: MUTED4 }]];
        for (let i = 0; i < visible; i++) {
          const text = layout.rows[editing.scroll + i] ?? "";
          rows.push([
            { text: "  ", style: PLAIN },
            { text, style: PLAIN }
          ]);
        }
        if (editing.text.text === "") {
          const placeholder = "parent_id" in editing.request ? "Your follow-up for Claude\u2026" : "Your note for Claude\u2026";
          rows[1] = [
            { text: "  ", style: PLAIN },
            { text: placeholder, style: MUTED4 }
          ];
        }
        const canSend = this.#model?.canSend() ?? false;
        const hint = canSend ? "\u23CE send now \xB7 ^S save for later \xB7 \u2325\u23CE new line \xB7 ^E $EDITOR \xB7 esc close" : "\u23CE save: Claude isn't listening, so it goes with your next prompt \xB7 \u2325\u23CE new line \xB7 esc close";
        rows.push(
          this.#message ? [{ text: this.#message.text, style: this.#message.style }] : [{ text: hint, style: MUTED4 }]
        );
        return {
          rows: rows.map((spans) => clipSpans(spans, columns)),
          cursor: { row: 1 + layout.cursorRow - editing.scroll, column: 2 + layout.cursorColumn }
        };
      }
      #editorWidth() {
        return Math.max(10, this.#terminal.size().columns - 3);
      }
      #hint() {
        if (this.#message) return [{ text: this.#message.text, style: this.#message.style }];
        const parts = [];
        if (this.#lines) {
          parts.push("j/k pick lines", "n note on these lines", "esc cancel");
        } else if (this.#view === "thread") {
          parts.push("j/k scroll", "r reply", "x delete unsent", "f show in feed", "esc back");
        } else {
          const target = this.#selectedTarget();
          parts.push("j/k move");
          if (target?.kind === "note" || target?.kind === "answer") parts.push("\u23CE open thread", "n reply");
          else if (target?.file !== void 0) parts.push("\u23CE fold", "n note");
          else if (target) parts.push("n note");
          if (target?.kind === "note") parts.push("x delete");
          if (target?.code) parts.push("v pick lines");
          parts.push("N note on reply");
        }
        if (this.#model?.pendingCount() && this.#model.canSend()) parts.push("S send now");
        parts.push("q quit");
        const spans = [];
        if (this.#newBelow) spans.push({ text: "\u2193 new reply: G \xB7 ", style: ACCENT });
        spans.push({ text: parts.join(" \xB7 "), style: MUTED4 });
        return spans;
      }
      #emptyText() {
        if (!this.#reachable) return "Can't reach the sidenote server. Retrying\u2026";
        if (!this.#model)
          return `Waiting for a Claude Code session in ${projectName(this.#cwd)}. Its replies appear here as Claude finishes them.`;
        return "No replies in this session yet. They appear here as Claude finishes them.";
      }
      #render(response, width) {
        const open = this.#openFiles.get(response.id);
        const key2 = `${response.id}:${width}:${open ? [...open].sort().join(",") : "default"}`;
        let rendered = this.#renders.get(key2);
        if (!rendered) {
          rendered = renderReply(response.text, {
            width,
            ...open ? { isFileOpen: (file) => open.has(file) } : {}
          });
          this.#renders.set(key2, rendered);
        }
        return rendered;
      }
      #selectedTarget() {
        return this.#feed?.targets.find((target) => target.key === this.#selected);
      }
      #revealTarget(target, height) {
        const size = target.end - target.start;
        if (size > height) {
          if (this.#scroll < target.start || this.#scroll + height > target.end) this.#scroll = target.start;
        } else if (target.start < this.#scroll) {
          this.#scroll = target.start;
        } else if (target.end > this.#scroll + height) {
          this.#scroll = target.end - height;
        }
      }
      #keepRowVisible(row) {
        const height = this.#bodyHeight();
        if (row < this.#scroll) this.#scroll = row;
        else if (row >= this.#scroll + height) this.#scroll = row - height + 1;
      }
      #clampScroll(scroll) {
        const rows = this.#feed?.rows.length ?? 0;
        return Math.max(0, Math.min(scroll, rows - this.#bodyHeight()));
      }
      #ansiRow(spans) {
        return lineToAnsi({ spans, block: -1 }, this.#ansi);
      }
    };
  }
});

// src/tui/keys.ts
function key(name, fields = {}) {
  return { name, text: "", ctrl: false, alt: false, shift: false, ...fields };
}
function parseKeys(data) {
  const keys = [];
  let i = 0;
  while (i < data.length) {
    if (data.startsWith(PASTE_START, i)) {
      const end = data.indexOf(PASTE_END, i + PASTE_START.length);
      const text = data.slice(i + PASTE_START.length, end < 0 ? void 0 : end);
      keys.push(key("paste", { text: text.replace(/\r\n?/g, "\n") }));
      i = end < 0 ? data.length : end + PASTE_END.length;
      continue;
    }
    if (data[i] === "\x1B") {
      const sequence = CSI.exec(data.slice(i));
      if (sequence) {
        keys.push(fromCsi(sequence[1], sequence[2]));
        i += sequence[0].length;
        continue;
      }
      const next = data.codePointAt(i + 1);
      if (next === void 0 || next === 27) {
        keys.push(key("escape"));
        i += 1;
        continue;
      }
      const char2 = String.fromCodePoint(next);
      keys.push({ ...single(char2), alt: true });
      i += 1 + char2.length;
      continue;
    }
    const char = String.fromCodePoint(data.codePointAt(i));
    keys.push(single(char));
    i += char.length;
  }
  return keys;
}
function single(char) {
  const code2 = char.codePointAt(0);
  if (char === "\r" || char === "\n") return key("enter");
  if (char === "	") return key("tab");
  if (code2 === 127 || code2 === 8) return key("backspace");
  if (code2 >= 1 && code2 <= 26) return key(String.fromCharCode(code2 + 96), { ctrl: true });
  if (code2 < 32) return key("unknown");
  return key(char, { text: char });
}
function fromCsi(params, final) {
  const [first = "", modifier = "1"] = params.split(";");
  const bits = Math.max(0, Number(modifier) - 1);
  const mods = { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
  if (final === "~") return key(CSI_TILDES.get(first) ?? "unknown", mods);
  if (final === "u") {
    const code2 = Number(first);
    const name = CSI_U_CODES.get(code2);
    if (name) return key(name, mods);
    const char = String.fromCodePoint(code2);
    return key(char, { ...mods, text: mods.ctrl || mods.alt ? "" : char });
  }
  if (final === "Z") return key("tab", { ...mods, shift: true });
  return key(CSI_LETTERS.get(final) ?? "unknown", mods);
}
var PASTE_START, PASTE_END, CSI, CSI_LETTERS, CSI_TILDES, CSI_U_CODES;
var init_keys = __esm({
  "src/tui/keys.ts"() {
    "use strict";
    PASTE_START = "\x1B[200~";
    PASTE_END = "\x1B[201~";
    CSI = /^\x1b[[O]([0-9;]*)([A-Za-z~])/;
    CSI_LETTERS = /* @__PURE__ */ new Map([
      ["A", "up"],
      ["B", "down"],
      ["C", "right"],
      ["D", "left"],
      ["H", "home"],
      ["F", "end"],
      ["Z", "tab"]
      // Shift+Tab
    ]);
    CSI_TILDES = /* @__PURE__ */ new Map([
      ["1", "home"],
      ["7", "home"],
      ["4", "end"],
      ["8", "end"],
      ["3", "delete"],
      ["5", "pageup"],
      ["6", "pagedown"]
    ]);
    CSI_U_CODES = /* @__PURE__ */ new Map([
      [13, "enter"],
      [9, "tab"],
      [27, "escape"],
      [127, "backspace"]
    ]);
  }
});

// src/tui/screen.ts
var ENTER, LEAVE, SYNC_START, SYNC_END, Screen;
var init_screen = __esm({
  "src/tui/screen.ts"() {
    "use strict";
    init_keys();
    ENTER = "\x1B[?1049h\x1B[?7l\x1B[?2004h\x1B[?25l\x1B[2J";
    LEAVE = "\x1B[?2004l\x1B[?7h\x1B[?25h\x1B[?1049l";
    SYNC_START = "\x1B[?2026h";
    SYNC_END = "\x1B[?2026l";
    Screen = class {
      #input;
      #output;
      #previous = [];
      #active = false;
      #onData = null;
      constructor(input, output) {
        this.#input = input;
        this.#output = output;
      }
      size() {
        return { columns: this.#output.columns || 80, rows: this.#output.rows || 24 };
      }
      start(onKeys, onResize) {
        this.#onData = (data) => onKeys(parseKeys(data));
        this.#input.setEncoding("utf8");
        this.#input.on("data", this.#onData);
        this.#output.on("resize", () => {
          this.#previous = [];
          this.#output.write("\x1B[2J");
          onResize();
        });
        this.#enter();
      }
      /** Puts the terminal back as it was. Safe to call more than once. */
      stop() {
        if (!this.#active) return;
        this.#active = false;
        this.#output.write(LEAVE);
        this.#input.setRawMode(false);
        this.#input.pause();
      }
      draw(rows, cursor) {
        if (!this.#active) return;
        let out = `${SYNC_START}\x1B[?25l`;
        const count = Math.max(rows.length, this.#previous.length);
        for (let i = 0; i < count; i++) {
          const row = rows[i] ?? "";
          if (row !== this.#previous[i]) out += `\x1B[${i + 1};1H\x1B[0m\x1B[2K${row}\x1B[0m`;
        }
        if (cursor) out += `\x1B[${cursor.row + 1};${cursor.column + 1}H\x1B[?25h`;
        this.#output.write(out + SYNC_END);
        this.#previous = rows;
      }
      /** Lends the terminal to another program, such as $EDITOR, then takes it back. */
      suspend(run2) {
        this.stop();
        try {
          return run2();
        } finally {
          this.#input.resume();
          this.#enter();
        }
      }
      #enter() {
        this.#input.setRawMode(true);
        this.#input.resume();
        this.#output.write(ENTER);
        this.#previous = [];
        this.#active = true;
      }
    };
  }
});

// src/tui/main.ts
var main_exports = {};
__export(main_exports, {
  runTui: () => runTui,
  terminalOptions: () => terminalOptions
});
import { spawnSync } from "node:child_process";
import { existsSync as existsSync2, mkdtempSync, readFileSync as readFileSync6, rmSync as rmSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { tmpdir } from "node:os";
import { join as join5 } from "node:path";
import { setTimeout as sleep3 } from "node:timers/promises";
function supportsHyperlinks(env) {
  if (env["SIDENOTE_HYPERLINKS"] === "0") return false;
  if (env["SIDENOTE_HYPERLINKS"] === "1") return true;
  const program = env["TERM_PROGRAM"] ?? "";
  return ["iTerm.app", "WezTerm", "vscode", "ghostty"].includes(program) || Boolean(env["KITTY_WINDOW_ID"] || env["WT_SESSION"]) || Number(env["VTE_VERSION"] ?? 0) >= 5e3;
}
function terminalOptions(env) {
  return { color: !env["NO_COLOR"] && env["TERM"] !== "dumb", hyperlinks: supportsHyperlinks(env) };
}
async function runTui(args) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("sidenote tui needs a terminal.");
    process.exitCode = 1;
    return;
  }
  if (!existsSync2(paths.enabledFlag())) {
    console.error("sidenote is off. Turn it on in Claude Code with /sidenote:on, then run sidenote tui again.");
    process.exitCode = 1;
    return;
  }
  const requested = args.find((arg) => !arg.startsWith("-"));
  if (requested !== void 0 && !SESSION_ID_PATTERN.test(requested)) {
    console.error("That doesn't look like a Claude Code session id.");
    process.exitCode = 2;
    return;
  }
  const { client } = await SidenoteClient.ensure();
  const screen = new Screen(process.stdin, process.stdout);
  let running = true;
  let releasePane = () => {
  };
  const quit = (code2 = 0) => {
    running = false;
    screen.stop();
    releasePane();
    process.exit(code2);
  };
  const app = new App({
    api: new ClientApi(client),
    ansi: terminalOptions(process.env),
    sessionId: requested ?? null,
    cwd: process.cwd(),
    terminal: {
      size: () => screen.size(),
      draw: (rows, cursor) => screen.draw(rows, cursor),
      editText: async (text) => screen.suspend(() => editInEditor(text)),
      quit: () => quit()
    }
  });
  for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => quit());
  process.on("uncaughtException", (error) => {
    screen.stop();
    releasePane();
    console.error(`sidenote tui stopped: ${error.message}`);
    process.exit(1);
  });
  let queue = Promise.resolve();
  screen.start(
    (keys) => {
      for (const key2 of keys) queue = queue.then(() => app.handleKey(key2));
    },
    () => app.render()
  );
  let claimed = null;
  while (running) {
    await app.refresh();
    if (app.sessionId && app.sessionId !== claimed) {
      releasePane();
      releasePane = claimPane(app.sessionId);
      claimed = app.sessionId;
    }
    await sleep3(POLL_INTERVAL_MS);
  }
}
function editInEditor(text) {
  const editor = (process.env["VISUAL"] || process.env["EDITOR"] || "vi").trim().split(/\s+/);
  const dir = mkdtempSync(join5(tmpdir(), "sidenote-note-"));
  const file = join5(dir, "note.md");
  try {
    writeFileSync3(file, text, { mode: 384 });
    const result = spawnSync(editor[0], [...editor.slice(1), file], { stdio: "inherit" });
    return result.status === 0 ? readFileSync6(file, "utf8") : null;
  } catch {
    return null;
  } finally {
    rmSync3(dir, { recursive: true, force: true });
  }
}
var POLL_INTERVAL_MS;
var init_main = __esm({
  "src/tui/main.ts"() {
    "use strict";
    init_client();
    init_panes();
    init_paths();
    init_types();
    init_api();
    init_app();
    init_screen();
    POLL_INTERVAL_MS = 1e3;
  }
});

// src/cli/main.ts
init_paths();
init_client();
import { appendFileSync, existsSync as existsSync3, mkdirSync as mkdirSync4, rmSync as rmSync4, writeFileSync as writeFileSync4 } from "node:fs";

// src/cli/config.ts
init_paths();
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync } from "node:fs";
function isUi(value) {
  return value === "browser" || value === "terminal";
}
function readUi() {
  try {
    const config = JSON.parse(readFileSync2(paths.configFile(), "utf8"));
    return config.ui === "terminal" ? "terminal" : "browser";
  } catch {
    return "browser";
  }
}
function writeUi(ui) {
  mkdirSync2(paths.stateDir(), { recursive: true, mode: 448 });
  writeFileSync(paths.configFile(), `${JSON.stringify({ ui })}
`, { mode: 384 });
}

// src/cli/hooks.ts
init_client();
import { randomBytes } from "node:crypto";
import { readFileSync as readFileSync5 } from "node:fs";
import { setTimeout as sleep2 } from "node:timers/promises";

// src/cli/format.ts
var MAX_CONTEXT_CHARS = 9500;
var CODE_CHANGE_RULE = "When you show a code change, or the user asks to see code or a diff, show it as changes to the current code, not as whole files: for each change, a sentence or two on what it does and why, then a ```diff block in unified diff format. Start each block with `--- a/<path>` and `+++ b/<path>` lines and use @@ hunks with about three lines of context. Use one block per file or per step. Put the diff in your reply itself, not only in command output such as `git diff`, because the sidenote window shows only your replies.";
function sessionContext() {
  return "The user follows this session in the sidenote browser window, which shows your replies and draws ```diff blocks as diffs. " + CODE_CHANGE_RULE;
}
function formatNotesForClaude(notes, options = {}) {
  const first = notes[0];
  if (!first) return "";
  const [intro, formatRule] = options.fromBrowser ? [
    "The user clicked Send now in the sidenote browser window. There is no new terminal message: answer only these inline notes on your earlier responses.",
    "Format: skip any main answer. Answer each note in its own section that starts with a line containing only its marker, for example:"
  ] : [
    "The user reviewed your earlier responses in the sidenote browser window and left these inline notes. Address them together with the user's message.",
    "Format: first answer the user's message as usual (skip this part if their message only asks you to look at the notes). Then answer each note in its own section that starts with a line containing only its marker, for example:"
  ];
  const lines = [
    intro,
    "",
    formatRule,
    "",
    `**\u21B3 Re: note ${first.id}**`,
    `Your answer to note ${first.id}.`,
    "",
    "Use one marker per note, with the note numbers given below, and put nothing after a note's section that is not about that note. The sidenote window files each section into that note's thread, so keep the main answer free of the note answers.",
    "",
    CODE_CHANGE_RULE
  ];
  for (const note of notes) {
    const time = clockTime(note.response_created_at);
    const quote = note.quote ? note.quote.split(/\r?\n/).map((line) => `> ${line}`).join("\n") : "> (whole response)";
    if (note.root_body) {
      lines.push(
        `
Note ${note.id}, a follow-up in the thread on your response from ${time}:
${quote}
Their earlier note: ${note.root_body}
Follow-up: ${note.body}`
      );
    } else {
      lines.push(`
Note ${note.id}, on your response from ${time}:
${quote}
${note.body}`);
    }
  }
  const text = lines.join("\n");
  return text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}
[truncated: more comments are visible in the sidenote window]` : text;
}
function clockTime(epochSeconds) {
  const date = new Date(epochSeconds * 1e3);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// src/cli/hooks.ts
init_panes();

// src/cli/transcript.ts
import { existsSync, readdirSync, readFileSync as readFileSync4 } from "node:fs";
import { join as join4 } from "node:path";
var QUESTION_TOOLS = /* @__PURE__ */ new Set(["AskUserQuestion", "ExitPlanMode"]);
function findTranscript(transcriptsDir, sessionId) {
  if (!existsSync(transcriptsDir)) return null;
  for (const project of readdirSync(transcriptsDir)) {
    const file = join4(transcriptsDir, project, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}
function finalResponsesPerTurn(transcript) {
  const replies = [];
  let lastMessageId;
  let lastBlocks = [];
  let lastTimestamp = 0;
  const flush = () => {
    replies.push({ createdAt: lastTimestamp, text: lastBlocks.join("\n\n").trim() });
    lastMessageId = void 0;
    lastBlocks = [];
  };
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    const entry2 = JSON.parse(line);
    if (entry2.isSidechain) continue;
    if (entry2.type === "user" && isUserPrompt(entry2) && lastBlocks.length) {
      flush();
    } else if (entry2.type === "assistant") {
      const content = entry2.message?.content;
      const blocks = Array.isArray(content) ? content : [];
      if (blocks.some((b) => b.name && QUESTION_TOOLS.has(b.name)) && lastBlocks.length) {
        flush();
        continue;
      }
      const texts = blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text);
      if (!texts.length) continue;
      if (entry2.message?.id !== lastMessageId) {
        lastMessageId = entry2.message?.id;
        lastBlocks = [];
      }
      lastBlocks.push(...texts);
      if (entry2.timestamp) lastTimestamp = Date.parse(entry2.timestamp) / 1e3;
    }
  }
  return replies;
}
function sessionNameFromTranscript(transcript) {
  let marker = transcript.lastIndexOf('"custom-title"');
  while (marker !== -1) {
    const start = transcript.lastIndexOf("\n", marker) + 1;
    const end = transcript.indexOf("\n", marker);
    try {
      const entry2 = JSON.parse(transcript.slice(start, end === -1 ? void 0 : end));
      if (entry2.type === "custom-title" && typeof entry2.customTitle === "string") return entry2.customTitle.trim();
    } catch {
    }
    marker = start > 0 ? transcript.lastIndexOf('"custom-title"', start - 1) : -1;
  }
  return "";
}
function cwdFromTranscript(transcript) {
  for (const line of transcript.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    try {
      const cwd = JSON.parse(line).cwd;
      if (cwd) return cwd;
    } catch {
    }
  }
  return "";
}
function readTranscript(file) {
  return readFileSync4(file, "utf8");
}
function isUserPrompt(entry2) {
  if (entry2.isMeta) return false;
  const content = entry2.message?.content;
  if (typeof content === "string") return true;
  return Array.isArray(content) && !content.some((b) => b.type === "tool_result");
}

// src/cli/hooks.ts
var WAITER_POLL_MS = 1e3;
function sessionName(transcriptPath) {
  if (!transcriptPath) return "";
  try {
    return sessionNameFromTranscript(readFileSync5(transcriptPath, "utf8"));
  } catch {
    return "";
  }
}
async function hookStop(input) {
  const text = input.last_assistant_message?.trim();
  const sessionId = input.session_id;
  if (!text || !sessionId) return;
  const { client, started } = await SidenoteClient.ensure();
  const reply = {
    session_id: sessionId,
    session_name: sessionName(input.transcript_path),
    cwd: input.cwd ?? "",
    text
  };
  const result = await client.post("/api/responses", reply);
  if (!started && !result.new_session) return;
  if (readUi() === "browser") {
    openBrowser(await client.windowUrl(sessionId));
    return;
  }
  const pane = await openTerminal(sessionId, input.cwd ?? "", process.env);
  if (!pane.opened) process.stdout.write(`${JSON.stringify({ systemMessage: pane.message })}
`);
}
async function hookSession() {
  const output = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sessionContext() } };
  process.stdout.write(`${JSON.stringify(output)}
`);
}
async function hookPrompt(input) {
  const client = await SidenoteClient.connect();
  if (!client || !input.session_id) return;
  const { comments } = await client.post("/api/claim", { session_id: input.session_id });
  if (!comments.length) return;
  const output = {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: formatNotesForClaude(comments) }
  };
  process.stdout.write(`${JSON.stringify(output)}
`);
}
async function hookWait(input) {
  if (!input.session_id) return;
  const client = await connectWithin(SERVER_START_TIMEOUT_MS);
  if (!client) return;
  const waiter = { session_id: input.session_id, waiter_id: randomBytes(8).toString("hex") };
  await client.post("/api/waiters", waiter);
  for (; ; ) {
    await sleep2(WAITER_POLL_MS);
    let result;
    try {
      result = await client.post("/api/waiters/poll", waiter);
    } catch {
      return;
    }
    if (result.action === "exit") return;
    if (result.action === "send") {
      process.stderr.write(formatNotesForClaude(result.comments, { fromBrowser: true }));
      process.exitCode = 2;
      return;
    }
  }
}
async function connectWithin(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (; ; ) {
    const client = await SidenoteClient.connect();
    if (client || Date.now() > deadline) return client;
    await sleep2(500);
  }
}

// src/cli/main.ts
init_panes();
var USAGE = `sidenote: leave inline notes on Claude Code replies in your browser or terminal.

  sidenote on [session] [terminal|browser]
                               turn sidenote on and open the session's window, in the browser
                               or in a terminal pane; the choice is remembered
  sidenote tui [session]       show the session's replies in this terminal; without a session,
                               the latest one in this folder
  sidenote off                 turn sidenote off; unsent notes are kept
  sidenote open [session]      reopen the session's window
  sidenote status [session]    show the session's replies, notes and Send now status
  sidenote backfill [session]  import the session's earlier replies
  sidenote hook-session        SessionStart hook: ask Claude to show code changes as diffs
  sidenote hook-stop           Stop hook: send the finished reply to its session's window
  sidenote hook-prompt         UserPromptSubmit hook: attach pending notes to the prompt
  sidenote hook-wait           async Stop hook: wake Claude when the browser clicks Send now

The /sidenote:* commands pass the current session. Without one, the most recently active
session is used.`;
var NOT_RUNNING = "The sidenote server is not running; use /sidenote:on first.";
var isEnabled = () => existsSync3(paths.enabledFlag());
function sessionArgument() {
  const value = process.argv[3]?.trim();
  return value && !value.includes("$") ? value : void 0;
}
async function latestSession(client) {
  const { sessions } = await client.get("/api/sessions");
  return sessions[0]?.id;
}
function fetchState(client, sessionId) {
  return client.get(`/api/state?s=${encodeURIComponent(sessionId ?? "")}`);
}
async function touchSession(client, sessionId) {
  const file = findTranscript(paths.transcriptsDir(), sessionId);
  const transcript = file ? readTranscript(file) : "";
  await client.post("/api/sessions", {
    session_id: sessionId,
    session_name: sessionNameFromTranscript(transcript),
    cwd: cwdFromTranscript(transcript)
  });
}
function uiArgument() {
  const value = process.argv[4]?.trim().toLowerCase();
  if (!value || value.includes("$")) return void 0;
  if (isUi(value)) return value;
  throw new UsageError(`"${value}" isn't a choice: use /sidenote:on terminal or /sidenote:on browser.`);
}
var UsageError = class extends Error {
};
async function show(client, requested) {
  if (requested) await touchSession(client, requested);
  const sessionId = requested ?? await latestSession(client);
  const { session } = await fetchState(client, sessionId);
  if (readUi() === "terminal") {
    return (await openTerminal(sessionId, session?.cwd || process.cwd(), process.env)).message;
  }
  openBrowser(await client.windowUrl(sessionId));
  const label = session ? `"${session.name || session.cwd.split("/").pop() || session.id.slice(0, 8)}"` : "sidenote";
  return `Opened the ${label} window in your browser (${client.origin}).`;
}
var commands = {
  async on() {
    mkdirSync4(paths.stateDir(), { recursive: true, mode: 448 });
    const ui = uiArgument();
    writeFileSync4(paths.enabledFlag(), "");
    if (ui) writeUi(ui);
    const { client } = await SidenoteClient.ensure();
    console.log(`sidenote is on. ${await show(client, sessionArgument())}`);
  },
  async off() {
    rmSync4(paths.enabledFlag(), { force: true });
    const pid = serverPid();
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
      }
    }
    console.log("sidenote is off. Unsent notes are kept and go out after the next /sidenote:on.");
  },
  async open() {
    const client = await SidenoteClient.connect();
    console.log(client ? await show(client, sessionArgument()) : NOT_RUNNING);
  },
  async status() {
    console.log(`enabled: ${isEnabled() ? "yes" : "no"}`);
    console.log(`shows in: ${readUi()}`);
    const client = await SidenoteClient.connect();
    if (!client) {
      console.log("server:  not running");
      return;
    }
    console.log(`server:  ${client.origin}`);
    const { session, responses, comments } = await fetchState(
      client,
      sessionArgument() ?? await latestSession(client)
    );
    if (!session) {
      console.log("This session has no replies in sidenote yet.");
      return;
    }
    console.log(`session: ${session.name || "(unnamed)"} \xB7 ${session.id.slice(0, 8)} \xB7 ${session.cwd}`);
    console.log(`replies: ${responses.length}`);
    console.log(`pending notes: ${comments.filter((c2) => c2.delivered_at === null).length}`);
    console.log(`Send now: ${session.status === "offline" ? "available after Claude's next reply" : "ready"}`);
    console.log(
      `terminal: ${tuiCommand(session.id).map((part, i) => i ? part : shellQuote(part)).join(" ")}`
    );
  },
  /** Imports the session's earlier replies from its transcript, so you can leave notes on them. */
  async backfill() {
    const client = await SidenoteClient.connect();
    if (!client) {
      console.log(NOT_RUNNING);
      return;
    }
    const sessionId = sessionArgument() ?? await latestSession(client);
    const file = sessionId ? findTranscript(paths.transcriptsDir(), sessionId) : null;
    if (!sessionId || !file) {
      console.log("No transcript found for this session.");
      return;
    }
    const transcript = readTranscript(file);
    const state = await fetchState(client, sessionId);
    const known = new Set(state.responses.map((r) => r.text));
    const cwd = state.session?.cwd || cwdFromTranscript(transcript);
    const sessionName2 = sessionNameFromTranscript(transcript);
    let imported = 0;
    for (const { createdAt, text } of finalResponsesPerTurn(transcript)) {
      if (known.has(text)) continue;
      const reply = {
        session_id: sessionId,
        session_name: sessionName2,
        cwd,
        text,
        created_at: createdAt
      };
      await client.post("/api/responses", reply);
      imported += 1;
    }
    console.log(`Imported ${imported} earlier replies of this session.`);
  },
  async tui() {
    const { runTui: runTui2 } = await Promise.resolve().then(() => (init_main(), main_exports));
    await runTui2(process.argv.slice(3));
  },
  "hook-session": () => runHook(hookSession),
  "hook-stop": () => runHook(hookStop),
  "hook-prompt": () => runHook(hookPrompt),
  "hook-wait": () => runHook(hookWait)
};
async function runHook(handler) {
  if (!isEnabled()) return;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    await handler(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
  } catch (error) {
    mkdirSync4(paths.stateDir(), { recursive: true, mode: 448 });
    appendFileSync(paths.logFile(), `${(/* @__PURE__ */ new Date()).toISOString()} ${handler.name} failed: ${String(error)}
`, {
      mode: 384
    });
  }
}
var command = commands[process.argv[2] ?? "status"];
if (command) {
  try {
    await command();
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.log(error.message);
    process.exitCode = 2;
  }
} else {
  console.log(USAGE);
  process.exitCode = 2;
}
