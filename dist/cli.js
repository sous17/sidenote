// src/cli/main.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, rmSync as rmSync2, writeFileSync } from "node:fs";
import { setTimeout as sleep3 } from "node:timers/promises";

// src/node/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
var stateDir = () => join(homedir(), ".sidenote");
var paths = {
  stateDir,
  serverFile: () => join(stateDir(), "server.json"),
  lockFile: () => join(stateDir(), "server.lock"),
  portFile: () => join(stateDir(), "port"),
  logFile: () => join(stateDir(), "server.log"),
  enabledFlag: () => join(stateDir(), "enabled"),
  transcriptsDir: () => join(homedir(), ".claude", "projects")
};

// src/shared/folders.ts
function folderName(cwd) {
  return cwd.split("/").filter(Boolean).pop() ?? "";
}
function folderPath(folder) {
  return folder ? `/${encodeURIComponent(folder)}` : "/";
}

// src/cli/client.ts
import { spawn as spawn2 } from "node:child_process";
import { mkdirSync, openSync as openSync2, readFileSync as readFileSync3 } from "node:fs";
import { dirname, join as join2 } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// src/node/open.ts
import { spawn } from "node:child_process";
function openWithSystem(target, onError) {
  const [command2, args] = process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", target]] : ["xdg-open", [target]];
  const child = spawn(command2, args, { detached: true, stdio: "ignore" });
  child.on("error", onError);
  child.unref();
}

// src/server/lock.ts
import { closeSync, openSync, readFileSync as readFileSync2, rmSync, statSync, writeSync } from "node:fs";

// src/node/process.ts
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
var MAX_DEPTH = 8;
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
function isClaude(info) {
  const base = (path) => path.split("/").pop() ?? "";
  return base(info.name) === "claude" || base(info.args.split(" ")[0] ?? "") === "claude" || /@anthropic-ai\/claude-code\/cli\.js/.test(info.args);
}
function findClaude(pid, info) {
  let current = pid;
  for (let depth = 0; depth < MAX_DEPTH && current > 1; depth += 1) {
    const found = info(current);
    if (!found) return null;
    if (isClaude(found)) return { pid: current, started: found.started };
    current = found.ppid;
  }
  return null;
}
function claudeProcess() {
  return findClaude(process.ppid, (pid) => processInfo(pid));
}
function pidInUse(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// src/server/lock.ts
function readLock(lockFile) {
  try {
    const [pid = "", started = ""] = readFileSync2(lockFile, "utf8").split("\n");
    return { pid: Number.parseInt(pid, 10), started };
  } catch {
    return null;
  }
}
function isOwner(pid, started) {
  const info = processInfo(pid);
  if (!info) return false;
  return started ? info.started === started : info.args.includes("server.js");
}
function serverLockOwner(lockFile) {
  const lock = readLock(lockFile);
  return lock && !Number.isNaN(lock.pid) && isOwner(lock.pid, lock.started) ? lock.pid : null;
}

// src/shared/types.ts
var TOKEN_HEADER = "X-Review-Token";
var LAUNCH_FRAGMENT_KEY = "launch";
var PAGE_HOST = "sidenote.localhost";

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
   * The address of the window for a folder. Only browsers get the page host: Node may resolve it
   * to ::1, where the server doesn't listen, so the CLI's own requests stay on 127.0.0.1.
   */
  windowAddress(cwd) {
    return `http://${PAGE_HOST}:${this.#server.port}${folderPath(folderName(cwd))}`;
  }
  /**
   * A one-time link to a session's window. The launch code sits in the URL fragment, which the
   * browser never sends to the server; the page trades it for the token once.
   */
  async windowUrl(sessionId, cwd = "") {
    const { code } = await this.post("/api/launch", {});
    const query = sessionId ? `?s=${encodeURIComponent(sessionId)}` : "";
    return `${this.windowAddress(cwd)}${query}#${LAUNCH_FRAGMENT_KEY}=${code}`;
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
    return JSON.parse(readFileSync3(paths.serverFile(), "utf8"));
  } catch {
    return null;
  }
}
function serverPid() {
  return serverLockOwner(paths.lockFile());
}
async function startServer() {
  mkdirSync(paths.stateDir(), { recursive: true, mode: 448 });
  const log = openSync2(paths.logFile(), "a", 384);
  spawn2(process.execPath, [SERVER_SCRIPT], { detached: true, stdio: ["ignore", log, log] }).unref();
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const client = await SidenoteClient.connect();
    if (client) return client;
    await sleep(100);
  }
  throw new Error(`the sidenote server did not start; see ${paths.logFile()}`);
}
function openBrowser(url) {
  openWithSystem(url, () => console.error(`Couldn't open a browser. Open this link instead (valid once): ${url}`));
}

// src/cli/hooks.ts
import { randomBytes } from "node:crypto";
import { readFileSync as readFileSync5 } from "node:fs";
import { setTimeout as sleep2 } from "node:timers/promises";

// src/cli/format.ts
var MAX_CONTEXT_CHARS = 9500;
var CODE_CHANGE_RULE = "When you show a code change, or the user asks to see code or a diff, show it as changes to the current code, not as whole files: for each change, a sentence or two on what it does and why, then a ```diff block in unified diff format. Start each block with `--- a/<path>` and `+++ b/<path>` lines and use @@ hunks with about three lines of context. Use one block per file or per step. Put the diff in your reply itself, not only in command output such as `git diff`, because the sidenote window shows only your replies.";
var QUESTION_RULE = "When you need the user to answer a question or choose between options, don't use the AskUserQuestion tool: it waits in the terminal, where the sidenote window can't show it. Write the question in your reply instead, with any options as a numbered list and your recommendation if you have one, then end your turn. The user answers in their next message.";
function sessionContext() {
  return `The user follows this session in the sidenote browser window, which shows your replies and draws \`\`\`diff blocks as diffs. ${CODE_CHANGE_RULE} ${QUESTION_RULE}`;
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
var WAKE_MARKERS = ["The user clicked Send now in the sidenote browser window", "from the sidenote browser window"];
function isWakeText(prompt) {
  return WAKE_MARKERS.some((marker) => prompt.includes(marker));
}
function formatPromptForClaude(prompt, notes, options = {}) {
  const intro = options.withTerminalPrompt ? "While you were working, the user also sent you this message from the sidenote browser window. Treat it as part of their message:" : "The user sent you this message from the sidenote browser window instead of the terminal. Treat it exactly as if they had typed it to you:";
  const text = `${intro}

${prompt.trim()}`;
  if (!notes.length) return text;
  const combined = `${text}

${formatNotesForClaude(notes)}`;
  return combined.length > MAX_CONTEXT_CHARS ? `${combined.slice(0, MAX_CONTEXT_CHARS)}
[truncated: more comments are visible in the sidenote window]` : combined;
}

// src/shared/tools.ts
var MAX_ACTIVITY_CHARS = 200;
var MAX_PROGRESS_DELTA_CHARS = 2e4;
var ACTIVITY_VERBS = /* @__PURE__ */ new Map([
  ["Read", "Reading"],
  ["Edit", "Editing"],
  ["MultiEdit", "Editing"],
  ["NotebookEdit", "Editing"],
  ["Write", "Writing"],
  ["Bash", "Running"],
  ["Grep", "Searching for"],
  ["Glob", "Searching for"],
  ["WebFetch", "Fetching"],
  ["WebSearch", "Searching the web for"],
  ["Task", "Delegating:"],
  ["Agent", "Delegating:"]
]);
var str = (value) => typeof value === "string" ? value : "";
function shortPath(path, cwd) {
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  return path;
}
function toolSummary(tool, input, cwd) {
  const path = str(input["file_path"]) || str(input["notebook_path"]);
  if (path) return shortPath(path, cwd);
  switch (tool) {
    case "Bash":
      return firstLine(str(input["command"]));
    case "Glob":
    case "Grep": {
      const where = str(input["path"]);
      return where ? `${str(input["pattern"])} in ${shortPath(where, cwd)}` : str(input["pattern"]);
    }
    case "WebFetch":
      return str(input["url"]);
    case "WebSearch":
      return str(input["query"]);
    case "Task":
    case "Agent":
      return str(input["description"]);
    case "TodoWrite":
      return "";
  }
  const first = Object.values(input).find((value) => typeof value === "string" && value.trim());
  return firstLine(str(first));
}
function toolActivity(tool, input, cwd) {
  return activityLine(tool, toolSummary(tool, input, cwd));
}
function activityLine(tool, summary) {
  if (tool === "TodoWrite") return "";
  const verb = ACTIVITY_VERBS.get(tool);
  const line = verb ? `${verb} ${summary}`.trim() : `Using ${tool}`;
  return line.slice(0, MAX_ACTIVITY_CHARS);
}
function firstLine(text) {
  const lines = text.trim().split("\n");
  return lines.length > 1 ? `${lines[0]} \u2026` : lines[0] ?? "";
}

// src/cli/transcript.ts
import { existsSync, readdirSync, readFileSync as readFileSync4 } from "node:fs";
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
  return readFileSync4(file, "utf8");
}
function isUserPrompt(entry) {
  if (entry.isMeta) return false;
  const content = entry.message?.content;
  if (typeof content === "string") return true;
  return Array.isArray(content) && !content.some((b) => b.type === "tool_result");
}

// src/cli/hooks.ts
var WAITER_POLL_MS = 1e3;
var MAX_SHOWN_PROMPT_CHARS = 1e5;
function reportedProcess() {
  const found = claudeProcess();
  return found ? { claude_process: found } : {};
}
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
    text,
    ...reportedProcess()
  };
  const result = await client.post("/api/responses", reply);
  if (started || result.new_session) openBrowser(await client.windowUrl(sessionId, reply.cwd));
}
async function hookClear(input) {
  if (input.reason !== "clear" || !input.session_id) return;
  const client = await SidenoteClient.connect();
  if (!client) return;
  await client.post("/api/sessions/cleared", { session_id: input.session_id });
}
async function hookSession() {
  const output = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sessionContext() } };
  process.stdout.write(`${JSON.stringify(output)}
`);
}
async function hookPrompt(input) {
  if (!input.session_id) return;
  const { client } = await SidenoteClient.ensure();
  const claim = { session_id: input.session_id, ...reportedProcess() };
  if (input.prompt && !isWakeText(input.prompt)) claim.prompt = input.prompt.slice(0, MAX_SHOWN_PROMPT_CHARS);
  const { comments, prompt } = await client.post("/api/claim", claim);
  if (!comments.length && prompt === void 0) return;
  const additionalContext = prompt === void 0 ? formatNotesForClaude(comments) : formatPromptForClaude(prompt, comments, { withTerminalPrompt: true });
  const output = { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
  process.stdout.write(`${JSON.stringify(output)}
`);
}
async function hookActivity(input) {
  if (!input.session_id || !input.tool_name || input.agent_id) return;
  const text = toolActivity(input.tool_name, input.tool_input ?? {}, input.cwd ?? "");
  if (!text) return;
  const client = await SidenoteClient.connect();
  if (!client) return;
  const activity = { session_id: input.session_id, text };
  await client.post("/api/activity", activity);
}
async function hookProgress(input) {
  const { session_id, message_id, index, delta } = input;
  if (!session_id || !message_id || index === void 0 || !delta || input.agent_id) return;
  const client = await SidenoteClient.connect();
  if (!client) return;
  const progress = {
    session_id,
    message_id,
    index,
    delta: delta.slice(0, MAX_PROGRESS_DELTA_CHARS)
  };
  await client.post("/api/progress", progress);
}
async function hookWait(input) {
  if (!input.session_id) return;
  const client = await connectWithin(SERVER_START_TIMEOUT_MS);
  if (!client) return;
  const waiter = {
    session_id: input.session_id,
    waiter_id: randomBytes(8).toString("hex"),
    ...reportedProcess()
  };
  await client.post("/api/waiters", waiter);
  const owner = claudeProcess();
  for (; ; ) {
    await sleep2(WAITER_POLL_MS);
    if (owner && !pidInUse(owner.pid)) return;
    let result;
    try {
      result = await client.post("/api/waiters/poll", waiter);
    } catch {
      return;
    }
    if (result.action === "exit") return;
    if (result.action === "send") {
      process.stderr.write(
        result.prompt === void 0 ? formatNotesForClaude(result.comments, { fromBrowser: true }) : formatPromptForClaude(result.prompt, result.comments)
      );
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
  sidenote restart [session]   restart the server, for example after an update, and open the
                               session's window; unsent notes are kept
  sidenote open [session]      reopen the session's window
  sidenote status [session]    show the session's replies, notes and Send now status
  sidenote backfill [session]  import the session's earlier replies
  sidenote hook-session        SessionStart hook: ask Claude to show code changes as diffs
  sidenote hook-stop           Stop hook: send the finished reply to its session's window
  sidenote hook-clear          SessionEnd hook: forget the session on /clear
  sidenote hook-prompt         UserPromptSubmit hook: attach pending notes to the prompt
  sidenote hook-activity       async PreToolUse hook: show what Claude is doing in the window
  sidenote hook-progress       async MessageDisplay hook: show Claude's messages as it works
  sidenote hook-wait           async Stop hook: wake Claude when the browser clicks Send now

The /sidenote:* commands pass the current session. Without one, the most recently active
session is used.`;
var NOT_RUNNING = "sidenote is off; use /sidenote:on first.";
var SERVER_STOP_TIMEOUT_MS = 5e3;
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
  const { session } = await fetchState(client, sessionId);
  const cwd = session?.cwd ?? "";
  openBrowser(await client.windowUrl(sessionId, cwd));
  const label = session ? `"${session.name || folderName(cwd) || session.id.slice(0, 8)}"` : "sidenote";
  return `Opened the ${label} window in your browser (${client.windowAddress(cwd)}).`;
}
async function enabledClient() {
  return isEnabled() ? (await SidenoteClient.ensure()).client : null;
}
function stopServer() {
  const pid = serverPid();
  if (!pid) return null;
  try {
    process.kill(pid, "SIGTERM");
    return pid;
  } catch {
    return null;
  }
}
async function exited(pid) {
  const deadline = Date.now() + SERVER_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep3(100);
  }
  return false;
}
async function turnOn() {
  mkdirSync2(paths.stateDir(), { recursive: true, mode: 448 });
  writeFileSync(paths.enabledFlag(), "");
  const { client } = await SidenoteClient.ensure();
  return openWindow(client, sessionArgument());
}
var commands = {
  async on() {
    console.log(`sidenote is on. ${await turnOn()}`);
  },
  async off() {
    rmSync2(paths.enabledFlag(), { force: true });
    stopServer();
    console.log("sidenote is off. Unsent notes are kept and go out after the next /sidenote:on.");
  },
  async restart() {
    const pid = stopServer();
    if (pid && !await exited(pid)) {
      console.log(`The sidenote server (pid ${pid}) didn't stop, so nothing was restarted.`);
      process.exitCode = 1;
      return;
    }
    console.log(`sidenote restarted. ${await turnOn()}`);
  },
  async open() {
    const client = await enabledClient();
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
    console.log(`window:  ${client.windowAddress(session.cwd)}`);
    console.log(`replies: ${responses.length}`);
    console.log(`pending notes: ${comments.filter((c) => c.delivered_at === null).length}`);
    console.log(`Send now: ${session.status === "offline" ? "available after Claude's next reply" : "ready"}`);
  },
  /** Imports the session's earlier replies from its transcript, so you can leave notes on them. */
  async backfill() {
    const client = await enabledClient();
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
  "hook-clear": () => runHook(hookClear),
  "hook-prompt": () => runHook(hookPrompt),
  "hook-activity": () => runHook(hookActivity),
  "hook-progress": () => runHook(hookProgress),
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
