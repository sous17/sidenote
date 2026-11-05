// Which folders have a browser window open, so a new session joins that window's list instead of
// opening another tab. The server can't see tabs, only their polls. Only the page names a folder in
// its poll; the terminal app and the CLI don't, so they never count as a window.
import { systemClock, type Clock } from "../node/clock.ts";

/** Browsers slow a hidden tab's timers to about one a minute, and it still counts as open. */
export const WINDOW_SEEN_MS = 2 * 60 * 1000;

export class OpenWindows {
  readonly #lastSeen = new Map<string, number>();
  readonly #clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
  }

  seen(folder: string): void {
    const now = this.#clock.monotonicMs();
    // Folders come from the request: dropping the stale ones keeps this from growing.
    for (const [known, at] of this.#lastSeen) {
      if (now - at >= WINDOW_SEEN_MS) this.#lastSeen.delete(known);
    }
    this.#lastSeen.set(folder, now);
  }

  isOpen(folder: string): boolean {
    const at = this.#lastSeen.get(folder);
    return at !== undefined && this.#clock.monotonicMs() - at < WINDOW_SEEN_MS;
  }
}
