import assert from "node:assert/strict";
import { test } from "node:test";
import { LaunchCodes, LAUNCH_CODE_TTL_MS } from "../src/server/launch.ts";
import {
  BadRequest,
  LIMITS,
  parseActivity,
  parseProgress,
  parseNewNote,
  parseNewResponse,
  parsePrompt,
  parseRename,
  parseSend,
  parseStartSession,
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

test("an activity line is short, and not empty", () => {
  const session_id = "s1";
  assert.deepEqual(parseActivity({ session_id, text: "Editing a.ts" }), { session_id, text: "Editing a.ts" });
  assert.throws(() => parseActivity({ session_id, text: " " }), BadRequest);
  assert.throws(() => parseActivity({ session_id, text: "x".repeat(201) }), BadRequest);
  assert.throws(() => parseActivity({ session_id: "../x", text: "Editing a.ts" }), BadRequest);
});

test("a batch of a message is bounded, and its ids checked", () => {
  const body = { session_id: "s1", message_id: "5b2a9c8e-1f63", index: 0, delta: "Line\n" };
  assert.deepEqual(parseProgress(body), body);
  assert.throws(() => parseProgress({ ...body, message_id: "../x" }), BadRequest);
  assert.throws(() => parseProgress({ ...body, index: -1 }), BadRequest);
  assert.throws(() => parseProgress({ ...body, delta: "x".repeat(20_001) }), BadRequest);
});

test("a name given in the window is one line, and empty removes it", () => {
  assert.deepEqual(parseRename({ session_id: "s", label: "  DM-1782 \n OAuth fix " }), {
    session_id: "s",
    label: "DM-1782 OAuth fix",
  });
  assert.equal(parseRename({ session_id: "s", label: "" }).label, "");
  assert.throws(() => parseRename({ session_id: "s", label: "x".repeat(LIMITS.sessionName + 1) }), BadRequest);
  assert.throws(() => parseRename({ session_id: "s" }), BadRequest);
  assert.equal(parseStartSession({ session_id: "s", name: " a\tb " }).name, "a b");
});

test("a reported Claude process is a pid above 1 and a start time, or nothing", () => {
  const waiter = { session_id: "s", waiter_id: "ab".repeat(8) };
  assert.deepEqual(parseWaiter({ ...waiter, claude_process: { pid: 42, started: "123" } }).claude_process, {
    pid: 42,
    started: "123",
  });
  assert.equal(parseWaiter(waiter).claude_process, undefined);
  for (const claude_process of [{ pid: 1, started: "1" }, { pid: 4.2, started: "1" }, { pid: 42, started: "" }, 42]) {
    assert.throws(() => parseWaiter({ ...waiter, claude_process }), BadRequest, JSON.stringify(claude_process));
  }
});
