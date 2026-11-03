// The terminal window's side of the API. It reads the token from ~/.sidenote/server.json like
// the hooks do, so it needs no launch code. sidenote restarts with a new port and token, so a
// request that can't connect looks the server up again before it gives up.
import { ApiError, SidenoteClient } from "../cli/client.ts";
import type { NewNoteRequest, SessionListResult, SessionSummary, StateSnapshot } from "../shared/types.ts";
import type { TuiApi } from "./app.ts";

export class ClientApi implements TuiApi {
  #client: SidenoteClient | null;

  constructor(client: SidenoteClient | null) {
    this.#client = client;
  }

  async sessions(): Promise<SessionSummary[]> {
    return (await this.#call((client) => client.get<SessionListResult>("/api/sessions"))).sessions;
  }

  state(knownVersion: number, sessionId: string): Promise<StateSnapshot | null> {
    return this.#call((client) =>
      client.get<StateSnapshot | null>(`/api/state?v=${knownVersion}&s=${encodeURIComponent(sessionId)}`),
    );
  }

  async addNote(note: NewNoteRequest): Promise<void> {
    await this.#call((client) => client.post("/api/comments", note));
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
    this.#client = await SidenoteClient.connect();
    if (!this.#client) throw new Error("the sidenote server isn't running");
    return request(this.#client);
  }
}
