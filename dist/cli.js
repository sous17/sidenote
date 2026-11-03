// src/cli/main.ts
import { appendFileSync, existsSync as existsSync3, mkdirSync as mkdirSync4, rmSync as rmSync4, writeFileSync as writeFileSync3 } from "node:fs";

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

// src/shared/types.ts
var AGENTS = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "Copilot"
};
function isAgentId(value) {
  return typeof value === "string" && Object.hasOwn(AGENTS, value);
}
var TOKEN_HEADER = "X-Review-Token";
var LAUNCH_FRAGMENT_KEY = "launch";
var SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// src/cli/agents/index.ts
import { homedir as homedir2 } from "node:os";
import { join as join5 } from "node:path";

// src/cli/agents/claude.ts
import { readFileSync as readFileSync3 } from "node:fs";

// src/cli/transcript.ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join as join2 } from "node:path";
var QUESTION_TOOLS = /* @__PURE__ */ new Set(["AskUserQuestion", "ExitPlanMode"]);
function findTranscript(transcriptsDir, sessionId) {
  if (!existsSync(transcriptsDir)) return null;
  for (const project of readdirSync(transcriptsDir)) {
    const file = join2(transcriptsDir, project, `${sessionId}.jsonl`);
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
  return readFileSync(file, "utf8");
}
function isUserPrompt(entry) {
  if (entry.isMeta) return false;
  const content = entry.message?.content;
  if (typeof content === "string") return true;
  return Array.isArray(content) && !content.some((b) => b.type === "tool_result");
}

// src/cli/agents/core.ts
import { randomBytes } from "node:crypto";
import { setTimeout as sleep2 } from "node:timers/promises";

// src/cli/client.ts
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync as readFileSync2, rmSync } from "node:fs";
import { dirname, join as join3 } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
var SERVER_START_TIMEOUT_MS = 1e4;
var REQUEST_TIMEOUT_MS = 3e3;
var SERVER_SCRIPT = join3(dirname(fileURLToPath(import.meta.url)), "server.js");
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
    const text2 = await response.text();
    if (!response.ok) {
      const detail = text2 ? JSON.parse(text2).error : void 0;
      throw new ApiError(
        response.status,
        `${method} ${path} failed with ${response.status}${detail ? `: ${detail}` : ""}`
      );
    }
    return text2 ? JSON.parse(text2) : null;
  }
};
function readServerInfo() {
  try {
    return JSON.parse(readFileSync2(paths.serverFile(), "utf8"));
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

// src/cli/format.ts
var MAX_CONTEXT_CHARS = 9500;
var CODE_CHANGE_RULE = "When you show a code change, or the user asks to see code or a diff, show it as changes to the current code, not as whole files: for each change, a sentence or two on what it does and why, then a ```diff block in unified diff format. Start each block with `--- a/<path>` and `+++ b/<path>` lines and use @@ hunks with about three lines of context. Use one block per file or per step. Put the diff in your reply itself, not only in command output such as `git diff`, because the sidenote window shows only your replies.";
function sessionContext() {
  return "The user follows this session in the sidenote browser window, which shows your replies and draws ```diff blocks as diffs. " + CODE_CHANGE_RULE;
}
var INTROS = {
  prompt: [
    "The user reviewed your earlier responses in the sidenote browser window and left these inline notes. Address them together with the user's message.",
    "Format: first answer the user's message as usual (skip this part if their message only asks you to look at the notes). Then answer each note in its own section that starts with a line containing only its marker, for example:"
  ],
  "send-now": [
    "The user clicked Send now in the sidenote browser window. There is no new terminal message: answer only these inline notes on your earlier responses.",
    "Format: skip any main answer. Answer each note in its own section that starts with a line containing only its marker, for example:"
  ],
  "turn-end": [
    "While you were working, the user left these inline notes on your earlier responses in the sidenote browser window. There is no new message from the user: answer only the notes.",
    "Format: skip any main answer. Answer each note in its own section that starts with a line containing only its marker, for example:"
  ]
};
function formatNotes(notes, trigger) {
  const first = notes[0];
  if (!first) return "";
  const [intro, formatRule] = INTROS[trigger];
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
  const text2 = lines.join("\n");
  return text2.length > MAX_CONTEXT_CHARS ? `${text2.slice(0, MAX_CONTEXT_CHARS)}
[truncated: more comments are visible in the sidenote window]` : text2;
}
function clockTime(epochSeconds) {
  const date = new Date(epochSeconds * 1e3);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// src/cli/agents/core.ts
var WAITER_POLL_MS = 1e3;
function text(input, ...keys) {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return void 0;
}
var json = (value) => ({ stdout: `${JSON.stringify(value)}
` });
async function recordReply(session2, reply) {
  const body = reply.trim();
  if (!body) return;
  const { client, started } = await SidenoteClient.ensure();
  const request = {
    session_id: session2.id,
    agent: session2.agent,
    session_name: session2.name ?? "",
    cwd: session2.cwd,
    text: body
  };
  const result = await client.post("/api/responses", request);
  if (started || result.new_session) openBrowser(await client.windowUrl(session2.id));
}
async function notesForPrompt(sessionId) {
  const client = await SidenoteClient.connect();
  if (!client) return null;
  const { comments } = await client.post("/api/claim", { session_id: sessionId });
  return comments.length ? formatNotes(comments, "prompt") : null;
}
async function startTurn(sessionId) {
  const client = await SidenoteClient.connect();
  if (client) await client.post("/api/turns/start", { session_id: sessionId });
}
async function notesAtTurnEnd(sessionId) {
  const client = await SidenoteClient.connect();
  if (!client) return null;
  const { comments } = await client.post("/api/turns/end", { session_id: sessionId });
  return comments.length ? formatNotes(comments, "turn-end") : null;
}
async function waitForSendNow(sessionId) {
  const client = await connectWithin(SERVER_START_TIMEOUT_MS);
  if (!client) return null;
  const waiter = { session_id: sessionId, waiter_id: randomBytes(8).toString("hex") };
  await client.post("/api/waiters", waiter);
  for (; ; ) {
    await sleep2(WAITER_POLL_MS);
    let result;
    try {
      result = await client.post("/api/waiters/poll", waiter);
    } catch {
      return null;
    }
    if (result.action === "exit") return null;
    if (result.action === "send") return formatNotes(result.comments, "send-now");
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

// src/cli/agents/claude.ts
function session(input) {
  const id = text(input, "session_id");
  return id ? { agent: "claude", id, cwd: text(input, "cwd") ?? "", name: renameOf(input) } : null;
}
function renameOf(input) {
  const path = text(input, "transcript_path");
  if (!path) return "";
  try {
    return sessionNameFromTranscript(readFileSync3(path, "utf8"));
  } catch {
    return "";
  }
}
var claude = {
  /** SessionStart: how to show code changes. */
  "session-start": async () => json({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sessionContext() } }),
  /** Stop: the finished reply goes to the session's window. */
  stop: async (input) => {
    const ref = session(input);
    const reply = text(input, "last_assistant_message");
    if (ref && reply) await recordReply(ref, reply);
    return {};
  },
  /** UserPromptSubmit: unsent notes go with the prompt. */
  prompt: async (input) => {
    const id = text(input, "session_id");
    const notes = id ? await notesForPrompt(id) : null;
    return notes ? json({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: notes } }) : {};
  },
  /** Stop, in the background (asyncRewake): exit 2 with the notes on stderr wakes Claude. */
  wait: async (input) => {
    const id = text(input, "session_id");
    const notes = id ? await waitForSendNow(id) : null;
    return notes ? { stderr: notes, exitCode: 2 } : {};
  }
};

// src/cli/agents/codex.ts
var codex = {
  "session-start": async () => json({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sessionContext() } }),
  prompt: async (input) => {
    const id = text(input, "session_id");
    const notes = id ? await notesForPrompt(id) : null;
    return notes ? json({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: notes } }) : {};
  },
  /** Records the reply, then continues the turn with any notes sent while Codex was working. */
  stop: async (input) => {
    const id = text(input, "session_id");
    if (!id) return json({});
    const reply = text(input, "last_assistant_message");
    if (reply) await recordReply({ agent: "codex", id, cwd: text(input, "cwd") ?? "" }, reply);
    const notes = await notesAtTurnEnd(id);
    return json(notes ? { decision: "block", reason: notes } : {});
  }
};

// src/cli/agents/copilot.ts
import { readFileSync as readFileSync4 } from "node:fs";
function lastReplyFromTranscript(transcript) {
  let reply = "";
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "user.message") reply = "";
    if (event.type !== "assistant.message" || event.data?.parentToolCallId) continue;
    const content = contentText(event.data?.content);
    if (content) reply = content;
  }
  return reply;
}
function contentText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map(
    (part) => typeof part === "object" && part && "text" in part && typeof part.text === "string" ? part.text : ""
  ).join("").trim();
}
var copilot = {
  "session-start": async () => json({ additionalContext: sessionContext() }),
  /** userPromptSubmitted can't add context: the turn starts, and unsent notes follow at its end. */
  prompt: async (input) => {
    const id = text(input, "sessionId", "session_id");
    if (id) await startTurn(id);
    return {};
  },
  stop: async (input) => {
    const id = text(input, "sessionId", "session_id");
    if (!id) return {};
    const transcriptPath = text(input, "transcriptPath", "transcript_path");
    let reply = "";
    try {
      if (transcriptPath) reply = lastReplyFromTranscript(readFileSync4(transcriptPath, "utf8"));
    } catch {
    }
    if (reply) await recordReply({ agent: "copilot", id, cwd: text(input, "cwd") ?? "" }, reply);
    const notes = await notesAtTurnEnd(id);
    return notes ? json({ decision: "block", reason: notes }) : {};
  }
};

// src/cli/agents/cursor.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync5, rmSync as rmSync2, writeFileSync } from "node:fs";
import { join as join4 } from "node:path";
var conversation = (input) => {
  const id = text(input, "conversation_id", "session_id");
  return id && SESSION_ID_PATTERN.test(id) ? id : void 0;
};
function workspace(input) {
  const roots = input["workspace_roots"];
  return Array.isArray(roots) && typeof roots[0] === "string" ? roots[0] : "";
}
var latestReplyFile = (id) => join4(paths.stateDir(), "turns", `cursor-${id}.txt`);
var cursor = {
  "session-start": async () => json({ additional_context: sessionContext() }),
  "after-response": async (input) => {
    const id = conversation(input);
    const reply = text(input, "text");
    if (id && reply) {
      mkdirSync2(join4(paths.stateDir(), "turns"), { recursive: true, mode: 448 });
      writeFileSync(latestReplyFile(id), reply, { mode: 384 });
    }
    return {};
  },
  /** beforeSubmitPrompt: the prompt goes through; unsent notes follow when this turn ends. */
  prompt: async (input) => {
    const id = conversation(input);
    if (id) await startTurn(id);
    return json({ continue: true });
  },
  stop: async (input) => {
    const id = conversation(input);
    if (!id) return json({});
    let reply = "";
    try {
      reply = readFileSync5(latestReplyFile(id), "utf8");
      rmSync2(latestReplyFile(id), { force: true });
    } catch {
    }
    if (reply) await recordReply({ agent: "cursor", id, cwd: workspace(input) }, reply);
    const notes = await notesAtTurnEnd(id);
    return json(notes ? { followup_message: notes } : {});
  }
};

// src/cli/agents/index.ts
var home = (envVar, fallback) => process.env[envVar] || join5(homedir2(), fallback);
var AGENT_ADAPTERS = {
  claude: { id: "claude", hooks: claude },
  codex: {
    id: "codex",
    hooks: codex,
    install: {
      configFile: () => join5(home("CODEX_HOME", ".codex"), "hooks.json"),
      shape: "grouped",
      events: { "session-start": "SessionStart", prompt: "UserPromptSubmit", stop: "Stop" },
      nextSteps: ["In Codex, run /hooks and trust the three sidenote hooks. Codex skips hooks until you do."]
    },
    // Codex requires JSON on stdout when a Stop hook exits 0.
    fallbackOutput: { stop: "{}" }
  },
  cursor: {
    id: "cursor",
    hooks: cursor,
    install: {
      configFile: () => join5(homedir2(), ".cursor", "hooks.json"),
      shape: "flat",
      events: {
        "session-start": "sessionStart",
        "after-response": "afterAgentResponse",
        prompt: "beforeSubmitPrompt",
        stop: "stop"
      },
      nextSteps: ["Restart Cursor, or open a new agent chat, so it loads the hooks."]
    },
    fallbackOutput: { prompt: '{"continue":true}' }
  },
  copilot: {
    id: "copilot",
    hooks: copilot,
    install: {
      configFile: () => join5(home("COPILOT_HOME", ".copilot"), "hooks", "sidenote.json"),
      shape: "own-file",
      events: { "session-start": "sessionStart", prompt: "userPromptSubmitted", stop: "agentStop" },
      nextSteps: [
        "Start a new Copilot CLI session so it loads the hooks.",
        "Copilot support is experimental: replies are read from Copilot's session log, whose format isn't documented."
      ]
    }
  }
};

// src/cli/install.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync6, rmSync as rmSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join6 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var HOOK_TIMEOUT_SECONDS = 30;
function launcherPath() {
  let dir = dirname2(fileURLToPath2(import.meta.url));
  for (; ; ) {
    const candidate = join6(dir, "bin", "sidenote");
    if (existsSync2(candidate)) return candidate;
    const parent = dirname2(dir);
    if (parent === dir) throw new Error("bin/sidenote not found next to the sidenote code");
    dir = parent;
  }
}
function hookCommand(agent, hook) {
  return `"${launcherPath()}" hook ${agent} ${hook}`;
}
function isOurs(entry, agent) {
  const command2 = entry?.["command"];
  return typeof command2 === "string" && command2.includes("sidenote") && command2.includes(` hook ${agent} `);
}
function readConfig(file) {
  if (!existsSync2(file)) return {};
  const parsed = JSON.parse(readFileSync6(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} isn't a JSON object; fix or move it, then install again`);
  }
  return parsed;
}
function writeConfig(file, config) {
  mkdirSync3(dirname2(file), { recursive: true });
  writeFileSync2(file, `${JSON.stringify(config, null, 2)}
`);
}
function withoutOurs(config, spec, agent) {
  const hooks = { ...config.hooks };
  for (const event of Object.values(spec.events)) {
    const entries = hooks[event] ?? [];
    const kept = spec.shape === "grouped" ? entries.map((group) => {
      const inner = group.hooks ?? [];
      return { ...group, hooks: inner.filter((entry) => !isOurs(entry, agent)) };
    }).filter((group) => group.hooks.length > 0) : entries.filter((entry) => !isOurs(entry, agent));
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  return { ...config, hooks };
}
function entryFor(spec, agent, hook) {
  const command2 = hookCommand(agent, hook);
  switch (spec.shape) {
    case "grouped":
      return { hooks: [{ type: "command", command: command2, timeout: HOOK_TIMEOUT_SECONDS }] };
    case "flat":
      return { command: command2, timeout: HOOK_TIMEOUT_SECONDS };
    case "own-file":
      return { type: "command", command: command2, timeoutSec: HOOK_TIMEOUT_SECONDS };
  }
}
function install(agent, spec) {
  const file = spec.configFile();
  const base = spec.shape === "own-file" ? {} : withoutOurs(readConfig(file), spec, agent);
  const config = spec.shape === "grouped" ? { ...base } : { version: 1, ...base };
  const hooks = { ...config.hooks };
  for (const [hook, event] of Object.entries(spec.events)) {
    hooks[event] = [...hooks[event] ?? [], entryFor(spec, agent, hook)];
  }
  writeConfig(file, { ...config, hooks });
  return file;
}
function uninstall(agent, spec) {
  const file = spec.configFile();
  if (!existsSync2(file)) return null;
  if (spec.shape === "own-file") {
    rmSync3(file);
    return file;
  }
  writeConfig(file, withoutOurs(readConfig(file), spec, agent));
  return file;
}

// src/cli/main.ts
var USAGE = `sidenote: leave inline notes on your coding agent's replies in a browser window.

  sidenote on [session]         turn sidenote on and open the session's window
  sidenote off                  turn sidenote off; unsent notes are kept
  sidenote open [session]       reopen the session's window
  sidenote status [session]     show the session's replies, notes and Send now status
  sidenote backfill [session]   import a Claude Code session's earlier replies
  sidenote install <agent>      add sidenote's hooks to codex, cursor or copilot
  sidenote uninstall <agent>    remove them again
  sidenote hook <agent> <hook>  run one of sidenote's hooks (agents call this)

Claude Code installs sidenote as a plugin, and its /sidenote:* commands pass the current
session. Without a session, the most recently active one is used.`;
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
    agent: "claude",
    session_name: sessionNameFromTranscript(transcript),
    cwd: cwdFromTranscript(transcript)
  });
}
async function openWindow(client, requested) {
  if (requested) await touchSession(client, requested);
  const sessionId = requested ?? await latestSession(client);
  openBrowser(await client.windowUrl(sessionId));
  const { session: session2 } = await fetchState(client, sessionId);
  const label = session2 ? `"${session2.name || session2.cwd.split("/").pop() || session2.id.slice(0, 8)}"` : "sidenote";
  return `Opened the ${label} window in your browser (${client.origin}).`;
}
var commands = {
  async on() {
    mkdirSync4(paths.stateDir(), { recursive: true, mode: 448 });
    writeFileSync3(paths.enabledFlag(), "");
    const { client } = await SidenoteClient.ensure();
    console.log(`sidenote is on. ${await openWindow(client, sessionArgument())}`);
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
    const { session: session2, responses, comments } = await fetchState(
      client,
      sessionArgument() ?? await latestSession(client)
    );
    if (!session2) {
      console.log("This session has no replies in sidenote yet.");
      return;
    }
    console.log(`session: ${session2.name || "(unnamed)"} \xB7 ${session2.id.slice(0, 8)} \xB7 ${session2.cwd}`);
    console.log(`replies: ${responses.length}`);
    console.log(`pending notes: ${comments.filter((c) => c.delivered_at === null).length}`);
    console.log(`Send now: ${session2.status === "offline" ? "available after Claude's next reply" : "ready"}`);
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
    const sessionName = sessionNameFromTranscript(transcript);
    let imported = 0;
    for (const { createdAt, text: text2 } of finalResponsesPerTurn(transcript)) {
      if (known.has(text2)) continue;
      const reply = {
        session_id: sessionId,
        agent: "claude",
        session_name: sessionName,
        cwd,
        text: text2,
        created_at: createdAt
      };
      await client.post("/api/responses", reply);
      imported += 1;
    }
    console.log(`Imported ${imported} earlier replies of this session.`);
  },
  async install() {
    const agent = agentArgument();
    const spec = agent && AGENT_ADAPTERS[agent].install;
    if (!agent || !spec) return void console.log(installHelp(agent));
    const file = install(agent, spec);
    console.log(`Added sidenote's hooks for ${AGENTS[agent]} to ${file}.`);
    for (const step of spec.nextSteps) console.log(`- ${step}`);
    console.log("- Turn sidenote on with: sidenote on");
  },
  async uninstall() {
    const agent = agentArgument();
    const spec = agent && AGENT_ADAPTERS[agent].install;
    if (!agent || !spec) return void console.log(installHelp(agent));
    const file = uninstall(agent, spec);
    console.log(file ? `Removed sidenote's hooks for ${AGENTS[agent]} from ${file}.` : "Nothing to remove.");
  },
  hook: () => runHook(process.argv[3], process.argv[4]),
  // The hook names Claude Code plugins installed before other agents were supported.
  "hook-session": () => runHook("claude", "session-start"),
  "hook-stop": () => runHook("claude", "stop"),
  "hook-prompt": () => runHook("claude", "prompt"),
  "hook-wait": () => runHook("claude", "wait")
};
function agentArgument() {
  const value = process.argv[3];
  return isAgentId(value) ? value : void 0;
}
function installHelp(agent) {
  if (agent === "claude") {
    return "Claude Code installs sidenote as a plugin: claude plugin install sidenote@sidenote";
  }
  return "Usage: sidenote install <codex|cursor|copilot>";
}
async function runHook(agentName, hookName) {
  const agent = isAgentId(agentName) ? AGENT_ADAPTERS[agentName] : void 0;
  const handler = agent && hookName ? agent.hooks[hookName] : void 0;
  const fallback = { stdout: agent?.fallbackOutput?.[hookName ?? ""] };
  let output = fallback;
  if (handler && isEnabled()) {
    try {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      output = await handler(typeof input === "object" && input !== null ? input : {});
    } catch (error) {
      mkdirSync4(paths.stateDir(), { recursive: true, mode: 448 });
      const line = `${(/* @__PURE__ */ new Date()).toISOString()} ${agentName} ${hookName} hook failed: ${String(error)}
`;
      appendFileSync(paths.logFile(), line, { mode: 384 });
      output = fallback;
    }
  }
  if (output.stdout) process.stdout.write(output.stdout);
  if (output.stderr) process.stderr.write(output.stderr);
  if (output.exitCode) process.exitCode = output.exitCode;
}
var command = commands[process.argv[2] ?? "status"];
if (command) {
  await command();
} else {
  console.log(USAGE);
  process.exitCode = 2;
}
