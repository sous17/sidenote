// sidenote CLI: the /sidenote:* commands and the Claude Code hooks.
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HEADLESS_ENV } from "../agent/claude.ts";
import { paths } from "../node/paths.ts";
import type { NewResponseRequest, SessionListResult, StateSnapshot } from "../shared/types.ts";
import { SidenoteClient, openBrowser, serverPid } from "./client.ts";
import { hookActivity, hookPrompt, hookSession, hookStop, hookWait, type HookInput } from "./hooks.ts";
import {
  cwdFromTranscript,
  finalResponsesPerTurn,
  findTranscript,
  readTranscript,
  sessionNameFromTranscript,
} from "./transcript.ts";

const USAGE = `sidenote: leave inline notes on Claude Code replies in your browser or terminal.

  sidenote on [session]        turn sidenote on and open the session's window in the browser
  sidenote chat [session]      talk to Claude Code here: sidenote runs the session, and you
                               note its replies as it works; without a session, a new one
                               starts in this folder
  sidenote tui [session]       show the session's replies in this terminal; without a session,
                               the latest one in this folder
  sidenote off                 turn sidenote off; unsent notes are kept
  sidenote open [session]      reopen the session's window
  sidenote status [session]    show the session's replies, notes and Send now status
  sidenote backfill [session]  import the session's earlier replies
  sidenote hook-session        SessionStart hook: ask Claude to show code changes as diffs
  sidenote hook-stop           Stop hook: send the finished reply to its session's window
  sidenote hook-prompt         UserPromptSubmit hook: attach pending notes to the prompt
  sidenote hook-activity       async PreToolUse hook: show what Claude is doing in the window
  sidenote hook-wait           async Stop hook: wake Claude when the browser clicks Send now

The /sidenote:* commands pass the current session. Without one, the most recently active
session is used.`;

const NOT_RUNNING = "The sidenote server is not running; use /sidenote:on first.";

/** The launcher, next to dist/: the plugin's bin/ isn't on the user's PATH. */
const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "sidenote");

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

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

/** Opens the given session's browser window, or the latest one's. Says what it did. */
async function show(client: SidenoteClient, requested: string | undefined): Promise<string> {
  if (requested) await touchSession(client, requested);
  const sessionId = requested ?? (await latestSession(client));
  const { session } = await fetchState(client, sessionId);
  openBrowser(await client.windowUrl(sessionId));
  const label = session ? `"${session.name || session.cwd.split("/").pop() || session.id.slice(0, 8)}"` : "sidenote";
  return `Opened the ${label} window in your browser (${client.origin}).`;
}

const commands: Record<string, () => Promise<void>> = {
  async on() {
    mkdirSync(paths.stateDir(), { recursive: true, mode: 0o700 });
    writeFileSync(paths.enabledFlag(), "");
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
    console.log(`terminal: ${shellQuote(LAUNCHER)} tui ${session.id}`);
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

  async chat() {
    const { runChat } = await import("../tui/main.ts");
    await runChat(process.argv.slice(3));
  },

  "hook-session": () => runHook(hookSession),
  "hook-stop": () => runHook(hookStop),
  "hook-prompt": () => runHook(hookPrompt),
  "hook-activity": () => runHook(hookActivity),
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
  await command();
} else {
  console.log(USAGE);
  process.exitCode = 2;
}
