// Send now: getting notes to a session's agent when the user asks, not only with their next prompt.
//
// Two ways, depending on what the agent's hooks allow:
// - Wake (Claude Code): after each turn, a background hook (asyncRewake) registers as the
//   session's waiter and polls. Send now marks the session; the waiter's next poll claims the
//   notes, prints them and exits 2, which wakes Claude even when it is idle.
// - At turn end (Codex, Cursor, Copilot): their stop hooks can make the agent continue with a
//   message. A send requested while the agent is working goes out when that turn ends. These
//   agents can't be woken from idle, so an idle session's notes wait for the next prompt.
//
// Everything here is in memory: a restarted server has no waiters or busy sessions until each
// session's next turn.
import { systemClock, type Clock } from "../node/clock.ts";
import type { ClaimedNote, SendStatus, SessionState, WaiterPollResult } from "../shared/types.ts";
import type { Store } from "./store.ts";

/** A session counts as listening while its waiter polls at least this often. */
export const LISTENER_STALE_MS = 5000;

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
  #statusSignature = "";

  constructor(store: Store, clock: Clock = systemClock) {
    this.#store = store;
    this.#clock = clock;
  }

  status(sessionId: string): SendStatus {
    return { status: this.#state(sessionId), send_requested: this.#requested.has(sessionId) };
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
  }

  pollWaiter(sessionId: string, waiterId: string): WaiterPollResult {
    const waiter = this.#waiters.get(sessionId);
    if (waiter?.id !== waiterId) return { action: "exit", comments: [] };
    waiter.seenMs = this.#clock.monotonicMs();
    if (!this.#requested.has(sessionId)) return { action: "wait", comments: [] };

    this.#requested.delete(sessionId);
    this.#waiters.delete(sessionId);
    this.#busy.add(sessionId);
    const comments = this.#store.claimPending(sessionId);
    return comments.length ? { action: "send", comments } : { action: "exit", comments: [] };
  }

  /** The user sent a prompt in the terminal: the waiter stands down and the prompt carries the notes. */
  markBusy(sessionId: string): void {
    this.#waiters.delete(sessionId);
    this.#busy.add(sessionId);
    this.#requested.delete(sessionId);
  }

  /**
   * The user sent a prompt to an agent that can't take notes with it (Cursor, Copilot): the
   * session is busy, and its unsent notes go out when this turn ends.
   */
  startTurn(sessionId: string): void {
    this.markBusy(sessionId);
    if (this.#store.sessionsWithPendingNotes().has(sessionId)) this.#requested.add(sessionId);
  }

  /**
   * An agent without a waiter finished a turn: the session is no longer busy, and notes queued
   * with Send now, or by startTurn, go out now, for the agent to answer in a follow-up turn.
   */
  endTurn(sessionId: string): ClaimedNote[] {
    const wasBusy = this.#busy.delete(sessionId);
    if (!this.#requested.delete(sessionId)) {
      if (wasBusy) this.#store.revision.bump();
      return [];
    }
    const claimed = this.#store.claimPending(sessionId);
    if (claimed.length)
      this.#busy.add(sessionId); // the agent goes straight on to answer them
    else this.#store.revision.bump();
    return claimed;
  }

  /** Queues these sessions' pending notes to go now, or as soon as a busy session's turn ends. */
  requestSend(sessionIds: readonly string[]): string[] {
    const pending = this.#store.sessionsWithPendingNotes();
    const targets = [...new Set(sessionIds)].filter((id) => pending.has(id)).sort();
    for (const id of targets) this.#requested.add(id);
    if (targets.length) this.#store.revision.bump();
    return targets;
  }

  #state(sessionId: string): SessionState {
    const waiter = this.#waiters.get(sessionId);
    if (waiter && this.#clock.monotonicMs() - waiter.seenMs < LISTENER_STALE_MS) return "listening";
    return this.#busy.has(sessionId) ? "busy" : "offline";
  }
}
