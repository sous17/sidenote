// Sessions, replies and notes, with retention limits. Send now coordination lives in delivery.ts.
import { systemClock, type Clock } from "../node/clock.ts";
import type {
  AgentId,
  ClaimedNote,
  EpochSeconds,
  Note,
  SessionMeta,
  SessionSummary,
  StoredResponse,
} from "../shared/types.ts";
import { emptyStore, loadStore, saveStore, type StoreData } from "./persistence.ts";
import type { ParsedNote } from "./requests.ts";
import { splitNoteAnswers } from "./split.ts";

/** Replies kept per session; older ones, and notes on them, are dropped. */
export const MAX_RESPONSES_PER_SESSION = 100;
/** A session with no activity for this long is forgotten, with its replies and notes. */
export const SESSION_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/** A counter pages poll with, so unchanged state costs one 204. */
export class Revision {
  #value = 0;
  get value(): number {
    return this.#value;
  }
  bump(): void {
    this.#value += 1;
  }
}

export interface NewReply {
  sessionId: string;
  agent: AgentId;
  cwd: string;
  text: string;
  sessionName: string;
  /** Only for backfilled replies; live replies are stamped now. */
  createdAt: EpochSeconds | undefined;
}

export class Store {
  readonly revision = new Revision();
  readonly #data: StoreData;
  readonly #file: string | undefined;
  readonly #clock: Clock;

  /** Without a file, the store lives in memory only (tests). */
  constructor(options: { file?: string; clock?: Clock } = {}) {
    this.#file = options.file;
    this.#clock = options.clock ?? systemClock;
    this.#data = this.#file ? loadStore(this.#file) : emptyStore();
    if (this.#prune()) this.#persist();
  }

  // ---- Reading ---------------------------------------------------------------------------

  session(sessionId: string): SessionSummary | undefined {
    const meta = this.#data.sessions.get(sessionId);
    return meta && { id: sessionId, ...meta };
  }

  /** Known sessions, most recently active first. */
  listSessions(): SessionSummary[] {
    return [...this.#data.sessions]
      .map(([id, meta]) => ({ id, ...meta }))
      .sort((a, b) => b.last_active - a.last_active);
  }

  /** One session's replies, oldest first, and the notes on them. */
  sessionContent(sessionId: string): { responses: StoredResponse[]; comments: Note[] } {
    const responses = this.#data.responses.filter((r) => r.session_id === sessionId);
    const ids = new Set(responses.map((r) => r.id));
    return { responses, comments: this.#data.comments.filter((c) => ids.has(c.response_id)) };
  }

  /** Sessions with notes that haven't been sent to Claude yet. */
  sessionsWithPendingNotes(): Set<string> {
    const sessionOf = this.#sessionOfResponse();
    const pending = new Set<string>();
    for (const note of this.#data.comments) {
      const sessionId = sessionOf.get(note.response_id);
      if (note.delivered_at === null && sessionId !== undefined) pending.add(sessionId);
    }
    return pending;
  }

  // ---- Writing ---------------------------------------------------------------------------

  /** Remembers a session before its first reply, e.g. when /sidenote:on opens its window. */
  touchSession(sessionId: string, update: { agent: AgentId; name: string; cwd: string }): void {
    this.#upsertSession(sessionId, { ...update, activeAt: this.#clock.now() });
    this.#changed();
  }

  addResponse(reply: NewReply): { response: StoredResponse; newSession: boolean } {
    const response: StoredResponse = {
      id: this.#newId(),
      session_id: reply.sessionId,
      cwd: reply.cwd,
      text: reply.text,
      created_at: reply.createdAt ?? this.#clock.now(),
      note_answers: {},
    };
    const newSession = !this.#data.sessions.has(reply.sessionId);
    this.#upsertSession(reply.sessionId, {
      agent: reply.agent,
      name: reply.sessionName,
      cwd: reply.cwd,
      activeAt: response.created_at,
    });
    // Backfilled replies are history: they never answer notes.
    if (reply.createdAt === undefined) this.#takeAnswers(response);
    this.#data.responses.push(response);
    this.#data.responses.sort((a, b) => a.created_at - b.created_at);
    this.#prune();
    this.#changed();
    return { response, newSession };
  }

  /** Adds a note on a reply, or a follow-up in a thread. Returns null when the target is unknown. */
  addNote(note: ParsedNote): Note | null {
    const anchor = this.#anchorFor(note);
    if (!anchor) return null;
    const created: Note = {
      id: this.#newId(),
      ...anchor,
      body: note.body,
      created_at: this.#clock.now(),
      delivered_at: null,
      answered_by: null,
    };
    this.#data.comments.push(created);
    this.#changed();
    return created;
  }

  /** Deletes an unsent note, with its follow-ups, unless any of them was already sent. */
  deletePendingNote(noteId: number): boolean {
    const doomed = this.#data.comments.filter((c) => c.id === noteId || c.parent_id === noteId);
    if (!doomed.some((c) => c.id === noteId) || doomed.some((c) => c.delivered_at !== null)) return false;
    const doomedIds = new Set(doomed.map((c) => c.id));
    this.#data.comments = this.#data.comments.filter((c) => !doomedIds.has(c.id));
    this.#changed();
    return true;
  }

  /** Marks this session's unsent notes delivered and returns them, described for Claude. */
  claimPending(sessionId: string): ClaimedNote[] {
    const responses = new Map(
      this.#data.responses.filter((r) => r.session_id === sessionId).map((r) => [r.id, r] as const),
    );
    const notes = new Map(this.#data.comments.map((c) => [c.id, c] as const));
    const now = this.#clock.now();
    const claimed: ClaimedNote[] = [];
    for (const note of this.#data.comments) {
      const response = responses.get(note.response_id);
      if (!response || note.delivered_at !== null) continue;
      note.delivered_at = now;
      note.answered_by = null;
      const root = note.parent_id === null ? undefined : notes.get(note.parent_id);
      claimed.push({ ...note, response_created_at: response.created_at, root_body: root?.body ?? null });
    }
    if (claimed.length) this.#changed();
    return claimed;
  }

  // ---- Internals -------------------------------------------------------------------------

  #anchorFor(note: ParsedNote): Pick<Note, "response_id" | "block_index" | "quote" | "parent_id"> | null {
    if (note.kind === "follow-up") {
      // A follow-up joins its root note's thread, so it inherits that note's anchor.
      const parent = this.#data.comments.find((c) => c.id === note.parentId);
      if (!parent) return null;
      return {
        response_id: parent.response_id,
        block_index: parent.block_index,
        quote: parent.quote,
        parent_id: parent.parent_id ?? parent.id,
      };
    }
    if (!this.#data.responses.some((r) => r.id === note.responseId)) return null;
    return { response_id: note.responseId, block_index: note.blockIndex, quote: note.quote, parent_id: null };
  }

  #upsertSession(
    sessionId: string,
    update: { agent: AgentId; name: string; cwd: string; activeAt: EpochSeconds },
  ): void {
    const meta: SessionMeta = this.#data.sessions.get(sessionId) ?? {
      agent: update.agent,
      name: "",
      cwd: update.cwd,
      last_active: 0,
    };
    meta.agent = update.agent;
    if (update.name) meta.name = update.name;
    if (update.cwd) meta.cwd = update.cwd;
    meta.last_active = Math.max(meta.last_active, update.activeAt);
    this.#data.sessions.set(sessionId, meta);
  }

  /**
   * Marks a live reply as Claude's answer to the notes its session was last sent, and moves the
   * sections it wrote for each note out of the main text into note_answers.
   */
  #takeAnswers(response: StoredResponse): void {
    const sessionOf = this.#sessionOfResponse();
    const awaiting = this.#data.comments.filter(
      (c) => sessionOf.get(c.response_id) === response.session_id && c.delivered_at !== null && c.answered_by === null,
    );
    if (!awaiting.length) return;
    for (const note of awaiting) note.answered_by = response.id;
    const { mainText, answers } = splitNoteAnswers(response.text, new Set(awaiting.map((c) => c.id)));
    if (answers.size) {
      response.text = mainText;
      response.note_answers = Object.fromEntries([...answers].map(([id, body]) => [String(id), body]));
    }
  }

  /** Applies the retention limits. Returns whether anything was dropped. */
  #prune(): boolean {
    const data = this.#data;
    const before = data.responses.length + data.sessions.size;
    const cutoff = this.#clock.now() - SESSION_RETENTION_SECONDS;
    for (const [sessionId, meta] of data.sessions) {
      if (meta.last_active < cutoff) data.sessions.delete(sessionId);
    }
    // Walk newest first, so each session keeps its latest replies.
    const kept: StoredResponse[] = [];
    const perSession = new Map<string, number>();
    for (const response of [...data.responses].reverse()) {
      if (!data.sessions.has(response.session_id)) continue;
      const count = (perSession.get(response.session_id) ?? 0) + 1;
      perSession.set(response.session_id, count);
      if (count <= MAX_RESPONSES_PER_SESSION) kept.push(response);
    }
    data.responses = kept.reverse();
    const keptIds = new Set(data.responses.map((r) => r.id));
    data.comments = data.comments.filter((c) => keptIds.has(c.response_id));
    return data.responses.length + data.sessions.size !== before;
  }

  #sessionOfResponse(): Map<number, string> {
    return new Map(this.#data.responses.map((r) => [r.id, r.session_id] as const));
  }

  #newId(): number {
    return this.#data.nextId++;
  }

  #changed(): void {
    this.revision.bump();
    this.#persist();
  }

  #persist(): void {
    if (this.#file) saveStore(this.#file, this.#data);
  }
}
