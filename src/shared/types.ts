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
  // The rest is set only for turns sidenote ran itself (see src/server/host.ts).
  /** What the user typed for this turn; notes that rode along aren't included. */
  prompt?: string;
  /** How many notes rode along with the prompt. */
  notes_sent?: number;
  /** The turn's tool calls, each shown as a one-line row. */
  steps?: TurnStep[];
  /** Set when the turn didn't finish: stopped by the user, or failed. */
  ended?: "interrupted" | "error";
  /** The agent's error, when ended is "error". */
  error?: string;
}

/** One tool call of a turn: "Edit src/app.ts", "Bash npm test". */
export interface TurnStep {
  tool: string;
  /** What the call works on, such as a file or a command, or "". */
  summary: string;
  /** The row follows this block of the reply's text; -1 puts it before the first. */
  after_block: number;
  failed: boolean;
}

/** A message the user sent Claude: typed in the terminal, or in the page's message box. */
export interface UserMessage {
  id: number;
  session_id: string;
  text: string;
  source: "terminal" | "page";
  created_at: EpochSeconds;
  /** When it reached Claude; null while a message from the page waits for Claude's turn to end. */
  delivered_at: EpochSeconds | null;
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

/** What sidenote remembers about a Claude Code session. */
export interface SessionMeta {
  /** The name given with /rename, or "" when the session has none. */
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
  /** A message typed in the page that waits for Claude to finish its turn; absent when none does. */
  queued_prompt?: string;
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
  /** What the user sent Claude in this session, oldest first. */
  messages: UserMessage[];
}

/** A note handed to Claude, with the context needed to describe it. */
export interface ClaimedNote extends Note {
  response_created_at: EpochSeconds;
  root_body: string | null;
}

// ---- Sessions sidenote runs ---------------------------------------------------------------

/**
 * What the agent of a session sidenote runs is doing:
 * - idle: waiting for a message
 * - working: in a turn
 * - waiting: in a turn, waiting for the user to answer a permission prompt
 * - stopped: its process ended; the next message starts it again
 */
export type AgentState = "idle" | "working" | "waiting" | "stopped";

/** Part of the turn in progress: streamed text, or a tool call (failed is null while it runs). */
export type LivePart =
  { kind: "text"; text: string } | { kind: "tool"; id: string; tool: string; summary: string; failed: boolean | null };

export interface LiveTurn {
  prompt: string;
  notes_sent: number;
  started_at: EpochSeconds;
  parts: LivePart[];
}

/** A tool call waiting for the user's yes or no. */
export interface PermissionPrompt {
  request_id: string;
  tool: string;
  summary: string;
  /** The command, file or input in full, for the user to read before answering. */
  detail: string;
}

export interface ConversationView {
  version: number;
  session_id: string;
  /** Such as "Claude Code". */
  agent: string;
  /** "" until the agent reports it. */
  model: string;
  state: AgentState;
  live: LiveTurn | null;
  /** Messages typed while the agent worked; each goes when the turn before it ends. */
  queued: string[];
  permission: PermissionPrompt | null;
  context: { used: number; limit: number } | null;
  /** Why the agent last stopped or failed, or "". */
  error: string;
}

export interface StartConversationRequest {
  cwd: string;
  /** An earlier session to continue; without one, a new session starts. */
  session_id?: string;
}

export interface StartConversationResult {
  session_id: string;
}

export interface ConversationMessageRequest {
  session_id: string;
  /** May be "" to send only the pending notes. */
  text: string;
}

export interface PermissionAnswerRequest {
  session_id: string;
  request_id: string;
  decision: "allow" | "deny" | "always";
}

// ---- Requests and results ------------------------------------------------------------------

export interface NewResponseRequest {
  session_id: string;
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
  session_name?: string;
  cwd?: string;
}

export interface SessionListResult {
  sessions: SessionSummary[];
}

export interface ClaimRequest {
  session_id: string;
  /** What the user typed in the terminal, so the page can show it. */
  prompt?: string;
}

export interface ClaimResult {
  comments: ClaimedNote[];
  /** A message sent from the page that hadn't reached Claude yet; it rides along with this prompt. */
  prompt?: string;
}

/** A message for Claude, typed in the page instead of the terminal. */
export interface PromptRequest {
  session_id: string;
  text: string;
}

export interface PromptResult {
  /** sent: Claude is starting on it; queued: it goes as soon as Claude finishes its turn. */
  delivery: "sent" | "queued";
}

export interface WaiterRequest {
  session_id: string;
  waiter_id: string;
}

export type WaiterAction = "exit" | "wait" | "send";

export interface WaiterPollResult {
  action: WaiterAction;
  comments: ClaimedNote[];
  /** A message typed in the page, when the user sent one rather than only notes. */
  prompt?: string;
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
