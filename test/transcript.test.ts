import assert from "node:assert/strict";
import { test } from "node:test";
import { cwdFromTranscript, finalResponsesPerTurn, sessionNameFromTranscript } from "../src/cli/transcript.ts";

const line = (entry: object) => JSON.stringify(entry);

test("takes the last assistant message before each prompt and skips the final turn", () => {
  const transcript = [
    line({ type: "user", message: { content: "first prompt" } }),
    line({ type: "assistant", timestamp: "2026-11-02T10:00:00Z", message: { id: "a", content: [{ type: "text", text: "thinking out loud" }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result" }] } }),
    line({ type: "assistant", timestamp: "2026-11-02T10:01:00Z", message: { id: "b", content: [{ type: "text", text: "Part one." }] } }),
    line({ type: "assistant", timestamp: "2026-11-02T10:01:01Z", message: { id: "b", content: [{ type: "text", text: "Part two." }] } }),
    line({ type: "user", isMeta: true, message: { content: "meta" } }),
    line({ type: "assistant", isSidechain: true, message: { id: "c", content: [{ type: "text", text: "subagent" }] } }),
    line({ type: "user", message: { content: "second prompt" } }),
    line({ type: "assistant", timestamp: "2026-11-02T10:02:00Z", message: { id: "d", content: [{ type: "text", text: "Final, already sent by the Stop hook." }] } }),
  ].join("\n");
  const replies = finalResponsesPerTurn(transcript);
  assert.deepEqual(replies.map((r) => r.text), ["Part one.\n\nPart two."]);
  assert.equal(replies[0]!.createdAt, Date.parse("2026-11-02T10:01:01Z") / 1000);
});

test("text right before a question tool counts as a reply", () => {
  const transcript = [
    line({ type: "assistant", timestamp: "2026-11-02T10:00:00Z", message: { id: "a", content: [{ type: "text", text: "Here is the plan." }] } }),
    line({ type: "assistant", timestamp: "2026-11-02T10:00:01Z", message: { id: "a", content: [{ type: "tool_use", name: "ExitPlanMode" }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result" }] } }),
  ].join("\n");
  assert.deepEqual(finalResponsesPerTurn(transcript).map((r) => r.text), ["Here is the plan."]);
});

test("reads the latest /rename name and the session folder", () => {
  const transcript = [
    line({ type: "user", cwd: "/w/shop-api", message: { content: "hi" } }),
    line({ type: "custom-title", customTitle: "first name", sessionId: "s" }),
    line({ type: "custom-title", customTitle: " rate limits ", sessionId: "s" }),
    // A message that merely quotes the entry must not count.
    line({ type: "user", message: { content: 'look for {"type":"custom-title"} lines' } }),
    '{"type":"custom-title" broken',
  ].join("\n");
  assert.equal(sessionNameFromTranscript(transcript), "rate limits");
  assert.equal(cwdFromTranscript(transcript), "/w/shop-api");
  assert.equal(sessionNameFromTranscript(line({ type: "user", message: { content: "x" } })), "");
});
