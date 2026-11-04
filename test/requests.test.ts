import assert from "node:assert/strict";
import { test } from "node:test";
import { LaunchCodes, LAUNCH_CODE_TTL_MS } from "../src/server/launch.ts";
import {
  BadRequest,
  LIMITS,
  parseNewNote,
  parseNewResponse,
  parsePrompt,
  parseSend,
  parseWaiter,
} from "../src/server/requests.ts";
import { FakeClock } from "./helpers.ts";

test("bodies must be JSON objects", () => {
  for (const body of [[], [1], "text", 7, null]) assert.throws(() => parseSend(body), BadRequest);
});

test("session ids must look like ids", () => {
  for (const id of ["__proto__", "", "../x", "a b", "x".repeat(129)]) {
    assert.throws(() => parseNewResponse({ session_id: id, text: "hi" }), BadRequest, id);
  }
  assert.equal(parseNewResponse({ session_id: "7f3a9c21-4be0", text: "hi" }).session_id, "7f3a9c21-4be0");
  assert.throws(() => parseSend({ session_ids: ["ok", "__proto__"] }), BadRequest);
  assert.throws(() => parseSend({}), BadRequest, "sending needs explicit sessions");
});

test("fields are typed and bounded", () => {
  assert.throws(() => parseNewResponse({ session_id: "s", text: 5 }), BadRequest);
  assert.throws(() => parseNewResponse({ session_id: "s", text: "x".repeat(LIMITS.replyText + 1) }), BadRequest);
  assert.throws(() => parseNewResponse({ session_id: "s", text: "x", created_at: -1 }), BadRequest);
  assert.throws(() => parseNewNote({ parent_id: 1, body: "   " }), BadRequest, "empty notes are refused");
  assert.throws(() => parseNewNote({ response_id: 1.5, block_index: 0, quote: "", body: "x" }), BadRequest);
  assert.throws(() => parseWaiter({ session_id: "s", waiter_id: "not hex!" }), BadRequest);
  assert.deepEqual(parseNewNote({ parent_id: 4, body: " Why? " }), { kind: "follow-up", parentId: 4, body: "Why?" });
  assert.throws(() => parsePrompt({ session_id: "s", text: " \n " }), BadRequest, "empty messages are refused");
  assert.throws(() => parsePrompt({ session_id: "s", text: "x".repeat(LIMITS.message + 1) }), BadRequest);
  assert.deepEqual(parsePrompt({ session_id: "s", text: " Add tests\n" }), { session_id: "s", text: "Add tests" });
});

test("launch codes work once and expire", () => {
  const clock = new FakeClock();
  const codes = new LaunchCodes(clock);
  const code = codes.issue();
  assert.match(code, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(codes.redeem(code), true);
  assert.equal(codes.redeem(code), false, "single use");

  const late = codes.issue();
  clock.advanceMs(LAUNCH_CODE_TTL_MS);
  assert.equal(codes.redeem(late), false, "expired");
  assert.equal(codes.redeem("never-issued-code-123"), false);
});
