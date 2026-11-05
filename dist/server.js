// src/server/main.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { mkdirSync as mkdirSync2, readFileSync as readFileSync6, rmSync as rmSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { createServer } from "node:http";
import { dirname as dirname3, join as join7 } from "node:path";
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
  serverFile: () => join(stateDir(), "server.json"),
  lockFile: () => join(stateDir(), "server.lock"),
  portFile: () => join(stateDir(), "port"),
  logFile: () => join(stateDir(), "server.log"),
  enabledFlag: () => join(stateDir(), "enabled"),
  /** Where the installed plugin's launcher is now, for the command below. */
  launcherFile: () => join(stateDir(), "launcher"),
  /** The `sidenote` command. Claude Code's own installer uses this folder too. */
  commandFile: () => join(homedir(), ".local", "bin", "sidenote"),
  transcriptsDir: () => join(homedir(), ".claude", "projects"),
  claudeSettings: () => join(process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), "settings.json"),
  /** Claude Code's own state, which records the folders the user trusted. */
  claudeConfig: () => join(process.env["CLAUDE_CONFIG_DIR"] ?? homedir(), ".claude.json"),
  managedClaudeSettings: () => process.platform === "darwin" ? "/Library/Application Support/ClaudeCode/managed-settings.json" : "/etc/claude-code/managed-settings.json"
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
function isClaude(info) {
  const base = (path) => path.split("/").pop() ?? "";
  return base(info.name) === "claude" || base(info.args.split(" ")[0] ?? "") === "claude" || /@anthropic-ai\/claude-code\/cli\.js/.test(info.args);
}
function isSameClaude(recorded, info = processInfo) {
  const found = info(recorded.pid);
  return found?.started === recorded.started && isClaude(found);
}
function pidInUse(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// src/node/trust.ts
import { readFileSync as readFileSync2, statSync } from "node:fs";
import { dirname, join as join2, resolve } from "node:path";
var WORKTREE_GITDIR = /^gitdir: (.+)\/\.git\/worktrees\/[^/\n]+\s*$/;
function read(file) {
  try {
    return readFileSync2(file, "utf8");
  } catch {
    return "";
  }
}
function mainCheckout(folder) {
  const gitFile = join2(folder, ".git");
  const gitDir = /^gitdir: (.+?)\s*$/.exec(read(gitFile))?.[1];
  const main2 = WORKTREE_GITDIR.exec(read(gitFile))?.[1];
  if (!gitDir || !main2) return null;
  return read(join2(resolve(folder, gitDir), "gitdir")).trim() === gitFile ? resolve(folder, main2) : null;
}
function repositoryRoot(folder) {
  for (let dir = folder; ; dir = dirname(dir)) {
    const git = statSync(join2(dir, ".git"), { throwIfNoEntry: false });
    if (git) return git.isFile() && mainCheckout(dir) || dir;
    if (dir === dirname(dir)) return null;
  }
}
function isTrustedFolder(folder, configFile = paths.claudeConfig()) {
  let projects;
  try {
    projects = JSON.parse(read(configFile)).projects;
  } catch {
    return false;
  }
  if (typeof projects !== "object" || projects === null) return false;
  const known = new Map(Object.entries(projects));
  const accepted = (path) => known.get(path)?.hasTrustDialogAccepted === true;
  const repository = repositoryRoot(folder);
  if (repository) return accepted(repository);
  for (let dir = folder; ; dir = dirname(dir)) {
    if (accepted(dir)) return true;
    if (dir === dirname(dir)) return false;
  }
}

// src/node/terminal.ts
import { spawn as spawn2 } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join as join3 } from "node:path";
var STILL_STARTING_MS = 3e3;
var MACOS_SCRIPT = [
  "on run argv",
  'set theCommand to "cd " & quoted form of item 1 of argv & " && claude " & quoted form of item 2 of argv & " " & quoted form of item 3 of argv',
  'if item 4 of argv is not "" then set theCommand to theCommand & " " & quoted form of ("--name=" & item 4 of argv)',
  'if (count of argv) > 4 then set theCommand to theCommand & " -- " & quoted form of item 5 of argv',
  'tell application "Terminal"',
  "activate",
  "do script theCommand",
  "end tell",
  "end run"
];
function terminalCommand(platform, session) {
  const prompt = session.prompt ? [session.prompt] : [];
  const sessionFlag = session.resume ? "--resume" : "--session-id";
  if (platform === "darwin") {
    const args = [session.cwd, sessionFlag, session.sessionId, session.name, ...prompt];
    return ["osascript", [...MACOS_SCRIPT.flatMap((line) => ["-e", line]), ...args]];
  }
  if (platform === "linux") {
    const claude = [
      "claude",
      sessionFlag,
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
  return new Promise((resolve3, reject) => {
    const child = spawn2(command[0], [...command[1]], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-500);
    });
    const stillStarting = setTimeout(() => {
      child.stderr.destroy();
      child.unref();
      resolve3();
    }, STILL_STARTING_MS);
    child.on("error", (error) => {
      clearTimeout(stillStarting);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(stillStarting);
      if (code === 0) resolve3();
      else reject(new Error(stderr.trim() || `${command[0]} exited with ${code}`));
    });
  });
}
function onPath(name) {
  return (process.env["PATH"] ?? "").split(delimiter).filter(Boolean).some((dir) => {
    try {
      accessSync(join3(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// src/agent/claude.ts
import { spawn as spawn3 } from "node:child_process";
import { existsSync, readFileSync as readFileSync3 } from "node:fs";
import { dirname as dirname2, join as join4 } from "node:path";
import { createInterface } from "node:readline";
var HEADLESS_ENV = "SIDENOTE_HEADLESS";
var CLOSE_GRACE_MS = 3e3;
var STDERR_TAIL_CHARS = 2e3;
var STARTING_MODES = /* @__PURE__ */ new Set(["auto", "acceptEdits", "dontAsk", "plan"]);
function startingMode(settingsFile, overriding = []) {
  if (overriding.some((file) => chosenMode(file) !== void 0)) return null;
  const chosen = chosenMode(settingsFile);
  if (chosen === void 0) return "auto";
  return typeof chosen === "string" && STARTING_MODES.has(chosen) ? chosen : null;
}
function chosenMode(settingsFile) {
  let contents;
  try {
    contents = readFileSync3(settingsFile, "utf8");
  } catch (error) {
    return error.code === "ENOENT" ? void 0 : null;
  }
  try {
    return JSON.parse(contents).permissions?.defaultMode;
  } catch {
    return null;
  }
}
function overridingSettings(cwd) {
  const inFolder = (folder, file) => join4(folder, ".claude", file);
  const files = [paths.managedClaudeSettings(), inFolder(cwd, "settings.local.json"), inFolder(cwd, "settings.json")];
  for (let folder = cwd; ; folder = dirname2(folder)) {
    if (existsSync(join4(folder, ".git"))) {
      files.push(inFolder(folder, "settings.local.json"));
      return files;
    }
    if (folder === dirname2(folder)) return files;
  }
}
function claudeArgs(options) {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool",
    "stdio",
    ...options.permissionMode ? ["--permission-mode", options.permissionMode] : [],
    ...options.resume ? ["--resume", options.sessionId] : ["--session-id", options.sessionId],
    ...options.instructions ? ["--append-system-prompt", options.instructions] : []
  ];
}
var ClaudeAgent = class {
  name = "Claude Code";
  #command;
  #instructions;
  #settingsFile;
  constructor(options = {}) {
    this.#command = options.command ?? process.env["SIDENOTE_CLAUDE"] ?? "claude";
    this.#instructions = options.instructions ?? "";
    this.#settingsFile = options.settingsFile ?? paths.claudeSettings();
  }
  start(options, onEvent) {
    const permissionMode = startingMode(this.#settingsFile, overridingSettings(options.cwd));
    const args = claudeArgs({ ...options, instructions: this.#instructions, permissionMode });
    const child = spawn3(this.#command, args, {
      cwd: options.cwd,
      env: { ...process.env, [HEADLESS_ENV]: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    return new ClaudeProcess(child, onEvent);
  }
};
var ClaudeProcess = class {
  #child;
  #stream;
  #onEvent;
  #stderr = "";
  #exited = false;
  #requests = 0;
  constructor(child, onEvent) {
    this.#child = child;
    this.#onEvent = onEvent;
    this.#stream = new ClaudeStream();
    createInterface({ input: child.stdout }).on("line", (line) => {
      for (const event of this.#stream.read(line)) onEvent(event);
    });
    child.stderr.on("data", (chunk) => {
      this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
    });
    child.stdin.on("error", () => {
    });
    child.on("error", (error) => this.#exit(`Couldn't start Claude Code: ${error.message}`));
    child.on("exit", (code, signal) => {
      const detail = this.#stderr.trim().split("\n").at(-1) ?? "";
      this.#exit(
        code === 0 ? "Claude Code stopped." : `Claude Code stopped (${signal ?? `exit ${code}`})${detail ? `: ${detail}` : "."}`
      );
    });
  }
  send(text2) {
    this.#write({ type: "user", message: { role: "user", content: text2 }, parent_tool_use_id: null, session_id: "" });
  }
  interrupt() {
    this.#stream.interrupting = true;
    this.#write({
      type: "control_request",
      request_id: `sidenote-${++this.#requests}`,
      request: { subtype: "interrupt" }
    });
  }
  answer(request, decision) {
    const suggestions = this.#stream.takeSuggestions(request.request_id);
    const response = decision === "deny" ? { behavior: "deny", message: "The user declined this in sidenote." } : {
      behavior: "allow",
      updatedInput: request.input,
      // "Always" applies the rule Claude Code suggested, such as allowing edits for the session.
      ...decision === "always" && suggestions.length ? { updatedPermissions: suggestions } : {}
    };
    this.#write({
      type: "control_response",
      response: { subtype: "success", request_id: request.request_id, response }
    });
  }
  close() {
    if (this.#exited) return;
    this.#child.stdin.end();
    setTimeout(() => {
      if (!this.#exited) this.#child.kill("SIGTERM");
    }, CLOSE_GRACE_MS).unref();
  }
  #write(message) {
    if (!this.#exited) this.#child.stdin.write(`${JSON.stringify(message)}
`);
  }
  #exit(message) {
    if (this.#exited) return;
    this.#exited = true;
    this.#onEvent({ type: "exit", message });
  }
};
var isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var text = (value) => typeof value === "string" ? value : "";
var count = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
var ClaudeStream = class {
  /** Set when an interrupt was sent, so the turn's error result reads as interrupted. */
  interrupting = false;
  #model = "";
  #suggestions = /* @__PURE__ */ new Map();
  read(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return [];
    }
    if (!isObject(message)) return [];
    if (message["type"] === "control_cancel_request") return this.#controlCancel(message);
    if ("parent_tool_use_id" in message && message["parent_tool_use_id"] !== null) return [];
    switch (message["type"]) {
      case "system":
        return this.#system(message);
      case "stream_event":
        return this.#streamEvent(message["event"]);
      case "assistant":
        return this.#assistant(message["message"]);
      case "user":
        return this.#toolResults(message["message"]);
      case "control_request":
        return this.#controlRequest(message);
      case "result":
        return this.#result(message);
      default:
        return [];
    }
  }
  /** The permission rules Claude Code suggested for a request, handed out once. */
  takeSuggestions(requestId) {
    const suggestions = this.#suggestions.get(requestId) ?? [];
    this.#suggestions.delete(requestId);
    return suggestions;
  }
  #system(message) {
    if (message["subtype"] !== "init") return [];
    this.#model = text(message["model"]);
    return [{ type: "ready", session_id: text(message["session_id"]), model: this.#model }];
  }
  #streamEvent(event) {
    if (!isObject(event) || event["type"] !== "content_block_delta") return [];
    const delta = event["delta"];
    if (!isObject(delta) || delta["type"] !== "text_delta") return [];
    return [{ type: "text_delta", text: text(delta["text"]) }];
  }
  #assistant(message) {
    if (!isObject(message) || !Array.isArray(message["content"])) return [];
    const events = [];
    for (const block of message["content"]) {
      if (!isObject(block)) continue;
      if (block["type"] === "text") events.push({ type: "text", text: text(block["text"]) });
      if (block["type"] === "tool_use") {
        events.push({
          type: "tool_use",
          id: text(block["id"]),
          name: text(block["name"]),
          input: isObject(block["input"]) ? block["input"] : {}
        });
      }
    }
    const usage = message["usage"];
    if (isObject(usage)) {
      const tokens = count(usage["input_tokens"]) + count(usage["cache_read_input_tokens"]) + count(usage["cache_creation_input_tokens"]);
      if (tokens) events.push({ type: "usage", context_tokens: tokens, context_window: null });
    }
    return events;
  }
  #toolResults(message) {
    if (!isObject(message) || !Array.isArray(message["content"])) return [];
    return message["content"].filter((block) => isObject(block) && block["type"] === "tool_result").map((block) => ({ type: "tool_result", id: text(block["tool_use_id"]), failed: block["is_error"] === true }));
  }
  #controlRequest(message) {
    const request = message["request"];
    if (!isObject(request) || request["subtype"] !== "can_use_tool") return [];
    const requestId = text(message["request_id"]);
    if (Array.isArray(request["permission_suggestions"]))
      this.#suggestions.set(requestId, request["permission_suggestions"]);
    return [
      {
        type: "permission",
        request: {
          request_id: requestId,
          tool_name: text(request["tool_name"]),
          description: text(request["description"]),
          input: isObject(request["input"]) ? request["input"] : {}
        }
      }
    ];
  }
  /** Claude Code took a request back, so its prompt must not wait for an answer any more. */
  #controlCancel(message) {
    const requestId = text(message["request_id"]);
    this.#suggestions.delete(requestId);
    return [{ type: "permission_cancelled", request_id: requestId }];
  }
  #result(message) {
    const interrupted = this.interrupting;
    this.interrupting = false;
    const events = [];
    const usage = message["modelUsage"];
    const model = isObject(usage) ? usage[this.#model] : void 0;
    if (isObject(model) && count(model["contextWindow"])) {
      events.push({ type: "usage", context_tokens: null, context_window: count(model["contextWindow"]) });
    }
    const cost = message["total_cost_usd"];
    const end = {
      // A failure such as a missing login can come as a "success" with is_error set.
      outcome: message["subtype"] === "success" && message["is_error"] !== true ? "done" : interrupted ? "interrupted" : "error",
      error: "",
      cost_usd: typeof cost === "number" ? cost : null
    };
    if (end.outcome === "error") {
      const errors = Array.isArray(message["errors"]) ? message["errors"].map(text) : [];
      end.error = text(message["result"]) || errors.filter(Boolean).join("; ") || text(message["subtype"]);
    }
    events.push({ type: "turn_end", end });
    return events;
  }
};

// src/shared/format.ts
var MAX_CONTEXT_CHARS = 9500;
var CODE_CHANGE_RULE = "When you show a code change, or the user asks to see code or a diff, show it as changes to the current code, not as whole files: for each change, a sentence or two on what it does and why, then a ```diff block in unified diff format. Start each block with `--- a/<path>` and `+++ b/<path>` lines and use @@ hunks with about three lines of context. Use one block per file or per step. Put the diff in your reply itself, not only in command output such as `git diff`, because the sidenote window shows only your replies.";
var QUESTION_RULE = "When you need the user to answer a question or choose between options, don't use the AskUserQuestion tool: it waits in the terminal, where the sidenote window can't show it. Write the question in your reply instead, with any options as a numbered list and your recommendation if you have one, then end your turn. The user answers in their next message.";
function sessionContext() {
  return `The user follows this session in sidenote, which shows your replies and draws \`\`\`diff blocks as diffs. ${CODE_CHANGE_RULE} ${QUESTION_RULE}`;
}
function formatNotesForClaude(notes, options = {}) {
  const first = notes[0];
  if (!first) return "";
  const [intro, formatRule] = options.sendNow ? [
    "The user clicked Send now in sidenote. There is no new message: answer only these inline notes on your earlier responses.",
    "Format: skip any main answer. Answer each note in its own section that starts with a line containing only its marker, for example:"
  ] : [
    "The user reviewed your earlier responses in sidenote and left these inline notes. Address them together with the user's message.",
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
  const text2 = lines.join("\n");
  return text2.length > MAX_CONTEXT_CHARS ? `${text2.slice(0, MAX_CONTEXT_CHARS)}
[truncated: more comments are visible in the sidenote window]` : text2;
}
function clockTime(epochSeconds) {
  const date = new Date(epochSeconds * 1e3);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
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
function splitNoteAnswers(text2, noteIds) {
  const main2 = [];
  const sections = /* @__PURE__ */ new Map();
  let current = null;
  let inFence = false;
  for (const line of text2.split(/\r?\n/)) {
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
    (text2) => text2.split(/\r?\n/).filter((line) => !NOTE_MARKER.test(line)).join("\n").trim()
  ).filter(Boolean).slice(-MAX_PROGRESS_MESSAGES).map((text2) => text2.length > MAX_PROGRESS_CHARS ? `\u2026${text2.slice(-MAX_PROGRESS_CHARS)}` : text2);
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
  /**
   * Bumps the store's revision when a status changed, so pages see it: a waiter gone quiet, or a
   * session sidenote runs moving on, whose status comes from statusOf.
   */
  refresh(statusOf = (id) => this.status(id)) {
    const signature = JSON.stringify(this.#store.listSessions().map((s) => [s.id, statusOf(s.id)]));
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
  setActivity(sessionId2, text2) {
    if (this.#state(sessionId2) !== "busy") return;
    this.#activity.set(sessionId2, text2);
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
  requestPrompt(sessionId2, text2) {
    const state = this.#state(sessionId2);
    if (state === "offline") return "offline";
    const waiting = this.#store.waitingMessageText(sessionId2);
    if ((waiting ? `${waiting}

${text2}` : text2).length > MAX_PROMPT_CHARS) return "too-long";
    this.#store.addMessage(sessionId2, text2, "page");
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
  /** The session's Claude is gone, so nothing may wake it: its waiter exits at its next poll. */
  forgetSession(sessionId2) {
    this.#waiters.delete(sessionId2);
    this.#busy.delete(sessionId2);
    this.#requested.delete(sessionId2);
    this.#forgetTurn(sessionId2);
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

// src/server/host.ts
import { randomUUID } from "node:crypto";

// node_modules/marked/lib/marked.esm.js
function v() {
  return { async: false, breaks: false, extensions: null, gfm: true, hooks: null, pedantic: false, renderer: null, silent: false, tokenizer: null, walkTokens: null };
}
var y = v();
function ee(a3) {
  y = a3;
}
var B = { exec: () => null };
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
var Me = ((a3 = "") => {
  try {
    return !!new RegExp("(?<=1)(?<!1)" + a3);
  } catch {
    return false;
  }
})();
var T = { codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm, outputLinkReplace: /\\([\[\]])/g, indentCodeCompensation: /^(\s+)(?:```)/, beginningSpace: /^\s+/, endingHash: /#$/, startingSpaceChar: /^ /, endingSpaceChar: / $/, endingSpaceTabChar: /[ \t]$/, nonSpaceChar: /[^ ]/, newLineCharGlobal: /\n/g, tabCharGlobal: /\t/g, leadingSpaceTab: /^[ \t]+/, multipleSpaceGlobal: /\s+/g, blankLine: /^[ \t]*$/, doubleBlankLine: /\n[ \t]*\n[ \t]*$/, blockquoteStart: /^ {0,3}>/, blockquoteSetextReplace: /\n {0,3}((?:=+|-+) *)(?=\n|$)/g, blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm, blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm, listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g, listIsTask: /^\[[ xX]\] +\S/, listReplaceTask: /^\[[ xX]\] +/, listTaskCheckbox: /\[[ xX]\]/, anyLine: /\n.*\n/, hrefBrackets: /^<(.*)>$/, tableDelimiter: /[:|]/, tableAlignChars: /^\||\| *$/g, tableRowBlankLine: /\n[ \t]*$/, tableAlignRight: /^ *-+: *$/, tableAlignCenter: /^ *:-+: *$/, tableAlignLeft: /^ *:-+ *$/, startATag: /^<a /i, endATag: /^<\/a>/i, startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i, endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i, startAngleBracket: /^</, endAngleBracket: />$/, pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/, unicodeAlphaNumeric: /[\p{L}\p{N}]/u, numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/, numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, escapeTest: /[&<>"']/, escapeReplace: /[&<>"']/g, escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/, escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, caret: /(^|[^\[])\^/g, percentDecode: /%25/g, findPipe: /\|/g, splitPipe: / \|/, slashPipe: /\\\|/g, carriageReturn: /\r\n|\r/g, spaceLine: /^ +$/gm, notSpaceStart: /^\S*/, endingNewline: /\n$/, listItemRegex: (a3) => new RegExp(`^( {0,3}${a3})((?:[	 ][^\\n]*)?(?:\\n|$))`), nextBulletRegex: I((a3) => new RegExp(`^ {0,${a3}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`)), hrRegex: I((a3) => new RegExp(`^ {0,${a3}}((?:-[ 	]*){3,}|(?:_[ 	]*){3,}|(?:\\*[ 	]*){3,})(?:\\n+|$)`)), fencesBeginRegex: I((a3) => new RegExp(`^ {0,${a3}}(?:\`\`\`|~~~)`)), headingBeginRegex: I((a3) => new RegExp(`^ {0,${a3}}#{1,6}(?:\\s|$)`)), pedanticHeadingBeginRegex: I((a3) => new RegExp(`^ {0,${a3}}#`)), htmlBeginRegex: I((a3) => new RegExp(`^ {0,${a3}}(?:</?(?:${K})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, "i")), blockquoteBeginRegex: I((a3) => new RegExp(`^ {0,${a3}}>`)) };
var Ce = /^(?:[ \t]*(?:\n|$))+/;
var Ee = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
var Ie = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/;
var U = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
var Be = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
var ne = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
var me = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/;
var xe = c(me).replace(/bull/g, ne).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/).replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/\|table/g, "").getRegex();
var De = c(me).replace(/bull/g, ne).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/).replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex();
var re = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
var qe = /^[^\n]+/;
var se = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/;
var Ze = c(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label", se).replace("title", /(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex();
var ve = c(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, ne).getRegex();
var K = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
var ie = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
var He = c("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))", "i").replace("comment", ie).replace("tag", K).replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex();
var be = (a3) => c(re).replace("hr", U).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("|table", "").replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", a3).replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", K).getRegex();
var Ge = be(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
var Ne = be(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
var Qe = c(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace("paragraph", Ne).getRegex();
var oe = { blockquote: Qe, code: Ee, def: Ze, fences: Ie, heading: Be, hr: U, html: He, lheading: xe, list: ve, newline: Ce, paragraph: Ge, table: B, text: qe };
var ke = c("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr", U).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("blockquote", " {0,3}>").replace("code", "(?: {4}| {0,3}	)[^\\n]").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", K).getRegex();
var je = { ...oe, lheading: De, table: ke, paragraph: c(re).replace("hr", U).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("table", ke).replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]").replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", K).getRegex() };
var Fe = { ...oe, html: c(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment", ie).replace(/tag/g, "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(), def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/, heading: /^(#{1,6})(.*)(?:\n+|$)/, fences: B, lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/, paragraph: c(re).replace("hr", U).replace("heading", ` *#{1,6} *[^
]`).replace("lheading", xe).replace("|table", "").replace("blockquote", " {0,3}>").replace("|fences", "").replace("|list", "").replace("|html", "").replace("|tag", "").getRegex() };
var Ue = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
var Ke = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
var Re = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
var We = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
var $ = /[\p{P}\p{S}]/u;
var H = /[\s\p{P}\p{S}]/u;
var W = /[^\s\p{P}\p{S}]/u;
var Xe = c(/^((?![*_])punctSpace)/, "u").replace(/punctSpace/g, H).getRegex();
var Ve = /[\p{Pi}\p{Ps}"']/u;
var Te = /(?!~)[\p{P}\p{S}]/u;
var Je = /(?!~)[\s\p{P}\p{S}]/u;
var Ye = /(?:[^\s\p{P}\p{S}]|~)/u;
var et = c(/link|precode-code|html/, "g").replace("link", /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-", Me ? "(?<!`)()" : "(^^|[^`])").replace("code", /(?<b>`+)[^`]+\k<b>(?!`)/).replace("html", /<(?! )[^<>]*?>/).getRegex();
var Oe = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
var tt = c(Oe, "u").replace(/punct/g, $).getRegex();
var nt = c(Oe, "u").replace(/punct/g, Te).getRegex();
var rt = /^(?:\*+(?:((?!\*)(?!openQuote)punct)|([^\s*]))?)|^_+(?:((?!_)(?!openQuote)punct)|([^\s_]))?/;
var st = c(rt, "u").replace(/openQuote/g, Ve).replace(/punct/g, $).getRegex();
var we = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
var it = c(we, "gu").replace(/notPunctSpace/g, W).replace(/punctSpace/g, H).replace(/punct/g, $).getRegex();
var ot = c(we, "gu").replace(/notPunctSpace/g, Ye).replace(/punctSpace/g, Je).replace(/punct/g, Te).getRegex();
var at = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)[\\s](\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|(?:(?!\\*)punct|notPunctSpace)(\\*+)(?!\\*)(?=notPunctSpace)";
var lt = c(at, "gu").replace(/notPunctSpace/g, W).replace(/punctSpace/g, H).replace(/punct/g, $).getRegex();
var ut = c("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)", "gu").replace(/notPunctSpace/g, W).replace(/punctSpace/g, H).replace(/punct/g, $).getRegex();
var pt = "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)[\\s](_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)|(?:(?!_)punct|notPunctSpace)(_+)(?!_)(?=notPunctSpace)";
var ct = c(pt, "gu").replace(/notPunctSpace/g, W).replace(/punctSpace/g, H).replace(/punct/g, $).getRegex();
var ht = c(/^~~?(?:((?!~)punct)|[^\s~])/, "u").replace(/punct/g, $).getRegex();
var dt = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
var kt = c(dt, "gu").replace(/notPunctSpace/g, W).replace(/punctSpace/g, H).replace(/punct/g, $).getRegex();
var gt = c(/\\(punct)/, "gu").replace(/punct/g, $).getRegex();
var ft = c(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, "gu").replace(/punct/g, $).getRegex();
var mt = c(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email", /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex();
var xt = c(ie).replace("(?:-->|$)", "-->").getRegex();
var bt = c("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment", xt).replace("attribute", /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex();
var Pe = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
var Y = c(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace("brackets", Pe).getRegex();
var Rt = c(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/).replace("label", Y).replace("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/).replace("title", /"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex();
var Tt = c(/^!?\[(label)\]\[(ref)\]/).replace("label", Y).replace("ref", se).getRegex();
var Ot = c(/^!?\[(ref)\](?:\[\])?/).replace("ref", se).getRegex();
var ge = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
var wt = c(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace("brackets", Pe).getRegex();
var Pt = c("reflink|nolink(?!\\()", "g").replace("reflink", c(/^!?\[(label)\]\[(ref)\]/).replace("label", wt).replace("ref", ge).getRegex()).replace("nolink", c(/^!?\[(ref)\](?:\[\])?/).replace("ref", ge).getRegex()).getRegex();
var fe = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
var yt = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
var St = c(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, yt).getRegex();
var ae = { _backpedal: B, anyPunctuation: gt, anyPunctuationOutsideCode: ft, autolink: mt, blockSkip: et, br: Re, code: Ke, del: B, delLDelim: B, delRDelim: B, emStrongLDelim: tt, emStrongRDelimAst: it, emStrongRDelimUnd: ut, escape: Ue, link: Rt, nolink: Ot, punctuation: Xe, reflink: Tt, reflinkSearch: Pt, tag: bt, text: We, url: B };
var _t = { ...ae, emStrongLDelim: st, emStrongRDelimAst: lt, emStrongRDelimUnd: ct, link: c(/^!?\[(label)\]\((.*?)\)/).replace("label", Y).getRegex(), reflink: c(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label", Y).getRegex() };
var te = { ...ae, emStrongRDelimAst: ot, emStrongLDelim: nt, delLDelim: ht, delRDelim: kt, url: c(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("emailProtocol", St).replace("protocol", fe).replace("email", /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).getRegex(), _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/, del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/, text: c(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/).replace("protocol", fe).replace(/emailProtocol/g, /(?:mailto|xmpp):/).getRegex() };
var $t = { ...te, br: c(Re).replace("{2,}", "*").getRegex(), text: c(te.text).replace("\\b_", "\\b_| {2,}\\n").replace(/\{2,\}/g, "*").getRegex() };
var X = { normal: oe, gfm: je, pedantic: Fe };
var G = { normal: ae, gfm: te, breaks: $t, pedantic: _t };
var Lt = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
var ye = (a3) => Lt[a3];
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
var _ = class {
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
var O = class a {
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
var L = class {
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
var M = class {
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
var w = class a2 {
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
var A = class {
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
function D(a3, e) {
  if (Array.isArray(e)) for (let t = 0; t < e.length; t++) a3.push(e[t]);
  else a3.push(e);
}
var J = class {
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
var q = new J();
function m(a3, e) {
  return q.parse(a3, e);
}
m.options = m.setOptions = function(a3) {
  return q.setOptions(a3), m.defaults = q.defaults, ee(m.defaults), m;
};
m.getDefaults = v;
m.defaults = y;
function zt(...a3) {
  return q.use(...a3), m.defaults = q.defaults, ee(m.defaults), m;
}
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
var Tn = m.options;
var On = m.setOptions;
var wn = m.walkTokens;
var Pn = m.parseInline;
var Sn = w.parse;
var _n = O.lex;

// src/shared/blocks.ts
var TOP_LEVEL_BLOCKS = /* @__PURE__ */ new Set(["paragraph", "code", "blockquote", "table", "heading"]);
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

// src/shared/tools.ts
var MAX_DETAIL_CHARS = 4e3;
var MAX_DETAIL_LINES = 40;
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
function activityLine(tool, summary) {
  if (tool === "TodoWrite") return "";
  const verb = ACTIVITY_VERBS.get(tool);
  const line = verb ? `${verb} ${summary}`.trim() : `Using ${tool}`;
  return line.slice(0, MAX_ACTIVITY_CHARS);
}
function toolDetail(tool, input, cwd) {
  let detail;
  if (tool === "Bash") {
    detail = str(input["command"]);
  } else if (tool === "Write") {
    detail = `${shortPath(str(input["file_path"]), cwd)}
${str(input["content"])}`;
  } else if (tool === "Edit") {
    const removed = prefixed(str(input["old_string"]), "- ");
    const added = prefixed(str(input["new_string"]), "+ ");
    detail = `${shortPath(str(input["file_path"]), cwd)}
${removed}
${added}`;
  } else {
    detail = JSON.stringify(input, null, 2);
  }
  return clip(detail);
}
function firstLine(text2) {
  const lines = text2.trim().split("\n");
  return lines.length > 1 ? `${lines[0]} \u2026` : lines[0] ?? "";
}
function prefixed(text2, prefix) {
  return text2.split("\n").map((line) => prefix + line).join("\n");
}
function clip(text2) {
  const lines = text2.split("\n");
  let clipped = lines.slice(0, MAX_DETAIL_LINES).join("\n");
  if (clipped.length > MAX_DETAIL_CHARS) clipped = clipped.slice(0, MAX_DETAIL_CHARS);
  return clipped.length < text2.length ? `${clipped}
\u2026` : clipped;
}

// src/shared/folders.ts
function folderName(cwd) {
  return cwd.split("/").filter(Boolean).pop() ?? "";
}

// src/server/persistence.ts
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync4, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join as join5 } from "node:path";
function emptyStore() {
  return { sessions: /* @__PURE__ */ new Map(), responses: [], comments: [], messages: [], nextId: 1 };
}
function writeAtomically(file, contents) {
  const temp = `${file}.tmp`;
  writeFileSync(temp, contents, { mode: 384 });
  renameSync(temp, file);
}
function parseSessionFile(contents) {
  try {
    const file = JSON.parse(contents);
    const complete = [file?.responses, file?.comments, file?.messages].every(Array.isArray);
    return complete ? file : null;
  } catch {
    return null;
  }
}
function sessionFiles(data) {
  const files = /* @__PURE__ */ new Map();
  const fileOf = (sessionId2) => {
    const existing = files.get(sessionId2);
    if (existing) return existing;
    const created = { session: null, responses: [], comments: [], messages: [] };
    files.set(sessionId2, created);
    return created;
  };
  for (const [id, meta] of data.sessions) fileOf(id).session = meta;
  const sessionOf = /* @__PURE__ */ new Map();
  for (const response of data.responses) {
    sessionOf.set(response.id, response.session_id);
    fileOf(response.session_id).responses.push(response);
  }
  for (const note of data.comments) {
    const sessionId2 = sessionOf.get(note.response_id);
    if (sessionId2 !== void 0) fileOf(sessionId2).comments.push(note);
  }
  for (const message of data.messages) fileOf(message.session_id).messages.push(message);
  return new Map([...files].map(([id, file]) => [id, JSON.stringify(file)]));
}
var StoreFiles = class {
  #sessionsDir;
  #idsFile;
  #legacyFile;
  /** What each session's file holds now, so saving writes only the ones that changed. */
  #written = /* @__PURE__ */ new Map();
  #writtenNextId = 0;
  constructor(dir) {
    this.#sessionsDir = join5(dir, "sessions");
    this.#idsFile = join5(dir, "ids.json");
    this.#legacyFile = join5(dir, "store.json");
  }
  load() {
    mkdirSync(this.#sessionsDir, { recursive: true, mode: 448 });
    if (existsSync2(this.#legacyFile)) {
      const data = migrate(JSON.parse(readFileSync4(this.#legacyFile, "utf8")));
      this.save(data);
      renameSync(this.#legacyFile, `${this.#legacyFile}.migrated`);
      return data;
    }
    const combined = {
      sessions: {},
      responses: [],
      comments: [],
      messages: [],
      next_id: this.#readNextId()
    };
    for (const entry of readdirSync(this.#sessionsDir)) {
      const id = entry.endsWith(".json") ? entry.slice(0, -".json".length) : "";
      if (!SESSION_ID_PATTERN.test(id)) continue;
      const contents = readFileSync4(join5(this.#sessionsDir, entry), "utf8");
      const file = parseSessionFile(contents);
      if (!file) {
        console.error(`skipping ${entry}: it isn't a session file`);
        continue;
      }
      this.#written.set(id, contents);
      if (file.session) combined.sessions[id] = file.session;
      combined.responses.push(...file.responses);
      combined.comments.push(...file.comments);
      combined.messages.push(...file.messages);
    }
    combined.responses.sort((a3, b) => a3.created_at - b.created_at);
    combined.comments.sort((a3, b) => a3.id - b.id);
    combined.messages.sort((a3, b) => a3.id - b.id);
    this.#writtenNextId = combined.next_id;
    return migrate(combined);
  }
  save(data) {
    if (data.nextId !== this.#writtenNextId) {
      writeAtomically(this.#idsFile, JSON.stringify({ next_id: data.nextId }));
      this.#writtenNextId = data.nextId;
    }
    const files = sessionFiles(data);
    for (const [id, contents] of files) {
      if (this.#written.get(id) === contents) continue;
      writeAtomically(join5(this.#sessionsDir, `${id}.json`), contents);
      this.#written.set(id, contents);
    }
    for (const id of this.#written.keys()) {
      if (files.has(id)) continue;
      rmSync(join5(this.#sessionsDir, `${id}.json`), { force: true });
      this.#written.delete(id);
    }
  }
  /** 1 when the file is missing or damaged: migrate then starts past the highest id it finds. */
  #readNextId() {
    try {
      return JSON.parse(readFileSync4(this.#idsFile, "utf8")).next_id ?? 1;
    } catch {
      return 1;
    }
  }
};
function migrate(file) {
  const responses = (file.responses ?? []).filter((r) => SESSION_ID_PATTERN.test(r.session_id));
  for (const response of responses) response.note_answers ??= {};
  const responseIds = new Set(responses.map((r) => r.id));
  const comments = (file.comments ?? []).filter((c2) => responseIds.has(c2.response_id));
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
  const messages = (file.messages ?? []).filter((m2) => SESSION_ID_PATTERN.test(m2.session_id));
  const highestId = Math.max(
    0,
    ...responses.map((r) => r.id),
    ...comments.map((c2) => c2.id),
    ...messages.map((m2) => m2.id)
  );
  return { sessions, responses, comments, messages, nextId: Math.max(file.next_id ?? 1, highestId + 1) };
}

// src/server/store.ts
var MAX_RESPONSES_PER_SESSION = 100;
var SESSION_RETENTION_SECONDS = 7 * 24 * 60 * 60;
var FIRST_MESSAGE_CHARS = 80;
var Revision = class {
  #value = 0;
  #waiting = /* @__PURE__ */ new Set();
  get value() {
    return this.#value;
  }
  bump() {
    this.#value += 1;
    for (const wake of [...this.#waiting]) wake();
  }
  /** Resolves when the value moves past `known`, or after timeoutMs: a long poll's wait. */
  async waitPast(known, timeoutMs) {
    if (this.#value !== known) return;
    await new Promise((resolve3) => {
      const wake = () => {
        clearTimeout(timer);
        this.#waiting.delete(wake);
        resolve3();
      };
      const timer = setTimeout(wake, timeoutMs);
      this.#waiting.add(wake);
    });
  }
};
var Store = class {
  revision = new Revision();
  #data;
  #files;
  #clock;
  /** Without a directory, the store lives in memory only (tests). */
  #awaitingFirstReply = /* @__PURE__ */ new Set();
  constructor(options = {}) {
    this.#files = options.dir === void 0 ? void 0 : new StoreFiles(options.dir);
    this.#clock = options.clock ?? systemClock;
    this.#data = this.#files?.load() ?? emptyStore();
    if (this.#prune()) this.#persist();
  }
  // ---- Reading ---------------------------------------------------------------------------
  session(sessionId2) {
    const meta = this.#data.sessions.get(sessionId2);
    return meta && { id: sessionId2, ...meta };
  }
  /** Known sessions, most recently active first. */
  listSessions() {
    return [...this.#data.sessions].map(([id, meta]) => ({ id, ...meta })).sort((a3, b) => b.last_active - a3.last_active);
  }
  /** The sessions that ran in a folder, most recently active first, with what their rows show. */
  folderSessions(folder) {
    const pending = this.#pendingNotesPerSession();
    return this.listSessions().filter((session) => folderName(session.cwd) === folder).map((session) => ({
      ...session,
      first_message: this.#firstMessage(session.id).replace(/\s+/g, " ").trim().slice(0, FIRST_MESSAGE_CHARS),
      pending_notes: pending.get(session.id) ?? 0
    }));
  }
  /** One session's replies and messages, oldest first, and the notes on the replies. */
  sessionContent(sessionId2) {
    const responses = this.#data.responses.filter((r) => r.session_id === sessionId2);
    const ids = new Set(responses.map((r) => r.id));
    return {
      responses,
      comments: this.#data.comments.filter((c2) => ids.has(c2.response_id)),
      messages: this.#data.messages.filter((m2) => m2.session_id === sessionId2)
    };
  }
  /** Messages from the page that haven't reached Claude yet, joined as Claude will get them, or "". */
  waitingMessageText(sessionId2) {
    return this.#waitingMessages(sessionId2).map((m2) => m2.text).join("\n\n");
  }
  /** Whether the session holds notes or messages that never reached Claude. */
  hasUnsent(sessionId2) {
    return this.#pendingNotesPerSession().has(sessionId2) || this.#waitingMessages(sessionId2).length > 0;
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
  /**
   * Learns a new session's folder from its first prompt, so its row shows before the first reply.
   * That reply still counts as the session's first. Kept in memory only: a server that restarts in
   * between opens the window anyway.
   */
  promptSession(sessionId2, cwd) {
    const meta = this.#data.sessions.get(sessionId2);
    if (meta?.cwd) return;
    if (!meta) this.#awaitingFirstReply.add(sessionId2);
    this.#upsertSession(sessionId2, { name: "", cwd, activeAt: this.#clock.now() });
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
    const data = this.#data;
    this.#awaitingFirstReply.delete(sessionId2);
    const known = data.sessions.delete(sessionId2) || data.messages.some((m2) => m2.session_id === sessionId2);
    if (!known) return false;
    const dropped = new Set(data.responses.filter((r) => r.session_id === sessionId2).map((r) => r.id));
    data.responses = data.responses.filter((r) => !dropped.has(r.id));
    data.comments = data.comments.filter((c2) => !dropped.has(c2.response_id));
    data.messages = data.messages.filter((m2) => m2.session_id !== sessionId2);
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
    if (reply.turn) {
      response.prompt = reply.turn.prompt;
      response.notes_sent = reply.turn.notesSent;
      response.steps = reply.turn.steps;
      if (reply.turn.ended) response.ended = reply.turn.ended;
      if (reply.turn.error) response.error = reply.turn.error;
    }
    const newSession = this.#awaitingFirstReply.delete(reply.sessionId) || !this.#data.sessions.has(reply.sessionId);
    this.#upsertSession(reply.sessionId, { name: reply.sessionName, cwd: reply.cwd, activeAt: response.created_at });
    if (reply.createdAt === void 0 && !reply.turn?.ended) this.#takeAnswers(response);
    this.#data.responses.push(response);
    this.#data.responses.sort((a3, b) => a3.created_at - b.created_at);
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
    const doomed = this.#data.comments.filter((c2) => c2.id === noteId || c2.parent_id === noteId);
    if (!doomed.some((c2) => c2.id === noteId) || doomed.some((c2) => c2.delivered_at !== null)) return false;
    const doomedIds = new Set(doomed.map((c2) => c2.id));
    this.#data.comments = this.#data.comments.filter((c2) => !doomedIds.has(c2.id));
    this.#changed();
    return true;
  }
  /** Rewrites an unsent note in place, keeping its anchor, id and follow-ups. */
  editPendingNote(noteId, body) {
    const note = this.#data.comments.find((c2) => c2.id === noteId);
    if (!note || note.delivered_at !== null) return false;
    note.body = body;
    this.#changed();
    return true;
  }
  /** The session a note belongs to, or null if there is no such note. */
  noteSession(noteId) {
    const note = this.#data.comments.find((c2) => c2.id === noteId);
    return (note && this.#sessionOfResponse().get(note.response_id)) ?? null;
  }
  /**
   * Records a message the user sent. A message from the page waits until claimMessages hands it
   * to Claude; one typed in the terminal has already reached Claude.
   */
  addMessage(sessionId2, text2, source) {
    const now = this.#clock.now();
    const message = {
      id: this.#newId(),
      session_id: sessionId2,
      text: text2,
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
    return waiting.map((m2) => m2.text).join("\n\n");
  }
  /** Marks this session's unsent notes delivered and returns them, described for Claude. */
  claimPending(sessionId2) {
    const responses = new Map(
      this.#data.responses.filter((r) => r.session_id === sessionId2).map((r) => [r.id, r])
    );
    const notes = new Map(this.#data.comments.map((c2) => [c2.id, c2]));
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
  /** Makes claimed notes pending again, when the turn they went with ended before reading them. */
  returnNotes(noteIds) {
    const ids = new Set(noteIds);
    const notes = this.#data.comments.filter((note) => ids.has(note.id));
    for (const note of notes) note.delivered_at = null;
    if (notes.length) this.#changed();
  }
  // ---- Internals -------------------------------------------------------------------------
  #waitingMessages(sessionId2) {
    return this.#data.messages.filter((m2) => m2.session_id === sessionId2 && m2.delivered_at === null);
  }
  #anchorFor(note) {
    if (note.kind === "follow-up") {
      const parent = this.#data.comments.find((c2) => c2.id === note.parentId);
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
      (c2) => sessionOf.get(c2.response_id) === response.session_id && c2.delivered_at !== null && c2.answered_by === null
    );
    if (!awaiting.length) return;
    for (const note of awaiting) note.answered_by = response.id;
    const { mainText, answers } = splitNoteAnswers(response.text, new Set(awaiting.map((c2) => c2.id)));
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
      const count2 = (perSession.get(response.session_id) ?? 0) + 1;
      perSession.set(response.session_id, count2);
      if (count2 <= MAX_RESPONSES_PER_SESSION) kept.push(response);
    }
    data.responses = kept.reverse();
    const keptIds = new Set(data.responses.map((r) => r.id));
    data.comments = data.comments.filter((c2) => keptIds.has(c2.response_id));
    const keptMessages = [];
    const messagesPerSession = /* @__PURE__ */ new Map();
    for (const message of [...data.messages].reverse()) {
      if (!data.sessions.has(message.session_id) && message.created_at < cutoff) continue;
      const count2 = (messagesPerSession.get(message.session_id) ?? 0) + 1;
      messagesPerSession.set(message.session_id, count2);
      if (count2 <= MAX_RESPONSES_PER_SESSION) keptMessages.push(message);
    }
    data.messages = keptMessages.reverse();
    return data.responses.length + data.sessions.size + data.messages.length !== before;
  }
  /** A session sidenote runs keeps what the user typed on each reply, not as a message of its own. */
  #firstMessage(sessionId2) {
    const message = this.#data.messages.find((m2) => m2.session_id === sessionId2);
    if (message) return message.text;
    return this.#data.responses.find((r) => r.session_id === sessionId2 && r.prompt?.trim())?.prompt ?? "";
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
    this.#files?.save(this.#data);
  }
};

// src/server/host.ts
var MAX_QUEUED = 20;
var HostError = class extends Error {
};
function untrustedFolderMessage(folder) {
  return `Claude Code doesn't trust ${folder} yet. Run claude there once and accept its trust prompt, then try again. sidenote chat can't show that prompt, and without it the folder's hooks and MCP servers would run unasked.`;
}
var UnknownSession = class extends HostError {
};
var SessionHost = class {
  revision = new Revision();
  #store;
  #agent;
  #clock;
  #isTrusted;
  #sessions = /* @__PURE__ */ new Map();
  constructor(options) {
    this.#store = options.store;
    this.#agent = options.agent;
    this.#isTrusted = options.isTrusted;
    this.#clock = options.clock ?? systemClock;
  }
  /**
   * Starts hosting a session: a new one in cwd, or an earlier one to continue. Nothing runs until
   * the first message. Returns the session's id.
   */
  open(cwd, sessionId2, resume = sessionId2 !== void 0) {
    const existing = sessionId2 === void 0 ? void 0 : this.#sessions.get(sessionId2);
    if (existing) return existing.id;
    const id = sessionId2 ?? randomUUID();
    const folder = sessionId2 && this.#store.session(sessionId2)?.cwd || cwd;
    this.#sessions.set(id, {
      id,
      cwd: folder,
      driver: null,
      known: resume,
      state: "idle",
      model: "",
      live: null,
      streaming: false,
      queued: [],
      permissions: [],
      claimed: [],
      context: { used: null, limit: null },
      error: ""
    });
    this.#store.touchSession(id, "", folder);
    this.#changed();
    return id;
  }
  owns(sessionId2) {
    return this.#sessions.has(sessionId2);
  }
  view(sessionId2) {
    const session = this.#sessions.get(sessionId2);
    if (!session) return null;
    const { used, limit } = session.context;
    const permission = session.permissions[0];
    return {
      version: this.revision.value,
      session_id: session.id,
      agent: this.#agent.name,
      model: session.model,
      state: session.state,
      live: session.live && { ...session.live, parts: session.live.parts.map((part) => ({ ...part })) },
      queued: [...session.queued],
      permission: permission ? {
        request_id: permission.request_id,
        tool: permission.tool_name,
        summary: toolSummary(permission.tool_name, permission.input, session.cwd),
        detail: toolDetail(permission.tool_name, permission.input, session.cwd)
      } : null,
      context: used !== null && limit ? { used, limit } : null,
      error: session.error
    };
  }
  /** Send now's status for a hosted session: it can always take notes, at once or after the turn. */
  sendStatus(sessionId2) {
    const session = this.#sessions.get(sessionId2);
    if (!session) return null;
    const busy = session.state === "working" || session.state === "waiting";
    const status = {
      status: busy ? "busy" : "listening",
      send_requested: session.queued.includes(""),
      hosted: true
    };
    const messages = session.queued.filter((text2) => text2.trim());
    if (messages.length) status.queued_prompt = messages.join("\n\n");
    const parts = busy ? session.live?.parts ?? [] : [];
    const progress = liveProgress(parts.flatMap((part) => part.kind === "text" ? [part.text] : []));
    if (progress.length) status.progress = progress;
    const tool = parts.findLast((part) => part.kind === "tool");
    const activity = tool?.kind === "tool" ? activityLine(tool.tool, tool.summary) : "";
    if (activity) status.activity = activity;
    return status;
  }
  /** Sends a message, with the session's pending notes; while the agent works, it waits its turn. */
  message(sessionId2, text2) {
    const session = this.#get(sessionId2);
    if (!text2.trim() && !this.#store.sessionsWithPendingNotes().has(sessionId2)) {
      throw new HostError("nothing to send: write a message or a note first");
    }
    if (session.state === "working" || session.state === "waiting") {
      if (session.queued.length >= MAX_QUEUED) throw new HostError("too many messages are waiting already");
      session.queued.push(text2);
      this.#changed();
      return;
    }
    this.#startTurn(session, text2);
  }
  /** Send now: the pending notes go as a message of their own. */
  sendNotes(sessionId2) {
    if (!this.#store.sessionsWithPendingNotes().has(sessionId2)) return false;
    const session = this.#get(sessionId2);
    if (session.queued.includes("")) return true;
    this.message(sessionId2, "");
    return true;
  }
  /** Stops the turn in progress. Queued messages are dropped and returned, to be edited again. */
  interrupt(sessionId2) {
    const session = this.#get(sessionId2);
    const dropped = session.queued.filter((text2) => text2 !== "");
    session.queued = [];
    if (session.driver && (session.state === "working" || session.state === "waiting")) {
      session.driver.interrupt();
      session.permissions = [];
    }
    this.#changed();
    return dropped;
  }
  /** Answers the permission prompt the session is waiting on. False if it no longer waits on it. */
  answer(sessionId2, requestId, decision) {
    const session = this.#get(sessionId2);
    const request = session.permissions[0];
    if (!request || request.request_id !== requestId || !session.driver) return false;
    session.driver.answer(request, decision);
    session.permissions.shift();
    if (!session.permissions.length) session.state = "working";
    this.#changed();
    return true;
  }
  /** Ends the session's agent process and lets go of it. False if this server doesn't run it. */
  end(sessionId2) {
    const session = this.#sessions.get(sessionId2);
    if (!session) return false;
    this.#sessions.delete(sessionId2);
    session.driver?.close();
    this.#changed();
    return true;
  }
  /** Whether an agent is in a turn: it needs this server, even with no client watching. */
  working() {
    return [...this.#sessions.values()].some((session) => session.state === "working");
  }
  /** Ends every agent process, when the server shuts down. */
  closeAll() {
    for (const session of this.#sessions.values()) session.driver?.close();
  }
  #get(sessionId2) {
    const session = this.#sessions.get(sessionId2);
    if (!session) throw new UnknownSession("sidenote isn't running this session");
    return session;
  }
  #startTurn(session, text2) {
    if (!session.driver && !this.#isTrusted(session.cwd)) throw new HostError(untrustedFolderMessage(session.cwd));
    const notes = this.#store.claimPending(session.id);
    if (!text2.trim() && !notes.length) return;
    const message = !notes.length ? text2 : text2.trim() ? `${text2}

---

${formatNotesForClaude(notes)}` : formatNotesForClaude(notes, { sendNow: true });
    if (!session.driver) {
      session.driver = this.#agent.start(
        { sessionId: session.id, cwd: session.cwd, resume: session.known },
        (event) => this.#event(session, event)
      );
      session.known = true;
    }
    session.live = { prompt: text2, notes_sent: notes.length, started_at: this.#clock.now(), parts: [] };
    session.claimed = notes.map((note) => note.id);
    this.#store.revision.bump();
    session.streaming = false;
    session.state = "working";
    session.error = "";
    session.driver.send(message);
    this.#changed();
  }
  #event(session, event) {
    if (this.#sessions.get(session.id) !== session) return;
    const parts = session.live?.parts;
    const last = parts?.at(-1);
    switch (event.type) {
      case "ready":
        session.model = event.model;
        break;
      case "text_delta":
        if (!parts) return;
        if (session.streaming && last?.kind === "text") last.text += event.text;
        else parts.push({ kind: "text", text: event.text });
        session.streaming = true;
        break;
      case "text":
        if (!parts) return;
        if (session.streaming && last?.kind === "text") last.text = event.text;
        else parts.push({ kind: "text", text: event.text });
        session.streaming = false;
        break;
      case "tool_use":
        if (!parts) return;
        session.streaming = false;
        parts.push({
          kind: "tool",
          id: event.id,
          tool: event.name,
          summary: toolSummary(event.name, event.input, session.cwd),
          failed: null
        });
        break;
      case "tool_result": {
        const call = parts?.find((part) => part.kind === "tool" && part.id === event.id);
        if (call?.kind === "tool") call.failed = event.failed;
        break;
      }
      case "permission":
        session.permissions.push(event.request);
        session.state = "waiting";
        break;
      case "permission_cancelled":
        session.permissions = session.permissions.filter((request) => request.request_id !== event.request_id);
        if (!session.permissions.length && session.state === "waiting") session.state = "working";
        break;
      case "usage":
        if (event.context_tokens !== null) session.context.used = event.context_tokens;
        if (event.context_window !== null) session.context.limit = event.context_window;
        break;
      case "turn_end":
        this.#finishTurn(session, event.end);
        break;
      case "exit":
        session.driver = null;
        session.queued = [];
        this.#finishTurn(session, { outcome: "error", error: event.message, cost_usd: null });
        session.state = "stopped";
        session.error = event.message;
        break;
    }
    this.#changed();
  }
  /** Stores the turn as a reply, then sends the next queued message. */
  #finishTurn(session, end) {
    const turn = session.live;
    session.live = null;
    session.streaming = false;
    session.permissions = [];
    session.state = "idle";
    if (end.outcome === "error") session.error = end.error;
    const claimed = session.claimed;
    session.claimed = [];
    if (turn) {
      const { text: text2, steps } = replyOf(turn.parts);
      const unread = end.outcome !== "done" && !turn.parts.length;
      if (unread) this.#store.returnNotes(claimed);
      this.#store.addResponse({
        sessionId: session.id,
        cwd: session.cwd,
        text: text2,
        sessionName: "",
        createdAt: void 0,
        turn: {
          prompt: turn.prompt,
          notesSent: unread ? 0 : turn.notes_sent,
          steps,
          ...end.outcome === "done" ? {} : { ended: end.outcome },
          ...end.outcome === "error" ? { error: end.error } : {}
        }
      });
    }
    const next = session.queued.shift();
    if (next !== void 0 && session.driver) this.#startTurn(session, next);
  }
  #changed() {
    this.revision.bump();
  }
};
function replyOf(parts) {
  const texts = [];
  const steps = [];
  for (const part of parts) {
    if (part.kind === "text") {
      if (part.text.trim()) texts.push(part.text.trim());
      continue;
    }
    const blocks = texts.length ? replyBlocks(lexReply(texts.join("\n\n"))).length : 0;
    steps.push({ tool: part.tool, summary: part.summary, after_block: blocks - 1, failed: part.failed === true });
  }
  return { text: texts.join("\n\n"), steps };
}

// src/server/http.ts
import { randomUUID as randomUUID2, timingSafeEqual } from "node:crypto";
import { statSync as statSync2 } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join as join6, resolve as resolve2, sep } from "node:path";

// src/server/windows.ts
var WINDOW_SEEN_MS = 2 * 60 * 1e3;
var OpenWindows = class {
  #lastSeen = /* @__PURE__ */ new Map();
  #clock;
  constructor(clock = systemClock) {
    this.#clock = clock;
  }
  seen(folder) {
    const now = this.#clock.monotonicMs();
    for (const [known, at2] of this.#lastSeen) {
      if (now - at2 >= WINDOW_SEEN_MS) this.#lastSeen.delete(known);
    }
    this.#lastSeen.set(folder, now);
  }
  isOpen(folder) {
    const at2 = this.#lastSeen.get(folder);
    return at2 !== void 0 && this.#clock.monotonicMs() - at2 < WINDOW_SEEN_MS;
  }
};

// src/server/requests.ts
import { isAbsolute } from "node:path";
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
var REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
var DECISIONS = /* @__PURE__ */ new Set(["allow", "deny", "always"]);
var WAITER_ID_PATTERN = /^[a-f0-9]{16,64}$/;
var LAUNCH_CODE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
var CONTROL_CHARS = /[\x00-\x09\x0b-\x1f\x7f]/;
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
function folderPath(value, key) {
  if (!isAbsolute(value) || CONTROL_CHARS.test(value)) throw new BadRequest(`${key} must be an absolute path`);
  return value;
}
function optionalFolder(body, key) {
  const value = optionalString(body, key, LIMITS.cwd) ?? "";
  return value && folderPath(value, key);
}
function terminalText(value, key) {
  const text2 = value.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  if (CONTROL_CHARS.test(text2)) throw new BadRequest(`${key} has control characters`);
  return text2;
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
    cwd: optionalFolder(body, "cwd"),
    text: string(body, "text", LIMITS.replyText),
    created_at: createdAt,
    claude_process: optionalProcess(body)
  };
}
function parseNewNote(input) {
  const body = asObject(input);
  const text2 = nonEmpty(string(body, "body", LIMITS.noteBody), "body").trim();
  if (body["parent_id"] !== void 0 && body["parent_id"] !== null) {
    return { kind: "follow-up", parentId: integer(body, "parent_id", 1), body: text2 };
  }
  return {
    kind: "root",
    responseId: integer(body, "response_id", 1),
    blockIndex: integer(body, "block_index", -1),
    quote: string(body, "quote", LIMITS.quote),
    body: text2
  };
}
function parseEditNote(input) {
  return { body: nonEmpty(string(asObject(input), "body", LIMITS.noteBody), "body").trim() };
}
function parseTouchSession(input) {
  const body = asObject(input);
  return {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    session_name: (optionalString(body, "session_name", LIMITS.sessionName) ?? "").trim(),
    cwd: optionalFolder(body, "cwd")
  };
}
function parseClaim(input) {
  const body = asObject(input);
  const prompt = optionalString(body, "prompt", LIMITS.message);
  const session_id = matching(body, "session_id", SESSION_ID_PATTERN);
  const claim = prompt === void 0 ? { session_id } : { session_id, prompt };
  const cwd = optionalFolder(body, "cwd");
  if (cwd) claim.cwd = cwd;
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
    message_id: matching(body, "message_id", REQUEST_ID_PATTERN),
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
function parseRegisterSession(input) {
  const body = asObject(input);
  const cwd = folderPath(string(body, "cwd", LIMITS.cwd), "cwd");
  const id = optionalString(body, "session_id", 256);
  return id === void 0 ? { cwd } : { cwd, session_id: sessionId(id) };
}
function parseStartConversation(input) {
  const body = asObject(input);
  const resume = body["resume"] ?? false;
  if (typeof resume !== "boolean") throw new BadRequest("resume must be true or false");
  return { session_id: matching(body, "session_id", SESSION_ID_PATTERN), resume };
}
function parseConversationMessage(input) {
  const body = asObject(input);
  return {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    text: string(body, "text", LIMITS.message)
  };
}
function parsePrompt(input) {
  const body = asObject(input);
  return {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    text: nonEmpty(string(body, "text", LIMITS.message), "text").trim()
  };
}
function parsePermissionAnswer(input) {
  const body = asObject(input);
  const decision = string(body, "decision", 16);
  if (!DECISIONS.has(decision)) throw new BadRequest("decision must be allow, deny or always");
  return {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    request_id: matching(body, "request_id", REQUEST_ID_PATTERN),
    decision
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
    prompt: terminalText(optionalString(body, "prompt", MAX_PROMPT_CHARS) ?? "", "prompt").trim(),
    name: terminalText((optionalString(body, "name", LIMITS.sessionName) ?? "").replace(/\s+/g, " "), "name").trim()
  };
}

// src/server/http.ts
var MAX_BODY_BYTES = 2 * 1024 * 1024;
var LONG_POLL_MS = 25e3;
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
function routes({
  store,
  delivery,
  host,
  launchCodes,
  token,
  openFolder,
  startSession,
  processes,
  isTrusted
}) {
  const windows = new OpenWindows();
  const statusOf = (sessionId2) => host.sendStatus(sessionId2) ?? delivery.status(sessionId2);
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
      session: { ...session, ...statusOf(session.id) },
      folder: windowFolder,
      sessions: store.folderSessions(windowFolder).map((row) => ({
        ...row,
        status: statusOf(row.id).status,
        // A session sidenote runs has no hooks to report its process, and sidenote can end it itself.
        process: host.owns(row.id) ? "running" : processes.state(row.id)
      })),
      can_start_sessions,
      ...store.sessionContent(session.id)
    };
  };
  const recordedFolder = (sessionId2) => {
    const cwd = store.session(sessionId2)?.cwd;
    if (!cwd) throw new HttpError(404, "sidenote doesn't know this session's folder");
    if (!statSync2(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new HttpError(404, `${cwd} no longer exists`);
    return cwd;
  };
  const requireTrust = (folder) => {
    if (!isTrusted(folder)) throw new HttpError(409, untrustedFolderMessage(folder));
  };
  return [
    {
      method: "GET",
      path: "/api/state",
      needsToken: true,
      handle: async ({ query }) => {
        delivery.refresh(statusOf);
        processes.refresh();
        const folder = query.get("f");
        if (folder) windows.seen(folder);
        const known = query.get("v");
        if (known === String(store.revision.value) && query.get("wait") === "1") {
          await store.revision.waitPast(Number(known), LONG_POLL_MS);
        }
        if (known === String(store.revision.value)) return empty(204);
        return ok(snapshot(query.get("s"), query.get("f")));
      }
    },
    {
      method: "GET",
      path: "/api/conversation",
      needsToken: true,
      handle: async ({ query }) => {
        const sessionId2 = query.get("s") ?? "";
        if (!host.owns(sessionId2)) throw new HttpError(404, "sidenote isn't running this session");
        const known = query.get("v");
        if (known === String(host.revision.value) && query.get("wait") === "1") {
          await host.revision.waitPast(Number(known), LONG_POLL_MS);
        }
        if (known === String(host.revision.value)) return empty(204);
        const view = host.view(sessionId2);
        if (!view) throw new HttpError(404, "sidenote isn't running this session");
        return ok(view);
      }
    },
    {
      method: "POST",
      path: "/api/sessions/register",
      needsToken: true,
      handle: ({ body }) => {
        const input = parseRegisterSession(body);
        if (!statSync2(input.cwd, { throwIfNoEntry: false })?.isDirectory()) {
          throw new HttpError(400, "cwd is not a folder");
        }
        requireTrust(input.cwd);
        const id = input.session_id ?? randomUUID2();
        if (!store.session(id)?.cwd) store.touchSession(id, "", input.cwd);
        return ok({ session_id: id }, 201);
      }
    },
    {
      method: "POST",
      path: "/api/conversations",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id, resume } = parseStartConversation(body);
        const folder = recordedFolder(session_id);
        requireTrust(folder);
        const id = host.open(folder, session_id, resume);
        return ok({ session_id: id }, 201);
      }
    },
    {
      method: "POST",
      path: "/api/conversation/messages",
      needsToken: true,
      handle: ({ body }) => {
        const input = parseConversationMessage(body);
        host.message(input.session_id, input.text);
        return ok({ ok: true }, 202);
      }
    },
    {
      method: "POST",
      path: "/api/conversation/interrupt",
      needsToken: true,
      handle: ({ body }) => ok({ queued: host.interrupt(parseSessionRequest(body).session_id) })
    },
    {
      method: "POST",
      path: "/api/conversation/permission",
      needsToken: true,
      handle: ({ body }) => {
        const input = parsePermissionAnswer(body);
        if (!host.answer(input.session_id, input.request_id, input.decision)) {
          throw new HttpError(409, "that permission prompt was already answered or has gone");
        }
        return ok({ ok: true });
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
        const window_open = windows.isOpen(folderName(input.cwd));
        return ok({ response, new_session: newSession, window_open }, 201);
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
      method: "PATCH",
      path: /^\/api\/comments\/(\d{1,15})$/,
      needsToken: true,
      handle: ({ body, param }) => {
        const { body: text2 } = parseEditNote(body);
        const noteId = Number(param);
        const sessionId2 = store.noteSession(noteId);
        if (sessionId2 === null) throw new HttpError(404, "unknown note");
        if (statusOf(sessionId2).send_requested) throw new HttpError(409, "this note is already being sent");
        if (!store.editPendingNote(noteId, text2)) throw new HttpError(409, "this note was already sent");
        return empty(204);
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
        const { session_id, prompt: typed, cwd, claude_process } = parseClaim(body);
        processes.record(session_id, claude_process);
        if (cwd) store.promptSession(session_id, cwd);
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
        const { session_id, text: text2 } = parseActivity(body);
        delivery.setActivity(session_id, text2);
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
      handle: ({ body }) => {
        const ids = parseSend(body).session_ids;
        const hosted = ids.filter((id) => host.owns(id) && host.sendNotes(id));
        const waiting = delivery.requestSend(ids.filter((id) => !host.owns(id)));
        return ok({ sessions: [...hosted, ...waiting].sort() });
      }
    },
    {
      method: "POST",
      path: "/api/prompt",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id, text: text2 } = parsePrompt(body);
        if (!store.session(session_id)) throw new HttpError(404, "sidenote doesn't know this session");
        if (host.owns(session_id)) {
          const busy = host.sendStatus(session_id)?.status === "busy";
          host.message(session_id, text2);
          return ok({ delivery: busy ? "queued" : "sent" }, 202);
        }
        const outcome = delivery.requestPrompt(session_id, text2);
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
        const folder = recordedFolder(parseSessionRequest(body).session_id);
        if (statSync2(join6(folder, "Contents", "Info.plist"), { throwIfNoEntry: false })) {
          throw new HttpError(409, `${folder} is an app, not a folder`);
        }
        openFolder(folder);
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
        if (!host.end(session_id)) {
          if (processes.state(session_id) === "unknown") {
            throw new HttpError(409, "sidenote learns this session's process with its next prompt or reply");
          }
          const running = processes.running(session_id);
          if (running) process.kill(running.pid, "SIGTERM");
        }
        processes.markEnded(session_id);
        delivery.forgetSession(session_id);
        return empty(204);
      }
    },
    {
      method: "POST",
      path: "/api/sessions/resume",
      needsToken: true,
      handle: async ({ body }) => {
        const { session_id } = parseSessionRequest(body);
        if (!startSession) throw new HttpError(501, "resuming sessions needs GNOME Terminal on Linux, or macOS");
        if (host.owns(session_id) || processes.running(session_id) || statusOf(session_id).status !== "offline") {
          throw new HttpError(409, "this session is still running");
        }
        const cwd = recordedFolder(session_id);
        try {
          await startSession({ cwd, sessionId: session_id, prompt: "", name: "", resume: true });
        } catch (error) {
          throw new HttpError(502, `couldn't open a terminal: ${error instanceof Error ? error.message : error}`);
        }
        processes.forget(session_id);
        delivery.markBusy(session_id);
        return empty(204);
      }
    },
    {
      method: "POST",
      path: "/api/sessions/forget",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id } = parseSessionRequest(body);
        if (host.owns(session_id) || processes.running(session_id)) {
          throw new HttpError(409, "this session is still running: end it instead");
        }
        processes.forget(session_id);
        if (!store.forgetSession(session_id)) throw new HttpError(404, "sidenote doesn't know this session");
        return empty(204);
      }
    },
    {
      method: "POST",
      path: "/api/sessions/cleared",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id } = parseSessionRequest(body);
        delivery.forgetSession(session_id);
        processes.forget(session_id);
        const forgotten = !store.hasUnsent(session_id) && store.forgetSession(session_id);
        return ok({ forgotten });
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
        const id = randomUUID2();
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
  const webDir = resolve2(options.webDir);
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
    if (route.needsToken) options.onActivity?.();
    const body = request.method === "POST" || request.method === "PATCH" ? await readJson(request) : void 0;
    return route.handle({ body, query: url.searchParams, param });
  };
  const handle = async (request, response) => {
    if (!options.allowedHosts.has(request.headers.host ?? "")) throw new HttpError(403);
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) return send(response, await serveApi(request, url));
    if (request.method !== "GET") throw new HttpError(405);
    if (url.pathname === "/" || FOLDER_PATH.test((request.url ?? "").split("?")[0])) {
      return sendFile(response, resolve2(webDir, "index.html"));
    }
    if (url.pathname.startsWith("/static/")) return sendFile(response, staticPath(webDir, url.pathname));
    throw new HttpError(404);
  };
  return (request, response) => {
    handle(request, response).catch((error) => {
      if (response.headersSent) return response.destroy();
      if (error instanceof HttpError) return send(response, errorReply(error.status, error.message));
      if (error instanceof BadRequest) return send(response, errorReply(400, error.message));
      if (error instanceof UnknownSession) return send(response, errorReply(404, error.message));
      if (error instanceof HostError) return send(response, errorReply(409, error.message));
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
  const file = resolve2(webDir, relative);
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
  const text2 = Buffer.concat(chunks).toString("utf8");
  try {
    return text2 ? JSON.parse(text2) : {};
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
  /** Ended from the window. A reused pid, or a process still shutting down, must not read as running. */
  #ended = /* @__PURE__ */ new Set();
  #probe;
  #revision;
  #signature = "";
  constructor(probe, revision) {
    this.#probe = probe;
    this.#revision = revision;
  }
  record(sessionId2, claudeProcess) {
    if (!claudeProcess) return;
    this.#processes.set(sessionId2, claudeProcess);
    this.#ended.delete(sessionId2);
  }
  markEnded(sessionId2) {
    this.#ended.add(sessionId2);
  }
  forget(sessionId2) {
    this.#processes.delete(sessionId2);
    this.#ended.delete(sessionId2);
  }
  state(sessionId2) {
    if (this.#ended.has(sessionId2)) return "ended";
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
import { closeSync, openSync, readFileSync as readFileSync5, rmSync as rmSync2, statSync as statSync3, writeSync } from "node:fs";
var STARTUP_GRACE_MS = 3e4;
function readLock(lockFile) {
  try {
    const [pid = "", started = ""] = readFileSync5(lockFile, "utf8").split("\n");
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
function isHeld(lockFile) {
  const lock = readLock(lockFile);
  if (!lock) return false;
  if (!Number.isNaN(lock.pid)) return serverLockOwner(lockFile) !== null;
  try {
    return Date.now() - statSync3(lockFile).mtimeMs < STARTUP_GRACE_MS;
  } catch {
    return false;
  }
}
function createLock(lockFile, contents) {
  try {
    const descriptor = openSync(lockFile, "wx", 384);
    writeSync(descriptor, contents);
    closeSync(descriptor);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return false;
  }
}
var ownLock = () => `${process.pid}
${processInfo(process.pid)?.started ?? ""}`;
function acquireServerLock(lockFile) {
  const contents = ownLock();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (createLock(lockFile, contents)) return true;
    if (isHeld(lockFile)) return false;
    rmSync2(lockFile, { force: true });
  }
  return false;
}
function holdServerLock(lockFile) {
  const lock = readLock(lockFile);
  if (lock) return lock.pid === process.pid;
  return createLock(lockFile, ownLock());
}
function releaseServerLock(lockFile) {
  if (readLock(lockFile)?.pid === process.pid) rmSync2(lockFile, { force: true });
}

// src/server/watch.ts
var WATCH_INTERVAL_MS = 5e3;
var IDLE_MINUTES = 30;
var IDLE_TICKS = IDLE_MINUTES * 6e4 / WATCH_INTERVAL_MS;
var ServerWatch = class {
  #checks;
  #idleTicks = 0;
  constructor(checks) {
    this.#checks = checks;
  }
  /** A client used the API: a session's waiter, a hook or an open window. */
  active() {
    this.#idleTicks = 0;
  }
  /** Why the server should stop now, or null to keep running. */
  tick() {
    if (!this.#checks.holdsLock()) return "another server holds the lock";
    if (!this.#checks.isRegistered()) this.#checks.register();
    this.#idleTicks = this.#checks.working() ? 0 : this.#idleTicks + 1;
    return this.#idleTicks >= IDLE_TICKS ? `nothing used it for ${IDLE_MINUTES} minutes` : null;
  }
};

// src/server/main.ts
var WEB_DIR = join7(dirname3(fileURLToPath(import.meta.url)), "web");
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
    preferred = Number.parseInt(readFileSync6(paths.portFile(), "utf8"), 10) || 0;
  } catch {
  }
  try {
    return await listenOn(server, preferred);
  } catch (error) {
    if (preferred && error.code === "EADDRINUSE") return listenOn(server, 0);
    throw error;
  }
}
function registeredPid() {
  try {
    return JSON.parse(readFileSync6(paths.serverFile(), "utf8")).pid;
  } catch {
    return null;
  }
}
function removeServerFile() {
  const owner = serverLockOwner(paths.lockFile());
  if (owner !== null && owner !== process.pid) return;
  if (registeredPid() === process.pid) rmSync3(paths.serverFile(), { force: true });
}
async function main() {
  mkdirSync2(paths.stateDir(), { recursive: true, mode: 448 });
  if (!acquireServerLock(paths.lockFile())) return;
  process.on("exit", () => releaseServerLock(paths.lockFile()));
  const store = new Store({ dir: paths.stateDir() });
  const isTrusted = (folder) => isTrustedFolder(folder);
  const host = new SessionHost({ store, agent: new ClaudeAgent({ instructions: sessionContext() }), isTrusted });
  const token = randomBytes2(32).toString("base64url");
  const allowedHosts = /* @__PURE__ */ new Set();
  let serverInfo = "";
  const register = () => writeFileSync2(paths.serverFile(), serverInfo, { mode: 384 });
  const watch = new ServerWatch({
    holdsLock: () => holdServerLock(paths.lockFile()),
    isRegistered: () => registeredPid() === process.pid,
    register,
    working: () => host.working()
  });
  const server = createServer(
    createApp({
      store,
      delivery: new Delivery(store),
      host,
      launchCodes: new LaunchCodes(),
      token,
      allowedHosts,
      webDir: WEB_DIR,
      onActivity: () => watch.active(),
      openFolder: (path) => openWithSystem(path, () => console.error(`couldn't open ${path}`)),
      processes: new SessionProcesses({ pidInUse, isSameProcess: isSameClaude }, store.revision),
      isTrusted,
      startSession: canStartSessions() ? (session) => startInTerminal(terminalCommand(process.platform, session)) : null
    })
  );
  server.keepAliveTimeout = 2e3;
  const port = await listen(server);
  allowedHosts.add(`127.0.0.1:${port}`);
  allowedHosts.add(`localhost:${port}`);
  allowedHosts.add(`${PAGE_HOST}:${port}`);
  writeFileSync2(paths.portFile(), String(port), { mode: 384 });
  serverInfo = JSON.stringify({ port, token, pid: process.pid });
  register();
  console.error(`sidenote listening on http://127.0.0.1:${port}`);
  const shutDown = () => {
    host.closeAll();
    removeServerFile();
    server.close();
    server.closeAllConnections();
    process.exit(0);
  };
  process.on("SIGTERM", shutDown);
  process.on("SIGINT", shutDown);
  const interval = Number(process.env["SIDENOTE_WATCH_INTERVAL_MS"]) || WATCH_INTERVAL_MS;
  setInterval(() => {
    let reason;
    try {
      reason = watch.tick();
    } catch (error) {
      reason = `its files can't be reached: ${String(error)}`;
    }
    if (!reason) return;
    console.error(`sidenote stopping: ${reason}`);
    shutDown();
  }, interval);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
