// sidenote CLI: the /sidenote:* commands and the three Claude Code hooks.
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { HEADLESS_ENV } from "../agent/claude.ts";
import { paths } from "../node/paths.ts";
import type { NewResponseRequest, SessionListResult, StateSnapshot } from "../shared/types.ts";
import { SidenoteClient, openBrowser, serverPid } from "./client.ts";
import { isUi, readUi, writeUi, type Ui } from "./config.ts";
import { hookPrompt, hookSession, hookStop, hookWait, type HookInput } from "./hooks.ts";
import { openTerminal, shellQuote, tuiCommand } from "./panes.ts";
import {
  cwdFromTranscript,
  finalResponsesPerTurn,
  findTranscript,
  readTranscript,
  sessionNameFromTranscript,
} from "./transcript.ts";

const USAGE = `sidenote: leave inline notes on Claude Code replies in your browser or terminal.

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

const NOT_RUNNING = "The sidenote server is not running; use /sidenote:on first.";

const isEnabled = (): boolean => existsSync(paths.enabledFlag());

/** The command's session argument, unless it is missing or an unexpanded placeholder. */
function sessionArgument(): string | undefined {
  const value = process.argv[3]?.trim();
  return value && !value.includes("$") ? value : undefined;
}

async function latestSession(client: SidenoteClient): Promise<string | undefined> {
  const { sessions } = await client.get<SessionListResult>("/api/sessions");
  return sessions[0]?.id;
}

function fetchState(client: SidenoteClient, sessionId: string | undefined): Promise<StateSnapshot> {
  return client.get<StateSnapshot>(`/api/state?s=${encodeURIComponent(sessionId ?? "")}`);
}

/** Registers the session, with its name and folder from its transcript, before its first reply. */
async function touchSession(client: SidenoteClient, sessionId: string): Promise<void> {
  const file = findTranscript(paths.transcriptsDir(), sessionId);
  const transcript = file ? readTranscript(file) : "";
  await client.post("/api/sessions", {
    session_id: sessionId,
    session_name: sessionNameFromTranscript(transcript),
    cwd: cwdFromTranscript(transcript),
  });
}

/** The way to show sessions this command asks for: "terminal" or "browser", or none. */
function uiArgument(): Ui | undefined {
  const value = process.argv[4]?.trim().toLowerCase();
  if (!value || value.includes("$")) return undefined;
  if (isUi(value)) return value;
  throw new UsageError(`"${value}" isn't a choice: use /sidenote:on terminal or /sidenote:on browser.`);
}

class UsageError extends Error {}

/**
 * Shows the given session, or the latest one, the way the user chose: its browser window, or
 * sidenote tui in a terminal pane beside Claude. Says what it did.
 */
async function show(client: SidenoteClient, requested: string | undefined): Promise<string> {
  if (requested) await touchSession(client, requested);
  const sessionId = requested ?? (await latestSession(client));
  const { session } = await fetchState(client, sessionId);
  if (readUi() === "terminal") {
    return (await openTerminal(sessionId, session?.cwd || process.cwd(), process.env)).message;
  }
  openBrowser(await client.windowUrl(sessionId));
  const label = session ? `"${session.name || session.cwd.split("/").pop() || session.id.slice(0, 8)}"` : "sidenote";
  return `Opened the ${label} window in your browser (${client.origin}).`;
}

const commands: Record<string, () => Promise<void>> = {
  async on() {
    mkdirSync(paths.stateDir(), { recursive: true, mode: 0o700 });
    const ui = uiArgument();
    writeFileSync(paths.enabledFlag(), "");
    if (ui) writeUi(ui);
    const { client } = await SidenoteClient.ensure();
    console.log(`sidenote is on. ${await show(client, sessionArgument())}`);
  },

  async off() {
    rmSync(paths.enabledFlag(), { force: true });
    const pid = serverPid();
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Not running.
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
      sessionArgument() ?? (await latestSession(client)),
    );
    if (!session) {
      console.log("This session has no replies in sidenote yet.");
      return;
    }
    console.log(`session: ${session.name || "(unnamed)"} · ${session.id.slice(0, 8)} · ${session.cwd}`);
    console.log(`replies: ${responses.length}`);
    console.log(`pending notes: ${comments.filter((c) => c.delivered_at === null).length}`);
    console.log(`Send now: ${session.status === "offline" ? "available after Claude's next reply" : "ready"}`);
    console.log(
      `terminal: ${tuiCommand(session.id)
        .map((part, i) => (i ? part : shellQuote(part)))
        .join(" ")}`,
    );
  },

  /** Imports the session's earlier replies from its transcript, so you can leave notes on them. */
  async backfill() {
    const client = await SidenoteClient.connect();
    if (!client) {
      console.log(NOT_RUNNING);
      return;
    }
    const sessionId = sessionArgument() ?? (await latestSession(client));
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
    for (const { createdAt, text } of finalResponsesPerTurn(transcript)) {
      if (known.has(text)) continue;
      const reply: NewResponseRequest = {
        session_id: sessionId,
        session_name: sessionName,
        cwd,
        text,
        created_at: createdAt,
      };
      await client.post("/api/responses", reply);
      imported += 1;
    }
    console.log(`Imported ${imported} earlier replies of this session.`);
  },

  async tui() {
    // Loaded only for this command, so the hooks don't pay for the terminal UI.
    const { runTui } = await import("../tui/main.ts");
    await runTui(process.argv.slice(3));
  },

  "hook-session": () => runHook(hookSession),
  "hook-stop": () => runHook(hookStop),
  "hook-prompt": () => runHook(hookPrompt),
  "hook-wait": () => runHook(hookWait),
};

/**
 * A hook must never break the Claude session: failures go to the log, and it exits 0. Sessions
 * sidenote runs itself get their replies and notes from the session host, so hooks skip them.
 */
async function runHook(handler: (input: HookInput) => Promise<void>): Promise<void> {
  if (!isEnabled() || process.env[HEADLESS_ENV]) return;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk);
    await handler(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as HookInput);
  } catch (error) {
    mkdirSync(paths.stateDir(), { recursive: true, mode: 0o700 });
    appendFileSync(paths.logFile(), `${new Date().toISOString()} ${handler.name} failed: ${String(error)}\n`, {
      mode: 0o600,
    });
  }
}

const command = commands[process.argv[2] ?? "status"];
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
