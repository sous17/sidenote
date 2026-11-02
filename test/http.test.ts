import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../src/server/http.ts";
import { Store } from "../src/server/store.ts";
import type { ClaimResult, NewResponseResult, Note, SessionListResult, StateSnapshot } from "../src/shared/types.ts";

const TOKEN = "test-token";
const server = createServer();
let base = "";

before(async () => {
  const webDir = mkdtempSync(join(tmpdir(), "sidenote-web-"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html>page");
  writeFileSync(join(webDir, "app.js"), "app");
  mkdirSync(join(webDir, "..", "secret-sibling"), { recursive: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  server.on(
    "request",
    createApp({ store: new Store(), token: TOKEN, allowedHosts: new Set([`127.0.0.1:${port}`]), webDir }),
  );
});

after(() => server.close());

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(base + path, {
    method,
    headers: { "X-Review-Token": TOKEN, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("serves the page with a strict content security policy", async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.equal((await fetch(`${base}/static/app.js`)).status, 200);
});

test("refuses paths outside the page directory", async () => {
  const response = await fetch(`${base}/static/..%2F..%2Fetc%2Fpasswd`);
  assert.equal(response.status, 404);
});

test("the API needs the token", async () => {
  assert.equal((await call("GET", "/api/state", undefined, { "X-Review-Token": "wrong" })).status, 403);
  assert.equal((await fetch(`${base}/api/state`)).status, 403);
});

test("rejects foreign Host headers (DNS rebinding)", async () => {
  const { request } = await import("node:http");
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${base}/api/health`, { headers: { Host: "evil.example:80", "X-Review-Token": TOKEN } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
});

test("round trip: reply, note, claim, answer; and 204 when nothing changed", async () => {
  const created = (await (await call("POST", "/api/responses", { session_id: "s", session_name: "demo", cwd: "/w", text: "Hi." })).json()) as NewResponseResult;
  assert.equal(created.new_session, true);
  const reply = created.response;
  assert.equal((await call("POST", "/api/responses", { cwd: "/w", text: "no session" })).status, 400);
  assert.equal((await call("POST", "/api/comments", { response_id: reply.id, block_index: 0, quote: "Hi.", body: "  " })).status, 400);
  const note = (await (await call("POST", "/api/comments", { response_id: reply.id, block_index: 0, quote: "Hi.", body: " Why? " })).json()) as Note;
  assert.equal(note.body, "Why?");
  assert.equal((await call("POST", "/api/comments", { parent_id: 999, body: "x" })).status, 404);

  const claimed = (await (await call("POST", "/api/claim", { session_id: "s" })).json()) as ClaimResult;
  assert.equal(claimed.comments.length, 1);
  await call("POST", "/api/responses", { session_id: "s", cwd: "/w", text: `**↳ Re: note ${note.id}**\nBecause.` });

  const state = (await (await call("GET", "/api/state?v=-1&s=s")).json()) as StateSnapshot;
  assert.equal(state.session?.name, "demo");
  assert.equal(state.responses.at(-1)?.note_answers[String(note.id)], "Because.");
  assert.equal((await call("GET", `/api/state?v=${state.version}&s=s`)).status, 204);

  const other = (await (await call("GET", "/api/state?v=-1&s=other")).json()) as StateSnapshot;
  assert.equal(other.session, null);
  assert.equal(other.responses.length, 0);

  await call("POST", "/api/sessions", { session_id: "fresh", session_name: "new one", cwd: "/w/x" });
  const list = (await (await call("GET", "/api/sessions")).json()) as SessionListResult;
  assert.deepEqual(list.sessions.map((s) => s.id), ["fresh", "s"]);
});

test("rejects invalid JSON and deleting sent notes", async () => {
  const response = await fetch(`${base}/api/send`, {
    method: "POST",
    headers: { "X-Review-Token": TOKEN },
    body: "{not json",
  });
  assert.equal(response.status, 400);
  assert.equal((await call("DELETE", "/api/comments/abc")).status, 404);
});
