// sidenote CLI: the /sidenote:* commands, the agent hooks, and installing hooks into other agents.
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { paths } from "../node/paths.ts";
import {
  AGENTS,
  isAgentId,
  type AgentId,
  type NewResponseRequest,
  type SessionListResult,
  type StateSnapshot,
} from "../shared/types.ts";
import { AGENT_ADAPTERS } from "./agents/index.ts";
import type { HookInput, HookOutput } from "./agents/core.ts";
import { SidenoteClient, openBrowser, serverPid } from "./client.ts";
import { install, uninstall } from "./install.ts";
import {
  cwdFromTranscript,
  finalResponsesPerTurn,
  findTranscript,
  readTranscript,
  sessionNameFromTranscript,
} from "./transcript.ts";

const USAGE = `sidenote: leave inline notes on your coding agent's replies in a browser window.

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
    agent: "claude",
    session_name: sessionNameFromTranscript(transcript),
    cwd: cwdFromTranscript(transcript),
  });
}

/** Opens the window of the given session, or of the latest one, and says which. */
async function openWindow(client: SidenoteClient, requested: string | undefined): Promise<string> {
  if (requested) await touchSession(client, requested);
  const sessionId = requested ?? (await latestSession(client));
  openBrowser(await client.windowUrl(sessionId));
  const { session } = await fetchState(client, sessionId);
  const label = session ? `"${session.name || session.cwd.split("/").pop() || session.id.slice(0, 8)}"` : "sidenote";
  return `Opened the ${label} window in your browser (${client.origin}).`;
}

const commands: Record<string, () => Promise<void>> = {
  async on() {
    mkdirSync(paths.stateDir(), { recursive: true, mode: 0o700 });
    writeFileSync(paths.enabledFlag(), "");
    const { client } = await SidenoteClient.ensure();
    console.log(`sidenote is on. ${await openWindow(client, sessionArgument())}`);
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
        agent: "claude",
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
  "hook-wait": () => runHook("claude", "wait"),
};

function agentArgument(): AgentId | undefined {
  const value = process.argv[3];
  return isAgentId(value) ? value : undefined;
}

function installHelp(agent: AgentId | undefined): string {
  if (agent === "claude") {
    return "Claude Code installs sidenote as a plugin: claude plugin install sidenote@sidenote";
  }
  return "Usage: sidenote install <codex|cursor|copilot>";
}

/**
 * Runs one of an agent's hooks. A hook must never break the agent's session: failures go to the
 * log, the hook exits 0, and agents that expect output from a hook still get some.
 */
async function runHook(agentName: string | undefined, hookName: string | undefined): Promise<void> {
  const agent = isAgentId(agentName) ? AGENT_ADAPTERS[agentName] : undefined;
  const handler = agent && hookName ? agent.hooks[hookName] : undefined;
  const fallback: HookOutput = { stdout: agent?.fallbackOutput?.[hookName ?? ""] };
  let output = fallback;
  if (handler && isEnabled()) {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk);
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      output = await handler(typeof input === "object" && input !== null ? (input as HookInput) : {});
    } catch (error) {
      mkdirSync(paths.stateDir(), { recursive: true, mode: 0o700 });
      const line = `${new Date().toISOString()} ${agentName} ${hookName} hook failed: ${String(error)}\n`;
      appendFileSync(paths.logFile(), line, { mode: 0o600 });
      output = fallback;
    }
  }
  if (output.stdout) process.stdout.write(output.stdout);
  if (output.stderr) process.stderr.write(output.stderr);
  // Set the exit code rather than calling process.exit, so output finishes writing first.
  if (output.exitCode) process.exitCode = output.exitCode;
}

const command = commands[process.argv[2] ?? "status"];
if (command) {
  await command();
} else {
  console.log(USAGE);
  process.exitCode = 2;
}
