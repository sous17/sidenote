// Shared test fixtures.
import type { Agent, AgentDriver, AgentEvent, PermissionDecision, StartOptions } from "../src/agent/driver.ts";
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

/** An agent the test speaks for: it records what the host does and emits events on request. */
export class FakeAgent implements Agent {
  readonly name = "Fake Agent";
  readonly starts: StartOptions[] = [];
  readonly sent: string[] = [];
  readonly answers: Array<[string, PermissionDecision]> = [];
  interrupts = 0;
  closed = 0;
  emit: (event: AgentEvent) => void = () => {
    throw new Error("not started");
  };

  start(options: StartOptions, onEvent: (event: AgentEvent) => void): AgentDriver {
    this.starts.push(options);
    this.emit = onEvent;
    return {
      send: (text) => this.sent.push(text),
      interrupt: () => (this.interrupts += 1),
      answer: (request, decision) => this.answers.push([request.request_id, decision]),
      close: () => (this.closed += 1),
    };
  }

  /** A whole turn: some streamed text, then the finished reply. */
  reply(text: string): void {
    this.emit({ type: "ready", session_id: "", model: "fake-model" });
    this.emit({ type: "text_delta", text: text.slice(0, 3) });
    this.emit({ type: "text", text });
    this.emit({ type: "turn_end", end: { outcome: "done", error: "", cost_usd: 0 } });
  }
}
