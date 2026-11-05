import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { isSameProcess, pidInUse, processInfo } from "../src/node/process.ts";
import type { NewSession } from "../src/node/terminal.ts";
import { Delivery } from "../src/server/delivery.ts";
import { SessionHost } from "../src/server/host.ts";
import { createApp } from "../src/server/http.ts";
import { LaunchCodes } from "../src/server/launch.ts";
import { SessionProcesses } from "../src/server/processes.ts";
import { Store } from "../src/server/store.ts";
import {
  MAX_PROMPT_CHARS,
  type ClaimResult,
  type ErrorResult,
  type LaunchCodeResult,
  type NewResponseResult,
  type Note,
  type PromptResult,
  type RedeemResult,
  type SessionListResult,
  type StartSessionResult,
  type StateSnapshot,
  type WaiterPollResult,
} from "../src/shared/types.ts";

const TOKEN = "test-token-0123456789";
const server = createServer();
let base = "";
let port = 0;
/** Folders the server asked the desktop to open. */
const openedFolders: string[] = [];
/** Sessions the server asked a terminal to start, and the error the next start fails with, if any. */
const startedSessions: NewSession[] = [];
let nextStartFails: string | null = null;

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
      host: new SessionHost({
        store,
        agent: {
          name: "None",
          start: () => {
            throw new Error("no agent in these tests");
          },
        },
      }),
      launchCodes: new LaunchCodes(),
      token: TOKEN,
      allowedHosts: new Set([`127.0.0.1:${port}`]),
      webDir,
      openFolder: (path) => {
        openedFolders.push(path);
      },
      processes: new SessionProcesses({ pidInUse, isSameProcess }, store.revision),
      startSession: async (session) => {
        if (nextStartFails) throw new Error(nextStartFails);
        startedSessions.push(session);
      },
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

  test("is served for a folder's window, and only one path segment deep", async () => {
    for (const path of ["/shop-api", "/my%20project"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    }
    assert.equal((await fetch(`${base}/shop-api/x`)).status, 404);
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

describe("folder windows", () => {
  test("show the session asked for, else the folder's latest, with the folder's sessions", async () => {
    // A minute older, so two replies in the same millisecond can't tie.
    const aMinuteAgo = Date.now() / 1000 - 60;
    await call("POST", "/api/responses", { session_id: "f1", cwd: "/a/shop", text: "One.", created_at: aMinuteAgo });
    await call("POST", "/api/responses", { session_id: "f2", cwd: "/b/shop", text: "Two." });
    await call("POST", "/api/responses", { session_id: "f3", cwd: "/a/other", text: "Three." });

    const byFolder = await json<StateSnapshot>(call("GET", "/api/state?v=-1&s=&f=shop"));
    assert.equal(byFolder.session?.id, "f2", "no session named: the folder's latest");
    assert.equal(byFolder.folder, "shop");
    assert.deepEqual(
      byFolder.sessions.map((row) => [row.id, row.status]),
      [
        ["f2", "offline"],
        ["f1", "offline"],
      ],
    );
    assert.equal(byFolder.responses[0]?.text, "Two.");

    const asked = await json<StateSnapshot>(call("GET", "/api/state?v=-1&s=f1&f=shop"));
    assert.equal(asked.session?.id, "f1");
    assert.equal(asked.responses[0]?.text, "One.");

    const forgotten = await json<StateSnapshot>(call("GET", "/api/state?v=-1&s=gone&f=shop"));
    assert.equal(forgotten.session?.id, "f2", "a session sidenote forgot falls back to the latest");

    const oldLink = await json<StateSnapshot>(call("GET", "/api/state?v=-1&s=f3"));
    assert.equal(oldLink.folder, "other", "a link without a folder learns it from the session");

    const empty = await json<StateSnapshot>(call("GET", "/api/state?v=-1&s=&f=nothing-here"));
    assert.deepEqual([empty.session, empty.folder, empty.sessions], [null, "nothing-here", []]);
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

describe("open folder", () => {
  test("opens only the folder sidenote recorded for the session, and only while it exists", async () => {
    const folder = mkdtempSync(join(tmpdir(), "sidenote-folder-"));
    await call("POST", "/api/sessions", { session_id: "o1", cwd: folder });
    await call("POST", "/api/sessions", { session_id: "o2", cwd: join(folder, "gone") });
    const open = (body: object, headers: Record<string, string> = {}) =>
      call("POST", "/api/open-folder", body, headers);

    assert.equal((await open({ session_id: "o1" })).status, 204);
    assert.equal((await open({ session_id: "o1", cwd: "/etc" })).status, 204, "a path in the request is ignored");
    assert.equal((await open({ session_id: "o2" })).status, 404, "the folder no longer exists");
    assert.equal((await open({ session_id: "unknown" })).status, 404);
    assert.equal((await open({ session_id: "../x" })).status, 400);
    assert.equal((await open({ session_id: "o1" }, { "X-Review-Token": "wrong" })).status, 403);
    assert.deepEqual(openedFolders, [folder, folder]);
  });
});

describe("starting a session", () => {
  test("opens a terminal in the folder sidenote recorded, and lists the new session right away", async () => {
    const folder = mkdtempSync(join(tmpdir(), "sidenote-start-"));
    await call("POST", "/api/sessions", { session_id: "st1", cwd: folder });
    const start = (body: object) => call("POST", "/api/sessions/start", body);

    const response = await start({ session_id: "st1", prompt: " --help me ", cwd: "/etc" });
    assert.equal(response.status, 201);
    const { session_id } = (await response.json()) as StartSessionResult;
    assert.match(session_id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(startedSessions.at(-1), { cwd: folder, sessionId: session_id, prompt: "--help me", name: "" });

    const state = await json<StateSnapshot>(call("GET", `/api/state?v=-1&s=${session_id}`));
    assert.equal(state.session?.id, session_id, "selectable before Claude's first reply");
    assert.equal(state.session?.cwd, folder);
    assert.equal(state.can_start_sessions, true);

    assert.equal((await start({ session_id: "st1" })).status, 201, "a prompt is optional");
    assert.equal(startedSessions.at(-1)?.prompt, "");
    assert.equal((await start({ session_id: "unknown" })).status, 404);
    assert.equal((await start({ session_id: "st1", prompt: "x".repeat(MAX_PROMPT_CHARS + 1) })).status, 400);
    assert.equal((await start({ session_id: "st1", prompt: 42 })).status, 400);
  });

  test("says why a terminal didn't open, and lists nothing then", async () => {
    const folder = mkdtempSync(join(tmpdir(), "sidenote-start-"));
    await call("POST", "/api/sessions", { session_id: "st2", cwd: folder });
    const before = (await json<SessionListResult>(call("GET", "/api/sessions"))).sessions.length;
    nextStartFails = "Not authorized to send Apple events to Terminal.";
    try {
      const response = await call("POST", "/api/sessions/start", { session_id: "st2" });
      assert.equal(response.status, 502);
      assert.match(((await response.json()) as ErrorResult).error, /Not authorized to send Apple events/);
    } finally {
      nextStartFails = null;
    }
    assert.equal((await json<SessionListResult>(call("GET", "/api/sessions"))).sessions.length, before);
  });

  test("is refused where there is no terminal to open", async () => {
    const store = new Store();
    store.touchSession("st3", "", mkdtempSync(join(tmpdir(), "sidenote-start-")));
    const allowedHosts = new Set<string>();
    const bare = createServer(
      createApp({
        store,
        delivery: new Delivery(store),
        host: new SessionHost({ store, agent: { name: "None", start: () => assert.fail("no agent here") } }),
        launchCodes: new LaunchCodes(),
        token: TOKEN,
        allowedHosts,
        webDir: tmpdir(),
        openFolder: () => {},
        startSession: null,
        processes: new SessionProcesses({ pidInUse, isSameProcess }, store.revision),
      }),
    );
    await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve));
    const address = bare.address();
    const bareBase = `127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    allowedHosts.add(bareBase);
    try {
      const headers = { "X-Review-Token": TOKEN, "Content-Type": "application/json" };
      const state = await (await fetch(`http://${bareBase}/api/state?v=-1&s=st3`, { headers })).json();
      assert.equal((state as StateSnapshot).can_start_sessions, false);
      const response = await fetch(`http://${bareBase}/api/sessions/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({ session_id: "st3" }),
      });
      assert.equal(response.status, 501);
    } finally {
      bare.close();
    }
  });
});

describe("renaming, ending and removing sessions", () => {
  const sessions = async (folder: string) =>
    (await json<StateSnapshot>(call("GET", `/api/state?v=-1&s=&f=${folder}`))).sessions;

  test("a name given in the window shows instead of the /rename name, until it is cleared", async () => {
    await call("POST", "/api/responses", { session_id: "rn", session_name: "auth", cwd: "/x/rename", text: "Hi." });
    assert.equal((await call("POST", "/api/sessions/rename", { session_id: "rn", label: "DM-1782" })).status, 204);
    assert.deepEqual(
      (await sessions("rename")).map((row) => [row.label, row.name]),
      [["DM-1782", "auth"]],
    );
    await call("POST", "/api/sessions/rename", { session_id: "rn", label: "" });
    assert.equal((await sessions("rename"))[0]?.label, "");
    assert.equal((await call("POST", "/api/sessions/rename", { session_id: "nope", label: "x" })).status, 404);
  });

  test("/clear forgets a session unless Claude never got something the user wrote", async () => {
    const cleared = (session_id: string): Promise<{ forgotten: boolean }> =>
      json(call("POST", "/api/sessions/cleared", { session_id }));
    await call("POST", "/api/responses", { session_id: "cl-done", cwd: "/x/clear", text: "Hi." });
    const { response } = await json<NewResponseResult>(
      call("POST", "/api/responses", { session_id: "cl-note", cwd: "/x/clear", text: "Hi." }),
    );
    await call("POST", "/api/comments", { response_id: response.id, block_index: 0, quote: "", body: "unsent" });

    assert.deepEqual(await cleared("cl-done"), { forgotten: true });
    assert.deepEqual(await cleared("cl-note"), { forgotten: false });
    assert.deepEqual(
      (await sessions("clear")).map((row) => row.id),
      ["cl-note"],
    );
    assert.deepEqual(await cleared("cl-unknown"), { forgotten: false }, "nothing to forget is fine");
    const anonymous = await fetch(`${base}/api/sessions/cleared`, { method: "POST", body: "{}" });
    assert.equal(anonymous.status, 403);
    assert.equal((await call("POST", "/api/sessions/cleared", { session_id: "../evil" })).status, 400);
  });

  test("ending a session stops the Claude process its hooks reported, and takes it off the list", async () => {
    const claude = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    const exited = once(claude, "exit");
    try {
      const reported = { pid: claude.pid!, started: processInfo(claude.pid!)!.started };
      await call("POST", "/api/responses", { session_id: "en", cwd: "/x/end", text: "Hi." });
      assert.equal(
        (await call("POST", "/api/sessions/end", { session_id: "en" })).status,
        409,
        "no hook has reported its process yet",
      );
      await call("POST", "/api/claim", { session_id: "en", claude_process: reported });
      assert.equal((await sessions("end"))[0]?.process, "running");
      assert.equal(
        (await call("POST", "/api/sessions/forget", { session_id: "en" })).status,
        409,
        "a running session is ended, not just removed",
      );

      assert.equal((await call("POST", "/api/sessions/end", { session_id: "en" })).status, 204);
      const [, signal] = await exited;
      assert.equal(signal, "SIGTERM");
      assert.deepEqual(await sessions("end"), []);
    } finally {
      claude.kill();
    }
  });

  test("a session whose process ended shows as ended and can be removed; a reused pid is left alone", async () => {
    const gone = spawn(process.execPath, ["-e", ""]);
    const started = processInfo(gone.pid!)?.started ?? "0";
    await once(gone, "exit");
    await call("POST", "/api/responses", { session_id: "rm", cwd: "/x/remove", text: "Hi." });
    await call("POST", "/api/claim", { session_id: "rm", claude_process: { pid: gone.pid, started } });
    assert.equal((await sessions("remove"))[0]?.process, "ended");
    assert.equal((await call("POST", "/api/sessions/forget", { session_id: "rm" })).status, 204);
    assert.deepEqual(await sessions("remove"), []);
    assert.equal((await call("POST", "/api/sessions/forget", { session_id: "rm" })).status, 404);

    await call("POST", "/api/responses", { session_id: "rp", cwd: "/x/reused", text: "Hi." });
    await call("POST", "/api/claim", { session_id: "rp", claude_process: { pid: process.pid, started: "long ago" } });
    assert.equal((await call("POST", "/api/sessions/end", { session_id: "rp" })).status, 204);
    assert.deepEqual(await sessions("reused"), [], "removed from the list, but the test process still runs");
  });

  test("a new session started with a name gets it in the window and in Claude", async () => {
    const folder = mkdtempSync(join(tmpdir(), "sidenote-start-"));
    await call("POST", "/api/sessions", { session_id: "nm", cwd: folder });
    const response = await call("POST", "/api/sessions/start", { session_id: "nm", name: " DM-1782  OAuth " });
    const { session_id } = (await response.json()) as StartSessionResult;
    assert.equal(startedSessions.at(-1)?.name, "DM-1782 OAuth");
    const state = await json<StateSnapshot>(call("GET", `/api/state?v=-1&s=${session_id}`));
    assert.equal(state.session?.label, "DM-1782 OAuth");
  });
});

describe("editing a note", () => {
  const noteIn = async (session: string): Promise<Note> => {
    const { response } = await json<NewResponseResult>(
      call("POST", "/api/responses", { session_id: session, cwd: "/elsewhere/edits", text: "Hi." }),
    );
    return json<Note>(
      call("POST", "/api/comments", { response_id: response.id, block_index: 0, quote: "", body: "a" }),
    );
  };
  const bodyOf = async (session: string, id: number): Promise<string | undefined> =>
    (await json<StateSnapshot>(call("GET", `/api/state?v=-1&s=${session}`))).comments.find((n) => n.id === id)?.body;

  test("rewrites a pending note, through the same checks as any body", async () => {
    const note = await noteIn("edit-pending");
    assert.equal((await call("PATCH", `/api/comments/${note.id}`, { body: " better " })).status, 204);
    assert.equal(await bodyOf("edit-pending", note.id), "better");
    assert.equal((await call("PATCH", `/api/comments/${note.id}`, { body: "  " })).status, 400);
    assert.equal((await call("PATCH", `/api/comments/${note.id}`, [])).status, 400);
    assert.equal((await call("PATCH", `/api/comments/${note.id}`, { body: "x".repeat(20_001) })).status, 400);
    assert.equal((await call("PATCH", "/api/comments/999999", { body: "x" })).status, 404);
  });

  test("refuses a note that was sent", async () => {
    const note = await noteIn("edit-sent");
    await call("POST", "/api/claim", { session_id: "edit-sent" });
    assert.equal((await call("PATCH", `/api/comments/${note.id}`, { body: "late" })).status, 409);
    assert.equal(await bodyOf("edit-sent", note.id), "a");
  });

  test("refuses a note Send now is about to deliver", async () => {
    const note = await noteIn("edit-sending");
    const waiter = "ab".repeat(8);
    await call("POST", "/api/waiters", { session_id: "edit-sending", waiter_id: waiter });
    await call("POST", "/api/send", { session_ids: ["edit-sending"] });
    assert.equal((await call("PATCH", `/api/comments/${note.id}`, { body: "late" })).status, 409);
    assert.equal(await bodyOf("edit-sending", note.id), "a");
  });
});
