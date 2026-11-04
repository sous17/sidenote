// Reading and writing ~/.sidenote/store.json, including stores written by older versions.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

/** The JSON layout on disk. */
interface StoreFile {
  sessions?: Record<string, SessionMeta>;
  responses?: StoredResponse[];
  comments?: Note[];
  messages?: UserMessage[];
  next_id?: number;
}

export function emptyStore(): StoreData {
  return { sessions: new Map(), responses: [], comments: [], messages: [], nextId: 1 };
}

export function loadStore(file: string): StoreData {
  if (!existsSync(file)) return emptyStore();
  return migrate(JSON.parse(readFileSync(file, "utf8")) as StoreFile);
}

/** Writes atomically: a crash mid-write leaves the previous store intact. */
export function saveStore(file: string, data: StoreData): void {
  const contents: Required<StoreFile> = {
    sessions: Object.fromEntries(data.sessions),
    responses: data.responses,
    comments: data.comments,
    messages: data.messages,
    next_id: data.nextId,
  };
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(contents), { mode: 0o600 });
  renameSync(temp, file);
}

/** Brings a store from any earlier version up to date, dropping anything malformed. */
export function migrate(file: StoreFile): StoreData {
  const responses = (file.responses ?? []).filter((r) => SESSION_ID_PATTERN.test(r.session_id));
  // Replies before note threads had no note_answers.
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
    sessions.set(id, { name: meta.name ?? "", cwd: meta.cwd ?? "", last_active: meta.last_active ?? 0 });
  }
  // Stores from before per-session windows have no session list: rebuild it from the replies.
  for (const response of responses) {
    const meta = sessions.get(response.session_id) ?? { name: "", cwd: response.cwd, last_active: 0 };
    meta.last_active = Math.max(meta.last_active, response.created_at);
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
