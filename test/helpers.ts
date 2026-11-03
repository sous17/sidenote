// Shared test fixtures.
import type { Clock } from "../src/node/clock.ts";
import { Delivery } from "../src/server/delivery.ts";
import { Store, type NewReply } from "../src/server/store.ts";
import type { Note } from "../src/shared/types.ts";

export const SESSION = "session-a";
export const DAY = 24 * 60 * 60;

/** A clock tests move by hand. */
export class FakeClock implements Clock {
  seconds = 1_000_000;
  ms = 0;
  now(): number {
    return this.seconds + this.ms / 1000;
  }
  monotonicMs(): number {
    return this.ms;
  }
  advanceMs(ms: number): void {
    this.ms += ms;
  }
  advanceDays(days: number): void {
    this.seconds += days * DAY;
  }
}

export function fixture(): { clock: FakeClock; store: Store; delivery: Delivery } {
  const clock = new FakeClock();
  const store = new Store({ clock });
  return { clock, store, delivery: new Delivery(store, clock) };
}

export function reply(store: Store, text: string, overrides: Partial<NewReply> = {}) {
  return store.addResponse({
    sessionId: SESSION,
    agent: "claude",
    cwd: "/w/shop-api",
    text,
    sessionName: "",
    createdAt: undefined,
    ...overrides,
  }).response;
}

export function noteOn(store: Store, responseId: number, body = "a note"): Note {
  const note = store.addNote({ kind: "root", responseId, blockIndex: 0, quote: "quoted", body });
  if (!note) throw new Error("note was not added");
  return note;
}
