// The API for sessions sidenote runs, against a real HTTP server and a fake agent.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { Delivery } from "../src/server/delivery.ts";
import { SessionHost } from "../src/server/host.ts";
import { createApp } from "../src/server/http.ts";
import { LaunchCodes } from "../src/server/launch.ts";
import { Store } from "../src/server/store.ts";
import type { ConversationView, SendResult, StartConversationResult, StateSnapshot } from "../src/shared/types.ts";
import { FakeAgent, noteOn } from "./helpers.ts";

const TOKEN = "test-token-0123456789";
const server = createServer();
const folder = mkdtempSync(`${tmpdir()}/sidenote-chat-`);
const store = new Store();
const agent = new FakeAgent();
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  server.on(
    "request",
    createApp({
      store,
      delivery: new Delivery(store),
      host: new SessionHost({ store, agent }),
      launchCodes: new LaunchCodes(),
      token: TOKEN,
      allowedHosts: new Set([`127.0.0.1:${port}`]),
      webDir: folder,
    }),
  );
});

after(() => {
  server.closeAllConnections();
  server.close();
});

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(base + path, {
    method,
    headers: { "X-Review-Token": TOKEN },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

async function start(): Promise<string> {
  const started = await call<StartConversationResult>("POST", "/api/conversations", { cwd: folder });
  assert.equal(started.status, 201);
  return started.body.session_id;
}

test("starts a session in a folder, and refuses anything that isn't one", async () => {
  const id = await start();
  const view = await call<ConversationView>("GET", `/api/conversation?s=${id}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.state, "idle");
  assert.equal(view.body.agent, "Fake Agent");
  assert.equal((await call("POST", "/api/conversations", { cwd: "relative/path" })).status, 400);
  assert.equal((await call("POST", "/api/conversations", { cwd: `${folder}/missing` })).status, 400);
  assert.equal((await call("POST", "/api/conversations", { cwd: folder, session_id: "../x" })).status, 400);
  assert.equal((await call("GET", "/api/conversation?s=never-started")).status, 404);
});

test("a long poll answers as soon as the turn changes", async () => {
  const id = await start();
  const { body: before } = await call<ConversationView>("GET", `/api/conversation?s=${id}`);
  const unchanged = await call("GET", `/api/conversation?s=${id}&v=${before.version}`);
  assert.equal(unchanged.status, 204, "without wait=1 an unchanged view answers at once");

  const polling = call<ConversationView>("GET", `/api/conversation?s=${id}&v=${before.version}&wait=1`);
  assert.equal((await call("POST", "/api/conversation/messages", { session_id: id, text: "Hello" })).status, 202);
  const changed = await polling;
  assert.equal(changed.status, 200);
  assert.equal(changed.body.state, "working");
  assert.equal(changed.body.live?.prompt, "Hello");

  const storePoll = call<StateSnapshot>("GET", `/api/state?s=${id}&v=${store.revision.value}&wait=1`);
  agent.reply("Hi!");
  const state = await storePoll;
  assert.equal(state.body.responses.at(-1)?.text, "Hi!", "the state poll wakes when the turn is stored");
  assert.equal(state.body.session?.status, "listening", "a session sidenote runs takes Send now at once");
});

test("permission answers, interrupts and Send now for a session sidenote runs", async () => {
  const id = await start();
  await call("POST", "/api/conversation/messages", { session_id: id, text: "Run it" });
  agent.emit({
    type: "permission",
    request: { request_id: "p-1", tool_name: "Bash", description: "", input: { command: "ls" } },
  });
  const bad = await call("POST", "/api/conversation/permission", {
    session_id: id,
    request_id: "p-1",
    decision: "maybe",
  });
  assert.equal(bad.status, 400);
  const answer = { session_id: id, request_id: "p-1", decision: "allow" };
  assert.equal((await call("POST", "/api/conversation/permission", answer)).status, 200);
  assert.equal((await call("POST", "/api/conversation/permission", answer)).status, 409, "already answered");

  await call("POST", "/api/conversation/messages", { session_id: id, text: "Then this" });
  const interrupted = await call<{ queued: string[] }>("POST", "/api/conversation/interrupt", { session_id: id });
  assert.deepEqual(interrupted.body.queued, ["Then this"]);
  agent.emit({ type: "turn_end", end: { outcome: "interrupted", error: "", cost_usd: null } });

  const reply = store.sessionContent(id).responses.at(-1)!;
  noteOn(store, reply.id, "Explain");
  const sent = await call<SendResult>("POST", "/api/send", { session_ids: [id] });
  assert.deepEqual(sent.body.sessions, [id]);
  assert.match(agent.sent.at(-1)!, /clicked Send now/);
});

test("an empty message without notes is refused with the reason", async () => {
  const id = await start();
  const refused = await call<{ error: string }>("POST", "/api/conversation/messages", { session_id: id, text: "" });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /nothing to send/);
  const unknown = await call("POST", "/api/conversation/messages", { session_id: "nope", text: "hi" });
  assert.equal(unknown.status, 409);
});
