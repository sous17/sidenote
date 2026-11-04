// The page's state: the latest snapshot from the server, the open thread, and questions about them.
import type { FolderSession, Note, SendStatus, StateSnapshot, StoredResponse, UserMessage } from "../shared/types.ts";

export type AnsweredNote = Note & { answered_by: number };

const EMPTY_SNAPSHOT: StateSnapshot = {
  version: -1,
  session: null,
  folder: "",
  sessions: [],
  responses: [],
  comments: [],
  messages: [],
};

export class Model {
  /** The selected session; "" until the server names the folder's latest. */
  sessionId: string;
  snapshot: StateSnapshot = EMPTY_SNAPSHOT;
  /** The root note whose thread is open in the pane, if any. */
  openThreadId: number | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** Switches to another of the folder's sessions; its state arrives with the next refresh. */
  select(sessionId: string): void {
    this.sessionId = sessionId;
    this.snapshot = { ...EMPTY_SNAPSHOT, folder: this.snapshot.folder, sessions: this.snapshot.sessions };
    this.openThreadId = null;
  }

  get notes(): readonly Note[] {
    return this.snapshot.comments;
  }

  get responses(): readonly StoredResponse[] {
    return this.snapshot.responses;
  }

  get messages(): readonly UserMessage[] {
    return this.snapshot.messages;
  }

  note(id: number | null | undefined): Note | undefined {
    return id == null ? undefined : this.notes.find((note) => note.id === id);
  }

  response(id: number | null | undefined): StoredResponse | undefined {
    return id == null ? undefined : this.responses.find((response) => response.id === id);
  }

  /** The note and its follow-ups, oldest first. */
  thread(rootId: number): Note[] {
    return this.notes
      .filter((note) => note.id === rootId || note.parent_id === rootId)
      .sort((a, b) => a.created_at - b.created_at);
  }

  /** What Claude wrote for this note under its marker, or "" if it didn't. */
  answerText(note: Note): string {
    if (!isAnswered(note)) return "";
    return this.response(note.answered_by)?.note_answers[String(note.id)] ?? "";
  }

  sendStatus(): SendStatus {
    return this.snapshot.session ?? { status: "offline", send_requested: false };
  }

  canSend(): boolean {
    return this.sendStatus().status !== "offline";
  }

  pendingCount(): number {
    return this.notes.filter((note) => note.delivered_at === null).length;
  }

  /** Whether the user's latest message or a sent note has no reply yet and Claude is on it, or about to be. */
  awaitingReply(): boolean {
    const { status } = this.sendStatus();
    if (status === "offline") return false;
    // Send now has no message: the turn it starts is only visible through its notes.
    if (status === "busy" && this.notes.some((note) => note.delivered_at !== null && note.answered_by === null)) {
      return true;
    }
    const latest = this.messages.at(-1);
    if (!latest) return false;
    if ((this.responses.at(-1)?.created_at ?? 0) > latest.created_at) return false;
    return this.sendStatus().status === "busy" || latest.delivered_at === null;
  }

  /** What Claude is doing while the user waits for its reply, or "". */
  activity(): string {
    return this.awaitingReply() ? (this.sendStatus().activity ?? "") : "";
  }

  /** What Claude has written so far in this turn, while the user waits for its reply. */
  progress(): readonly string[] {
    return this.awaitingReply() ? (this.sendStatus().progress ?? []) : [];
  }

  /** Unsent, but Send now was clicked: it goes as soon as the session can take it. */
  isQueued(note: Note): boolean {
    return note.delivered_at === null && this.sendStatus().send_requested;
  }
}

export function isAnswered(note: Note): note is AnsweredNote {
  return note.answered_by !== null && note.answered_by > 0;
}

/** Note ids a reply answered: those it wrote marked sections for, and those it was the next reply to. */
export function answeredNoteIds(model: Model, response: StoredResponse): Set<number> {
  const ids = new Set(Object.keys(response.note_answers).map(Number));
  for (const note of model.notes) if (note.answered_by === response.id) ids.add(note.id);
  return ids;
}

/** What a session is called: its /rename name, else its first message, else its short id. */
export function sessionLabel(session: Pick<FolderSession, "id" | "name" | "first_message">): string {
  return session.name || session.first_message || `Session ${session.id.slice(0, 8)}`;
}
