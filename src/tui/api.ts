// The terminal window's side of the API. It reads the token from ~/.sidenote/server.json like
// the hooks do, so it needs no launch code. sidenote restarts with a new port and token, so a
// request that can't connect looks the server up again before it gives up.
import { ApiError, SidenoteClient } from "../cli/client.ts";
import type {
  ConversationMessageRequest,
  ConversationView,
  NewNoteRequest,
  PermissionAnswerRequest,
  RegisterSessionRequest,
  SessionListResult,
  SessionSummary,
  StartConversationRequest,
  StartConversationResult,
  StateSnapshot,
} from "../shared/types.ts";
import type { ChatApi, TuiApi } from "./app.ts";

/** Longer than the server holds a long poll (LONG_POLL_MS in src/server/http.ts). */
const LONG_POLL_TIMEOUT_MS = 35_000;

export class ClientApi implements TuiApi, ChatApi {
  #client: SidenoteClient | null;
  /** The folder of the session this window runs, to start it again after a server restart. */
  #chatCwd = "";

  readonly #startServer: boolean;

  /** startServer: start the server again when it is gone, as sidenote chat needs it to run the session. */
  constructor(client: SidenoteClient | null, options: { startServer?: boolean } = {}) {
    this.#client = client;
    this.#startServer = options.startServer ?? false;
  }

  /** Starts a session sidenote runs in cwd, or continues sessionId; resolves with its id. */
  async startConversation(cwd: string, sessionId?: string): Promise<string> {
    this.#chatCwd = cwd;
    // The folder is recorded first: what starts a process takes a session id, never a path.
    const folder: RegisterSessionRequest = sessionId ? { cwd, session_id: sessionId } : { cwd };
    const { session_id } = await this.#call((client) =>
      client.post<StartConversationResult>("/api/sessions/register", folder),
    );
    const request: StartConversationRequest = { session_id, resume: sessionId !== undefined };
    await this.#call((client) => client.post<StartConversationResult>("/api/conversations", request));
    return session_id;
  }

  async conversation(knownVersion: number, sessionId: string, wait: boolean): Promise<ConversationView | null> {
    const path = (version: number): string =>
      `/api/conversation?v=${version}&s=${encodeURIComponent(sessionId)}${wait ? "&wait=1" : ""}`;
    let version = knownVersion;
    return this.#hosted(sessionId, (client) => {
      const request = client.get<ConversationView | null>(path(version), LONG_POLL_TIMEOUT_MS);
      version = -1; // after a restart, the new server's versions start again
      return request;
    });
  }

  async message(sessionId: string, text: string): Promise<void> {
    const request: ConversationMessageRequest = { session_id: sessionId, text };
    await this.#hosted(sessionId, (client) => client.post("/api/conversation/messages", request));
  }

  async interrupt(sessionId: string): Promise<string[]> {
    const result = await this.#hosted(sessionId, (client) =>
      client.post<{ queued: string[] }>("/api/conversation/interrupt", { session_id: sessionId }),
    );
    return result.queued;
  }

  async answer(sessionId: string, requestId: string, decision: PermissionAnswerRequest["decision"]): Promise<void> {
    const request: PermissionAnswerRequest = { session_id: sessionId, request_id: requestId, decision };
    await this.#hosted(sessionId, (client) => client.post("/api/conversation/permission", request));
  }

  /** A request about the session this window runs. A restarted server doesn't run it yet: start it again. */
  async #hosted<T>(sessionId: string, request: (client: SidenoteClient) => Promise<T>): Promise<T> {
    try {
      return await this.#call(request);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404 || !this.#chatCwd) throw error;
      await this.startConversation(this.#chatCwd, sessionId);
      return this.#call(request);
    }
  }

  async sessions(): Promise<SessionSummary[]> {
    return (await this.#call((client) => client.get<SessionListResult>("/api/sessions"))).sessions;
  }

  state(knownVersion: number, sessionId: string, wait = false): Promise<StateSnapshot | null> {
    const path = `/api/state?v=${knownVersion}&s=${encodeURIComponent(sessionId)}${wait ? "&wait=1" : ""}`;
    return this.#call((client) => client.get<StateSnapshot | null>(path, LONG_POLL_TIMEOUT_MS));
  }

  async addNote(note: NewNoteRequest): Promise<void> {
    await this.#call((client) => client.post("/api/comments", note));
  }

  async editNote(id: number, body: string): Promise<void> {
    await this.#call((client) => client.patch(`/api/comments/${id}`, { body }));
  }

  async deleteNote(id: number): Promise<void> {
    await this.#call((client) => client.delete(`/api/comments/${id}`));
  }

  async send(sessionId: string): Promise<void> {
    await this.#call((client) => client.post("/api/send", { session_ids: [sessionId] }));
  }

  async #call<T>(request: (client: SidenoteClient) => Promise<T>): Promise<T> {
    if (this.#client) {
      try {
        return await request(this.#client);
      } catch (error) {
        // The server answered: the request itself was refused, and asking again won't help.
        if (error instanceof ApiError) throw error;
      }
    }
    this.#client = this.#startServer ? (await SidenoteClient.ensure()).client : await SidenoteClient.connect();
    if (!this.#client) throw new Error("the sidenote server isn't running");
    return request(this.#client);
  }
}
