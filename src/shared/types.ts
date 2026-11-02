// The API contract shared by the server, the hooks and the page.
// Field names are snake_case because they are also the on-disk format of ~/.sidenote/store.json.

/** Seconds since the epoch, with a fraction. */
export type EpochSeconds = number;

/** A finished Claude reply, as the Stop hook delivered it. */
export interface StoredResponse {
  id: number;
  session_id: string;
  cwd: string;
  /** The main answer; sections Claude wrote for notes are moved into note_answers. */
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

/** "listening": Send now wakes Claude. "busy": Claude is mid-turn, a send waits for it.
 *  "offline": no waiter; notes go with the next terminal prompt. */
export type SessionState = "listening" | "busy" | "offline";

/** What sidenote remembers about a Claude Code session. */
export interface SessionMeta {
  /** The name given with /rename, or "" when the session has none. */
  name: string;
  cwd: string;
  /** When the session's latest reply arrived; sessions idle too long are forgotten. */
  last_active: EpochSeconds;
}

/** The session a page shows, with its Send now status. */
export interface SessionView extends SessionMeta {
  id: string;
  status: SessionState;
  send_requested: boolean;
}

/** One session's replies and notes: each page shows exactly one session. */
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
  | { response_id: number; block_index: number; quote: string; body: string }
  | { parent_id: number; body: string };

export interface TouchSessionRequest {
  session_id: string;
  session_name?: string;
  cwd?: string;
}

export interface SessionListResult {
  sessions: Array<SessionMeta & { id: string }>;
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
  /** Omit to send every session's pending notes. */
  session_ids?: string[];
}

export interface SendResult {
  sessions: string[];
}

/** Written to ~/.sidenote/server.json so the hooks can find the running server. */
export interface ServerInfo {
  port: number;
  token: string;
  pid: number;
}

export const TOKEN_HEADER = "X-Review-Token";
