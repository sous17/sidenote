// Sessions sidenote runs itself. The host owns each session's agent process: it sends the
// user's messages with any pending notes attached, keeps the turn in progress for clients to
// stream, holds permission prompts until a client answers, and stores each finished turn as a
// reply, so notes, threads and the page work on it like on any other reply.
//
// Everything here is in memory. A restarted server has no processes; the next message starts
// one again and resumes the session.
import { liveProgress } from "./split.ts";
import { randomUUID } from "node:crypto";
import type { Agent, AgentDriver, AgentEvent, PermissionRequest, TurnEnd } from "../agent/driver.ts";
import { systemClock, type Clock } from "../node/clock.ts";
import { lexReply, replyBlocks } from "../shared/blocks.ts";
import { formatNotesForClaude } from "../shared/format.ts";
import { activityLine, toolDetail, toolSummary } from "../shared/tools.ts";
import type {
  AgentState,
  ConversationView,
  LivePart,
  LiveTurn,
  PermissionAnswerRequest,
  SendStatus,
  TurnStep,
} from "../shared/types.ts";
import { Revision, type Store } from "./store.ts";

/** Messages typed while the agent works wait in a queue of at most this many. */
export const MAX_QUEUED = 20;

export class HostError extends Error {}

/** The session isn't one this server runs: never opened, or opened before a restart. */
export class UnknownSession extends HostError {}

interface Hosted {
  id: string;
  cwd: string;
  driver: AgentDriver | null;
  /** Whether the agent knows this session already, so a new process resumes it. */
  known: boolean;
  state: AgentState;
  model: string;
  live: LiveTurn | null;
  /** The last part is text still streaming in. */
  streaming: boolean;
  /** "" stands for a Send now: only the pending notes. */
  queued: string[];
  /** Parallel tool calls can each ask at once. The first is shown; each needs its own answer. */
  permissions: PermissionRequest[];
  /** The notes that went with the turn in progress. */
  claimed: number[];
  context: { used: number | null; limit: number | null };
  error: string;
}

export class SessionHost {
  readonly revision = new Revision();
  readonly #store: Store;
  readonly #agent: Agent;
  readonly #clock: Clock;
  readonly #sessions = new Map<string, Hosted>();

  constructor(options: { store: Store; agent: Agent; clock?: Clock }) {
    this.#store = options.store;
    this.#agent = options.agent;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Starts hosting a session: a new one in cwd, or an earlier one to continue. Nothing runs until
   * the first message. Returns the session's id.
   */
  open(cwd: string, sessionId?: string, resume = sessionId !== undefined): string {
    const existing = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
    if (existing) return existing.id;
    const id = sessionId ?? randomUUID();
    const folder = (sessionId && this.#store.session(sessionId)?.cwd) || cwd;
    this.#sessions.set(id, {
      id,
      cwd: folder,
      driver: null,
      known: resume,
      state: "idle",
      model: "",
      live: null,
      streaming: false,
      queued: [],
      permissions: [],
      claimed: [],
      context: { used: null, limit: null },
      error: "",
    });
    this.#store.touchSession(id, "", folder);
    this.#changed();
    return id;
  }

  owns(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  view(sessionId: string): ConversationView | null {
    const session = this.#sessions.get(sessionId);
    if (!session) return null;
    const { used, limit } = session.context;
    const permission = session.permissions[0];
    return {
      version: this.revision.value,
      session_id: session.id,
      agent: this.#agent.name,
      model: session.model,
      state: session.state,
      live: session.live && { ...session.live, parts: session.live.parts.map((part) => ({ ...part })) },
      queued: [...session.queued],
      permission: permission
        ? {
            request_id: permission.request_id,
            tool: permission.tool_name,
            summary: toolSummary(permission.tool_name, permission.input, session.cwd),
            detail: toolDetail(permission.tool_name, permission.input, session.cwd),
          }
        : null,
      context: used !== null && limit ? { used, limit } : null,
      error: session.error,
    };
  }

  /** Send now's status for a hosted session: it can always take notes, at once or after the turn. */
  sendStatus(sessionId: string): SendStatus | null {
    const session = this.#sessions.get(sessionId);
    if (!session) return null;
    const busy = session.state === "working" || session.state === "waiting";
    const status: SendStatus = {
      status: busy ? "busy" : "listening",
      send_requested: session.queued.includes(""),
      hosted: true,
    };
    const messages = session.queued.filter((text) => text.trim());
    if (messages.length) status.queued_prompt = messages.join("\n\n");
    const parts = busy ? (session.live?.parts ?? []) : [];
    const progress = liveProgress(parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])));
    if (progress.length) status.progress = progress;
    const tool = parts.findLast((part) => part.kind === "tool");
    const activity = tool?.kind === "tool" ? activityLine(tool.tool, tool.summary) : "";
    if (activity) status.activity = activity;
    return status;
  }

  /** Sends a message, with the session's pending notes; while the agent works, it waits its turn. */
  message(sessionId: string, text: string): void {
    const session = this.#get(sessionId);
    if (!text.trim() && !this.#store.sessionsWithPendingNotes().has(sessionId)) {
      throw new HostError("nothing to send: write a message or a note first");
    }
    if (session.state === "working" || session.state === "waiting") {
      if (session.queued.length >= MAX_QUEUED) throw new HostError("too many messages are waiting already");
      session.queued.push(text);
      this.#changed();
      return;
    }
    this.#startTurn(session, text);
  }

  /** Send now: the pending notes go as a message of their own. */
  sendNotes(sessionId: string): boolean {
    if (!this.#store.sessionsWithPendingNotes().has(sessionId)) return false;
    const session = this.#get(sessionId);
    if (session.queued.includes("")) return true;
    this.message(sessionId, "");
    return true;
  }

  /** Stops the turn in progress. Queued messages are dropped and returned, to be edited again. */
  interrupt(sessionId: string): string[] {
    const session = this.#get(sessionId);
    const dropped = session.queued.filter((text) => text !== "");
    session.queued = [];
    if (session.driver && (session.state === "working" || session.state === "waiting")) {
      session.driver.interrupt();
      session.permissions = [];
    }
    this.#changed();
    return dropped;
  }

  /** Answers the permission prompt the session is waiting on. False if it no longer waits on it. */
  answer(sessionId: string, requestId: string, decision: PermissionAnswerRequest["decision"]): boolean {
    const session = this.#get(sessionId);
    const request = session.permissions[0];
    if (!request || request.request_id !== requestId || !session.driver) return false;
    session.driver.answer(request, decision);
    session.permissions.shift();
    if (!session.permissions.length) session.state = "working";
    this.#changed();
    return true;
  }

  /** Ends the session's agent process and lets go of it. False if this server doesn't run it. */
  end(sessionId: string): boolean {
    const session = this.#sessions.get(sessionId);
    if (!session) return false;
    // First, so the turn its process leaves unfinished isn't stored as if it had finished.
    this.#sessions.delete(sessionId);
    session.driver?.close();
    this.#changed();
    return true;
  }

  /** Whether an agent is in a turn: it needs this server, even with no client watching. */
  working(): boolean {
    return [...this.#sessions.values()].some((session) => session.state === "working");
  }

  /** Ends every agent process, when the server shuts down. */
  closeAll(): void {
    for (const session of this.#sessions.values()) session.driver?.close();
  }

  #get(sessionId: string): Hosted {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new UnknownSession("sidenote isn't running this session");
    return session;
  }

  #startTurn(session: Hosted, text: string): void {
    const notes = this.#store.claimPending(session.id);
    if (!text.trim() && !notes.length) return;
    const message = !notes.length
      ? text
      : text.trim()
        ? `${text}\n\n---\n\n${formatNotesForClaude(notes)}`
        : formatNotesForClaude(notes, { sendNow: true });
    if (!session.driver) {
      session.driver = this.#agent.start({ sessionId: session.id, cwd: session.cwd, resume: session.known }, (event) =>
        this.#event(session, event),
      );
      session.known = true;
    }
    session.live = { prompt: text, notes_sent: notes.length, started_at: this.#clock.now(), parts: [] };
    session.claimed = notes.map((note) => note.id);
    // Pages poll the store's revision, and a turn starting changes nothing in the store.
    this.#store.revision.bump();
    session.streaming = false;
    session.state = "working";
    session.error = "";
    session.driver.send(message);
    this.#changed();
  }

  #event(session: Hosted, event: AgentEvent): void {
    if (this.#sessions.get(session.id) !== session) return;
    const parts = session.live?.parts;
    const last = parts?.at(-1);
    switch (event.type) {
      case "ready":
        session.model = event.model;
        break;
      case "text_delta":
        if (!parts) return;
        if (session.streaming && last?.kind === "text") last.text += event.text;
        else parts.push({ kind: "text", text: event.text });
        session.streaming = true;
        break;
      case "text":
        if (!parts) return;
        if (session.streaming && last?.kind === "text") last.text = event.text;
        else parts.push({ kind: "text", text: event.text });
        session.streaming = false;
        break;
      case "tool_use":
        if (!parts) return;
        session.streaming = false;
        parts.push({
          kind: "tool",
          id: event.id,
          tool: event.name,
          summary: toolSummary(event.name, event.input, session.cwd),
          failed: null,
        });
        break;
      case "tool_result": {
        const call = parts?.find((part) => part.kind === "tool" && part.id === event.id);
        if (call?.kind === "tool") call.failed = event.failed;
        break;
      }
      case "permission":
        session.permissions.push(event.request);
        session.state = "waiting";
        break;
      case "permission_cancelled":
        session.permissions = session.permissions.filter((request) => request.request_id !== event.request_id);
        if (!session.permissions.length && session.state === "waiting") session.state = "working";
        break;
      case "usage":
        if (event.context_tokens !== null) session.context.used = event.context_tokens;
        if (event.context_window !== null) session.context.limit = event.context_window;
        break;
      case "turn_end":
        this.#finishTurn(session, event.end);
        break;
      case "exit":
        session.driver = null;
        session.queued = [];
        this.#finishTurn(session, { outcome: "error", error: event.message, cost_usd: null });
        session.state = "stopped";
        session.error = event.message;
        break;
    }
    this.#changed();
  }

  /** Stores the turn as a reply, then sends the next queued message. */
  #finishTurn(session: Hosted, end: TurnEnd): void {
    const turn = session.live;
    session.live = null;
    session.streaming = false;
    session.permissions = [];
    session.state = "idle";
    if (end.outcome === "error") session.error = end.error;
    const claimed = session.claimed;
    session.claimed = [];
    if (turn) {
      const { text, steps } = replyOf(turn.parts);
      // A turn that ended before the agent did anything never dealt with its notes: they go again.
      const unread = end.outcome !== "done" && !turn.parts.length;
      if (unread) this.#store.returnNotes(claimed);
      this.#store.addResponse({
        sessionId: session.id,
        cwd: session.cwd,
        text,
        sessionName: "",
        createdAt: undefined,
        turn: {
          prompt: turn.prompt,
          notesSent: unread ? 0 : turn.notes_sent,
          steps,
          ...(end.outcome === "done" ? {} : { ended: end.outcome }),
          ...(end.outcome === "error" ? { error: end.error } : {}),
        },
      });
    }
    const next = session.queued.shift();
    if (next !== undefined && session.driver) this.#startTurn(session, next);
  }

  #changed(): void {
    this.revision.bump();
  }
}

/** A turn's text as one reply, and its tool calls placed after the block they followed. */
export function replyOf(parts: readonly LivePart[]): { text: string; steps: TurnStep[] } {
  const texts: string[] = [];
  const steps: TurnStep[] = [];
  for (const part of parts) {
    if (part.kind === "text") {
      if (part.text.trim()) texts.push(part.text.trim());
      continue;
    }
    const blocks = texts.length ? replyBlocks(lexReply(texts.join("\n\n"))).length : 0;
    steps.push({ tool: part.tool, summary: part.summary, after_block: blocks - 1, failed: part.failed === true });
  }
  return { text: texts.join("\n\n"), steps };
}
