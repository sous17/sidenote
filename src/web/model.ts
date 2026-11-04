// The page's state: the latest snapshot from the server, the open thread, and questions about them.
import type { Note, SendStatus, StateSnapshot, StoredResponse, UserMessage } from "../shared/types.ts";

export type AnsweredNote = Note & { answered_by: number };

export class Model {
  readonly sessionId: string;
  snapshot: StateSnapshot = { version: -1, session: null, responses: [], comments: [], messages: [] };
  /** The root note whose thread is open in the pane, if any. */
  openThreadId: number | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
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

  /** Whether the user's latest message has no reply yet and Claude is on it, or about to be. */
  awaitingReply(): boolean {
    const latest = this.messages.at(-1);
    if (!latest || this.sendStatus().status === "offline") return false;
    if ((this.responses.at(-1)?.created_at ?? 0) > latest.created_at) return false;
    return this.sendStatus().status === "busy" || latest.delivered_at === null;
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
