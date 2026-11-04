// The contract between the server, the hooks and the page.
// Field names are snake_case because they are also the on-disk format of ~/.sidenote/sessions/.

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
  /** The name given in the window, which only sidenote shows; "" when it has none. */
  label: string;
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
  /** What Claude is doing in this turn, such as "Editing src/app.ts"; absent when unknown. */
  activity?: string;
  /** What Claude has written so far in this turn, oldest first, as plain text. */
  progress?: string[];
}

/** The session a page shows, with its Send now status. */
export type SessionView = SessionSummary & SendStatus;

/** A row in a folder's session list: one of the sessions that ran in that folder. */
export interface FolderSession extends SessionSummary {
  status: SessionState;
  /** The session's first message, shortened, so sessions without a /rename name can be told apart. */
  first_message: string;
  pending_notes: number;
  /** Whether sidenote knows the session's Claude process, and whether that still runs. */
  process: "running" | "ended" | "unknown";
}

/** The Claude Code process a session runs in, as its hooks report it. */
export interface ClaudeProcess {
  pid: number;
  /** When it started, so a later process that gets the same pid isn't mistaken for it. */
  started: string;
}

/**
 * A folder's window: its sessions, and the replies and notes of the one selected. Each page shows
 * one folder, and one of its sessions at a time.
 */
export interface StateSnapshot {
  version: number;
  /** The session asked for, else the folder's latest; null when sidenote knows neither. */
  session: SessionView | null;
  /** The window's folder by name; "" when the session's folder is unknown. */
  folder: string;
  /** The folder's sessions, most recently active first. */
  sessions: FolderSession[];
  /** Whether the page can start a new session in the folder: there is a terminal to open. */
  can_start_sessions: boolean;
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

/** A terminal session's tool call, reported by its PreToolUse hook. */
export interface ActivityRequest {
  session_id: string;
  text: string;
}

/** Part of a message Claude is writing, reported by a terminal session's MessageDisplay hook. */
export interface ProgressRequest {
  session_id: string;
  /** The same for every batch of one message. */
  message_id: string;
  /** Batches run in the background, so they can arrive out of order. */
  index: number;
  delta: string;
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
  claude_process?: ClaudeProcess;
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
  claude_process?: ClaudeProcess;
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
  claude_process?: ClaudeProcess;
}

/**
 * Acts on one session: opens its folder, ends it, or removes it from the list. The server knows
 * the folder and the process; the page only names the session.
 */
export interface SessionRequest {
  session_id: string;
}

/** Names a session in the window; an empty label removes the name. */
export interface RenameSessionRequest {
  session_id: string;
  label: string;
}

/**
 * Starts a new session in a terminal, in the folder of the session named, which the server knows;
 * the page never sends a path.
 */
export interface StartSessionRequest {
  session_id: string;
  /** The new session's first prompt; empty or absent starts Claude without one. */
  prompt?: string;
  /** Its name, in the window and in Claude Code; empty or absent leaves it unnamed. */
  name?: string;
}

export interface StartSessionResult {
  /** The new session's id, which the server gave Claude, so the page can select it right away. */
  session_id: string;
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

/** /clear ended a session: forgotten is false when it was kept for its unsent notes or messages. */
export interface ClearedSessionResult {
  forgotten: boolean;
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

/**
 * The longest message the page can send. It reaches Claude through the same capped hook output as
 * notes, so it leaves room for the framing and some notes.
 */
export const MAX_PROMPT_CHARS = 8000;

/** URL fragment key that carries a launch code to a newly opened page. */
export const LAUNCH_FRAGMENT_KEY = "launch";

/** The host windows open on. Browsers resolve *.localhost to this machine without any setup. */
export const PAGE_HOST = "sidenote.localhost";

/** Session ids are Claude Code UUIDs; anything else is refused. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
