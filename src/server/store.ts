// Sessions, replies and notes, with retention limits. Send now coordination lives in delivery.ts.
import { systemClock, type Clock } from "../node/clock.ts";
import { folderName } from "../shared/folders.ts";
import type {
  ClaimedNote,
  EpochSeconds,
  Note,
  SessionMeta,
  SessionSummary,
  FolderSession,
  StoredResponse,
  TurnStep,
  UserMessage,
} from "../shared/types.ts";
import { StoreFiles, emptyStore, type StoreData } from "./persistence.ts";
import type { ParsedNote } from "./requests.ts";
import { splitNoteAnswers } from "./split.ts";

/** Replies kept per session; older ones, and notes on them, are dropped. */
export const MAX_RESPONSES_PER_SESSION = 100;
/** A session with no activity for this long is forgotten, with its replies and notes. */
export const SESSION_RETENTION_SECONDS = 7 * 24 * 60 * 60;
/** Enough of a session's first message to recognize the session by in its tab. */
const FIRST_MESSAGE_CHARS = 80;

/** A counter clients poll with, so unchanged state costs one 204. */
export class Revision {
  #value = 0;
  readonly #waiting = new Set<() => void>();
  get value(): number {
    return this.#value;
  }
  bump(): void {
    this.#value += 1;
    for (const wake of [...this.#waiting]) wake();
  }
  /** Resolves when the value moves past `known`, or after timeoutMs: a long poll's wait. */
  async waitPast(known: number, timeoutMs: number): Promise<void> {
    if (this.#value !== known) return;
    await new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.#waiting.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, timeoutMs);
      this.#waiting.add(wake);
    });
  }
}

export interface NewReply {
  sessionId: string;
  cwd: string;
  text: string;
  sessionName: string;
  /** Only for backfilled replies; live replies are stamped now. */
  createdAt: EpochSeconds | undefined;
  /** For turns sidenote ran itself. */
  turn?: {
    prompt: string;
    notesSent: number;
    steps: TurnStep[];
    ended?: "interrupted" | "error";
    error?: string;
  };
}

export class Store {
  readonly revision = new Revision();
  readonly #data: StoreData;
  readonly #files: StoreFiles | undefined;
  readonly #clock: Clock;

  /** Without a directory, the store lives in memory only (tests). */
  readonly #awaitingFirstReply = new Set<string>();

  constructor(options: { dir?: string; clock?: Clock } = {}) {
    this.#files = options.dir === undefined ? undefined : new StoreFiles(options.dir);
    this.#clock = options.clock ?? systemClock;
    this.#data = this.#files?.load() ?? emptyStore();
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

  /** The sessions that ran in a folder, most recently active first, with what their rows show. */
  folderSessions(folder: string): Omit<FolderSession, "status" | "process">[] {
    const pending = this.#pendingNotesPerSession();
    return this.listSessions()
      .filter((session) => !session.chat && folderName(session.cwd) === folder)
      .map((session) => ({
        ...session,
        first_message: this.#firstMessage(session.id).replace(/\s+/g, " ").trim().slice(0, FIRST_MESSAGE_CHARS),
        pending_notes: pending.get(session.id) ?? 0,
      }));
  }

  /** One session's replies and messages, oldest first, and the notes on the replies. */
  sessionContent(sessionId: string): { responses: StoredResponse[]; comments: Note[]; messages: UserMessage[] } {
    const responses = this.#data.responses.filter((r) => r.session_id === sessionId);
    const ids = new Set(responses.map((r) => r.id));
    return {
      responses,
      comments: this.#data.comments.filter((c) => ids.has(c.response_id)),
      messages: this.#data.messages.filter((m) => m.session_id === sessionId),
    };
  }

  /** Messages from the page that haven't reached Claude yet, joined as Claude will get them, or "". */
  waitingMessageText(sessionId: string): string {
    return this.#waitingMessages(sessionId)
      .map((m) => m.text)
      .join("\n\n");
  }

  /** Whether the session holds notes or messages that never reached Claude. */
  hasUnsent(sessionId: string): boolean {
    return this.#pendingNotesPerSession().has(sessionId) || this.#waitingMessages(sessionId).length > 0;
  }

  /** Sessions with notes that haven't been sent to Claude yet. */
  sessionsWithPendingNotes(): Set<string> {
    return new Set(this.#pendingNotesPerSession().keys());
  }

  // ---- Writing ---------------------------------------------------------------------------

  /** Remembers a session before its first reply, e.g. when /sidenote:on opens its window. */
  touchSession(sessionId: string, name: string, cwd: string): void {
    this.#upsertSession(sessionId, { name, cwd, activeAt: this.#clock.now() });
    this.#changed();
  }

  /**
   * Learns a new session's folder from its first prompt, so its row shows before the first reply.
   * That reply still counts as the session's first. Kept in memory only: a server that restarts in
   * between opens the window anyway.
   */
  promptSession(sessionId: string, cwd: string): void {
    const meta = this.#data.sessions.get(sessionId);
    if (meta?.cwd) return;
    if (!meta) this.#awaitingFirstReply.add(sessionId);
    this.#upsertSession(sessionId, { name: "", cwd, activeAt: this.#clock.now() });
    this.#changed();
  }

  /** Marks a session sidenote chat runs, which folder windows leave out. */
  markChat(sessionId: string): void {
    const meta = this.#data.sessions.get(sessionId);
    if (!meta || meta.chat) return;
    meta.chat = true;
    this.#changed();
  }

  /** Names a session in the window; "" removes the name. Returns false for an unknown session. */
  renameSession(sessionId: string, label: string): boolean {
    const meta = this.#data.sessions.get(sessionId);
    if (!meta) return false;
    meta.label = label;
    this.#changed();
    return true;
  }

  /** Forgets a session with its replies, notes and messages. Claude's own transcript stays. */
  forgetSession(sessionId: string): boolean {
    const data = this.#data;
    this.#awaitingFirstReply.delete(sessionId);
    // A session's first prompt comes before the first reply that makes the session known.
    const known = data.sessions.delete(sessionId) || data.messages.some((m) => m.session_id === sessionId);
    if (!known) return false;
    const dropped = new Set(data.responses.filter((r) => r.session_id === sessionId).map((r) => r.id));
    data.responses = data.responses.filter((r) => !dropped.has(r.id));
    data.comments = data.comments.filter((c) => !dropped.has(c.response_id));
    data.messages = data.messages.filter((m) => m.session_id !== sessionId);
    this.#changed();
    return true;
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
    if (reply.turn) {
      response.prompt = reply.turn.prompt;
      response.notes_sent = reply.turn.notesSent;
      response.steps = reply.turn.steps;
      if (reply.turn.ended) response.ended = reply.turn.ended;
      if (reply.turn.error) response.error = reply.turn.error;
    }
    const newSession = this.#awaitingFirstReply.delete(reply.sessionId) || !this.#data.sessions.has(reply.sessionId);
    this.#upsertSession(reply.sessionId, { name: reply.sessionName, cwd: reply.cwd, activeAt: response.created_at });
    // A reply from the hooks means the session went back to a terminal, so its window can show it.
    if (!reply.turn) delete this.#data.sessions.get(reply.sessionId)!.chat;
    // Backfilled replies are history: they never answer notes.
    // A turn that didn't finish answered nothing: its notes stay open for the next reply.
    if (reply.createdAt === undefined && !reply.turn?.ended) this.#takeAnswers(response);
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

  /** Rewrites an unsent note in place, keeping its anchor, id and follow-ups. */
  editPendingNote(noteId: number, body: string): boolean {
    const note = this.#data.comments.find((c) => c.id === noteId);
    if (!note || note.delivered_at !== null) return false;
    note.body = body;
    this.#changed();
    return true;
  }

  /** The session a note belongs to, or null if there is no such note. */
  noteSession(noteId: number): string | null {
    const note = this.#data.comments.find((c) => c.id === noteId);
    return (note && this.#sessionOfResponse().get(note.response_id)) ?? null;
  }

  /**
   * Records a message the user sent. A message from the page waits until claimMessages hands it
   * to Claude; one typed in the terminal has already reached Claude.
   */
  addMessage(sessionId: string, text: string, source: UserMessage["source"]): UserMessage {
    const now = this.#clock.now();
    const message: UserMessage = {
      id: this.#newId(),
      session_id: sessionId,
      text,
      source,
      created_at: now,
      delivered_at: source === "terminal" ? now : null,
    };
    this.#data.messages.push(message);
    this.#changed();
    return message;
  }

  /** Marks this session's waiting page messages delivered and returns their text joined, or undefined. */
  claimMessages(sessionId: string): string | undefined {
    const waiting = this.#waitingMessages(sessionId);
    if (!waiting.length) return undefined;
    const now = this.#clock.now();
    for (const message of waiting) message.delivered_at = now;
    this.#changed();
    return waiting.map((m) => m.text).join("\n\n");
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

  /** Makes claimed notes pending again, when the turn they went with ended before reading them. */
  returnNotes(noteIds: readonly number[]): void {
    const ids = new Set(noteIds);
    const notes = this.#data.comments.filter((note) => ids.has(note.id));
    for (const note of notes) note.delivered_at = null;
    if (notes.length) this.#changed();
  }

  // ---- Internals -------------------------------------------------------------------------

  #waitingMessages(sessionId: string): UserMessage[] {
    return this.#data.messages.filter((m) => m.session_id === sessionId && m.delivered_at === null);
  }

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

  #upsertSession(sessionId: string, update: { name: string; cwd: string; activeAt: EpochSeconds }): void {
    const meta: SessionMeta = this.#data.sessions.get(sessionId) ?? {
      name: "",
      label: "",
      cwd: update.cwd,
      last_active: 0,
    };
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
    const before = data.responses.length + data.sessions.size + data.messages.length;
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
    // Messages follow the same limits. A session's first prompt comes before the first reply that
    // makes the session known, so an unknown session's message is only dropped once it is old.
    const keptMessages: UserMessage[] = [];
    const messagesPerSession = new Map<string, number>();
    for (const message of [...data.messages].reverse()) {
      if (!data.sessions.has(message.session_id) && message.created_at < cutoff) continue;
      const count = (messagesPerSession.get(message.session_id) ?? 0) + 1;
      messagesPerSession.set(message.session_id, count);
      if (count <= MAX_RESPONSES_PER_SESSION) keptMessages.push(message);
    }
    data.messages = keptMessages.reverse();
    return data.responses.length + data.sessions.size + data.messages.length !== before;
  }

  /** A session sidenote runs keeps what the user typed on each reply, not as a message of its own. */
  #firstMessage(sessionId: string): string {
    const message = this.#data.messages.find((m) => m.session_id === sessionId);
    if (message) return message.text;
    return this.#data.responses.find((r) => r.session_id === sessionId && r.prompt?.trim())?.prompt ?? "";
  }

  #pendingNotesPerSession(): Map<string, number> {
    const sessionOf = this.#sessionOfResponse();
    const pending = new Map<string, number>();
    for (const note of this.#data.comments) {
      const sessionId = sessionOf.get(note.response_id);
      if (note.delivered_at === null && sessionId !== undefined)
        pending.set(sessionId, (pending.get(sessionId) ?? 0) + 1);
    }
    return pending;
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
    this.#files?.save(this.#data);
  }
}
