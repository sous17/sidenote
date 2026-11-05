// The API for sessions sidenote runs, against a real HTTP server and a fake agent.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Delivery } from "../src/server/delivery.ts";
import { SessionHost } from "../src/server/host.ts";
import { createApp } from "../src/server/http.ts";
import { LaunchCodes } from "../src/server/launch.ts";
import { SessionProcesses } from "../src/server/processes.ts";
import { Store } from "../src/server/store.ts";
import type { ConversationView, SendResult, StartConversationResult, StateSnapshot } from "../src/shared/types.ts";
import { ApiError, SidenoteClient } from "../src/cli/client.ts";
import { ClientApi } from "../src/tui/api.ts";
import { FakeAgent, noteOn } from "./helpers.ts";

const TOKEN = "test-token-0123456789";
const server = createServer();
const folder = mkdtempSync(`${tmpdir()}/sidenote-chat-`);
const store = new Store();
const agent = new FakeAgent();
let base = "";
let port = 0;
let trusted = true;

function app(host: SessionHost) {
  return createApp({
    store,
    delivery: new Delivery(store),
    host,
    launchCodes: new LaunchCodes(),
    token: TOKEN,
    allowedHosts: new Set([`127.0.0.1:${port}`]),
    webDir: folder,
    openFolder: () => {},
    startSession: null,
    processes: new SessionProcesses({ pidInUse: () => false, isSameProcess: () => false }, store.revision),
    isTrusted: () => trusted,
  });
}

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  server.on("request", app(new SessionHost({ store, agent, isTrusted: () => trusted })));
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
  const registered = await call<StartConversationResult>("POST", "/api/sessions/register", { cwd: folder });
  assert.equal(registered.status, 201);
  const id = registered.body.session_id;
  assert.equal((await call("POST", "/api/conversations", { session_id: id })).status, 201);
  return id;
}

test("starts a session in a folder, and refuses anything that isn't one", async () => {
  const id = await start();
  const view = await call<ConversationView>("GET", `/api/conversation?s=${id}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.state, "idle");
  assert.equal(view.body.agent, "Fake Agent");
  assert.equal((await call("POST", "/api/sessions/register", { cwd: "relative/path" })).status, 400);
  assert.equal((await call("POST", "/api/sessions/register", { cwd: `${folder}/missing` })).status, 400);
  assert.equal((await call("POST", "/api/sessions/register", { cwd: folder, session_id: "../x" })).status, 400);
  assert.equal((await call("GET", "/api/conversation?s=never-started")).status, 404);
});

test("a folder Claude Code doesn't trust starts nothing, and leaves no session behind", async () => {
  const before = store.listSessions().length;
  trusted = false;
  try {
    const registered = await call<{ error: string }>("POST", "/api/sessions/register", { cwd: folder });
    assert.equal(registered.status, 409);
    assert.match(registered.body.error, /accept its trust prompt/);
    assert.equal(store.listSessions().length, before);
  } finally {
    trusted = true;
  }
});

test("a session whose folder lost its trust can't be started either", async () => {
  const id = (await call<{ session_id: string }>("POST", "/api/sessions/register", { cwd: folder })).body.session_id;
  trusted = false;
  try {
    assert.equal((await call("POST", "/api/conversations", { session_id: id })).status, 409);
    assert.equal((await call("GET", `/api/conversation?s=${id}`)).status, 404, "nothing was started");
  } finally {
    trusted = true;
  }
});

test("starting a session takes its id, never a path", async () => {
  const refused = await call("POST", "/api/conversations", { cwd: folder });
  assert.equal(refused.status, 400, "a folder alone starts nothing");
  const unknown = await call("POST", "/api/conversations", { session_id: "never-registered", cwd: folder });
  assert.equal(unknown.status, 404, "a folder beside an unknown id isn't recorded either");
  assert.equal(store.session("never-registered"), undefined);
  assert.equal((await call("POST", "/api/conversations", { session_id: "a", resume: "yes" })).status, 400);
});

test("registering never moves a session sidenote knows to another folder", async () => {
  const id = await start();
  const other = mkdtempSync(join(tmpdir(), "sidenote-other-"));
  const again = await call("POST", "/api/sessions/register", { cwd: other, session_id: id });
  assert.equal(again.status, 201);
  assert.equal(store.session(id)?.cwd, folder);
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
  assert.equal(unknown.status, 404, "a session this server doesn't run, say after a restart");
});

test("the terminal gets the server's words for an untrusted folder, to show as they are", async () => {
  const api = new ClientApi(new SidenoteClient({ port, token: TOKEN, pid: process.pid }));
  trusted = false;
  try {
    await assert.rejects(
      api.startConversation(folder),
      (error: unknown) =>
        error instanceof ApiError && error.status === 409 && error.detail.startsWith("Claude Code doesn't trust"),
    );
  } finally {
    trusted = true;
  }
});

test("the terminal starts its session again when the server restarted", async () => {
  const api = new ClientApi(new SidenoteClient({ port, token: TOKEN, pid: process.pid }));
  const id = await api.startConversation(folder);
  // A restart: a new host that has never heard of the session.
  const restarted = new FakeAgent();
  server.removeAllListeners("request");
  server.on("request", app(new SessionHost({ store, agent: restarted, isTrusted: () => trusted })));

  await api.message(id, "Still there?");
  assert.deepEqual(restarted.starts, [{ sessionId: id, cwd: folder, resume: true }]);
  assert.deepEqual(restarted.sent, ["Still there?"]);
  const view = await api.conversation(57, id, false);
  assert.equal(view?.live?.prompt, "Still there?");
});

test("the terminal rewrites an unsent note through the API", async () => {
  const api = new ClientApi(new SidenoteClient({ port, token: TOKEN, pid: process.pid }));
  const { response } = store.addResponse({
    sessionId: "edited-note",
    cwd: folder,
    text: "Hi.",
    sessionName: "",
    createdAt: undefined,
  });
  const note = noteOn(store, response.id, "tpyo");
  await api.editNote(note.id, "typo");
  assert.equal(store.sessionContent("edited-note").comments[0]?.body, "typo");
});

describe("sessions sidenote runs stay out of folder windows", () => {
  const running = new FakeAgent();

  before(() => {
    server.removeAllListeners("request");
    server.on("request", app(new SessionHost({ store, agent: running, isTrusted: () => trusted })));
  });

  const window = async () => (await call<StateSnapshot>("GET", `/api/state?v=-1&s=&f=${basename(folder)}`)).body;
  const listed = async (id: string) => (await window()).sessions.some((row) => row.id === id);

  test("before, during and after a turn, and a window doesn't open on one", async () => {
    const id = await start();
    assert.equal(await listed(id), false);
    await call("POST", "/api/conversation/messages", { session_id: id, text: "Fix the login" });
    assert.equal(await listed(id), false);
    running.reply("Done.");
    assert.equal(await listed(id), false);
    assert.notEqual((await window()).session?.id, id);
  });

  test("the terminal still reads its own session by id", async () => {
    const id = await start();
    await call("POST", "/api/conversation/messages", { session_id: id, text: "Hi" });
    running.reply("Done.");
    const { body } = await call<StateSnapshot>("GET", `/api/state?v=-1&s=${id}`);
    assert.equal(body.session?.id, id);
    assert.equal(body.responses.at(-1)?.text, "Done.");
  });

  test("a session that goes back to a terminal shows again with its next reply", async () => {
    const id = await start();
    await call("POST", "/api/responses", { session_id: id, cwd: folder, text: "From the hooks" });
    assert.equal(await listed(id), true);
  });

  test("end with their agent; removing one that runs is refused", async () => {
    const id = await start();
    await call("POST", "/api/conversation/messages", { session_id: id, text: "Hi" });
    assert.equal((await call("POST", "/api/sessions/forget", { session_id: id })).status, 409);

    const closed = running.closed;
    assert.equal((await call("POST", "/api/sessions/end", { session_id: id })).status, 204);
    assert.equal(running.closed, closed + 1);
    running.emit({ type: "exit", message: "closed" });
    assert.equal((await call("GET", `/api/conversation?s=${id}`)).status, 404);
  });

  test("a long poll on the state wakes when the store changes", async () => {
    const id = await start();
    const { body } = await call<StateSnapshot>("GET", `/api/state?v=-1&s=${id}`);
    const poll = call<StateSnapshot>("GET", `/api/state?v=${body.version}&s=${id}&wait=1`);
    await call("POST", "/api/conversation/messages", { session_id: id, text: "Hi" });
    running.reply("Done.");
    assert.equal((await poll).status, 200);
  });
});
