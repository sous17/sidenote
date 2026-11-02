import {
  TOKEN_HEADER,
  type NewNoteRequest,
  type Note,
  type SendRequest,
  type SendResult,
  type StateSnapshot,
} from "../shared/types.ts";

const token = new URLSearchParams(location.search).get("t") ?? "";

async function request<T>(method: string, path: string, payload?: unknown): Promise<T | null> {
  const response = await fetch(path, {
    method,
    headers: { [TOKEN_HEADER]: token, "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!response.ok) throw new ApiError(response.status, `${method} ${path} failed with ${response.status}`);
  return response.status === 204 ? null : ((await response.json()) as T);
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const api = {
  /** The new state, or null when it has not changed since knownVersion. */
  state: (knownVersion: number, sessionId: string | null) =>
    request<StateSnapshot>("GET", `/api/state?v=${knownVersion}&s=${encodeURIComponent(sessionId ?? "")}`),
  addNote: (note: NewNoteRequest) => request<Note>("POST", "/api/comments", note),
  deleteNote: (id: number) => request<null>("DELETE", `/api/comments/${id}`),
  send: (body: SendRequest) => request<SendResult>("POST", "/api/send", body),
};
