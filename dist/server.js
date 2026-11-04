// src/server/main.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { mkdirSync, readFileSync as readFileSync4, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { createServer } from "node:http";
import { dirname, join as join3 } from "node:path";
import { fileURLToPath } from "node:url";

// src/node/open.ts
import { spawn } from "node:child_process";
function openWithSystem(target, onError) {
  const [command, args] = process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", target]] : ["xdg-open", [target]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", onError);
  child.unref();
}

// src/node/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
var stateDir = () => join(homedir(), ".sidenote");
var paths = {
  stateDir,
  storeFile: () => join(stateDir(), "store.json"),
  serverFile: () => join(stateDir(), "server.json"),
  lockFile: () => join(stateDir(), "server.lock"),
  portFile: () => join(stateDir(), "port"),
  logFile: () => join(stateDir(), "server.log"),
  enabledFlag: () => join(stateDir(), "enabled"),
  transcriptsDir: () => join(homedir(), ".claude", "projects")
};

// src/node/process.ts
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
function processInfo(pid, platform = process.platform) {
  try {
    return platform === "linux" ? linuxInfo(pid) : platform === "darwin" ? psInfo(pid) : null;
  } catch {
    return null;
  }
}
function linuxInfo(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).split(" ");
  return {
    ppid: Number(fields[1]),
    started: fields[19],
    name: stat.slice(stat.indexOf("(") + 1, close),
    args: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim()
  };
}
function psInfo(pid) {
  const ps = (field) => spawnSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  const ppid = ps("ppid");
  if (!ppid) return null;
  return { ppid: Number(ppid), started: ps("lstart"), name: ps("comm"), args: ps("args") };
}
function isSameProcess(recorded) {
  return processInfo(recorded.pid)?.started === recorded.started;
}
function pidInUse(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// src/node/terminal.ts
import { spawn as spawn2 } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join as join2 } from "node:path";
var STILL_STARTING_MS = 3e3;
var MACOS_SCRIPT = [
  "on run argv",
  'set theCommand to "cd " & quoted form of item 1 of argv & " && claude --session-id " & quoted form of item 2 of argv',
  'if item 3 of argv is not "" then set theCommand to theCommand & " " & quoted form of ("--name=" & item 3 of argv)',
  'if (count of argv) > 3 then set theCommand to theCommand & " -- " & quoted form of item 4 of argv',
  'tell application "Terminal"',
  "activate",
  "do script theCommand",
  "end tell",
  "end run"
];
function terminalCommand(platform, session) {
  const prompt = session.prompt ? [session.prompt] : [];
  if (platform === "darwin") {
    const args = [session.cwd, session.sessionId, session.name, ...prompt];
    return ["osascript", [...MACOS_SCRIPT.flatMap((line) => ["-e", line]), ...args]];
  }
  if (platform === "linux") {
    const claude = [
      "claude",
      "--session-id",
      session.sessionId,
      ...session.name ? [`--name=${session.name}`] : [],
      ...session.prompt ? ["--", session.prompt] : []
    ];
    return ["gnome-terminal", [`--working-directory=${session.cwd}`, "--", ...claude]];
  }
  return null;
}
function canStartSessions(platform = process.platform) {
  if (platform === "darwin") return true;
  return platform === "linux" && onPath("gnome-terminal");
}
function startInTerminal(command) {
  return new Promise((resolve2, reject) => {
    const child = spawn2(command[0], [...command[1]], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-500);
    });
    const stillStarting = setTimeout(() => {
      child.stderr.destroy();
      child.unref();
      resolve2();
    }, STILL_STARTING_MS);
    child.on("error", (error) => {
      clearTimeout(stillStarting);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(stillStarting);
      if (code === 0) resolve2();
      else reject(new Error(stderr.trim() || `${command[0]} exited with ${code}`));
    });
  });
}
function onPath(name) {
  return (process.env["PATH"] ?? "").split(delimiter).filter(Boolean).some((dir) => {
    try {
      accessSync(join2(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// src/shared/types.ts
var TOKEN_HEADER = "X-Review-Token";
var MAX_PROMPT_CHARS = 8e3;
var PAGE_HOST = "sidenote.localhost";
var SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// src/node/clock.ts
var systemClock = {
  now: () => Date.now() / 1e3,
  monotonicMs: () => performance.now()
};

// src/server/split.ts
var NOTE_MARKER = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*↳?\s*Re:?\s*notes?\s+(?<ids>#?\d+(?:\s*(?:,|and|&)\s*#?\d+)*)\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i;
var TRAILING_RULES = /(?:\n\s*(?:-{3,}|\*{3,}|_{3,})\s*)+$/;
var FENCE = /^\s*(?:```|~~~)/;
function splitNoteAnswers(text, noteIds) {
  const main2 = [];
  const sections = /* @__PURE__ */ new Map();
  let current = null;
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) inFence = !inFence;
    const ids = inFence ? [] : markerIds(line).filter((id) => noteIds.has(id));
    if (ids.length) {
      current = ids;
      for (const id of ids) if (!sections.has(id)) sections.set(id, []);
      continue;
    }
    if (current === null) main2.push(line);
    else for (const id of current) sections.get(id).push(line);
  }
  const answers = /* @__PURE__ */ new Map();
  for (const [id, lines] of sections) {
    const body = lines.join("\n").trim();
    if (body) answers.set(id, body);
  }
  const mainText = main2.join("\n").trim().replace(TRAILING_RULES, "").trim();
  return { mainText, answers };
}
var MAX_PROGRESS_MESSAGES = 20;
var MAX_PROGRESS_CHARS = 4e3;
function liveProgress(messages) {
  return messages.map(
    (text) => text.split(/\r?\n/).filter((line) => !NOTE_MARKER.test(line)).join("\n").trim()
  ).filter(Boolean).slice(-MAX_PROGRESS_MESSAGES).map((text) => text.length > MAX_PROGRESS_CHARS ? `\u2026${text.slice(-MAX_PROGRESS_CHARS)}` : text);
}
function markerIds(line) {
  const ids = NOTE_MARKER.exec(line)?.groups?.["ids"];
  return ids ? [...ids.matchAll(/\d+/g)].map((match) => Number(match[0])) : [];
}

// src/server/delivery.ts
var LISTENER_STALE_MS = 5e3;
var MAX_TRACKED_MESSAGES = 40;
var MAX_TRACKED_BATCHES = 2e3;
var Delivery = class {
  #store;
  #clock;
  #waiters = /* @__PURE__ */ new Map();
  /** Sessions where Claude is mid-turn. */
  #busy = /* @__PURE__ */ new Set();
  /** Sessions whose notes go out at the waiter's next poll. */
  #requested = /* @__PURE__ */ new Set();
  /** The latest tool call of each busy session. Only the page's status line needs it. */
  #activity = /* @__PURE__ */ new Map();
  /** Each busy session's messages this turn, by message id, as batches by index. */
  #progress = /* @__PURE__ */ new Map();
  #statusSignature = "";
  constructor(store, clock = systemClock) {
    this.#store = store;
    this.#clock = clock;
  }
  status(sessionId2) {
    const status = { status: this.#state(sessionId2), send_requested: this.#requested.has(sessionId2) };
    const waiting = this.#store.waitingMessageText(sessionId2);
    if (waiting) status.queued_prompt = waiting;
    const activity = this.#activity.get(sessionId2);
    if (activity) status.activity = activity;
    const messages = this.#progress.get(sessionId2);
    const progress = messages ? liveProgress([...messages.values()].map((batches) => batches.join(""))) : [];
    if (progress.length) status.progress = progress;
    return status;
  }
  /** Bumps the store's revision when a waiter went quiet, so pages see the session stop listening. */
  refresh() {
    const signature = JSON.stringify(this.#store.listSessions().map((s) => [s.id, this.status(s.id)]));
    if (signature === this.#statusSignature) return;
    this.#statusSignature = signature;
    this.#store.revision.bump();
  }
  /** A new waiter starts when Claude finishes a turn; it replaces any older one. */
  registerWaiter(sessionId2, waiterId) {
    this.#waiters.set(sessionId2, { id: waiterId, seenMs: this.#clock.monotonicMs() });
    this.#busy.delete(sessionId2);
    this.#forgetTurn(sessionId2);
  }
  /** Hooks run in the background, so one can land after its turn ended: only a busy session counts. */
  setActivity(sessionId2, text) {
    if (this.#state(sessionId2) !== "busy") return;
    this.#activity.set(sessionId2, text);
    this.#store.revision.bump();
  }
  /** Part of a message Claude is writing. Like an activity line, it can land after its turn. */
  addProgress({ session_id: sessionId2, message_id: messageId, index, delta }) {
    if (this.#state(sessionId2) !== "busy" || index >= MAX_TRACKED_BATCHES) return;
    const messages = this.#progress.get(sessionId2) ?? /* @__PURE__ */ new Map();
    this.#progress.set(sessionId2, messages);
    const batches = messages.get(messageId) ?? [];
    messages.set(messageId, batches);
    batches[index] = delta;
    if (messages.size > MAX_TRACKED_MESSAGES) messages.delete(messages.keys().next().value);
    this.#store.revision.bump();
  }
  pollWaiter(sessionId2, waiterId) {
    const waiter = this.#waiters.get(sessionId2);
    if (waiter?.id !== waiterId) return { action: "exit", comments: [] };
    waiter.seenMs = this.#clock.monotonicMs();
    if (!this.#requested.has(sessionId2)) return { action: "wait", comments: [] };
    this.#requested.delete(sessionId2);
    this.#waiters.delete(sessionId2);
    this.#busy.add(sessionId2);
    this.#forgetTurn(sessionId2);
    const comments = this.#store.claimPending(sessionId2);
    const prompt = this.#store.claimMessages(sessionId2);
    if (prompt === void 0) return comments.length ? { action: "send", comments } : { action: "exit", comments: [] };
    return { action: "send", comments, prompt };
  }
  /**
   * Queues a message typed in the page: it wakes a listening session at the waiter's next poll, or
   * goes as soon as a busy session's turn ends. Messages sent while one waits join it.
   */
  requestPrompt(sessionId2, text) {
    const state = this.#state(sessionId2);
    if (state === "offline") return "offline";
    const waiting = this.#store.waitingMessageText(sessionId2);
    if ((waiting ? `${waiting}

${text}` : text).length > MAX_PROMPT_CHARS) return "too-long";
    this.#store.addMessage(sessionId2, text, "page");
    this.#requested.add(sessionId2);
    return state === "listening" ? "sent" : "queued";
  }
  /** The user sent a prompt in the terminal: the waiter stands down and the prompt carries the notes. */
  markBusy(sessionId2) {
    this.#waiters.delete(sessionId2);
    this.#busy.add(sessionId2);
    this.#requested.delete(sessionId2);
    this.#forgetTurn(sessionId2);
  }
  /** Queues these sessions' pending notes to go now, or as soon as a busy session's turn ends. */
  requestSend(sessionIds) {
    const pending = this.#store.sessionsWithPendingNotes();
    const targets = [...new Set(sessionIds)].filter((id) => pending.has(id)).sort();
    for (const id of targets) this.#requested.add(id);
    if (targets.length) this.#store.revision.bump();
    return targets;
  }
  #forgetTurn(sessionId2) {
    this.#activity.delete(sessionId2);
    this.#progress.delete(sessionId2);
  }
  #state(sessionId2) {
    const waiter = this.#waiters.get(sessionId2);
    if (waiter && this.#clock.monotonicMs() - waiter.seenMs < LISTENER_STALE_MS) return "listening";
    return this.#busy.has(sessionId2) ? "busy" : "offline";
  }
};

// src/server/http.ts
import { randomUUID, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

// src/shared/folders.ts
function folderName(cwd) {
  return cwd.split("/").filter(Boolean).pop() ?? "";
}

// src/shared/tools.ts
var MAX_ACTIVITY_CHARS = 200;
var MAX_PROGRESS_DELTA_CHARS = 2e4;

// src/server/requests.ts
var BadRequest = class extends Error {
};
var LIMITS = {
  replyText: 1e6,
  noteBody: 2e4,
  quote: 2e3,
  sessionName: 200,
  cwd: 4096,
  sessionIds: 100,
  message: 1e5
};
var MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
var WAITER_ID_PATTERN = /^[a-f0-9]{16,64}$/;
var LAUNCH_CODE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
function asObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequest("expected a JSON object");
  }
  return value;
}
function string(body, key, max) {
  const value = body[key];
  if (typeof value !== "string") throw new BadRequest(`${key} must be a string`);
  if (value.length > max) throw new BadRequest(`${key} is longer than ${max} characters`);
  return value;
}
function optionalString(body, key, max) {
  return body[key] === void 0 || body[key] === null ? void 0 : string(body, key, max);
}
function integer(body, key, min) {
  const value = body[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new BadRequest(`${key} must be an integer of at least ${min}`);
  }
  return value;
}
function matching(body, key, pattern) {
  const value = string(body, key, 256);
  if (!pattern.test(value)) throw new BadRequest(`${key} is malformed`);
  return value;
}
function sessionId(value) {
  if (!SESSION_ID_PATTERN.test(value)) throw new BadRequest("session_id is malformed");
  return value;
}
function nonEmpty(value, key) {
  if (!value.trim()) throw new BadRequest(`${key} must not be empty`);
  return value;
}
function parseNewResponse(input) {
  const body = asObject(input);
  const createdAt = body["created_at"];
  if (createdAt !== void 0 && (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt <= 0)) {
    throw new BadRequest("created_at must be a positive number of seconds");
  }
  return {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    session_name: (optionalString(body, "session_name", LIMITS.sessionName) ?? "").trim(),
    cwd: optionalString(body, "cwd", LIMITS.cwd) ?? "",
    text: string(body, "text", LIMITS.replyText),
    created_at: createdAt,
    claude_process: optionalProcess(body)
  };
}
function parseNewNote(input) {
  const body = asObject(input);
  const text = nonEmpty(string(body, "body", LIMITS.noteBody), "body").trim();
  if (body["parent_id"] !== void 0 && body["parent_id"] !== null) {
    return { kind: "follow-up", parentId: integer(body, "parent_id", 1), body: text };
  }
  return {
    kind: "root",
    responseId: integer(body, "response_id", 1),
    blockIndex: integer(body, "block_index", -1),
    quote: string(body, "quote", LIMITS.quote),
    body: text
  };
}
function parseTouchSession(input) {
  const body = asObject(input);
  return {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    session_name: (optionalString(body, "session_name", LIMITS.sessionName) ?? "").trim(),
    cwd: optionalString(body, "cwd", LIMITS.cwd) ?? ""
  };
}
function parseClaim(input) {
  const body = asObject(input);
  const prompt = optionalString(body, "prompt", LIMITS.message);
  const session_id = matching(body, "session_id", SESSION_ID_PATTERN);
  const claim = prompt === void 0 ? { session_id } : { session_id, prompt };
  const claudeProcess = optionalProcess(body);
  if (claudeProcess) claim.claude_process = claudeProcess;
  return claim;
}
function parseActivity(input) {
  const body = asObject(input);
  return {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    text: nonEmpty(string(body, "text", MAX_ACTIVITY_CHARS), "text")
  };
}
function parseProgress(input) {
  const body = asObject(input);
  return {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    message_id: matching(body, "message_id", MESSAGE_ID_PATTERN),
    index: integer(body, "index", 0),
    delta: string(body, "delta", MAX_PROGRESS_DELTA_CHARS)
  };
}
function parseWaiter(input) {
  const body = asObject(input);
  const waiter = {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    waiter_id: matching(body, "waiter_id", WAITER_ID_PATTERN)
  };
  const claudeProcess = optionalProcess(body);
  if (claudeProcess) waiter.claude_process = claudeProcess;
  return waiter;
}
function parseSend(input) {
  const ids = asObject(input)["session_ids"];
  if (!Array.isArray(ids) || ids.length > LIMITS.sessionIds || !ids.every((id) => typeof id === "string")) {
    throw new BadRequest("session_ids must be a list of session ids");
  }
  return { session_ids: ids.map(sessionId) };
}
function parseRedeem(input) {
  return { code: matching(asObject(input), "code", LAUNCH_CODE_PATTERN) };
}
function parsePrompt(input) {
  const body = asObject(input);
  return {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    text: nonEmpty(string(body, "text", LIMITS.message), "text").trim()
  };
}
function parseSessionRequest(input) {
  return { session_id: matching(asObject(input), "session_id", SESSION_ID_PATTERN) };
}
function parseRename(input) {
  const body = asObject(input);
  return {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    label: string(body, "label", LIMITS.sessionName).replace(/\s+/g, " ").trim()
  };
}
function optionalProcess(body) {
  const value = body["claude_process"];
  if (value === void 0 || value === null) return void 0;
  const fields = asObject(value);
  return { pid: integer(fields, "pid", 2), started: nonEmpty(string(fields, "started", 64), "started") };
}
function parseStartSession(input) {
  const body = asObject(input);
  return {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    prompt: (optionalString(body, "prompt", MAX_PROMPT_CHARS) ?? "").trim(),
    name: (optionalString(body, "name", LIMITS.sessionName) ?? "").replace(/\s+/g, " ").trim()
  };
}

// src/server/http.ts
var MAX_BODY_BYTES = 2 * 1024 * 1024;
var FOLDER_PATH = /^\/[^/]+$/;
var CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml"
};
var COMMON_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin"
};
var PAGE_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY"
};
var HttpError = class extends Error {
  status;
  constructor(status, message = "") {
    super(message);
    this.status = status;
  }
};
var ok = (body, status = 200) => ({ status, body });
var empty = (status) => ({ status });
function routes({ store, delivery, launchCodes, token, openFolder, startSession, processes }) {
  const snapshot = (sessionId2, folder) => {
    const latest = folder === null ? void 0 : store.folderSessions(folder)[0];
    const session = store.session(sessionId2 ?? "") ?? store.session(latest?.id ?? "");
    const version = store.revision.value;
    const can_start_sessions = startSession !== null;
    if (!session) {
      return {
        version,
        session: null,
        folder: folder ?? "",
        sessions: [],
        can_start_sessions,
        responses: [],
        comments: [],
        messages: []
      };
    }
    const windowFolder = folderName(session.cwd);
    return {
      version,
      session: { ...session, ...delivery.status(session.id) },
      folder: windowFolder,
      sessions: store.folderSessions(windowFolder).map((row) => ({
        ...row,
        status: delivery.status(row.id).status,
        process: processes.state(row.id)
      })),
      can_start_sessions,
      ...store.sessionContent(session.id)
    };
  };
  const recordedFolder = (sessionId2) => {
    const cwd = store.session(sessionId2)?.cwd;
    if (!cwd) throw new HttpError(404, "sidenote doesn't know this session's folder");
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new HttpError(404, `${cwd} no longer exists`);
    return cwd;
  };
  return [
    {
      method: "GET",
      path: "/api/state",
      needsToken: true,
      handle: ({ query }) => {
        delivery.refresh();
        processes.refresh();
        if (query.get("v") === String(store.revision.value)) return empty(204);
        return ok(snapshot(query.get("s"), query.get("f")));
      }
    },
    {
      method: "GET",
      path: "/api/sessions",
      needsToken: true,
      handle: () => ok({ sessions: store.listSessions() })
    },
    { method: "GET", path: "/api/health", needsToken: true, handle: () => ok({ ok: true }) },
    {
      method: "POST",
      path: "/api/sessions",
      needsToken: true,
      handle: ({ body }) => {
        const input = parseTouchSession(body);
        store.touchSession(input.session_id, input.session_name, input.cwd);
        return ok({ ok: true });
      }
    },
    {
      method: "POST",
      path: "/api/responses",
      needsToken: true,
      handle: ({ body }) => {
        const input = parseNewResponse(body);
        processes.record(input.session_id, input.claude_process);
        const { response, newSession } = store.addResponse({
          sessionId: input.session_id,
          sessionName: input.session_name,
          cwd: input.cwd,
          text: input.text,
          createdAt: input.created_at
        });
        return ok({ response, new_session: newSession }, 201);
      }
    },
    {
      method: "POST",
      path: "/api/comments",
      needsToken: true,
      handle: ({ body }) => {
        const note = store.addNote(parseNewNote(body));
        if (!note) throw new HttpError(404, "unknown reply or thread");
        return ok(note, 201);
      }
    },
    {
      method: "DELETE",
      path: /^\/api\/comments\/(\d{1,15})$/,
      needsToken: true,
      handle: ({ param }) => empty(store.deletePendingNote(Number(param)) ? 204 : 404)
    },
    {
      method: "POST",
      path: "/api/claim",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id, prompt: typed, claude_process } = parseClaim(body);
        processes.record(session_id, claude_process);
        delivery.markBusy(session_id);
        const prompt = store.claimMessages(session_id);
        if (typed?.trim()) store.addMessage(session_id, typed.trim(), "terminal");
        const result = { comments: store.claimPending(session_id) };
        if (prompt !== void 0) result.prompt = prompt;
        return ok(result);
      }
    },
    {
      method: "POST",
      path: "/api/activity",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id, text } = parseActivity(body);
        delivery.setActivity(session_id, text);
        return ok({ ok: true });
      }
    },
    {
      method: "POST",
      path: "/api/progress",
      needsToken: true,
      handle: ({ body }) => {
        delivery.addProgress(parseProgress(body));
        return ok({ ok: true });
      }
    },
    {
      method: "POST",
      path: "/api/waiters",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id, waiter_id, claude_process } = parseWaiter(body);
        processes.record(session_id, claude_process);
        delivery.registerWaiter(session_id, waiter_id);
        return ok({ ok: true });
      }
    },
    {
      method: "POST",
      path: "/api/waiters/poll",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id, waiter_id } = parseWaiter(body);
        return ok(delivery.pollWaiter(session_id, waiter_id));
      }
    },
    {
      method: "POST",
      path: "/api/send",
      needsToken: true,
      handle: ({ body }) => ok({ sessions: delivery.requestSend(parseSend(body).session_ids) })
    },
    {
      method: "POST",
      path: "/api/prompt",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id, text } = parsePrompt(body);
        if (!store.session(session_id)) throw new HttpError(404, "sidenote doesn't know this session");
        const outcome = delivery.requestPrompt(session_id, text);
        if (outcome === "offline") {
          throw new HttpError(
            409,
            "this session isn't listening: it may be closed, or hasn't finished a reply since sidenote started"
          );
        }
        if (outcome === "too-long") {
          throw new HttpError(413, `messages to a terminal session are limited to ${MAX_PROMPT_CHARS} characters`);
        }
        return ok({ delivery: outcome }, 202);
      }
    },
    {
      method: "POST",
      path: "/api/open-folder",
      needsToken: true,
      handle: ({ body }) => {
        openFolder(recordedFolder(parseSessionRequest(body).session_id));
        return empty(204);
      }
    },
    {
      method: "POST",
      path: "/api/sessions/rename",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id, label } = parseRename(body);
        if (!store.renameSession(session_id, label)) throw new HttpError(404, "sidenote doesn't know this session");
        return empty(204);
      }
    },
    {
      method: "POST",
      path: "/api/sessions/end",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id } = parseSessionRequest(body);
        if (processes.state(session_id) === "unknown") {
          throw new HttpError(409, "sidenote learns this session's process with its next prompt or reply");
        }
        const running = processes.running(session_id);
        if (running) process.kill(running.pid, "SIGTERM");
        processes.forget(session_id);
        store.forgetSession(session_id);
        return empty(204);
      }
    },
    {
      method: "POST",
      path: "/api/sessions/forget",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id } = parseSessionRequest(body);
        if (processes.running(session_id)) throw new HttpError(409, "this session is still running: end it instead");
        processes.forget(session_id);
        if (!store.forgetSession(session_id)) throw new HttpError(404, "sidenote doesn't know this session");
        return empty(204);
      }
    },
    {
      method: "POST",
      path: "/api/sessions/start",
      needsToken: true,
      handle: async ({ body }) => {
        const { session_id, prompt, name } = parseStartSession(body);
        const cwd = recordedFolder(session_id);
        if (!startSession) throw new HttpError(501, "starting sessions needs GNOME Terminal on Linux, or macOS");
        const id = randomUUID();
        try {
          await startSession({ cwd, sessionId: id, prompt, name });
        } catch (error) {
          throw new HttpError(502, `couldn't open a terminal: ${error instanceof Error ? error.message : error}`);
        }
        store.touchSession(id, "", cwd);
        if (name) store.renameSession(id, name);
        return ok({ session_id: id }, 201);
      }
    },
    {
      method: "POST",
      path: "/api/launch",
      needsToken: true,
      handle: () => ok({ code: launchCodes.issue() })
    },
    {
      method: "POST",
      path: "/api/launch/redeem",
      needsToken: false,
      handle: ({ body }) => {
        if (!launchCodes.redeem(parseRedeem(body).code))
          throw new HttpError(403, "this link was already used or has expired");
        return ok({ token });
      }
    }
  ];
}
function createApp(options) {
  const webDir = resolve(options.webDir);
  const tokenBytes = Buffer.from(options.token);
  const table = routes(options);
  const tokenValid = (request) => {
    const given = Buffer.from(String(request.headers[TOKEN_HEADER.toLowerCase()] ?? ""));
    return given.length === tokenBytes.length && timingSafeEqual(given, tokenBytes);
  };
  const serveApi = async (request, url) => {
    let param = "";
    const route = table.find((candidate) => {
      if (candidate.method !== request.method) return false;
      if (typeof candidate.path === "string") return candidate.path === url.pathname;
      const match = candidate.path.exec(url.pathname);
      param = match?.[1] ?? "";
      return match !== null;
    });
    if (!route) throw new HttpError(404);
    if (route.needsToken && !tokenValid(request)) throw new HttpError(403);
    const body = request.method === "POST" ? await readJson(request) : void 0;
    return route.handle({ body, query: url.searchParams, param });
  };
  const handle = async (request, response) => {
    if (!options.allowedHosts.has(request.headers.host ?? "")) throw new HttpError(403);
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) return send(response, await serveApi(request, url));
    if (request.method !== "GET") throw new HttpError(405);
    if (url.pathname === "/" || FOLDER_PATH.test((request.url ?? "").split("?")[0])) {
      return sendFile(response, resolve(webDir, "index.html"));
    }
    if (url.pathname.startsWith("/static/")) return sendFile(response, staticPath(webDir, url.pathname));
    throw new HttpError(404);
  };
  return (request, response) => {
    handle(request, response).catch((error) => {
      if (response.headersSent) return response.destroy();
      if (error instanceof HttpError) return send(response, errorReply(error.status, error.message));
      if (error instanceof BadRequest) return send(response, errorReply(400, error.message));
      console.error(error);
      send(response, errorReply(500, "internal error"));
    });
  };
}
function errorReply(status, message) {
  return message ? { status, body: { error: message } } : { status };
}
function staticPath(webDir, pathname) {
  let relative;
  try {
    relative = decodeURIComponent(pathname.slice("/static/".length));
  } catch {
    throw new HttpError(404);
  }
  const file = resolve(webDir, relative);
  if (relative.includes("\0") || !file.startsWith(webDir + sep)) throw new HttpError(404);
  return file;
}
async function readJson(request) {
  if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) throw new HttpError(413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new BadRequest("invalid JSON");
  }
}
async function sendFile(response, file) {
  const content = await readFile(file).catch(() => {
    throw new HttpError(404);
  });
  response.writeHead(200, {
    ...COMMON_HEADERS,
    ...extname(file) === ".html" ? PAGE_HEADERS : {},
    "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    "Content-Length": content.length
  });
  response.end(content);
}
function send(response, reply) {
  const content = reply.body === void 0 ? void 0 : Buffer.from(JSON.stringify(reply.body));
  response.writeHead(reply.status, {
    ...COMMON_HEADERS,
    ...content ? { "Content-Type": "application/json" } : {},
    "Content-Length": content?.length ?? 0
  });
  response.end(content);
}

// src/server/processes.ts
var SessionProcesses = class {
  #processes = /* @__PURE__ */ new Map();
  #probe;
  #revision;
  #signature = "";
  constructor(probe, revision) {
    this.#probe = probe;
    this.#revision = revision;
  }
  record(sessionId2, claudeProcess) {
    if (claudeProcess) this.#processes.set(sessionId2, claudeProcess);
  }
  forget(sessionId2) {
    this.#processes.delete(sessionId2);
  }
  state(sessionId2) {
    const recorded = this.#processes.get(sessionId2);
    if (!recorded) return "unknown";
    return this.#probe.pidInUse(recorded.pid) ? "running" : "ended";
  }
  /** The session's process, if it still runs as recorded; undefined when it ended or is unknown. */
  running(sessionId2) {
    const recorded = this.#processes.get(sessionId2);
    return recorded && this.#probe.isSameProcess(recorded) ? recorded : void 0;
  }
  /** Bumps the revision when a process ended, so pages see the session as ended. */
  refresh() {
    const signature = JSON.stringify([...this.#processes.keys()].map((id) => [id, this.state(id)]));
    if (signature === this.#signature) return;
    this.#signature = signature;
    this.#revision.bump();
  }
};

// src/server/launch.ts
import { randomBytes } from "node:crypto";
var LAUNCH_CODE_TTL_MS = 2 * 60 * 1e3;
var MAX_LIVE_CODES = 32;
var LaunchCodes = class {
  #issued = /* @__PURE__ */ new Map();
  #clock;
  constructor(clock = systemClock) {
    this.#clock = clock;
  }
  issue() {
    this.#expire();
    const code = randomBytes(24).toString("base64url");
    this.#issued.set(code, this.#clock.monotonicMs() + LAUNCH_CODE_TTL_MS);
    while (this.#issued.size > MAX_LIVE_CODES) this.#issued.delete(this.#issued.keys().next().value);
    return code;
  }
  /** True once per issued code, within its lifetime. */
  redeem(code) {
    this.#expire();
    return this.#issued.delete(code);
  }
  #expire() {
    const now = this.#clock.monotonicMs();
    for (const [code, expiresAt] of this.#issued) {
      if (expiresAt <= now) this.#issued.delete(code);
    }
  }
};

// src/server/lock.ts
import { closeSync, openSync, readFileSync as readFileSync2, rmSync, statSync as statSync2, writeSync } from "node:fs";
var STARTUP_GRACE_MS = 3e4;
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function registeredPid(serverFile) {
  try {
    return JSON.parse(readFileSync2(serverFile, "utf8")).pid;
  } catch {
    return null;
  }
}
function isHeld(lockFile, serverFile) {
  let pid;
  let ageMs;
  try {
    pid = Number.parseInt(readFileSync2(lockFile, "utf8"), 10);
    ageMs = Date.now() - statSync2(lockFile).mtimeMs;
  } catch {
    return false;
  }
  if (ageMs < STARTUP_GRACE_MS) return Number.isNaN(pid) || isRunning(pid);
  return !Number.isNaN(pid) && isRunning(pid) && registeredPid(serverFile) === pid;
}
function acquireServerLock(lockFile, serverFile) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockFile, "wx", 384);
      writeSync(descriptor, String(process.pid));
      closeSync(descriptor);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (isHeld(lockFile, serverFile)) return false;
    rmSync(lockFile, { force: true });
  }
  return false;
}
function releaseServerLock(lockFile) {
  try {
    if (Number.parseInt(readFileSync2(lockFile, "utf8"), 10) === process.pid) rmSync(lockFile);
  } catch {
  }
}

// src/server/persistence.ts
import { existsSync, readFileSync as readFileSync3, renameSync, writeFileSync } from "node:fs";
function emptyStore() {
  return { sessions: /* @__PURE__ */ new Map(), responses: [], comments: [], messages: [], nextId: 1 };
}
function loadStore(file) {
  if (!existsSync(file)) return emptyStore();
  return migrate(JSON.parse(readFileSync3(file, "utf8")));
}
function saveStore(file, data) {
  const contents = {
    sessions: Object.fromEntries(data.sessions),
    responses: data.responses,
    comments: data.comments,
    messages: data.messages,
    next_id: data.nextId
  };
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(contents), { mode: 384 });
  renameSync(temp, file);
}
function migrate(file) {
  const responses = (file.responses ?? []).filter((r) => SESSION_ID_PATTERN.test(r.session_id));
  for (const response of responses) response.note_answers ??= {};
  const responseIds = new Set(responses.map((r) => r.id));
  const comments = (file.comments ?? []).filter((c) => responseIds.has(c.response_id));
  for (const comment of comments) {
    comment.parent_id ??= null;
    if (comment.answered_by === void 0) comment.answered_by = comment.delivered_at === null ? null : 0;
  }
  const sessions = /* @__PURE__ */ new Map();
  for (const [id, meta] of Object.entries(file.sessions ?? {})) {
    if (!SESSION_ID_PATTERN.test(id)) continue;
    sessions.set(id, {
      name: meta.name ?? "",
      label: meta.label ?? "",
      cwd: meta.cwd ?? "",
      last_active: meta.last_active ?? 0
    });
  }
  for (const response of responses) {
    const meta = sessions.get(response.session_id) ?? { name: "", label: "", cwd: response.cwd, last_active: 0 };
    meta.last_active = Math.max(meta.last_active, response.created_at);
    sessions.set(response.session_id, meta);
  }
  const messages = (file.messages ?? []).filter((m) => SESSION_ID_PATTERN.test(m.session_id));
  const highestId = Math.max(
    0,
    ...responses.map((r) => r.id),
    ...comments.map((c) => c.id),
    ...messages.map((m) => m.id)
  );
  return { sessions, responses, comments, messages, nextId: Math.max(file.next_id ?? 1, highestId + 1) };
}

// src/server/store.ts
var MAX_RESPONSES_PER_SESSION = 100;
var SESSION_RETENTION_SECONDS = 7 * 24 * 60 * 60;
var FIRST_MESSAGE_CHARS = 80;
var Revision = class {
  #value = 0;
  get value() {
    return this.#value;
  }
  bump() {
    this.#value += 1;
  }
};
var Store = class {
  revision = new Revision();
  #data;
  #file;
  #clock;
  /** Without a file, the store lives in memory only (tests). */
  constructor(options = {}) {
    this.#file = options.file;
    this.#clock = options.clock ?? systemClock;
    this.#data = this.#file ? loadStore(this.#file) : emptyStore();
    if (this.#prune()) this.#persist();
  }
  // ---- Reading ---------------------------------------------------------------------------
  session(sessionId2) {
    const meta = this.#data.sessions.get(sessionId2);
    return meta && { id: sessionId2, ...meta };
  }
  /** Known sessions, most recently active first. */
  listSessions() {
    return [...this.#data.sessions].map(([id, meta]) => ({ id, ...meta })).sort((a, b) => b.last_active - a.last_active);
  }
  /** The sessions that ran in a folder, most recently active first, with what their rows show. */
  folderSessions(folder) {
    const pending = this.#pendingNotesPerSession();
    return this.listSessions().filter((session) => folderName(session.cwd) === folder).map((session) => ({
      ...session,
      first_message: (this.#data.messages.find((m) => m.session_id === session.id)?.text ?? "").replace(/\s+/g, " ").trim().slice(0, FIRST_MESSAGE_CHARS),
      pending_notes: pending.get(session.id) ?? 0
    }));
  }
  /** One session's replies and messages, oldest first, and the notes on the replies. */
  sessionContent(sessionId2) {
    const responses = this.#data.responses.filter((r) => r.session_id === sessionId2);
    const ids = new Set(responses.map((r) => r.id));
    return {
      responses,
      comments: this.#data.comments.filter((c) => ids.has(c.response_id)),
      messages: this.#data.messages.filter((m) => m.session_id === sessionId2)
    };
  }
  /** Messages from the page that haven't reached Claude yet, joined as Claude will get them, or "". */
  waitingMessageText(sessionId2) {
    return this.#waitingMessages(sessionId2).map((m) => m.text).join("\n\n");
  }
  /** Sessions with notes that haven't been sent to Claude yet. */
  sessionsWithPendingNotes() {
    return new Set(this.#pendingNotesPerSession().keys());
  }
  // ---- Writing ---------------------------------------------------------------------------
  /** Remembers a session before its first reply, e.g. when /sidenote:on opens its window. */
  touchSession(sessionId2, name, cwd) {
    this.#upsertSession(sessionId2, { name, cwd, activeAt: this.#clock.now() });
    this.#changed();
  }
  /** Names a session in the window; "" removes the name. Returns false for an unknown session. */
  renameSession(sessionId2, label) {
    const meta = this.#data.sessions.get(sessionId2);
    if (!meta) return false;
    meta.label = label;
    this.#changed();
    return true;
  }
  /** Forgets a session with its replies, notes and messages. Claude's own transcript stays. */
  forgetSession(sessionId2) {
    if (!this.#data.sessions.delete(sessionId2)) return false;
    const data = this.#data;
    const dropped = new Set(data.responses.filter((r) => r.session_id === sessionId2).map((r) => r.id));
    data.responses = data.responses.filter((r) => !dropped.has(r.id));
    data.comments = data.comments.filter((c) => !dropped.has(c.response_id));
    data.messages = data.messages.filter((m) => m.session_id !== sessionId2);
    this.#changed();
    return true;
  }
  addResponse(reply) {
    const response = {
      id: this.#newId(),
      session_id: reply.sessionId,
      cwd: reply.cwd,
      text: reply.text,
      created_at: reply.createdAt ?? this.#clock.now(),
      note_answers: {}
    };
    const newSession = !this.#data.sessions.has(reply.sessionId);
    this.#upsertSession(reply.sessionId, { name: reply.sessionName, cwd: reply.cwd, activeAt: response.created_at });
    if (reply.createdAt === void 0) this.#takeAnswers(response);
    this.#data.responses.push(response);
    this.#data.responses.sort((a, b) => a.created_at - b.created_at);
    this.#prune();
    this.#changed();
    return { response, newSession };
  }
  /** Adds a note on a reply, or a follow-up in a thread. Returns null when the target is unknown. */
  addNote(note) {
    const anchor = this.#anchorFor(note);
    if (!anchor) return null;
    const created = {
      id: this.#newId(),
      ...anchor,
      body: note.body,
      created_at: this.#clock.now(),
      delivered_at: null,
      answered_by: null
    };
    this.#data.comments.push(created);
    this.#changed();
    return created;
  }
  /** Deletes an unsent note, with its follow-ups, unless any of them was already sent. */
  deletePendingNote(noteId) {
    const doomed = this.#data.comments.filter((c) => c.id === noteId || c.parent_id === noteId);
    if (!doomed.some((c) => c.id === noteId) || doomed.some((c) => c.delivered_at !== null)) return false;
    const doomedIds = new Set(doomed.map((c) => c.id));
    this.#data.comments = this.#data.comments.filter((c) => !doomedIds.has(c.id));
    this.#changed();
    return true;
  }
  /**
   * Records a message the user sent. A message from the page waits until claimMessages hands it
   * to Claude; one typed in the terminal has already reached Claude.
   */
  addMessage(sessionId2, text, source) {
    const now = this.#clock.now();
    const message = {
      id: this.#newId(),
      session_id: sessionId2,
      text,
      source,
      created_at: now,
      delivered_at: source === "terminal" ? now : null
    };
    this.#data.messages.push(message);
    this.#changed();
    return message;
  }
  /** Marks this session's waiting page messages delivered and returns their text joined, or undefined. */
  claimMessages(sessionId2) {
    const waiting = this.#waitingMessages(sessionId2);
    if (!waiting.length) return void 0;
    const now = this.#clock.now();
    for (const message of waiting) message.delivered_at = now;
    this.#changed();
    return waiting.map((m) => m.text).join("\n\n");
  }
  /** Marks this session's unsent notes delivered and returns them, described for Claude. */
  claimPending(sessionId2) {
    const responses = new Map(
      this.#data.responses.filter((r) => r.session_id === sessionId2).map((r) => [r.id, r])
    );
    const notes = new Map(this.#data.comments.map((c) => [c.id, c]));
    const now = this.#clock.now();
    const claimed = [];
    for (const note of this.#data.comments) {
      const response = responses.get(note.response_id);
      if (!response || note.delivered_at !== null) continue;
      note.delivered_at = now;
      note.answered_by = null;
      const root = note.parent_id === null ? void 0 : notes.get(note.parent_id);
      claimed.push({ ...note, response_created_at: response.created_at, root_body: root?.body ?? null });
    }
    if (claimed.length) this.#changed();
    return claimed;
  }
  // ---- Internals -------------------------------------------------------------------------
  #waitingMessages(sessionId2) {
    return this.#data.messages.filter((m) => m.session_id === sessionId2 && m.delivered_at === null);
  }
  #anchorFor(note) {
    if (note.kind === "follow-up") {
      const parent = this.#data.comments.find((c) => c.id === note.parentId);
      if (!parent) return null;
      return {
        response_id: parent.response_id,
        block_index: parent.block_index,
        quote: parent.quote,
        parent_id: parent.parent_id ?? parent.id
      };
    }
    if (!this.#data.responses.some((r) => r.id === note.responseId)) return null;
    return { response_id: note.responseId, block_index: note.blockIndex, quote: note.quote, parent_id: null };
  }
  #upsertSession(sessionId2, update) {
    const meta = this.#data.sessions.get(sessionId2) ?? {
      name: "",
      label: "",
      cwd: update.cwd,
      last_active: 0
    };
    if (update.name) meta.name = update.name;
    if (update.cwd) meta.cwd = update.cwd;
    meta.last_active = Math.max(meta.last_active, update.activeAt);
    this.#data.sessions.set(sessionId2, meta);
  }
  /**
   * Marks a live reply as Claude's answer to the notes its session was last sent, and moves the
   * sections it wrote for each note out of the main text into note_answers.
   */
  #takeAnswers(response) {
    const sessionOf = this.#sessionOfResponse();
    const awaiting = this.#data.comments.filter(
      (c) => sessionOf.get(c.response_id) === response.session_id && c.delivered_at !== null && c.answered_by === null
    );
    if (!awaiting.length) return;
    for (const note of awaiting) note.answered_by = response.id;
    const { mainText, answers } = splitNoteAnswers(response.text, new Set(awaiting.map((c) => c.id)));
    if (answers.size) {
      response.text = mainText;
      response.note_answers = Object.fromEntries([...answers].map(([id, body]) => [String(id), body]));
    }
  }
  /** Applies the retention limits. Returns whether anything was dropped. */
  #prune() {
    const data = this.#data;
    const before = data.responses.length + data.sessions.size + data.messages.length;
    const cutoff = this.#clock.now() - SESSION_RETENTION_SECONDS;
    for (const [sessionId2, meta] of data.sessions) {
      if (meta.last_active < cutoff) data.sessions.delete(sessionId2);
    }
    const kept = [];
    const perSession = /* @__PURE__ */ new Map();
    for (const response of [...data.responses].reverse()) {
      if (!data.sessions.has(response.session_id)) continue;
      const count = (perSession.get(response.session_id) ?? 0) + 1;
      perSession.set(response.session_id, count);
      if (count <= MAX_RESPONSES_PER_SESSION) kept.push(response);
    }
    data.responses = kept.reverse();
    const keptIds = new Set(data.responses.map((r) => r.id));
    data.comments = data.comments.filter((c) => keptIds.has(c.response_id));
    const keptMessages = [];
    const messagesPerSession = /* @__PURE__ */ new Map();
    for (const message of [...data.messages].reverse()) {
      if (!data.sessions.has(message.session_id) && message.created_at < cutoff) continue;
      const count = (messagesPerSession.get(message.session_id) ?? 0) + 1;
      messagesPerSession.set(message.session_id, count);
      if (count <= MAX_RESPONSES_PER_SESSION) keptMessages.push(message);
    }
    data.messages = keptMessages.reverse();
    return data.responses.length + data.sessions.size + data.messages.length !== before;
  }
  #pendingNotesPerSession() {
    const sessionOf = this.#sessionOfResponse();
    const pending = /* @__PURE__ */ new Map();
    for (const note of this.#data.comments) {
      const sessionId2 = sessionOf.get(note.response_id);
      if (note.delivered_at === null && sessionId2 !== void 0)
        pending.set(sessionId2, (pending.get(sessionId2) ?? 0) + 1);
    }
    return pending;
  }
  #sessionOfResponse() {
    return new Map(this.#data.responses.map((r) => [r.id, r.session_id]));
  }
  #newId() {
    return this.#data.nextId++;
  }
  #changed() {
    this.revision.bump();
    this.#persist();
  }
  #persist() {
    if (this.#file) saveStore(this.#file, this.#data);
  }
};

// src/server/main.ts
var WEB_DIR = join3(dirname(fileURLToPath(import.meta.url)), "web");
function listenOn(server, port) {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolvePort(typeof address === "object" && address ? address.port : port);
    });
  });
}
async function listen(server) {
  let preferred = 0;
  try {
    preferred = Number.parseInt(readFileSync4(paths.portFile(), "utf8"), 10) || 0;
  } catch {
  }
  try {
    return await listenOn(server, preferred);
  } catch (error) {
    if (preferred && error.code === "EADDRINUSE") return listenOn(server, 0);
    throw error;
  }
}
function removeServerFile() {
  try {
    const current = JSON.parse(readFileSync4(paths.serverFile(), "utf8"));
    if (current.pid === process.pid) rmSync2(paths.serverFile());
  } catch {
  }
}
async function main() {
  mkdirSync(paths.stateDir(), { recursive: true, mode: 448 });
  if (!acquireServerLock(paths.lockFile(), paths.serverFile())) return;
  process.on("exit", () => releaseServerLock(paths.lockFile()));
  const store = new Store({ file: paths.storeFile() });
  const token = randomBytes2(32).toString("base64url");
  const allowedHosts = /* @__PURE__ */ new Set();
  const server = createServer(
    createApp({
      store,
      delivery: new Delivery(store),
      launchCodes: new LaunchCodes(),
      token,
      allowedHosts,
      webDir: WEB_DIR,
      openFolder: (path) => openWithSystem(path, () => console.error(`couldn't open ${path}`)),
      processes: new SessionProcesses({ pidInUse, isSameProcess }, store.revision),
      startSession: canStartSessions() ? (session) => startInTerminal(terminalCommand(process.platform, session)) : null
    })
  );
  server.keepAliveTimeout = 2e3;
  const port = await listen(server);
  allowedHosts.add(`127.0.0.1:${port}`);
  allowedHosts.add(`localhost:${port}`);
  allowedHosts.add(`${PAGE_HOST}:${port}`);
  writeFileSync2(paths.portFile(), String(port), { mode: 384 });
  writeFileSync2(paths.serverFile(), JSON.stringify({ port, token, pid: process.pid }), {
    mode: 384
  });
  console.error(`sidenote listening on http://127.0.0.1:${port}`);
  const shutDown = () => {
    removeServerFile();
    server.close();
    server.closeAllConnections();
    process.exit(0);
  };
  process.on("SIGTERM", shutDown);
  process.on("SIGINT", shutDown);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
