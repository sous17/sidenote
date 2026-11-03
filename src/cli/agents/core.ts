// What sidenote's hooks do, independent of the agent. Each agent's adapter (claude.ts, codex.ts, …)
// only translates its own hook input and output to these operations.
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  AgentId,
  ClaimResult,
  NewResponseRequest,
  NewResponseResult,
  WaiterPollResult,
  WaiterRequest,
} from "../../shared/types.ts";
import { SERVER_START_TIMEOUT_MS, SidenoteClient, openBrowser } from "../client.ts";
import { formatNotes, sessionContext } from "../format.ts";

const WAITER_POLL_MS = 1000;

/** The session a hook fired in. */
export interface SessionRef {
  agent: AgentId;
  id: string;
  cwd: string;
  /** The session's name, when the agent has one. */
  name?: string;
}

/** What a hook prints, and how it exits. */
export interface HookOutput {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

/** A hook's raw input: Claude Code and the other agents send one JSON object on stdin. */
export type HookInput = Readonly<Record<string, unknown>>;

export type HookHandler = (input: HookInput) => Promise<HookOutput>;

/** The first of these fields that holds a non-empty string. Agents name the same thing differently. */
export function text(input: HookInput, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export const json = (value: object): HookOutput => ({ stdout: `${JSON.stringify(value)}\n` });

/** The instructions every session gets while sidenote is on: how to show code changes. */
export { sessionContext };

/** Sends a finished reply to its session's window, opening the window for a new session. */
export async function recordReply(session: SessionRef, reply: string): Promise<void> {
  const body = reply.trim();
  if (!body) return;
  const { client, started } = await SidenoteClient.ensure();
  const request: NewResponseRequest = {
    session_id: session.id,
    agent: session.agent,
    session_name: session.name ?? "",
    cwd: session.cwd,
    text: body,
  };
  const result = await client.post<NewResponseResult>("/api/responses", request);
  if (started || result.new_session) openBrowser(await client.windowUrl(session.id));
}

/** For agents that take context with a prompt: the session's unsent notes, described for the agent. */
export async function notesForPrompt(sessionId: string): Promise<string | null> {
  const client = await SidenoteClient.connect();
  if (!client) return null;
  const { comments } = await client.post<ClaimResult>("/api/claim", { session_id: sessionId });
  return comments.length ? formatNotes(comments, "prompt") : null;
}

/** For agents that can't take context with a prompt: the turn starts, and unsent notes go at its end. */
export async function startTurn(sessionId: string): Promise<void> {
  const client = await SidenoteClient.connect();
  if (client) await client.post("/api/turns/start", { session_id: sessionId });
}

/** At the end of a turn: notes due now (queued with Send now, or saved before this turn), if any. */
export async function notesAtTurnEnd(sessionId: string): Promise<string | null> {
  const client = await SidenoteClient.connect();
  if (!client) return null;
  const { comments } = await client.post<ClaimResult>("/api/turns/end", { session_id: sessionId });
  return comments.length ? formatNotes(comments, "turn-end") : null;
}

/**
 * Waits in the background until the user clicks Send now, then returns the notes to wake the
 * agent with. Returns null when the wait ends otherwise: a prompt was typed, a newer turn took
 * over, or sidenote was turned off.
 */
export async function waitForSendNow(sessionId: string): Promise<string | null> {
  // The hook that starts the server runs alongside this one, so give it time.
  const client = await connectWithin(SERVER_START_TIMEOUT_MS);
  if (!client) return null;
  const waiter: WaiterRequest = { session_id: sessionId, waiter_id: randomBytes(8).toString("hex") };
  await client.post("/api/waiters", waiter);
  for (;;) {
    await sleep(WAITER_POLL_MS);
    let result: WaiterPollResult;
    try {
      result = await client.post<WaiterPollResult>("/api/waiters/poll", waiter);
    } catch {
      return null; // sidenote was turned off or restarted
    }
    if (result.action === "exit") return null;
    if (result.action === "send") return formatNotes(result.comments, "send-now");
  }
}

async function connectWithin(timeoutMs: number): Promise<SidenoteClient | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = await SidenoteClient.connect();
    if (client || Date.now() > deadline) return client;
    await sleep(500);
  }
}
