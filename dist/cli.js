// src/cli/main.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, rmSync as rmSync2, writeFileSync } from "node:fs";

// src/node/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
var stateDir = () => join(homedir(), ".sidenote");
var paths = {
  stateDir,
  storeFile: () => join(stateDir(), "store.json"),
  serverFile: () => join(stateDir(), "server.json"),
  portFile: () => join(stateDir(), "port"),
  logFile: () => join(stateDir(), "server.log"),
  enabledFlag: () => join(stateDir(), "enabled"),
  transcriptsDir: () => join(homedir(), ".claude", "projects")
};

// src/cli/client.ts
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join as join2 } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// src/shared/types.ts
var TOKEN_HEADER = "X-Review-Token";
var LAUNCH_FRAGMENT_KEY = "launch";

// src/cli/client.ts
var SERVER_START_TIMEOUT_MS = 1e4;
var REQUEST_TIMEOUT_MS = 3e3;
var SERVER_SCRIPT = join2(dirname(fileURLToPath(import.meta.url)), "server.js");
var ApiError = class extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
var SidenoteClient = class _SidenoteClient {
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
  /**
   * A one-time link to a session's window. The launch code sits in the URL fragment, which the
   * browser never sends to the server; the page trades it for the token once.
   */
  async windowUrl(sessionId) {
    const { code } = await this.post("/api/launch", {});
    const query = sessionId ? `?s=${encodeURIComponent(sessionId)}` : "";
    return `${this.origin}/${query}#${LAUNCH_FRAGMENT_KEY}=${code}`;
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

// src/cli/hooks.ts
import { randomBytes } from "node:crypto";
import { readFileSync as readFileSync3 } from "node:fs";
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

// src/cli/transcript.ts
import { existsSync, readdirSync, readFileSync as readFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
var QUESTION_TOOLS = /* @__PURE__ */ new Set(["AskUserQuestion", "ExitPlanMode"]);
function findTranscript(transcriptsDir, sessionId) {
  if (!existsSync(transcriptsDir)) return null;
  for (const project of readdirSync(transcriptsDir)) {
    const file = join3(transcriptsDir, project, `${sessionId}.jsonl`);
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
    const entry = JSON.parse(line);
    if (entry.isSidechain) continue;
    if (entry.type === "user" && isUserPrompt(entry) && lastBlocks.length) {
      flush();
    } else if (entry.type === "assistant") {
      const content = entry.message?.content;
      const blocks = Array.isArray(content) ? content : [];
      if (blocks.some((b) => b.name && QUESTION_TOOLS.has(b.name)) && lastBlocks.length) {
        flush();
        continue;
      }
      const texts = blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text);
      if (!texts.length) continue;
      if (entry.message?.id !== lastMessageId) {
        lastMessageId = entry.message?.id;
        lastBlocks = [];
      }
      lastBlocks.push(...texts);
      if (entry.timestamp) lastTimestamp = Date.parse(entry.timestamp) / 1e3;
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
      const entry = JSON.parse(transcript.slice(start, end === -1 ? void 0 : end));
      if (entry.type === "custom-title" && typeof entry.customTitle === "string") return entry.customTitle.trim();
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
  return readFileSync2(file, "utf8");
}
function isUserPrompt(entry) {
  if (entry.isMeta) return false;
  const content = entry.message?.content;
  if (typeof content === "string") return true;
  return Array.isArray(content) && !content.some((b) => b.type === "tool_result");
}

// src/cli/hooks.ts
var WAITER_POLL_MS = 1e3;
function sessionName(transcriptPath) {
  if (!transcriptPath) return "";
  try {
    return sessionNameFromTranscript(readFileSync3(transcriptPath, "utf8"));
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
  if (started || result.new_session) openBrowser(await client.windowUrl(sessionId));
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
var USAGE = `sidenote: leave inline notes on Claude Code replies in your browser.

  sidenote on [session]        turn sidenote on and open the session's window
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
var isEnabled = () => existsSync2(paths.enabledFlag());
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
async function openWindow(client, requested) {
  if (requested) await touchSession(client, requested);
  const sessionId = requested ?? await latestSession(client);
  openBrowser(await client.windowUrl(sessionId));
  const { session } = await fetchState(client, sessionId);
  const label = session ? `"${session.name || session.cwd.split("/").pop() || session.id.slice(0, 8)}"` : "sidenote";
  return `Opened the ${label} window in your browser (${client.origin}).`;
}
var commands = {
  async on() {
    mkdirSync2(paths.stateDir(), { recursive: true, mode: 448 });
    writeFileSync(paths.enabledFlag(), "");
    const { client } = await SidenoteClient.ensure();
    console.log(`sidenote is on. ${await openWindow(client, sessionArgument())}`);
  },
  async off() {
    rmSync2(paths.enabledFlag(), { force: true });
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
    console.log(client ? await openWindow(client, sessionArgument()) : NOT_RUNNING);
  },
  async status() {
    console.log(`enabled: ${isEnabled() ? "yes" : "no"}`);
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
    console.log(`pending notes: ${comments.filter((c) => c.delivered_at === null).length}`);
    console.log(`Send now: ${session.status === "offline" ? "available after Claude's next reply" : "ready"}`);
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
    mkdirSync2(paths.stateDir(), { recursive: true, mode: 448 });
    appendFileSync(paths.logFile(), `${(/* @__PURE__ */ new Date()).toISOString()} ${handler.name} failed: ${String(error)}
`, {
      mode: 384
    });
  }
}
var command = commands[process.argv[2] ?? "status"];
if (command) {
  await command();
} else {
  console.log(USAGE);
  process.exitCode = 2;
}
