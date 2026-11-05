// Keeps a running server honest. Each tick it gives up if another server owns the lock, puts
// server.json back if something removed it, and stops when nothing has used it for a while, so a
// server never outlives the sessions and windows it served.
//
// Idleness is counted in ticks, not time: timers stop while a laptop sleeps, so waking it never
// finds the server idle before its open windows had a chance to poll.

export const WATCH_INTERVAL_MS = 5000;
export const IDLE_MINUTES = 30;
const IDLE_TICKS = (IDLE_MINUTES * 60_000) / WATCH_INTERVAL_MS;

export interface WatchChecks {
  /** Whether this server still owns the lock. */
  holdsLock(): boolean;
  /** Whether server.json names this server. */
  isRegistered(): boolean;
  register(): void;
  /** Whether an agent this server runs is in a turn, which stopping the server would cut short. */
  working(): boolean;
}

export class ServerWatch {
  readonly #checks: WatchChecks;
  #idleTicks = 0;

  constructor(checks: WatchChecks) {
    this.#checks = checks;
  }

  /** A client used the API: a session's waiter, a hook or an open window. */
  active(): void {
    this.#idleTicks = 0;
  }

  /** Why the server should stop now, or null to keep running. */
  tick(): string | null {
    if (!this.#checks.holdsLock()) return "another server holds the lock";
    if (!this.#checks.isRegistered()) this.#checks.register();
    this.#idleTicks = this.#checks.working() ? 0 : this.#idleTicks + 1;
    return this.#idleTicks >= IDLE_TICKS ? `nothing used it for ${IDLE_MINUTES} minutes` : null;
  }
}
