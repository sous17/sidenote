// Single-use launch codes, so the API token never appears in a page URL.
//
// To open a window, the CLI asks for a code and opens `/<folder>?s=<session>#launch=<code>`. The
// fragment is never sent over the network; the page trades the code for the token once and keeps
// the token in the origin's localStorage. Browser history, synced history and `ps` only ever see a
// spent code.
import { randomBytes } from "node:crypto";
import { systemClock, type Clock } from "../node/clock.ts";

export const LAUNCH_CODE_TTL_MS = 2 * 60 * 1000;
/** Old codes are dropped beyond this many, so nothing grows without bound. */
const MAX_LIVE_CODES = 32;

export class LaunchCodes {
  readonly #issued = new Map<string, number>();
  readonly #clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
  }

  issue(): string {
    this.#expire();
    const code = randomBytes(24).toString("base64url");
    this.#issued.set(code, this.#clock.monotonicMs() + LAUNCH_CODE_TTL_MS);
    while (this.#issued.size > MAX_LIVE_CODES) this.#issued.delete(this.#issued.keys().next().value!);
    return code;
  }

  /** True once per issued code, within its lifetime. */
  redeem(code: string): boolean {
    this.#expire();
    return this.#issued.delete(code);
  }

  #expire(): void {
    const now = this.#clock.monotonicMs();
    for (const [code, expiresAt] of this.#issued) {
      if (expiresAt <= now) this.#issued.delete(code);
    }
  }
}
