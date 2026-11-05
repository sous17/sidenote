// The Claude Code hooks. Each reads Claude Code's JSON hook input from stdin (see main.ts).
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  ActivityRequest,
  ClaimRequest,
  ClaudeProcess,
  ProgressRequest,
  ClaimResult,
  NewResponseRequest,
  NewResponseResult,
  WaiterPollResult,
  WaiterRequest,
} from "../shared/types.ts";
import { paths } from "../node/paths.ts";
import { claudeProcess, pidInUse } from "../node/process.ts";
import { SERVER_START_TIMEOUT_MS, SidenoteClient, openBrowser } from "./client.ts";
import { formatNotesForClaude, formatPromptForClaude, isWakeText, sessionContext } from "../shared/format.ts";
import { MAX_PROGRESS_DELTA_CHARS, toolActivity } from "../shared/tools.ts";
import { sessionNameFromTranscript } from "./transcript.ts";

const WAITER_POLL_MS = 1000;
/** Plenty for a restart. A server gone for longer gets a new waiter with Claude's next reply. */
const WAITER_REJOIN_MS = 60_000;
/** A huge paste is cut for the window; Claude still gets all of it from Claude Code. */
const MAX_SHOWN_PROMPT_CHARS = 100_000;

/** The fields sidenote reads from Claude Code's hook input. */
export interface HookInput {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  last_assistant_message?: string;
  /** UserPromptSubmit: what the user typed. */
  prompt?: string;
  /** SessionEnd: why the session ended. */
  reason?: string;
  /** PreToolUse: the call Claude is about to make. */
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Set when a subagent makes the call or writes the message. */
  agent_id?: string;
  /** MessageDisplay: a batch of the message Claude is writing. */
  message_id?: string;
  index?: number;
  delta?: string;
}

/** The Claude process this hook runs under, so the window can end its session. */
function reportedProcess(): { claude_process?: ClaudeProcess } {
  const found = claudeProcess();
  return found ? { claude_process: found } : {};
}

/** The session's /rename name, or "" if the transcript can't be read or has none. */
function sessionName(transcriptPath: string | undefined): string {
  if (!transcriptPath) return "";
  try {
    return sessionNameFromTranscript(readFileSync(transcriptPath, "utf8"));
  } catch {
    return "";
  }
}

/** Stop: sends the finished reply to its session's window, opening it for a new session. */
export async function hookStop(input: HookInput): Promise<void> {
  const text = input.last_assistant_message?.trim();
  const sessionId = input.session_id;
  if (!text || !sessionId) return;
  const { client, started } = await SidenoteClient.ensure();
  const reply: NewResponseRequest = {
    session_id: sessionId,
    session_name: sessionName(input.transcript_path),
    cwd: input.cwd ?? "",
    text,
    ...reportedProcess(),
  };
  const result = await client.post<NewResponseResult>("/api/responses", reply);
  if (started || result.new_session) openBrowser(await client.windowUrl(sessionId, reply.cwd));
}

/**
 * SessionEnd, only for /clear: the session is over, so its window lets go of it. Claude Code gives
 * these hooks 1.5 seconds and a plugin can't raise that, so a stopped server is left alone: retention
 * forgets the session later.
 */
export async function hookClear(input: HookInput): Promise<void> {
  if (input.reason !== "clear" || !input.session_id) return;
  const client = await SidenoteClient.connect();
  if (!client) return;
  await client.post("/api/sessions/cleared", { session_id: input.session_id });
}

/** SessionStart: tells Claude how to show code changes so the window can draw them as diffs. */
export async function hookSession(): Promise<void> {
  const output = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sessionContext() } };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

/** UserPromptSubmit: shows the prompt in the window, and attaches pending notes to it as context. */
export async function hookPrompt(input: HookInput): Promise<void> {
  if (!input.session_id) return;
  // The server stops when idle, and saved notes must still go with this prompt.
  const { client } = await SidenoteClient.ensure();
  const claim: ClaimRequest = { session_id: input.session_id, ...reportedProcess() };
  if (input.prompt && !isWakeText(input.prompt)) claim.prompt = input.prompt.slice(0, MAX_SHOWN_PROMPT_CHARS);
  const { comments, prompt } = await client.post<ClaimResult>("/api/claim", claim);
  if (!comments.length && prompt === undefined) return;
  const additionalContext =
    prompt === undefined
      ? formatNotesForClaude(comments)
      : formatPromptForClaude(prompt, comments, { withTerminalPrompt: true });
  const output = { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

/**
 * PreToolUse, in the background: shows the window what Claude is doing, in one line. Subagents
 * work in parallel with Claude, so their calls would only make the line flicker.
 */
export async function hookActivity(input: HookInput): Promise<void> {
  if (!input.session_id || !input.tool_name || input.agent_id) return;
  const text = toolActivity(input.tool_name, input.tool_input ?? {}, input.cwd ?? "");
  if (!text) return;
  const client = await SidenoteClient.connect();
  if (!client) return;
  const activity: ActivityRequest = { session_id: input.session_id, text };
  await client.post("/api/activity", activity);
}

/**
 * MessageDisplay, in the background: shows the window what Claude writes between tool calls. Its
 * last message of a turn comes through here too; the page drops it when the reply lands.
 */
export async function hookProgress(input: HookInput): Promise<void> {
  const { session_id, message_id, index, delta } = input;
  if (!session_id || !message_id || index === undefined || !delta || input.agent_id) return;
  const client = await SidenoteClient.connect();
  if (!client) return;
  const progress: ProgressRequest = {
    session_id,
    message_id,
    index,
    delta: delta.slice(0, MAX_PROGRESS_DELTA_CHARS),
  };
  await client.post("/api/progress", progress);
}

/**
 * Stop, in the background with asyncRewake: waits for Send now or a message from the browser, then
 * prints the notes and message to stderr and exits 2, which wakes Claude to answer them.
 */
export async function hookWait(input: HookInput): Promise<void> {
  if (!input.session_id) return;
  let client = await connectWithin(SERVER_START_TIMEOUT_MS);
  if (!client) return;
  const waiter: WaiterRequest = {
    session_id: input.session_id,
    waiter_id: randomBytes(8).toString("hex"),
    ...reportedProcess(),
  };
  await client.post("/api/waiters", waiter);
  // A waiter left behind by a Claude that died would keep the server, and "listening", alive.
  const owner = claudeProcess();
  for (;;) {
    await sleep(WAITER_POLL_MS);
    if (owner && !pidInUse(owner.pid)) return;
    let result: WaiterPollResult;
    try {
      result = await client.post<WaiterPollResult>("/api/waiters/poll", waiter);
    } catch {
      client = await rejoin(waiter);
      if (!client) return;
      continue;
    }
    if (result.action === "exit") return;
    if (result.action === "send") {
      process.stderr.write(
        result.prompt === undefined
          ? formatNotesForClaude(result.comments, { sendNow: true })
          : formatPromptForClaude(result.prompt, result.comments),
      );
      // Exit code 2 wakes Claude. Set it instead of calling process.exit, so stderr finishes
      // writing first (pipes are asynchronous on macOS).
      process.exitCode = 2;
      return;
    }
  }
}

/** The Stop hook that starts the server runs alongside hook-wait, so give it time. */
/**
 * Finds the server that replaced a lost one and waits there, so a restart doesn't leave a session
 * that nothing can wake. A new server knows no waiters, and has a new token. Null once sidenote was
 * turned off, or no server came back.
 */
async function rejoin(waiter: WaiterRequest): Promise<SidenoteClient | null> {
  const deadline = Date.now() + WAITER_REJOIN_MS;
  while (Date.now() < deadline && existsSync(paths.enabledFlag())) {
    const client = await SidenoteClient.connect();
    const joined = await client?.post("/api/waiters", waiter).then(
      () => true,
      () => false,
    );
    if (joined) return client;
    await sleep(500);
  }
  return null;
}

async function connectWithin(timeoutMs: number): Promise<SidenoteClient | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = await SidenoteClient.connect();
    if (client || Date.now() > deadline) return client;
    await sleep(500);
  }
}
