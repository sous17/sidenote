// The page's side of the API, plus how it gets its token.
import {
  LAUNCH_FRAGMENT_KEY,
  TOKEN_HEADER,
  type ErrorResult,
  type NewNoteRequest,
  type Note,
  type PromptResult,
  type RedeemResult,
  type SendResult,
  type StateSnapshot,
} from "../shared/types.ts";

const TOKEN_STORAGE_KEY = "sidenote-token";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, token: string | null, body?: object): Promise<T | null> {
  const response = await fetch(path, {
    method,
    headers: { ...(token ? { [TOKEN_HEADER]: token } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response
      .json()
      .then((json: Partial<ErrorResult>) => json.error)
      .catch(() => undefined);
    throw new ApiError(response.status, detail ?? `${method} ${path} failed with ${response.status}`);
  }
  return response.status === 204 ? null : ((await response.json()) as T);
}

/**
 * The API token for this tab. A newly opened window carries a single-use launch code in its URL
 * fragment; it is traded for the token once, the fragment is removed, and the token is kept in
 * sessionStorage, which belongs to this tab and this origin only. A reload finds it there.
 */
export async function obtainToken(): Promise<string | null> {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const code = fragment.get(LAUNCH_FRAGMENT_KEY);
  if (code) {
    history.replaceState(null, "", location.pathname + location.search);
    // A spent or expired code falls back to the token this tab may already hold.
    const result = await request<RedeemResult>("POST", "/api/launch/redeem", null, { code }).catch(() => null);
    if (result) {
      writeToken(result.token);
      return result.token;
    }
  }
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Storage blocked: this page load still works, a reload will need /sidenote:open.
  }
}

export class Api {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  /** The window's state, or null when nothing changed since knownVersion. */
  state(knownVersion: number, sessionId: string, folder: string): Promise<StateSnapshot | null> {
    const query = new URLSearchParams({ v: String(knownVersion), s: sessionId });
    if (folder) query.set("f", folder);
    return request("GET", `/api/state?${query}`, this.#token);
  }

  addNote(note: NewNoteRequest): Promise<Note | null> {
    return request("POST", "/api/comments", this.#token, note);
  }

  deleteNote(id: number): Promise<null> {
    return request("DELETE", `/api/comments/${id}`, this.#token);
  }

  /** Sends a message to the session's Claude, as if it were typed in the terminal. */
  prompt(sessionId: string, text: string): Promise<PromptResult | null> {
    return request("POST", "/api/prompt", this.#token, { session_id: sessionId, text });
  }

  /** Opens the session's folder on the desktop. */
  openFolder(sessionId: string): Promise<null> {
    return request("POST", "/api/open-folder", this.#token, { session_id: sessionId });
  }

  send(sessionId: string): Promise<SendResult | null> {
    return request("POST", "/api/send", this.#token, { session_ids: [sessionId] });
  }
}
