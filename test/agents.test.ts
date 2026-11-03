// End to end: Codex, Cursor and Copilot hooks against a real server, with the inputs each agent
// documents. (Claude Code's hooks are covered in hooks.test.ts.)
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { lastReplyFromTranscript } from "../src/cli/agents/copilot.ts";
import type { Note, StateSnapshot } from "../src/shared/types.ts";
import { Sandbox } from "./sandbox.ts";

const sandbox = new Sandbox();

before(async () => {
  assert.equal((await sandbox.run(["on"])).code, 0);
  await sandbox.nextOpened();
});
after(async () => {
  await sandbox.run(["off"]);
});

const state = (sessionId: string): Promise<StateSnapshot> =>
  sandbox.api<StateSnapshot>("GET", `/api/state?v=-1&s=${sessionId}`);

async function noteOnFirstReply(sessionId: string, body: string): Promise<Note> {
  const { responses } = await state(sessionId);
  return sandbox.api<Note>("POST", "/api/comments", {
    response_id: responses[0]!.id,
    block_index: 0,
    quote: "quoted",
    body,
  });
}

describe("Codex", () => {
  const session = "codex-session-1";
  const input = (fields: object) => ({ session_id: session, cwd: "/w/api", hook_event_name: "Stop", ...fields });

  test("session start asks for diffs", async () => {
    const output = await sandbox.hook("codex", "session-start", { session_id: session, source: "startup" });
    assert.match(JSON.stringify(output), /```diff block/);
  });

  test("records replies, and notes go with the next prompt", async () => {
    assert.deepEqual(await sandbox.hook("codex", "stop", input({ last_assistant_message: "Para one." })), {});
    assert.equal((await sandbox.nextOpened()).searchParams.get("s"), session, "a new session opens its window");
    const snapshot = await state(session);
    assert.equal(snapshot.session?.agent, "codex");
    assert.equal(snapshot.session?.cwd, "/w/api");

    const note = await noteOnFirstReply(session, "Why?");
    const prompt = await sandbox.hook("codex", "prompt", { session_id: session, prompt: "go on" });
    const context = (prompt["hookSpecificOutput"] as { additionalContext: string }).additionalContext;
    assert.match(context, new RegExp(`Note ${note.id}, on your response`));
  });

  test("Send now while Codex works goes out when its turn ends", async () => {
    const note = await noteOnFirstReply(session, "And this?");
    await sandbox.api("POST", "/api/send", { session_ids: [session] });
    const stop = await sandbox.hook("codex", "stop", input({ last_assistant_message: "Done." }));
    assert.equal(stop["decision"], "block");
    assert.match(String(stop["reason"]), new RegExp(`While you were working[\\s\\S]*Note ${note.id}`));
    assert.deepEqual(
      await sandbox.hook("codex", "stop", input({ last_assistant_message: "Answered." })),
      {},
      "nothing more to send",
    );
  });
});

describe("Cursor", () => {
  const session = "cursor-conv-1";
  const base = { conversation_id: session, generation_id: "g1", workspace_roots: ["/w/web"] };

  test("session start asks for diffs", async () => {
    const output = await sandbox.hook("cursor", "session-start", { session_id: session });
    assert.match(String(output["additional_context"]), /```diff block/);
  });

  test("records the turn's last reply when the turn stops", async () => {
    await sandbox.hook("cursor", "after-response", { ...base, text: "Looking into it." });
    await sandbox.hook("cursor", "after-response", { ...base, text: "Fixed the bug." });
    assert.deepEqual(await sandbox.hook("cursor", "stop", { ...base, status: "completed", loop_count: 0 }), {});
    const { responses, session: view } = await state(session);
    assert.deepEqual(
      responses.map((r) => r.text),
      ["Fixed the bug."],
    );
    assert.equal(view?.agent, "cursor");
    assert.equal(view?.cwd, "/w/web");
  });

  test("saved notes follow the next prompt, as a follow-up message when the turn ends", async () => {
    const note = await noteOnFirstReply(session, "Add a test");
    assert.deepEqual(await sandbox.hook("cursor", "prompt", { ...base, prompt: "next thing" }), { continue: true });
    assert.equal((await state(session)).session?.status, "busy");
    await sandbox.hook("cursor", "after-response", { ...base, text: "Next thing done." });
    const stop = await sandbox.hook("cursor", "stop", { ...base, status: "completed", loop_count: 0 });
    assert.match(String(stop["followup_message"]), new RegExp(`Note ${note.id}`));
  });
});

describe("Copilot", () => {
  const session = "copilot-session-1";
  const transcript = join(sandbox.home, "events.jsonl");
  const events = (...lines: object[]) => writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join("\n"));

  test("reads the reply from the transcript, and notes go at the end of the next turn", async () => {
    events(
      { type: "user.message", data: { content: "Fix it" } },
      { type: "assistant.message", data: { content: "Working on it." } },
      { type: "assistant.message", data: { content: "Subagent noise", parentToolCallId: "t1" } },
      { type: "assistant.message", data: { content: "Fixed." } },
      { type: "assistant.turn_end", data: { turnId: "1" } },
    );
    const stopInput = { sessionId: session, cwd: "/w/cli", transcriptPath: transcript, stopReason: "end_turn" };
    assert.deepEqual(await sandbox.hook("copilot", "stop", stopInput), {});
    const { responses, session: view } = await state(session);
    assert.deepEqual(
      responses.map((r) => r.text),
      ["Fixed."],
    );
    assert.equal(view?.agent, "copilot");

    const note = await noteOnFirstReply(session, "Explain");
    await sandbox.hook("copilot", "prompt", { sessionId: session, prompt: "more" });
    events(
      { type: "user.message", data: { content: "more" } },
      { type: "assistant.message", data: { content: "More." } },
    );
    const stop = await sandbox.hook("copilot", "stop", stopInput);
    assert.equal(stop["decision"], "block");
    assert.match(String(stop["reason"]), new RegExp(`Note ${note.id}`));
  });

  test("transcript reading takes the last top-level reply after the last prompt", () => {
    const lines = (...events: object[]) => events.map((e) => JSON.stringify(e)).join("\n");
    assert.equal(
      lastReplyFromTranscript(
        lines(
          { type: "assistant.message", data: { content: "old turn" } },
          { type: "user.message", data: { content: "new prompt" } },
          { type: "assistant.message", data: { content: [{ type: "text", text: "Block " }, { text: "content" }] } },
        ),
      ),
      "Block content",
    );
    assert.equal(lastReplyFromTranscript(lines({ type: "user.message", data: { content: "q" } })), "");
    assert.equal(lastReplyFromTranscript("not json\n"), "");
  });
});

test("hooks stay quiet while sidenote is off, but still answer agents that require output", async () => {
  const off = new Sandbox();
  assert.equal(
    (await off.run(["hook", "codex", "stop"], { session_id: "s", last_assistant_message: "x" })).stdout,
    "{}\n".trimEnd(),
  );
  assert.equal((await off.run(["hook", "cursor", "prompt"], { conversation_id: "c" })).stdout, '{"continue":true}');
  assert.equal((await off.run(["hook", "cursor", "stop"], { conversation_id: "c" })).stdout, "");
  assert.equal((await off.run(["hook", "nobody", "stop"], {})).code, 0, "unknown agents are ignored");
});
