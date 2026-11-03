import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_CONTEXT_CHARS, formatNotesForClaude } from "../src/shared/format.ts";
import type { ClaimedNote } from "../src/shared/types.ts";

function claimed(overrides: Partial<ClaimedNote> = {}): ClaimedNote {
  return {
    id: 41,
    response_id: 1,
    block_index: 0,
    quote: "line one\nline two",
    body: "Why?",
    parent_id: null,
    created_at: 0,
    delivered_at: 0,
    answered_by: null,
    response_created_at: new Date(2026, 10, 2, 14, 5).getTime() / 1000,
    root_body: null,
    ...overrides,
  };
}

test("asks for one marker per note, using a real note id in the example", () => {
  const text = formatNotesForClaude([claimed(), claimed({ id: 43, parent_id: 41, root_body: "Why?", body: "And?" })]);
  assert.match(text, /answer the user's message as usual/);
  assert.match(text, /\*\*↳ Re: note 41\*\*\nYour answer to note 41\./);
  assert.match(text, /Note 41, on your response from 14:05:\n> line one\n> line two\nWhy\?/);
  assert.match(
    text,
    /Note 43, a follow-up in the thread on your response from 14:05:[\s\S]*Their earlier note: Why\?\nFollow-up: And\?/,
  );
});

test("Send now asks Claude to skip the main answer", () => {
  const text = formatNotesForClaude([claimed()], { sendNow: true });
  assert.match(text, /clicked Send now/);
  assert.match(text, /skip any main answer/);
});

test("notes on the whole reply say so, and long context is truncated", () => {
  assert.match(formatNotesForClaude([claimed({ quote: "" })]), /> \(whole response\)/);
  const long = formatNotesForClaude([claimed({ body: "x".repeat(20_000) })]);
  assert.ok(long.length < MAX_CONTEXT_CHARS + 100);
  assert.match(long, /\[truncated/);
});

test("nothing to say about no notes", () => {
  assert.equal(formatNotesForClaude([]), "");
});
