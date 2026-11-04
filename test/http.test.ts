import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Delivery } from "../src/server/delivery.ts";
import { createApp } from "../src/server/http.ts";
import { LaunchCodes } from "../src/server/launch.ts";
import { Store } from "../src/server/store.ts";
import type {
  ClaimResult,
  LaunchCodeResult,
  NewResponseResult,
  Note,
  PromptResult,
  RedeemResult,
  SessionListResult,
  StateSnapshot,
  WaiterPollResult,
} from "../src/shared/types.ts";

const TOKEN = "test-token-0123456789";
const server = createServer();
let base = "";
let port = 0;

before(async () => {
  const webDir = mkdtempSync(join(tmpdir(), "sidenote-web-"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html>page");
  writeFileSync(join(webDir, "app.js"), "app");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  const store = new Store();
  server.on(
    "request",
    createApp({
      store,
      delivery: new Delivery(store),
      launchCodes: new LaunchCodes(),
      token: TOKEN,
      allowedHosts: new Set([`127.0.0.1:${port}`]),
      webDir,
    }),
  );
});

after(() => server.close());

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(base + path, {
    method,
    headers: { "X-Review-Token": TOKEN, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function json<T>(response: Promise<Response>): Promise<T> {
  return (await (await response).json()) as T;
}

/** fetch() can't set Host or skip URL normalization, so these go through node:http. */
function rawStatus(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("page", () => {
  test("is served with a strict content security policy and safe headers", async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal((await fetch(`${base}/static/app.js`)).status, 200);
  });

  test("refuses paths outside the page directory and malformed ones", async () => {
    for (const path of [
      "/static/../server.js",
      "/static/..%2f..%2fetc%2fpasswd",
      "/static/%2e%2e/x",
      "/static/%E0%A4%A",
      "/static/a%00b",
    ]) {
      assert.equal(await rawStatus(path, { Host: `127.0.0.1:${port}` }), 404, path);
    }
  });
});

describe("API access", () => {
  test("needs the token", async () => {
    assert.equal((await call("GET", "/api/sessions", undefined, { "X-Review-Token": "wrong" })).status, 403);
    assert.equal((await fetch(`${base}/api/sessions`)).status, 403);
  });

  test("rejects foreign Host headers (DNS rebinding)", async () => {
    assert.equal(await rawStatus("/api/health", { Host: `evil.example:${port}`, "X-Review-Token": TOKEN }), 403);
  });

  test("never approves a cross-origin preflight", async () => {
    const response = await call("OPTIONS", "/api/send", undefined, { Origin: "https://evil.example" });
    assert.notEqual(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });

  test("a launch code gets a page the token once, without the token ever being in a URL", async () => {
    const { code } = await json<LaunchCodeResult>(call("POST", "/api/launch", {}));
    const redeem = () => fetch(`${base}/api/launch/redeem`, { method: "POST", body: JSON.stringify({ code }) });
    assert.deepEqual(await json<RedeemResult>(redeem()), { token: TOKEN });
    assert.equal((await redeem()).status, 403);
    assert.equal(
      (await fetch(`${base}/api/launch`, { method: "POST", body: "{}" })).status,
      403,
      "issuing needs the token",
    );
  });
});

describe("API input", () => {
  test("rejects non-object bodies, invalid JSON and bad ids", async () => {
    assert.equal((await call("POST", "/api/send", [])).status, 400, "an array must not mean 'every session'");
    assert.equal((await call("POST", "/api/send", "{not json")).status, 400);
    assert.equal((await call("POST", "/api/responses", { session_id: "__proto__", text: "hi" })).status, 400);
    assert.equal((await call("DELETE", "/api/comments/abc")).status, 404);
    assert.equal(({} as Record<string, unknown>)["cwd"], undefined, "Object.prototype is untouched");
  });

  test("refuses oversized bodies", async () => {
    assert.equal((await call("POST", "/api/responses", "x".repeat(3 * 1024 * 1024))).status, 413);
  });
});

describe("round trip", () => {
  test("reply, note, claim, answer, per-session state, and 204 when nothing changed", async () => {
    const created = await json<NewResponseResult>(
      call("POST", "/api/responses", { session_id: "s", session_name: "demo", cwd: "/w", text: "Hi." }),
    );
    assert.equal(created.new_session, true);
    const note = await json<Note>(
      call("POST", "/api/comments", { response_id: created.response.id, block_index: 0, quote: "Hi.", body: " Why? " }),
    );
    assert.equal(note.body, "Why?");
    assert.equal((await call("POST", "/api/comments", { parent_id: 999, body: "x" })).status, 404);

    const claimed = await json<ClaimResult>(call("POST", "/api/claim", { session_id: "s" }));
    assert.equal(claimed.comments.length, 1);
    await call("POST", "/api/responses", { session_id: "s", cwd: "/w", text: `**↳ Re: note ${note.id}**\nBecause.` });

    const state = await json<StateSnapshot>(call("GET", "/api/state?v=-1&s=s"));
    assert.equal(state.session?.name, "demo");
    assert.equal(state.session?.status, "busy", "claiming marks the session busy");
    assert.equal(state.responses.at(-1)?.note_answers[String(note.id)], "Because.");
    assert.equal((await call("GET", `/api/state?v=${state.version}&s=s`)).status, 204);

    const other = await json<StateSnapshot>(call("GET", "/api/state?v=-1&s=other"));
    assert.equal(other.session, null);
    assert.equal(other.responses.length, 0);

    await call("POST", "/api/sessions", { session_id: "fresh", session_name: "new one", cwd: "/w/x" });
    const list = await json<SessionListResult>(call("GET", "/api/sessions"));
    assert.deepEqual(
      list.sessions.map((s) => s.id),
      ["fresh", "s"],
    );
  });
});

describe("messages from the page", () => {
  test("reach a listening session's waiter, and show in the state from the moment they are sent", async () => {
    await call("POST", "/api/responses", { session_id: "p", cwd: "/w", text: "Done." });
    const send = (text: unknown, session_id = "p") => call("POST", "/api/prompt", { session_id, text });

    assert.equal((await send("hi", "unknown")).status, 404);
    assert.equal((await send("   ")).status, 400);
    assert.equal((await send("hi")).status, 409, "no waiter, so nothing would wake Claude");

    const waiter = { session_id: "p", waiter_id: "ab".repeat(8) };
    await call("POST", "/api/waiters", waiter);
    assert.deepEqual(await json<PromptResult>(send(" Add tests ")), { delivery: "sent" });
    let state = await json<StateSnapshot>(call("GET", "/api/state?v=-1&s=p"));
    assert.equal(state.session?.queued_prompt, "Add tests");
    assert.equal(state.messages[0]?.text, "Add tests");
    assert.equal(state.messages[0]?.delivered_at, null);

    const poll = await json<WaiterPollResult>(call("POST", "/api/waiters/poll", waiter));
    assert.equal(poll.action, "send");
    assert.equal(poll.prompt, "Add tests");

    await call("POST", "/api/responses", { session_id: "p", cwd: "/w", text: "Added." });
    state = await json<StateSnapshot>(call("GET", "/api/state?v=-1&s=p"));
    assert.equal(state.session?.queued_prompt, undefined);
    assert.equal(state.messages.length, 1);
    assert.notEqual(state.messages[0]?.delivered_at, null);
  });

  test("a message queued while Claude works rides along with a terminal prompt", async () => {
    await call("POST", "/api/responses", { session_id: "q", cwd: "/w", text: "Done." });
    await call("POST", "/api/claim", { session_id: "q" }); // the user typed in the terminal: busy
    assert.deepEqual(await json<PromptResult>(call("POST", "/api/prompt", { session_id: "q", text: "And docs" })), {
      delivery: "queued",
    });
    const claimed = await json<ClaimResult>(call("POST", "/api/claim", { session_id: "q" }));
    assert.equal(claimed.prompt, "And docs");
    assert.equal((await json<ClaimResult>(call("POST", "/api/claim", { session_id: "q" }))).prompt, undefined);
  });

  test("prompts typed in the terminal show too, in the order they were sent", async () => {
    await call("POST", "/api/responses", { session_id: "t", cwd: "/w", text: "Done." });
    await call("POST", "/api/claim", { session_id: "t", prompt: " Fix the bug \n" });
    await call("POST", "/api/claim", { session_id: "t", prompt: "   " });
    const state = await json<StateSnapshot>(call("GET", "/api/state?v=-1&s=t"));
    assert.deepEqual(
      state.messages.map((m) => [m.text, m.source, m.delivered_at !== null]),
      [["Fix the bug", "terminal", true]],
    );
  });
});
