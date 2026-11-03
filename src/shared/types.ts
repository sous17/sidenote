// The contract between the server, the hooks and the page.
// Field names are snake_case because they are also the on-disk format of ~/.sidenote/store.json.

/** Seconds since the epoch, with a fraction. */
export type EpochSeconds = number;

/** A finished Claude reply, as the Stop hook delivered it. */
export interface StoredResponse {
  id: number;
  session_id: string;
  cwd: string;
  /** The main answer. Sections Claude wrote for notes are moved into note_answers. */
  text: string;
  created_at: EpochSeconds;
  /** Claude's answer to each note this reply answered, keyed by String(note id). */
  note_answers: Record<string, string>;
}

/** A note the user wrote in the browser. Follow-ups in a thread point at the thread's root note. */
export interface Note {
  id: number;
  response_id: number;
  /** Index of the paragraph, list item or other block the note is on; -1 for the whole reply. */
  block_index: number;
  quote: string;
  body: string;
  parent_id: number | null;
  created_at: EpochSeconds;
  delivered_at: EpochSeconds | null;
  /** The reply that answered this note: null while awaiting one, 0 when unknown (older notes). */
  answered_by: number | null;
}

/**
 * Whether Send now can reach the session's Claude:
 * - listening: a waiter is running, so Send now wakes Claude at once
 * - busy: Claude is mid-turn, so a send goes as soon as it finishes
 * - offline: nothing is waiting, so notes go with the next terminal prompt
 */
export type SessionState = "listening" | "busy" | "offline";

/** The coding agents sidenote works with. */
export const AGENTS = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "Copilot",
} as const;

export type AgentId = keyof typeof AGENTS;

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && Object.hasOwn(AGENTS, value);
}

/** What sidenote remembers about an agent session. */
export interface SessionMeta {
  /** The agent the session runs in. */
  agent: AgentId;
  /** The session's name (Claude Code's /rename), or "" when it has none. */
  name: string;
  cwd: string;
  /** When the session was last active; sessions idle too long are forgotten. */
  last_active: EpochSeconds;
}

export interface SessionSummary extends SessionMeta {
  id: string;
}

export interface SendStatus {
  status: SessionState;
  send_requested: boolean;
}

/** The session a page shows, with its Send now status. */
export type SessionView = SessionSummary & SendStatus;

/** One session's replies and notes. Each page shows exactly one session. */
export interface StateSnapshot {
  version: number;
  /** null when the page names no session, or one sidenote has never seen or has forgotten. */
  session: SessionView | null;
  responses: StoredResponse[];
  comments: Note[];
}

/** A note handed to Claude, with the context needed to describe it. */
export interface ClaimedNote extends Note {
  response_created_at: EpochSeconds;
  root_body: string | null;
}

// ---- Requests and results ------------------------------------------------------------------

export interface NewResponseRequest {
  session_id: string;
  /** Defaults to "claude", for hooks installed before other agents were supported. */
  agent?: AgentId;
  /** The session's /rename name, when the hook could read it. */
  session_name?: string;
  cwd: string;
  text: string;
  /** Only for backfilled replies; live replies are stamped by the server. */
  created_at?: EpochSeconds;
}

export interface NewResponseResult {
  response: StoredResponse;
  /** True for a session's first reply, so the hook opens that session's window. */
  new_session: boolean;
}

export type NewNoteRequest =
  { response_id: number; block_index: number; quote: string; body: string } | { parent_id: number; body: string };

export interface TouchSessionRequest {
  session_id: string;
  agent?: AgentId;
  session_name?: string;
  cwd?: string;
}

export interface SessionListResult {
  sessions: SessionSummary[];
}

export interface ClaimRequest {
  session_id: string;
}

export interface ClaimResult {
  comments: ClaimedNote[];
}

export interface WaiterRequest {
  session_id: string;
  waiter_id: string;
}

export type WaiterAction = "exit" | "wait" | "send";

export interface WaiterPollResult {
  action: WaiterAction;
  comments: ClaimedNote[];
}

export interface SendRequest {
  session_ids: string[];
}

export interface SendResult {
  sessions: string[];
}

/** A single-use code that lets a newly opened page obtain the API token. */
export interface LaunchCodeResult {
  code: string;
}

export interface RedeemRequest {
  code: string;
}

export interface RedeemResult {
  token: string;
}

export interface ErrorResult {
  error: string;
}

/** Written to ~/.sidenote/server.json so the hooks can find the running server. */
export interface ServerInfo {
  port: number;
  token: string;
  pid: number;
}

// ---- Protocol constants --------------------------------------------------------------------

export const TOKEN_HEADER = "X-Review-Token";

/** URL fragment key that carries a launch code to a newly opened page. */
export const LAUNCH_FRAGMENT_KEY = "launch";

/** Session ids are Claude Code UUIDs; anything else is refused. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
