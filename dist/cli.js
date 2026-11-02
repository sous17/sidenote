// src/cli/main.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, rmSync as rmSync2, writeFileSync } from "node:fs";

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

// src/cli/client.ts
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join as join2 } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

// src/shared/types.ts
var TOKEN_HEADER = "X-Review-Token";

// src/cli/client.ts
var SERVER_START_TIMEOUT_MS = 1e4;
var REQUEST_TIMEOUT_MS = 3e3;
var SERVER_SCRIPT = join2(dirname(fileURLToPath(import.meta.url)), "server.js");
function readServerInfo() {
  try {
    return JSON.parse(readFileSync(paths.serverFile(), "utf8"));
  } catch {
    return null;
  }
}
async function callApi(server, method, path, payload) {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { [TOKEN_HEADER]: server.token, "Content-Type": "application/json" },
    body: payload === void 0 ? void 0 : JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
async function runningServer() {
  const server = readServerInfo();
  if (!server) return null;
  try {
    await callApi(server, "GET", "/api/health");
    return server;
  } catch {
    return null;
  }
}
async function startServer() {
  mkdirSync(paths.stateDir(), { recursive: true, mode: 448 });
  rmSync(paths.serverFile(), { force: true });
  const log = openSync(paths.logFile(), "a");
  spawn(process.execPath, [SERVER_SCRIPT], { detached: true, stdio: ["ignore", log, log] }).unref();
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const server = await runningServer();
    if (server) return server;
    await sleep(100);
  }
  throw new Error(`sidenote server did not start, see ${paths.logFile()}`);
}
function pageUrl(server, sessionId) {
  const session = sessionId ? `&s=${encodeURIComponent(sessionId)}` : "";
  return `http://127.0.0.1:${server.port}/?t=${server.token}${session}`;
}
function openBrowser(url) {
  const [command2, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const child = spawn(command2, args, { detached: true, stdio: "ignore" });
  child.on("error", () => console.error(`Open ${url} in your browser.`));
  child.unref();
}
async function ensureServer() {
  const existing = await runningServer();
  if (existing) return { server: existing, started: false };
  return { server: await startServer(), started: true };
}

// src/cli/hooks.ts
import { randomBytes } from "node:crypto";
import { readFileSync as readFileSync3 } from "node:fs";
import { setTimeout as sleep2 } from "node:timers/promises";

// src/cli/format.ts
var MAX_CONTEXT_CHARS = 9500;
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
    "Use one marker per note, with the note numbers given below, and put nothing after a note's section that is not about that note. The sidenote window files each section into that note's thread, so keep the main answer free of the note answers."
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
  const text = (input.last_assistant_message ?? "").trim();
  const sessionId = input.session_id ?? "";
  if (!text || !sessionId) return;
  const { server, started } = await ensureServer();
  const body = {
    session_id: sessionId,
    session_name: sessionName(input.transcript_path),
    cwd: input.cwd ?? "",
    text
  };
  const result = await callApi(server, "POST", "/api/responses", body);
  if (started || result.new_session) openBrowser(pageUrl(server, sessionId));
}
async function hookPrompt(input) {
  const server = await runningServer();
  if (!server) return;
  const { comments } = await callApi(server, "POST", "/api/claim", { session_id: input.session_id ?? "" });
  if (!comments.length) return;
  const output = {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: formatNotesForClaude(comments) }
  };
  process.stdout.write(`${JSON.stringify(output)}
`);
}
async function hookWait(input) {
  const sessionId = input.session_id;
  if (!sessionId) return;
  let server = null;
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (!(server = await runningServer())) {
    if (Date.now() > deadline) return;
    await sleep2(500);
  }
  const waiter = { session_id: sessionId, waiter_id: randomBytes(8).toString("hex") };
  await callApi(server, "POST", "/api/waiters", waiter);
  for (; ; ) {
    await sleep2(WAITER_POLL_MS);
    let result;
    try {
      result = await callApi(server, "POST", "/api/waiters/poll", waiter);
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

// src/cli/main.ts
var USAGE = `sidenote: leave inline notes on Claude Code replies in your browser.

  sidenote on [session]        turn sidenote on and open the session's window
  sidenote off                 turn sidenote off; pending notes are kept
  sidenote open [session]      reopen the session's window
  sidenote status [session]    show the address and the session's notes
  sidenote backfill [session]  import the session's earlier replies
  sidenote hook-stop           Stop hook: send the finished reply to its session's window
  sidenote hook-prompt         UserPromptSubmit hook: attach pending notes to the prompt
  sidenote hook-wait           async Stop hook: wake Claude when the browser clicks Send now

The /sidenote:* commands pass the current session. Without one, the most recently active
session is used.`;
var isEnabled = () => existsSync2(paths.enabledFlag());
function sessionArg() {
  const arg = process.argv[3]?.trim();
  return arg && !arg.includes("$") ? arg : void 0;
}
async function latestSession(server) {
  const { sessions } = await callApi(server, "GET", "/api/sessions");
  return sessions[0]?.id;
}
async function touchSession(server, sessionId) {
  const file = findTranscript(paths.transcriptsDir(), sessionId);
  const transcript = file ? readTranscript(file) : "";
  await callApi(server, "POST", "/api/sessions", {
    session_id: sessionId,
    session_name: sessionNameFromTranscript(transcript),
    cwd: cwdFromTranscript(transcript)
  });
}
async function openSessionWindow(server, sessionId) {
  if (sessionId) await touchSession(server, sessionId);
  const url = pageUrl(server, sessionId ?? await latestSession(server));
  openBrowser(url);
  return url;
}
async function commandOn() {
  mkdirSync2(paths.stateDir(), { recursive: true, mode: 448 });
  writeFileSync(paths.enabledFlag(), "");
  const { server } = await ensureServer();
  console.log(`sidenote on: ${await openSessionWindow(server, sessionArg())}`);
}
async function commandOff() {
  rmSync2(paths.enabledFlag(), { force: true });
  const server = readServerInfo();
  if (server) {
    try {
      process.kill(server.pid, "SIGTERM");
    } catch {
    }
  }
  console.log("sidenote off. Undelivered notes are kept and will be sent after the next 'on'.");
}
async function commandStatus() {
  const server = await runningServer();
  console.log(`enabled: ${isEnabled() ? "yes" : "no"}`);
  if (!server) {
    console.log("server:  not running");
    return;
  }
  const sessionId = sessionArg() ?? await latestSession(server);
  console.log(`window:  ${pageUrl(server, sessionId)}`);
  const state = await callApi(server, "GET", `/api/state?s=${encodeURIComponent(sessionId ?? "")}`);
  if (!state.session) {
    console.log("This session has no replies in sidenote yet.");
    return;
  }
  const { session } = state;
  console.log(`session: ${session.name || "(unnamed)"} \xB7 ${session.id.slice(0, 8)} \xB7 ${session.cwd}`);
  console.log(`replies: ${state.responses.length}`);
  console.log(`pending notes: ${state.comments.filter((c) => c.delivered_at === null).length}`);
  console.log(`Send now: ${session.status === "offline" ? "not available until Claude's next reply" : "ready"}`);
}
async function commandOpen() {
  const server = await runningServer();
  if (!server) {
    console.log("The sidenote server is not running; use /sidenote:on first.");
    return;
  }
  console.log(await openSessionWindow(server, sessionArg()));
}
async function commandBackfill() {
  const server = await runningServer();
  if (!server) {
    console.log("The sidenote server is not running; use /sidenote:on first.");
    return;
  }
  const sessionId = sessionArg() ?? await latestSession(server);
  const file = sessionId ? findTranscript(paths.transcriptsDir(), sessionId) : null;
  if (!sessionId || !file) {
    console.log("No transcript found for this session.");
    return;
  }
  const transcript = readTranscript(file);
  const state = await callApi(server, "GET", `/api/state?s=${encodeURIComponent(sessionId)}`);
  const knownTexts = new Set(state.responses.map((r) => r.text));
  const cwd = state.session?.cwd || cwdFromTranscript(transcript);
  const sessionName2 = sessionNameFromTranscript(transcript);
  let imported = 0;
  for (const { createdAt, text } of finalResponsesPerTurn(transcript)) {
    if (knownTexts.has(text)) continue;
    const body = { session_id: sessionId, session_name: sessionName2, cwd, text, created_at: createdAt };
    await callApi(server, "POST", "/api/responses", body);
    imported += 1;
  }
  console.log(`Imported ${imported} earlier replies of this session.`);
}
async function runHook(handler) {
  if (!isEnabled()) return;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    await handler(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
  } catch (error) {
    mkdirSync2(paths.stateDir(), { recursive: true, mode: 448 });
    appendFileSync(paths.logFile(), `${(/* @__PURE__ */ new Date()).toISOString()} ${handler.name} failed: ${String(error)}
`);
  }
}
var COMMANDS = {
  on: commandOn,
  off: commandOff,
  status: commandStatus,
  open: commandOpen,
  backfill: commandBackfill,
  "hook-stop": () => runHook(hookStop),
  "hook-prompt": () => runHook(hookPrompt),
  "hook-wait": () => runHook(hookWait)
};
var command = COMMANDS[process.argv[2] ?? "status"];
if (!command) {
  console.log(USAGE);
  process.exitCode = 2;
} else {
  await command();
}
