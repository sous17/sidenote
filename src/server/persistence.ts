// Reading and writing the store: one file per session in ~/.sidenote/sessions/, so forgetting a
// session is deleting its file and a change only rewrites the session it touched. The ids are shared
// by all sessions, so they keep a file of their own. Older versions kept everything in store.json.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SESSION_ID_PATTERN,
  type Note,
  type SessionMeta,
  type StoredResponse,
  type UserMessage,
} from "../shared/types.ts";

/** The store's contents in memory. Sessions are a Map, so no id can collide with Object keys. */
export interface StoreData {
  sessions: Map<string, SessionMeta>;
  responses: StoredResponse[];
  comments: Note[];
  messages: UserMessage[];
  nextId: number;
}

/** The contents of all sessions together. Sessions from older versions lack fields added since. */
interface StoreFile {
  sessions?: Record<string, Partial<SessionMeta>>;
  responses?: StoredResponse[];
  comments?: Note[];
  messages?: UserMessage[];
  next_id?: number;
}

/** One file in sessions/. A session's first prompt comes before it is known, so session can be null. */
interface SessionFile {
  session: Partial<SessionMeta> | null;
  responses: StoredResponse[];
  comments: Note[];
  messages: UserMessage[];
}

export function emptyStore(): StoreData {
  return { sessions: new Map(), responses: [], comments: [], messages: [], nextId: 1 };
}

/** Writes atomically: a crash mid-write leaves the previous file intact. */
function writeAtomically(file: string, contents: string): void {
  const temp = `${file}.tmp`;
  writeFileSync(temp, contents, { mode: 0o600 });
  renameSync(temp, file);
}

function parseSessionFile(contents: string): SessionFile | null {
  try {
    const file = JSON.parse(contents) as SessionFile | null;
    const complete = [file?.responses, file?.comments, file?.messages].every(Array.isArray);
    return complete ? file : null;
  } catch {
    return null;
  }
}

/** Each session's file contents, by session id. Sessions with nothing left to keep have none. */
function sessionFiles(data: StoreData): Map<string, string> {
  const files = new Map<string, SessionFile>();
  const fileOf = (sessionId: string): SessionFile => {
    const existing = files.get(sessionId);
    if (existing) return existing;
    const created: SessionFile = { session: null, responses: [], comments: [], messages: [] };
    files.set(sessionId, created);
    return created;
  };
  for (const [id, meta] of data.sessions) fileOf(id).session = meta;
  const sessionOf = new Map<number, string>();
  for (const response of data.responses) {
    sessionOf.set(response.id, response.session_id);
    fileOf(response.session_id).responses.push(response);
  }
  for (const note of data.comments) {
    const sessionId = sessionOf.get(note.response_id);
    if (sessionId !== undefined) fileOf(sessionId).comments.push(note);
  }
  for (const message of data.messages) fileOf(message.session_id).messages.push(message);
  return new Map([...files].map(([id, file]) => [id, JSON.stringify(file)]));
}

export class StoreFiles {
  readonly #sessionsDir: string;
  readonly #idsFile: string;
  readonly #legacyFile: string;
  /** What each session's file holds now, so saving writes only the ones that changed. */
  #written = new Map<string, string>();
  #writtenNextId = 0;

  constructor(dir: string) {
    this.#sessionsDir = join(dir, "sessions");
    this.#idsFile = join(dir, "ids.json");
    this.#legacyFile = join(dir, "store.json");
  }

  load(): StoreData {
    mkdirSync(this.#sessionsDir, { recursive: true, mode: 0o700 });
    // store.json only goes once every session has its file, so a crash here just repeats this.
    if (existsSync(this.#legacyFile)) {
      const data = migrate(JSON.parse(readFileSync(this.#legacyFile, "utf8")) as StoreFile);
      this.save(data);
      renameSync(this.#legacyFile, `${this.#legacyFile}.migrated`);
      return data;
    }
    const combined: Required<StoreFile> = {
      sessions: {},
      responses: [],
      comments: [],
      messages: [],
      next_id: this.#readNextId(),
    };
    for (const entry of readdirSync(this.#sessionsDir)) {
      const id = entry.endsWith(".json") ? entry.slice(0, -".json".length) : "";
      if (!SESSION_ID_PATTERN.test(id)) continue;
      const contents = readFileSync(join(this.#sessionsDir, entry), "utf8");
      const file = parseSessionFile(contents);
      if (!file) {
        // One damaged session shouldn't cost the others. Its file stays, for whoever looks.
        console.error(`skipping ${entry}: it isn't a session file`);
        continue;
      }
      this.#written.set(id, contents);
      if (file.session) combined.sessions[id] = file.session;
      combined.responses.push(...file.responses);
      combined.comments.push(...file.comments);
      combined.messages.push(...file.messages);
    }
    combined.responses.sort((a, b) => a.created_at - b.created_at);
    combined.comments.sort((a, b) => a.id - b.id);
    combined.messages.sort((a, b) => a.id - b.id);
    this.#writtenNextId = combined.next_id;
    return migrate(combined);
  }

  save(data: StoreData): void {
    // The ids go first: a crash then can only skip ids, never hand one out twice.
    if (data.nextId !== this.#writtenNextId) {
      writeAtomically(this.#idsFile, JSON.stringify({ next_id: data.nextId }));
      this.#writtenNextId = data.nextId;
    }
    const files = sessionFiles(data);
    for (const [id, contents] of files) {
      if (this.#written.get(id) === contents) continue;
      writeAtomically(join(this.#sessionsDir, `${id}.json`), contents);
      this.#written.set(id, contents);
    }
    for (const id of this.#written.keys()) {
      if (files.has(id)) continue;
      rmSync(join(this.#sessionsDir, `${id}.json`), { force: true });
      this.#written.delete(id);
    }
  }

  /** 1 when the file is missing or damaged: migrate then starts past the highest id it finds. */
  #readNextId(): number {
    try {
      return (JSON.parse(readFileSync(this.#idsFile, "utf8")) as { next_id?: number }).next_id ?? 1;
    } catch {
      return 1;
    }
  }
}

/** Brings a store from any earlier version up to date, dropping anything malformed. */
export function migrate(file: StoreFile): StoreData {
  const responses = (file.responses ?? []).filter((r) => SESSION_ID_PATTERN.test(r.session_id));
  // Replies before note threads had no note_answers. The turn fields (prompt, steps, ended)
  // are optional: replies from the hooks never have them, so older stores load as they are.
  for (const response of responses) response.note_answers ??= {};

  const responseIds = new Set(responses.map((r) => r.id));
  const comments = (file.comments ?? []).filter((c) => responseIds.has(c.response_id));
  for (const comment of comments) {
    comment.parent_id ??= null;
    // Notes delivered before answers were tracked: 0 means "answer unknown", not "awaiting one".
    if (comment.answered_by === undefined) comment.answered_by = comment.delivered_at === null ? null : 0;
  }

  const sessions = new Map<string, SessionMeta>();
  for (const [id, meta] of Object.entries(file.sessions ?? {})) {
    if (!SESSION_ID_PATTERN.test(id)) continue;
    // Stores from before names given in the window have no label.
    sessions.set(id, {
      name: meta.name ?? "",
      label: meta.label ?? "",
      cwd: meta.cwd ?? "",
      last_active: meta.last_active ?? 0,
      ...(meta.chat ? { chat: true } : {}),
    });
  }
  // Stores from before per-session windows have no session list: rebuild it from the replies.
  for (const response of responses) {
    const meta = sessions.get(response.session_id) ?? { name: "", label: "", cwd: response.cwd, last_active: 0 };
    meta.last_active = Math.max(meta.last_active, response.created_at);
    // Stores from before chat was marked: only sidenote chat keeps the prompt on a reply, and the
    // latest reply decides, because a session can move between chat and a terminal.
    if (response.prompt !== undefined) meta.chat = true;
    else delete meta.chat;
    sessions.set(response.session_id, meta);
  }

  // Stores from before the message box have no messages.
  const messages = (file.messages ?? []).filter((m) => SESSION_ID_PATTERN.test(m.session_id));

  const highestId = Math.max(
    0,
    ...responses.map((r) => r.id),
    ...comments.map((c) => c.id),
    ...messages.map((m) => m.id),
  );
  return { sessions, responses, comments, messages, nextId: Math.max(file.next_id ?? 1, highestId + 1) };
}
