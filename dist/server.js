// src/server/main.ts
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync as readFileSync2, rmSync, writeFileSync as writeFileSync2 } from "node:fs";
import { createServer } from "node:http";
import { dirname, join as join2 } from "node:path";
import { fileURLToPath } from "node:url";

// src/shared/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
var paths = {
  stateDir: () => join(homedir(), ".sidenote"),
  storeFile: () => join(paths.stateDir(), "store.json"),
  serverFile: () => join(paths.stateDir(), "server.json"),
  portFile: () => join(paths.stateDir(), "port"),
  logFile: () => join(paths.stateDir(), "server.log"),
  enabledFlag: () => join(paths.stateDir(), "enabled"),
  transcriptsDir: () => join(homedir(), ".claude", "projects")
};

// src/server/http.ts
import { timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

// src/shared/types.ts
var TOKEN_HEADER = "X-Review-Token";

// src/server/http.ts
var MAX_BODY_BYTES = 2 * 1024 * 1024;
var CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml"
};
var CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
var HttpError = class extends Error {
  status;
  constructor(status, message = "") {
    super(message);
    this.status = status;
  }
};
function createApp(options) {
  const { store, token, allowedHosts } = options;
  const webDir = resolve(options.webDir);
  const tokenBytes = Buffer.from(token);
  function tokenValid(request) {
    const given = Buffer.from(String(request.headers[TOKEN_HEADER.toLowerCase()] ?? ""));
    return given.length === tokenBytes.length && timingSafeEqual(given, tokenBytes);
  }
  async function handle(request, response) {
    if (!allowedHosts.has(request.headers.host ?? "")) throw new HttpError(403);
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";
    if (method === "GET" && url.pathname === "/") return sendFile(response, resolve(webDir, "index.html"));
    if (method === "GET" && url.pathname.startsWith("/static/")) {
      const file = resolve(webDir, decodeURIComponent(url.pathname.slice("/static/".length)));
      if (!file.startsWith(webDir + sep)) throw new HttpError(404);
      return sendFile(response, file);
    }
    if (!url.pathname.startsWith("/api/")) throw new HttpError(404);
    if (!tokenValid(request)) throw new HttpError(403);
    if (method === "GET") {
      switch (url.pathname) {
        case "/api/state": {
          store.refreshStatus();
          if (url.searchParams.get("v") === String(store.version)) return sendEmpty(response, 204);
          return sendJson(response, 200, store.snapshot(url.searchParams.get("s")));
        }
        case "/api/sessions": {
          const result = { sessions: store.listSessions() };
          return sendJson(response, 200, result);
        }
        case "/api/health":
          return sendJson(response, 200, { ok: true });
      }
    }
    if (method === "POST") {
      const body = await readJson(request);
      switch (url.pathname) {
        case "/api/responses": {
          const input = body;
          const sessionId = str(input.session_id);
          if (!sessionId) throw new HttpError(400, "session_id is required");
          const { response: created, newSession } = store.addResponse({
            sessionId,
            cwd: str(input.cwd),
            text: str(input.text),
            createdAt: Number(input.created_at) || void 0,
            sessionName: str(input.session_name).trim().slice(0, 200)
          });
          const result = { response: created, new_session: newSession };
          return sendJson(response, 201, result);
        }
        case "/api/sessions": {
          const input = body;
          const sessionId = str(input.session_id);
          if (!sessionId) throw new HttpError(400, "session_id is required");
          store.touchSession(sessionId, str(input.session_name).trim().slice(0, 200), str(input.cwd));
          return sendJson(response, 200, { ok: true });
        }
        case "/api/comments": {
          const input = body;
          const text = str(input["body"]).trim();
          if (!text) throw new HttpError(400, "empty note");
          const parentId = input["parent_id"];
          const target = parentId !== void 0 && parentId !== null ? { parentId: Number(parentId) } : {
            responseId: Number(input["response_id"] ?? 0),
            blockIndex: Number(input["block_index"] ?? -1),
            quote: str(input["quote"])
          };
          const comment = store.addComment(target, text);
          if (!comment) throw new HttpError(404, "unknown reply or thread");
          return sendJson(response, 201, comment);
        }
        case "/api/claim": {
          const sessionId = str(body.session_id);
          store.markBusy(sessionId);
          const result = { comments: store.claimPending(sessionId) };
          return sendJson(response, 200, result);
        }
        case "/api/waiters": {
          const input = body;
          store.registerWaiter(str(input.session_id), str(input.waiter_id));
          return sendJson(response, 200, { ok: true });
        }
        case "/api/waiters/poll": {
          const input = body;
          const result = store.pollWaiter(str(input.session_id), str(input.waiter_id));
          return sendJson(response, 200, result);
        }
        case "/api/send": {
          const ids = body.session_ids;
          const result = {
            sessions: store.requestSend(Array.isArray(ids) ? ids.map(String) : void 0)
          };
          return sendJson(response, 200, result);
        }
      }
    }
    if (method === "DELETE" && url.pathname.startsWith("/api/comments/")) {
      const id = url.pathname.slice("/api/comments/".length);
      const deleted = /^\d+$/.test(id) && store.deletePendingComment(Number(id));
      return sendEmpty(response, deleted ? 204 : 404);
    }
    throw new HttpError(404);
  }
  return (request, response) => {
    handle(request, response).catch((error) => {
      if (response.headersSent) return response.destroy();
      if (error instanceof HttpError) {
        return error.message ? sendJson(response, error.status, { error: error.message }) : sendEmpty(response, error.status);
      }
      console.error(error);
      sendEmpty(response, 500);
    });
  };
}
function str(value) {
  return value === void 0 || value === null ? "" : String(value);
}
async function readJson(request) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = text ? JSON.parse(text) : {};
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    return parsed;
  } catch {
    throw new HttpError(400, "invalid json");
  }
}
async function sendFile(response, file) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new HttpError(404);
  const content = await readFile(file);
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    "Content-Length": content.length,
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "Cache-Control": "no-store"
  });
  response.end(content);
}
function sendJson(response, status, payload) {
  const content = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": content.length });
  response.end(content);
}
function sendEmpty(response, status) {
  response.writeHead(status, { "Content-Length": 0 });
  response.end();
}

// src/server/store.ts
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

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
function markerIds(line) {
  const ids = NOTE_MARKER.exec(line)?.groups?.["ids"];
  return ids ? [...ids.matchAll(/\d+/g)].map((match) => Number(match[0])) : [];
}

// src/server/store.ts
var MAX_RESPONSES_PER_SESSION = 100;
var SESSION_RETENTION_SECONDS = 7 * 24 * 60 * 60;
var LISTENER_STALE_MS = 5e3;
var Store = class {
  version = 0;
  sessions;
  responses;
  comments;
  nextId;
  file;
  now;
  monotonicMs;
  // Live-only state for Send now: the current waiter per session, sessions that are
  // mid-turn, and sessions with a send waiting to go out.
  waiters = /* @__PURE__ */ new Map();
  busy = /* @__PURE__ */ new Set();
  sendRequested = /* @__PURE__ */ new Set();
  statusSignature = "";
  constructor(options = {}) {
    this.file = options.file;
    this.now = options.now ?? (() => Date.now() / 1e3);
    this.monotonicMs = options.monotonicMs ?? (() => performance.now());
    const data = this.file && existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
    this.sessions = data.sessions ?? {};
    this.responses = data.responses ?? [];
    this.comments = data.comments ?? [];
    this.nextId = data.next_id ?? 1;
    for (const response of this.responses) response.note_answers ??= {};
    for (const comment of this.comments) {
      if (comment.answered_by === void 0) comment.answered_by = comment.delivered_at ? 0 : null;
      comment.parent_id ??= null;
    }
    for (const response of this.responses) {
      const meta = this.sessions[response.session_id] ??= { name: "", cwd: response.cwd, last_active: 0 };
      meta.last_active = Math.max(meta.last_active, response.created_at);
    }
    if (this.prune()) this.persist();
  }
  /** One session's replies and notes, as its page shows them. */
  snapshot(sessionId) {
    const meta = sessionId === null ? void 0 : this.sessions[sessionId];
    if (sessionId === null || !meta) return { version: this.version, session: null, responses: [], comments: [] };
    const responses = this.responses.filter((r) => r.session_id === sessionId);
    const ids = new Set(responses.map((r) => r.id));
    return {
      version: this.version,
      session: { id: sessionId, ...meta, ...this.sendStatus(sessionId) },
      responses,
      comments: this.comments.filter((c) => ids.has(c.response_id))
    };
  }
  /** Known sessions, most recently active first. */
  listSessions() {
    return Object.entries(this.sessions).map(([id, meta]) => ({ id, ...meta })).sort((a, b) => b.last_active - a.last_active);
  }
  /** Remembers a session before its first reply, e.g. when /sidenote:on opens its window. */
  touchSession(sessionId, name, cwd) {
    const meta = this.sessions[sessionId] ??= { name: "", cwd, last_active: 0 };
    if (name) meta.name = name;
    meta.cwd = cwd || meta.cwd;
    meta.last_active = Math.max(meta.last_active, this.now());
    this.changed();
  }
  addResponse(input) {
    const { sessionId, cwd, text, createdAt, sessionName } = input;
    const response = {
      id: this.newId(),
      session_id: sessionId,
      cwd,
      text,
      created_at: createdAt ?? this.now(),
      note_answers: {}
    };
    const newSession = !this.sessions[sessionId];
    const meta = this.sessions[sessionId] ??= { name: "", cwd, last_active: 0 };
    meta.cwd = cwd || meta.cwd;
    if (sessionName) meta.name = sessionName;
    meta.last_active = Math.max(meta.last_active, response.created_at);
    if (createdAt === void 0) this.linkAnswer(response);
    this.responses.push(response);
    this.responses.sort((a, b) => a.created_at - b.created_at);
    this.prune();
    this.changed();
    return { response, newSession };
  }
  /** Adds a note on a reply, or a follow-up in an existing thread. Returns null for unknown targets. */
  addComment(target, body) {
    let anchor;
    if ("parentId" in target) {
      const parent = this.comments.find((c) => c.id === target.parentId);
      if (!parent) return null;
      anchor = {
        responseId: parent.response_id,
        blockIndex: parent.block_index,
        quote: parent.quote,
        parentId: parent.parent_id ?? parent.id
      };
    } else {
      anchor = { ...target, parentId: null };
    }
    if (!this.responses.some((r) => r.id === anchor.responseId)) return null;
    const comment = {
      id: this.newId(),
      response_id: anchor.responseId,
      block_index: anchor.blockIndex,
      quote: anchor.quote,
      body,
      parent_id: anchor.parentId,
      created_at: this.now(),
      delivered_at: null,
      answered_by: null
    };
    this.comments.push(comment);
    this.changed();
    return comment;
  }
  /** Deletes an undelivered note, together with its follow-ups if none of them were sent. */
  deletePendingComment(commentId) {
    const doomed = this.comments.filter((c) => c.id === commentId || c.parent_id === commentId);
    if (!doomed.some((c) => c.id === commentId) || doomed.some((c) => c.delivered_at !== null)) return false;
    this.comments = this.comments.filter((c) => !doomed.includes(c));
    this.changed();
    return true;
  }
  /** Returns this session's undelivered notes and marks them delivered. */
  claimPending(sessionId) {
    const responsesById = new Map(
      this.responses.filter((r) => r.session_id === sessionId).map((r) => [r.id, r])
    );
    const commentsById = new Map(this.comments.map((c) => [c.id, c]));
    const claimed = [];
    const now = this.now();
    for (const comment of this.comments) {
      const response = responsesById.get(comment.response_id);
      if (!response || comment.delivered_at !== null) continue;
      comment.delivered_at = now;
      comment.answered_by = null;
      const root = comment.parent_id === null ? void 0 : commentsById.get(comment.parent_id);
      claimed.push({ ...comment, response_created_at: response.created_at, root_body: root?.body ?? null });
    }
    if (claimed.length) this.changed();
    return claimed;
  }
  // ---- Send now ----------------------------------------------------------------
  /** Bumps the version when a waiter went quiet, so pages see the session stop listening. */
  refreshStatus() {
    const signature = JSON.stringify(Object.keys(this.sessions).map((id) => this.sendStatus(id)));
    if (signature !== this.statusSignature) {
      this.statusSignature = signature;
      this.version += 1;
    }
  }
  /** A new waiter starts when Claude finishes a turn; it replaces any older one. */
  registerWaiter(sessionId, waiterId) {
    this.waiters.set(sessionId, { id: waiterId, seenMs: this.monotonicMs() });
    this.busy.delete(sessionId);
  }
  pollWaiter(sessionId, waiterId) {
    const waiter = this.waiters.get(sessionId);
    if (!waiter || waiter.id !== waiterId) return { action: "exit", comments: [] };
    waiter.seenMs = this.monotonicMs();
    if (!this.sendRequested.has(sessionId)) return { action: "wait", comments: [] };
    this.sendRequested.delete(sessionId);
    this.waiters.delete(sessionId);
    this.busy.add(sessionId);
    const comments = this.claimPending(sessionId);
    return comments.length ? { action: "send", comments } : { action: "exit", comments: [] };
  }
  /** The user sent a prompt in the terminal: the waiter stands down until the turn ends. */
  markBusy(sessionId) {
    this.waiters.delete(sessionId);
    this.busy.add(sessionId);
    this.sendRequested.delete(sessionId);
  }
  /** Queues pending notes to go out now, or as soon as a busy session's turn ends. */
  requestSend(sessionIds) {
    const sessionOf = new Map(this.responses.map((r) => [r.id, r.session_id]));
    const pendingSessions = new Set(
      this.comments.filter((c) => c.delivered_at === null).map((c) => sessionOf.get(c.response_id))
    );
    const targets = sessionIds ? sessionIds.filter((s) => pendingSessions.has(s)) : [...pendingSessions];
    for (const sessionId of targets) this.sendRequested.add(sessionId);
    this.version += 1;
    return [...new Set(targets)].sort();
  }
  sendStatus(sessionId) {
    const waiter = this.waiters.get(sessionId);
    const status = waiter && this.monotonicMs() - waiter.seenMs < LISTENER_STALE_MS ? "listening" : this.busy.has(sessionId) ? "busy" : "offline";
    return { status, send_requested: this.sendRequested.has(sessionId) };
  }
  // ---- Internals -----------------------------------------------------------------
  /**
   * Marks a live reply as Claude's answer to the notes its session was last sent, and moves
   * the sections it wrote for each note out of the main text into note_answers.
   */
  linkAnswer(response) {
    const sessionResponseIds = new Set(
      this.responses.filter((r) => r.session_id === response.session_id).map((r) => r.id)
    );
    const awaiting = this.comments.filter(
      (c) => sessionResponseIds.has(c.response_id) && c.delivered_at !== null && c.answered_by === null
    );
    if (!awaiting.length) return;
    for (const comment of awaiting) comment.answered_by = response.id;
    const { mainText, answers } = splitNoteAnswers(response.text, new Set(awaiting.map((c) => c.id)));
    if (answers.size) {
      response.text = mainText;
      response.note_answers = Object.fromEntries([...answers].map(([id, body]) => [String(id), body]));
    }
  }
  /**
   * Forgets sessions idle longer than SESSION_RETENTION_SECONDS and keeps each session's newest
   * MAX_RESPONSES_PER_SESSION replies, dropping notes on whatever goes. Returns whether anything did.
   */
  prune() {
    const cutoff = this.now() - SESSION_RETENTION_SECONDS;
    const before = this.responses.length + Object.keys(this.sessions).length;
    for (const [sessionId, meta] of Object.entries(this.sessions)) {
      if (meta.last_active < cutoff) delete this.sessions[sessionId];
    }
    const perSession = /* @__PURE__ */ new Map();
    const kept = [];
    for (const response of [...this.responses].reverse()) {
      if (!this.sessions[response.session_id]) continue;
      const count = (perSession.get(response.session_id) ?? 0) + 1;
      perSession.set(response.session_id, count);
      if (count <= MAX_RESPONSES_PER_SESSION) kept.push(response);
    }
    this.responses = kept.reverse();
    const keptIds = new Set(this.responses.map((r) => r.id));
    this.comments = this.comments.filter((c) => keptIds.has(c.response_id));
    return this.responses.length + Object.keys(this.sessions).length !== before;
  }
  newId() {
    return this.nextId++;
  }
  changed() {
    this.version += 1;
    this.persist();
  }
  persist() {
    if (!this.file) return;
    const data = {
      sessions: this.sessions,
      responses: this.responses,
      comments: this.comments,
      next_id: this.nextId
    };
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(data), { mode: 384 });
    renameSync(temp, this.file);
  }
};

// src/server/main.ts
var WEB_DIR = join2(dirname(fileURLToPath(import.meta.url)), "web");
function listen(server) {
  let preferred = 0;
  try {
    preferred = Number.parseInt(readFileSync2(paths.portFile(), "utf8"), 10) || 0;
  } catch {
  }
  const tryPort = (port) => new Promise((resolvePort, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      resolvePort(typeof address === "object" && address ? address.port : port);
    });
  });
  return tryPort(preferred).catch((error) => {
    if (preferred && error.code === "EADDRINUSE") return tryPort(0);
    throw error;
  });
}
async function main() {
  mkdirSync(paths.stateDir(), { recursive: true, mode: 448 });
  const store = new Store({ file: paths.storeFile() });
  const token = randomBytes(24).toString("base64url");
  const allowedHosts = /* @__PURE__ */ new Set();
  const server = createServer(createApp({ store, token, allowedHosts, webDir: WEB_DIR }));
  server.keepAliveTimeout = 2e3;
  const port = await listen(server);
  allowedHosts.add(`127.0.0.1:${port}`);
  allowedHosts.add(`localhost:${port}`);
  writeFileSync2(paths.portFile(), String(port));
  const info = { port, token, pid: process.pid };
  writeFileSync2(paths.serverFile(), JSON.stringify(info), { mode: 384 });
  chmodSync(paths.serverFile(), 384);
  console.error(`sidenote listening on http://127.0.0.1:${port}`);
  const shutDown = () => {
    try {
      const current = JSON.parse(readFileSync2(paths.serverFile(), "utf8"));
      if (current.pid === process.pid) rmSync(paths.serverFile());
    } catch {
    }
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
