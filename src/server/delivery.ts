// Send now: lets the page wake a session's Claude through that session's background waiter.
//
// After each turn, Claude Code starts `sidenote hook-wait` in the background (asyncRewake). It
// registers as the session's waiter and polls. Send now, or a message typed in the page, marks the
// session; the waiter's next poll claims the notes and message, prints them and exits 2, which
// wakes Claude. Everything here is in memory: a restarted server simply has no waiters until each
// session's next turn ends. Notes and messages themselves live in the store, so they survive.
import { systemClock, type Clock } from "../node/clock.ts";
import {
  MAX_PROMPT_CHARS,
  type ProgressRequest,
  type SendStatus,
  type SessionState,
  type WaiterPollResult,
} from "../shared/types.ts";
import { liveProgress } from "./split.ts";
import type { Store } from "./store.ts";

/** A session counts as listening while its waiter polls at least this often. */
export const LISTENER_STALE_MS = 5000;
/** Enough of a turn for the page, which shows only the last of it. */
const MAX_TRACKED_MESSAGES = 40;
const MAX_TRACKED_BATCHES = 2000;

interface Waiter {
  id: string;
  seenMs: number;
}

export class Delivery {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #waiters = new Map<string, Waiter>();
  /** Sessions where Claude is mid-turn. */
  readonly #busy = new Set<string>();
  /** Sessions whose notes go out at the waiter's next poll. */
  readonly #requested = new Set<string>();
  /** The latest tool call of each busy session. Only the page's status line needs it. */
  readonly #activity = new Map<string, string>();
  /** Each busy session's messages this turn, by message id, as batches by index. */
  readonly #progress = new Map<string, Map<string, string[]>>();
  #statusSignature = "";

  constructor(store: Store, clock: Clock = systemClock) {
    this.#store = store;
    this.#clock = clock;
  }

  status(sessionId: string): SendStatus {
    const status: SendStatus = { status: this.#state(sessionId), send_requested: this.#requested.has(sessionId) };
    const waiting = this.#store.waitingMessageText(sessionId);
    if (waiting) status.queued_prompt = waiting;
    const activity = this.#activity.get(sessionId);
    if (activity) status.activity = activity;
    const messages = this.#progress.get(sessionId);
    const progress = messages ? liveProgress([...messages.values()].map((batches) => batches.join(""))) : [];
    if (progress.length) status.progress = progress;
    return status;
  }

  /** Bumps the store's revision when a waiter went quiet, so pages see the session stop listening. */
  refresh(): void {
    const signature = JSON.stringify(this.#store.listSessions().map((s) => [s.id, this.status(s.id)]));
    if (signature === this.#statusSignature) return;
    this.#statusSignature = signature;
    this.#store.revision.bump();
  }

  /** A new waiter starts when Claude finishes a turn; it replaces any older one. */
  registerWaiter(sessionId: string, waiterId: string): void {
    this.#waiters.set(sessionId, { id: waiterId, seenMs: this.#clock.monotonicMs() });
    this.#busy.delete(sessionId);
    this.#forgetTurn(sessionId);
  }

  /** Hooks run in the background, so one can land after its turn ended: only a busy session counts. */
  setActivity(sessionId: string, text: string): void {
    if (this.#state(sessionId) !== "busy") return;
    this.#activity.set(sessionId, text);
    this.#store.revision.bump();
  }

  /** Part of a message Claude is writing. Like an activity line, it can land after its turn. */
  addProgress({ session_id: sessionId, message_id: messageId, index, delta }: ProgressRequest): void {
    if (this.#state(sessionId) !== "busy" || index >= MAX_TRACKED_BATCHES) return;
    const messages = this.#progress.get(sessionId) ?? new Map<string, string[]>();
    this.#progress.set(sessionId, messages);
    const batches = messages.get(messageId) ?? [];
    messages.set(messageId, batches);
    batches[index] = delta;
    if (messages.size > MAX_TRACKED_MESSAGES) messages.delete(messages.keys().next().value!);
    this.#store.revision.bump();
  }

  pollWaiter(sessionId: string, waiterId: string): WaiterPollResult {
    const waiter = this.#waiters.get(sessionId);
    if (waiter?.id !== waiterId) return { action: "exit", comments: [] };
    waiter.seenMs = this.#clock.monotonicMs();
    if (!this.#requested.has(sessionId)) return { action: "wait", comments: [] };

    this.#requested.delete(sessionId);
    this.#waiters.delete(sessionId);
    this.#busy.add(sessionId);
    this.#forgetTurn(sessionId);
    const comments = this.#store.claimPending(sessionId);
    const prompt = this.#store.claimMessages(sessionId);
    if (prompt === undefined) return comments.length ? { action: "send", comments } : { action: "exit", comments: [] };
    return { action: "send", comments, prompt };
  }

  /**
   * Queues a message typed in the page: it wakes a listening session at the waiter's next poll, or
   * goes as soon as a busy session's turn ends. Messages sent while one waits join it.
   */
  requestPrompt(sessionId: string, text: string): "sent" | "queued" | "offline" | "too-long" {
    const state = this.#state(sessionId);
    if (state === "offline") return "offline";
    const waiting = this.#store.waitingMessageText(sessionId);
    if ((waiting ? `${waiting}\n\n${text}` : text).length > MAX_PROMPT_CHARS) return "too-long";
    this.#store.addMessage(sessionId, text, "page");
    this.#requested.add(sessionId);
    return state === "listening" ? "sent" : "queued";
  }

  /** The user sent a prompt in the terminal: the waiter stands down and the prompt carries the notes. */
  markBusy(sessionId: string): void {
    this.#waiters.delete(sessionId);
    this.#busy.add(sessionId);
    this.#requested.delete(sessionId);
    this.#forgetTurn(sessionId);
  }

  /** Queues these sessions' pending notes to go now, or as soon as a busy session's turn ends. */
  requestSend(sessionIds: readonly string[]): string[] {
    const pending = this.#store.sessionsWithPendingNotes();
    const targets = [...new Set(sessionIds)].filter((id) => pending.has(id)).sort();
    for (const id of targets) this.#requested.add(id);
    if (targets.length) this.#store.revision.bump();
    return targets;
  }

  /** The session's Claude is gone, so nothing may wake it: its waiter exits at its next poll. */
  forgetSession(sessionId: string): void {
    this.#waiters.delete(sessionId);
    this.#busy.delete(sessionId);
    this.#requested.delete(sessionId);
    this.#forgetTurn(sessionId);
  }

  #forgetTurn(sessionId: string): void {
    this.#activity.delete(sessionId);
    this.#progress.delete(sessionId);
  }

  #state(sessionId: string): SessionState {
    const waiter = this.#waiters.get(sessionId);
    if (waiter && this.#clock.monotonicMs() - waiter.seenMs < LISTENER_STALE_MS) return "listening";
    return this.#busy.has(sessionId) ? "busy" : "offline";
  }
}
