import type { EpochSeconds } from "../shared/types.ts";

/** Time sources, injectable so tests control them. */
export interface Clock {
  /** Wall clock, for timestamps people see. */
  now(): EpochSeconds;
  /** Monotonic milliseconds, for timeouts and liveness. */
  monotonicMs(): number;
}

export const systemClock: Clock = {
  now: () => Date.now() / 1000,
  monotonicMs: () => performance.now(),
};
