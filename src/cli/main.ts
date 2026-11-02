// sidenote CLI: the /sidenote:* commands and the three Claude Code hooks.
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { paths } from "../shared/paths.ts";
import type { NewResponseRequest, ServerInfo, SessionListResult, StateSnapshot } from "../shared/types.ts";
import { callApi, ensureServer, openBrowser, pageUrl, readServerInfo, runningServer } from "./client.ts";
import { hookPrompt, hookStop, hookWait, type HookInput } from "./hooks.ts";
import {
  cwdFromTranscript,
  finalResponsesPerTurn,
  findTranscript,
  readTranscript,
  sessionNameFromTranscript,
} from "./transcript.ts";

const USAGE = `sidenote: leave inline notes on Claude Code replies in your browser.

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

const isEnabled = () => existsSync(paths.enabledFlag());

/** The session a command is about: its argument, unless that is missing or an unexpanded placeholder. */
function sessionArg(): string | undefined {
  const arg = process.argv[3]?.trim();
  return arg && !arg.includes("$") ? arg : undefined;
}

async function latestSession(server: ServerInfo): Promise<string | undefined> {
  const { sessions } = await callApi<SessionListResult>(server, "GET", "/api/sessions");
  return sessions[0]?.id;
}

/** Registers the session with its name and folder, read from its transcript when there is one. */
async function touchSession(server: ServerInfo, sessionId: string): Promise<void> {
  const file = findTranscript(paths.transcriptsDir(), sessionId);
  const transcript = file ? readTranscript(file) : "";
  await callApi(server, "POST", "/api/sessions", {
    session_id: sessionId,
    session_name: sessionNameFromTranscript(transcript),
    cwd: cwdFromTranscript(transcript),
  });
}

/** Opens the window of the given session, or of the latest one; returns its URL. */
async function openSessionWindow(server: ServerInfo, sessionId: string | undefined): Promise<string> {
  if (sessionId) await touchSession(server, sessionId);
  const url = pageUrl(server, sessionId ?? (await latestSession(server)));
  openBrowser(url);
  return url;
}

async function commandOn(): Promise<void> {
  mkdirSync(paths.stateDir(), { recursive: true, mode: 0o700 });
  writeFileSync(paths.enabledFlag(), "");
  const { server } = await ensureServer();
  console.log(`sidenote on: ${await openSessionWindow(server, sessionArg())}`);
}

async function commandOff(): Promise<void> {
  rmSync(paths.enabledFlag(), { force: true });
  const server = readServerInfo();
  if (server) {
    try {
      process.kill(server.pid, "SIGTERM");
    } catch {
      // Not running.
    }
  }
  console.log("sidenote off. Undelivered notes are kept and will be sent after the next 'on'.");
}

async function commandStatus(): Promise<void> {
  const server = await runningServer();
  console.log(`enabled: ${isEnabled() ? "yes" : "no"}`);
  if (!server) {
    console.log("server:  not running");
    return;
  }
  const sessionId = sessionArg() ?? (await latestSession(server));
  console.log(`window:  ${pageUrl(server, sessionId)}`);
  const state = await callApi<StateSnapshot>(server, "GET", `/api/state?s=${encodeURIComponent(sessionId ?? "")}`);
  if (!state.session) {
    console.log("This session has no replies in sidenote yet.");
    return;
  }
  const { session } = state;
  console.log(`session: ${session.name || "(unnamed)"} · ${session.id.slice(0, 8)} · ${session.cwd}`);
  console.log(`replies: ${state.responses.length}`);
  console.log(`pending notes: ${state.comments.filter((c) => c.delivered_at === null).length}`);
  console.log(`Send now: ${session.status === "offline" ? "not available until Claude's next reply" : "ready"}`);
}

async function commandOpen(): Promise<void> {
  const server = await runningServer();
  if (!server) {
    console.log("The sidenote server is not running; use /sidenote:on first.");
    return;
  }
  console.log(await openSessionWindow(server, sessionArg()));
}

/** Imports the session's earlier replies from its transcript, so you can leave notes on them. */
async function commandBackfill(): Promise<void> {
  const server = await runningServer();
  if (!server) {
    console.log("The sidenote server is not running; use /sidenote:on first.");
    return;
  }
  const sessionId = sessionArg() ?? (await latestSession(server));
  const file = sessionId ? findTranscript(paths.transcriptsDir(), sessionId) : null;
  if (!sessionId || !file) {
    console.log("No transcript found for this session.");
    return;
  }
  const transcript = readTranscript(file);
  const state = await callApi<StateSnapshot>(server, "GET", `/api/state?s=${encodeURIComponent(sessionId)}`);
  const knownTexts = new Set(state.responses.map((r) => r.text));
  const cwd = state.session?.cwd || cwdFromTranscript(transcript);
  const sessionName = sessionNameFromTranscript(transcript);
  let imported = 0;
  for (const { createdAt, text } of finalResponsesPerTurn(transcript)) {
    if (knownTexts.has(text)) continue;
    const body: NewResponseRequest = { session_id: sessionId, session_name: sessionName, cwd, text, created_at: createdAt };
    await callApi(server, "POST", "/api/responses", body);
    imported += 1;
  }
  console.log(`Imported ${imported} earlier replies of this session.`);
}

/** A hook must never break the Claude session: failures go to the log, and it exits 0. */
async function runHook(handler: (input: HookInput) => Promise<void>): Promise<void> {
  if (!isEnabled()) return;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk);
    await handler(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as HookInput);
  } catch (error) {
    mkdirSync(paths.stateDir(), { recursive: true, mode: 0o700 });
    appendFileSync(paths.logFile(), `${new Date().toISOString()} ${handler.name} failed: ${String(error)}\n`);
  }
}

const COMMANDS: Record<string, () => Promise<void>> = {
  on: commandOn,
  off: commandOff,
  status: commandStatus,
  open: commandOpen,
  backfill: commandBackfill,
  "hook-stop": () => runHook(hookStop),
  "hook-prompt": () => runHook(hookPrompt),
  "hook-wait": () => runHook(hookWait),
};

const command = COMMANDS[process.argv[2] ?? "status"];
if (!command) {
  console.log(USAGE);
  process.exitCode = 2;
} else {
  await command();
}
