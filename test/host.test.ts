import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionHost, replyOf } from "../src/server/host.ts";
import { FakeAgent, FakeClock, noteOn } from "./helpers.ts";
import { Store } from "../src/server/store.ts";

function setup() {
  const clock = new FakeClock();
  const store = new Store({ clock });
  const agent = new FakeAgent();
  const host = new SessionHost({ store, agent, clock });
  return { store, agent, host };
}

test("a new session starts its agent at the first message, and each turn becomes a reply", () => {
  const { store, agent, host } = setup();
  const id = host.open("/w/shop");
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(store.session(id)?.cwd, "/w/shop");
  assert.equal(agent.starts.length, 0, "nothing runs before the first message");

  host.message(id, "Hi there");
  assert.deepEqual(agent.starts, [{ sessionId: id, cwd: "/w/shop", resume: false }]);
  assert.deepEqual(agent.sent, ["Hi there"]);
  agent.emit({ type: "ready", session_id: id, model: "fake-model" });
  agent.emit({ type: "text_delta", text: "Hel" });
  agent.emit({ type: "text_delta", text: "lo" });
  let view = host.view(id)!;
  assert.equal(view.state, "working");
  assert.equal(view.model, "fake-model");
  assert.deepEqual(view.live?.parts, [{ kind: "text", text: "Hello" }]);
  assert.equal(view.live?.prompt, "Hi there");

  agent.emit({ type: "text", text: "Hello!" });
  agent.emit({ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/w/shop/src/a.ts" } });
  agent.emit({ type: "tool_result", id: "t1", failed: false });
  agent.emit({ type: "text", text: "Done." });
  agent.emit({ type: "usage", context_tokens: 5000, context_window: null });
  agent.emit({ type: "usage", context_tokens: null, context_window: 200000 });
  agent.emit({ type: "turn_end", end: { outcome: "done", error: "", cost_usd: 0.1 } });

  view = host.view(id)!;
  assert.equal(view.state, "idle");
  assert.equal(view.live, null);
  assert.deepEqual(view.context, { used: 5000, limit: 200000 });
  const [turn] = store.sessionContent(id).responses;
  assert.equal(turn?.text, "Hello!\n\nDone.");
  assert.equal(turn?.prompt, "Hi there");
  assert.deepEqual(turn?.steps, [{ tool: "Edit", summary: "src/a.ts", after_block: 0, failed: false }]);
  assert.equal(turn?.ended, undefined);

  host.message(id, "Again");
  assert.equal(agent.starts.length, 1, "one process for the whole session");
});

test("continuing an earlier session resumes it, in the folder sidenote knows for it", () => {
  const { store, agent, host } = setup();
  store.touchSession("earlier-session", "", "/w/earlier");
  assert.equal(host.open("/somewhere/else", "earlier-session"), "earlier-session");
  host.message("earlier-session", "Where were we?");
  assert.deepEqual(agent.starts, [{ sessionId: "earlier-session", cwd: "/w/earlier", resume: true }]);
});

test("pending notes ride along with the next message, and that turn answers them", () => {
  const { store, agent, host } = setup();
  const id = host.open("/w/shop");
  host.message(id, "First");
  agent.reply("Para one.\n\nPara two.");
  const [first] = store.sessionContent(id).responses;
  const note = noteOn(store, first!.id, "Why two paragraphs?");

  host.message(id, "Also fix the tests");
  const sent = agent.sent.at(-1)!;
  assert.ok(sent.startsWith("Also fix the tests\n\n---\n\n"));
  assert.match(sent, /Why two paragraphs\?/);
  assert.equal(host.view(id)?.live?.prompt, "Also fix the tests", "the turn shows only what the user typed");
  assert.equal(host.view(id)?.live?.notes_sent, 1);
  agent.reply(`Fixed them.\n\n**↳ Re: note ${note.id}**\nOne idea each.`);

  const [, second] = store.sessionContent(id).responses;
  assert.equal(second?.text, "Fixed them.");
  assert.deepEqual(second?.note_answers, { [note.id]: "One idea each." });
  assert.equal(second?.notes_sent, 1);
});

test("Send now sends only the notes, and waits for the turn in progress", () => {
  const { store, agent, host } = setup();
  const id = host.open("/w/shop");
  assert.equal(host.sendNotes(id), false, "no notes yet");
  host.message(id, "First");
  agent.reply("Answer.");
  host.message(id, "Something slow");
  noteOn(store, store.sessionContent(id).responses[0]!.id, "Shorter please");
  assert.equal(host.sendStatus(id)?.status, "busy");
  assert.equal(host.sendStatus(id)?.hosted, true, "the page shows the dots from this");
  assert.equal(host.sendNotes(id), true);
  assert.equal(host.sendStatus(id)?.send_requested, true);
  assert.equal(agent.sent.length, 2, "nothing more while the agent works");
  agent.reply("Slow answer.");
  assert.equal(agent.sent.length, 3);
  assert.match(agent.sent[2]!, /clicked Send now/);
  assert.equal(host.view(id)?.live?.prompt, "");
});

test("messages typed during a turn queue up, and an interrupt hands them back", () => {
  const { agent, host } = setup();
  const id = host.open("/w/shop");
  host.message(id, "One");
  host.message(id, "Two");
  host.message(id, "Three");
  assert.deepEqual(host.view(id)?.queued, ["Two", "Three"]);
  agent.reply("First answer.");
  assert.deepEqual(agent.sent, ["One", "Two"]);
  assert.deepEqual(host.view(id)?.queued, ["Three"]);

  assert.deepEqual(host.interrupt(id), ["Three"]);
  assert.equal(agent.interrupts, 1);
  agent.emit({ type: "text_delta", text: "Partial" });
  agent.emit({ type: "turn_end", end: { outcome: "interrupted", error: "", cost_usd: null } });
  assert.equal(host.view(id)?.state, "idle");
  assert.deepEqual(host.view(id)?.queued, []);
});

test("an interrupted or failed turn is kept, marked as such", () => {
  const { store, agent, host } = setup();
  const id = host.open("/w/shop");
  host.message(id, "Go");
  agent.emit({ type: "text_delta", text: "Partial" });
  host.interrupt(id);
  agent.emit({ type: "turn_end", end: { outcome: "interrupted", error: "", cost_usd: null } });
  host.message(id, "Go again");
  agent.emit({ type: "turn_end", end: { outcome: "error", error: "Not logged in", cost_usd: null } });
  const [interrupted, failed] = store.sessionContent(id).responses;
  assert.equal(interrupted?.text, "Partial");
  assert.equal(interrupted?.ended, "interrupted");
  assert.equal(failed?.ended, "error");
  assert.equal(failed?.error, "Not logged in");
  assert.equal(host.view(id)?.error, "Not logged in");
});

test("permission prompts wait for the user's answer", () => {
  const { agent, host } = setup();
  const id = host.open("/w/shop");
  host.message(id, "Run the tests");
  const request = { request_id: "perm-1", tool_name: "Bash", description: "", input: { command: "npm test" } };
  agent.emit({ type: "permission", request });
  const view = host.view(id)!;
  assert.equal(view.state, "waiting");
  assert.deepEqual(view.permission, { request_id: "perm-1", tool: "Bash", summary: "npm test", detail: "npm test" });
  assert.equal(host.answer(id, "other", "allow"), false, "only the prompt it waits on");
  assert.equal(host.answer(id, "perm-1", "always"), true);
  assert.deepEqual(agent.answers, [["perm-1", "always"]]);
  assert.equal(host.view(id)?.state, "working");
  assert.equal(host.view(id)?.permission, null);
  assert.equal(host.answer(id, "perm-1", "allow"), false, "answered once");
});

test("when the agent process ends, the turn is kept and the next message starts it again", () => {
  const { store, agent, host } = setup();
  const id = host.open("/w/shop");
  host.message(id, "Crash please");
  host.message(id, "Queued");
  agent.emit({ type: "exit", message: "Claude Code stopped (exit 3): boom" });
  const view = host.view(id)!;
  assert.equal(view.state, "stopped");
  assert.equal(view.error, "Claude Code stopped (exit 3): boom");
  assert.deepEqual(view.queued, [], "nothing restarts by itself");
  assert.equal(store.sessionContent(id).responses[0]?.ended, "error");
  host.message(id, "Back?");
  assert.deepEqual(
    agent.starts.map((start) => start.resume),
    [false, true],
  );
});

test("refuses an empty message without notes, and sessions it doesn't run", () => {
  const { host } = setup();
  const id = host.open("/w/shop");
  assert.throws(() => host.message(id, "  "), /nothing to send/);
  assert.throws(() => host.message("unknown", "hi"), /isn't running this session/);
  assert.equal(host.view("unknown"), null);
  assert.equal(host.sendStatus("unknown"), null);
});

test("tool rows are placed after the block of text they followed", () => {
  const tool = (name: string) => ({ kind: "tool" as const, id: name, tool: name, summary: "", failed: null });
  const { text, steps } = replyOf([
    tool("Read"),
    { kind: "text", text: "Looking.\n\n- one\n- two" },
    tool("Edit"),
    { kind: "text", text: "  " },
    { kind: "text", text: "Done." },
  ]);
  assert.equal(text, "Looking.\n\n- one\n- two\n\nDone.");
  assert.deepEqual(
    steps.map((step) => [step.tool, step.after_block]),
    [
      ["Read", -1],
      ["Edit", 2],
    ],
  );
});

test("closing the host ends every agent process", () => {
  const { agent, host } = setup();
  host.message(host.open("/w/a"), "hi");
  host.closeAll();
  assert.equal(agent.closed, 1);
});

test("a turn starting reaches pages, which poll the store's revision", () => {
  const { store, agent, host } = setup();
  const id = host.open("/w/shop");
  host.message(id, "First");
  agent.reply("Answer.");
  const before = store.revision.value;
  host.message(id, "Something slow");
  assert.ok(store.revision.value > before);
});

test("a turn's text and latest tool call reach the page", () => {
  const { store, agent, host } = setup();
  const id = host.open("/w/shop");
  host.message(id, "Something slow");
  agent.emit({ type: "text", text: "Looking at it." });
  agent.emit({ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/w/shop/a.ts" } });
  agent.emit({ type: "text", text: "Found it." });
  assert.deepEqual(host.sendStatus(id)?.progress, ["Looking at it.", "Found it."]);
  assert.equal(host.sendStatus(id)?.activity, "Editing a.ts");

  agent.reply("Done.");
  assert.equal(host.sendStatus(id)?.progress, undefined, "the reply took over");
  assert.ok(store.revision.value > 0);
});
