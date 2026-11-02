import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
  ClaimedNote,
  EpochSeconds,
  Note,
  SessionMeta,
  SessionState,
  SessionView,
  StateSnapshot,
  StoredResponse,
  WaiterPollResult,
} from "../shared/types.ts";
import { splitNoteAnswers } from "./split.ts";

/** Replies kept per session; older ones (and notes on them) are dropped. */
export const MAX_RESPONSES_PER_SESSION = 100;
/** A session with no new reply for this long is forgotten, with its replies and notes. */
export const SESSION_RETENTION_SECONDS = 7 * 24 * 60 * 60;
/** A session counts as listening while its waiter (the hook-wait hook) polls at least this often. */
export const LISTENER_STALE_MS = 5000;

interface StoreFile {
  sessions: Record<string, SessionMeta>;
  responses: StoredResponse[];
  comments: Note[];
  next_id: number;
}

export interface StoreOptions {
  /** Where to persist; omit for an in-memory store (tests). */
  file?: string;
  /** Wall clock in epoch seconds. */
  now?: () => EpochSeconds;
  /** Monotonic clock in milliseconds, for waiter liveness. */
  monotonicMs?: () => number;
}

interface Waiter {
  id: string;
  seenMs: number;
}

export class Store {
  version = 0;
  private sessions: Record<string, SessionMeta>;
  private responses: StoredResponse[];
  private comments: Note[];
  private nextId: number;
  private readonly file: string | undefined;
  private readonly now: () => EpochSeconds;
  private readonly monotonicMs: () => number;

  // Live-only state for Send now: the current waiter per session, sessions that are
  // mid-turn, and sessions with a send waiting to go out.
  private readonly waiters = new Map<string, Waiter>();
  private readonly busy = new Set<string>();
  private readonly sendRequested = new Set<string>();
  private statusSignature = "";

  constructor(options: StoreOptions = {}) {
    this.file = options.file;
    this.now = options.now ?? (() => Date.now() / 1000);
    this.monotonicMs = options.monotonicMs ?? (() => performance.now());
    const data: Partial<StoreFile> =
      this.file && existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
    this.sessions = data.sessions ?? {};
    this.responses = data.responses ?? [];
    this.comments = data.comments ?? [];
    this.nextId = data.next_id ?? 1;
    // Older stores: replies had no note_answers, and notes delivered before answers were
    // tracked get 0 ("answer unknown") rather than null ("awaiting one").
    for (const response of this.responses) response.note_answers ??= {};
    for (const comment of this.comments) {
      if (comment.answered_by === undefined) comment.answered_by = comment.delivered_at ? 0 : null;
      comment.parent_id ??= null;
    }
    // Stores from before per-session pages have no session list: rebuild it from the replies.
    for (const response of this.responses) {
      const meta = (this.sessions[response.session_id] ??= { name: "", cwd: response.cwd, last_active: 0 });
      meta.last_active = Math.max(meta.last_active, response.created_at);
    }
    if (this.prune()) this.persist();
  }

  /** One session's replies and notes, as its page shows them. */
  snapshot(sessionId: string | null): StateSnapshot {
    const meta = sessionId === null ? undefined : this.sessions[sessionId];
    if (sessionId === null || !meta) return { version: this.version, session: null, responses: [], comments: [] };
    const responses = this.responses.filter((r) => r.session_id === sessionId);
    const ids = new Set(responses.map((r) => r.id));
    return {
      version: this.version,
      session: { id: sessionId, ...meta, ...this.sendStatus(sessionId) },
      responses,
      comments: this.comments.filter((c) => ids.has(c.response_id)),
    };
  }

  /** Known sessions, most recently active first. */
  listSessions(): Array<SessionMeta & { id: string }> {
    return Object.entries(this.sessions)
      .map(([id, meta]) => ({ id, ...meta }))
      .sort((a, b) => b.last_active - a.last_active);
  }

  /** Remembers a session before its first reply, e.g. when /sidenote:on opens its window. */
  touchSession(sessionId: string, name: string, cwd: string): void {
    const meta = (this.sessions[sessionId] ??= { name: "", cwd, last_active: 0 });
    if (name) meta.name = name;
    meta.cwd = cwd || meta.cwd;
    meta.last_active = Math.max(meta.last_active, this.now());
    this.changed();
  }

  addResponse(input: {
    sessionId: string;
    cwd: string;
    text: string;
    /** Only for backfilled replies; live replies are stamped now. */
    createdAt?: EpochSeconds;
    sessionName?: string;
  }): { response: StoredResponse; newSession: boolean } {
    const { sessionId, cwd, text, createdAt, sessionName } = input;
    const response: StoredResponse = {
      id: this.newId(),
      session_id: sessionId,
      cwd,
      text,
      created_at: createdAt ?? this.now(),
      note_answers: {},
    };
    const newSession = !this.sessions[sessionId];
    const meta = (this.sessions[sessionId] ??= { name: "", cwd, last_active: 0 });
    meta.cwd = cwd || meta.cwd;
    if (sessionName) meta.name = sessionName;
    meta.last_active = Math.max(meta.last_active, response.created_at);
    // Backfilled replies are history: they never answer notes.
    if (createdAt === undefined) this.linkAnswer(response);
    this.responses.push(response);
    this.responses.sort((a, b) => a.created_at - b.created_at);
    this.prune();
    this.changed();
    return { response, newSession };
  }

  /** Adds a note on a reply, or a follow-up in an existing thread. Returns null for unknown targets. */
  addComment(
    target: { responseId: number; blockIndex: number; quote: string } | { parentId: number },
    body: string,
  ): Note | null {
    let anchor: { responseId: number; blockIndex: number; quote: string; parentId: number | null };
    if ("parentId" in target) {
      // A follow-up joins its root note's thread, so it inherits that note's anchor.
      const parent = this.comments.find((c) => c.id === target.parentId);
      if (!parent) return null;
      anchor = {
        responseId: parent.response_id,
        blockIndex: parent.block_index,
        quote: parent.quote,
        parentId: parent.parent_id ?? parent.id,
      };
    } else {
      anchor = { ...target, parentId: null };
    }
    if (!this.responses.some((r) => r.id === anchor.responseId)) return null;
    const comment: Note = {
      id: this.newId(),
      response_id: anchor.responseId,
      block_index: anchor.blockIndex,
      quote: anchor.quote,
      body,
      parent_id: anchor.parentId,
      created_at: this.now(),
      delivered_at: null,
      answered_by: null,
    };
    this.comments.push(comment);
    this.changed();
    return comment;
  }

  /** Deletes an undelivered note, together with its follow-ups if none of them were sent. */
  deletePendingComment(commentId: number): boolean {
    const doomed = this.comments.filter((c) => c.id === commentId || c.parent_id === commentId);
    if (!doomed.some((c) => c.id === commentId) || doomed.some((c) => c.delivered_at !== null)) return false;
    this.comments = this.comments.filter((c) => !doomed.includes(c));
    this.changed();
    return true;
  }

  /** Returns this session's undelivered notes and marks them delivered. */
  claimPending(sessionId: string): ClaimedNote[] {
    const responsesById = new Map(
      this.responses.filter((r) => r.session_id === sessionId).map((r) => [r.id, r]),
    );
    const commentsById = new Map(this.comments.map((c) => [c.id, c]));
    const claimed: ClaimedNote[] = [];
    const now = this.now();
    for (const comment of this.comments) {
      const response = responsesById.get(comment.response_id);
      if (!response || comment.delivered_at !== null) continue;
      comment.delivered_at = now;
      comment.answered_by = null;
      const root = comment.parent_id === null ? undefined : commentsById.get(comment.parent_id);
      claimed.push({ ...comment, response_created_at: response.created_at, root_body: root?.body ?? null });
    }
    if (claimed.length) this.changed();
    return claimed;
  }

  // ---- Send now ----------------------------------------------------------------

  /** Bumps the version when a waiter went quiet, so pages see the session stop listening. */
  refreshStatus(): void {
    const signature = JSON.stringify(Object.keys(this.sessions).map((id) => this.sendStatus(id)));
    if (signature !== this.statusSignature) {
      this.statusSignature = signature;
      this.version += 1;
    }
  }

  /** A new waiter starts when Claude finishes a turn; it replaces any older one. */
  registerWaiter(sessionId: string, waiterId: string): void {
    this.waiters.set(sessionId, { id: waiterId, seenMs: this.monotonicMs() });
    this.busy.delete(sessionId);
  }

  pollWaiter(sessionId: string, waiterId: string): WaiterPollResult {
    const waiter = this.waiters.get(sessionId);
    if (!waiter || waiter.id !== waiterId) return { action: "exit", comments: [] };
    waiter.seenMs = this.monotonicMs();
    if (!this.sendRequested.has(sessionId)) return { action: "wait", comments: [] };
    this.sendRequested.delete(sessionId);
    this.waiters.delete(sessionId);
    this.busy.add(sessionId);
    const comments = this.claimPending(sessionId);
    return comments.length ? { action: "send", comments } : { action: "exit", comments: [] };
  }

  /** The user sent a prompt in the terminal: the waiter stands down until the turn ends. */
  markBusy(sessionId: string): void {
    this.waiters.delete(sessionId);
    this.busy.add(sessionId);
    this.sendRequested.delete(sessionId);
  }

  /** Queues pending notes to go out now, or as soon as a busy session's turn ends. */
  requestSend(sessionIds?: readonly string[]): string[] {
    const sessionOf = new Map(this.responses.map((r) => [r.id, r.session_id]));
    const pendingSessions = new Set(
      this.comments.filter((c) => c.delivered_at === null).map((c) => sessionOf.get(c.response_id)!),
    );
    const targets = sessionIds ? sessionIds.filter((s) => pendingSessions.has(s)) : [...pendingSessions];
    for (const sessionId of targets) this.sendRequested.add(sessionId);
    this.version += 1;
    return [...new Set(targets)].sort();
  }

  private sendStatus(sessionId: string): { status: SessionState; send_requested: boolean } {
    const waiter = this.waiters.get(sessionId);
    const status: SessionState =
      waiter && this.monotonicMs() - waiter.seenMs < LISTENER_STALE_MS
        ? "listening"
        : this.busy.has(sessionId)
          ? "busy"
          : "offline";
    return { status, send_requested: this.sendRequested.has(sessionId) };
  }

  // ---- Internals -----------------------------------------------------------------

  /**
   * Marks a live reply as Claude's answer to the notes its session was last sent, and moves
   * the sections it wrote for each note out of the main text into note_answers.
   */
  private linkAnswer(response: StoredResponse): void {
    const sessionResponseIds = new Set(
      this.responses.filter((r) => r.session_id === response.session_id).map((r) => r.id),
    );
    const awaiting = this.comments.filter(
      (c) => sessionResponseIds.has(c.response_id) && c.delivered_at !== null && c.answered_by === null,
    );
    if (!awaiting.length) return;
    for (const comment of awaiting) comment.answered_by = response.id;
    const { mainText, answers } = splitNoteAnswers(response.text, new Set(awaiting.map((c) => c.id)));
    if (answers.size) {
      response.text = mainText;
      response.note_answers = Object.fromEntries([...answers].map(([id, body]) => [String(id), body]));
    }
  }

  /**
   * Forgets sessions idle longer than SESSION_RETENTION_SECONDS and keeps each session's newest
   * MAX_RESPONSES_PER_SESSION replies, dropping notes on whatever goes. Returns whether anything did.
   */
  private prune(): boolean {
    const cutoff = this.now() - SESSION_RETENTION_SECONDS;
    const before = this.responses.length + Object.keys(this.sessions).length;
    for (const [sessionId, meta] of Object.entries(this.sessions)) {
      if (meta.last_active < cutoff) delete this.sessions[sessionId];
    }
    const perSession = new Map<string, number>();
    const kept: StoredResponse[] = [];
    // Newest first, so the count keeps the latest replies of each session.
    for (const response of [...this.responses].reverse()) {
      if (!this.sessions[response.session_id]) continue;
      const count = (perSession.get(response.session_id) ?? 0) + 1;
      perSession.set(response.session_id, count);
      if (count <= MAX_RESPONSES_PER_SESSION) kept.push(response);
    }
    this.responses = kept.reverse();
    const keptIds = new Set(this.responses.map((r) => r.id));
    this.comments = this.comments.filter((c) => keptIds.has(c.response_id));
    return this.responses.length + Object.keys(this.sessions).length !== before;
  }

  private newId(): number {
    return this.nextId++;
  }

  private changed(): void {
    this.version += 1;
    this.persist();
  }

  private persist(): void {
    if (!this.file) return;
    const data: StoreFile = {
      sessions: this.sessions,
      responses: this.responses,
      comments: this.comments,
      next_id: this.nextId,
    };
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
