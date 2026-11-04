// End to end: the built launcher and CLI against a real server, in a scratch HOME.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  PAGE_HOST,
  type Note,
  type RedeemResult,
  type ServerInfo,
  type StartSessionResult,
  type StateSnapshot,
} from "../src/shared/types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(root, "bin", "sidenote");
const home = mkdtempSync(join(tmpdir(), "sidenote-home-"));
const opened = join(home, "opened.txt");
const terminalArgs = join(home, "terminal-args");
const SESSION = "e2e-session";

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], stdin = ""): Promise<Run> {
  const child = spawn(launcher, args, {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${join(home, "fakebin")}:${process.env["PATH"]}`,
      SIDENOTE_NODE: process.execPath,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
  child.stdin.end(stdin);
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

const hookInput = (fields: Record<string, string>): string =>
  JSON.stringify({ session_id: SESSION, cwd: "/w/demo", ...fields });

function server(): ServerInfo {
  return JSON.parse(readFileSync(join(home, ".sidenote", "server.json"), "utf8")) as ServerInfo;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { port, token } = server();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "X-Review-Token": token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()) as T;
}

/** fetch() can't set Host, so this goes through node:http. */
function statusWithHost(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server().port, path: "/demo", headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

let openedCount = 0;

/** The next thing the stand-in opener is asked to open. The opener runs detached, so wait for it. */
async function nextOpened(): Promise<string> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const lines = existsSync(opened) ? readFileSync(opened, "utf8").trim().split("\n") : [];
    if (lines.length > openedCount) {
      openedCount = lines.length;
      return lines.at(-1)!;
    }
    if (Date.now() > deadline) throw new Error("nothing was opened");
    await sleep(50);
  }
}

/** The next URL the stand-in browser is asked to open. */
async function lastOpened(): Promise<URL> {
  return new URL(await nextOpened());
}

before(() => {
  assert.ok(existsSync(join(root, "dist", "cli.js")), "run npm run build first");
  // Stand-ins for the browser openers: record the URL instead of opening a tab.
  mkdirSync(join(home, "fakebin"));
  for (const opener of ["open", "xdg-open"]) {
    writeFileSync(join(home, "fakebin", opener), `#!/bin/sh\necho "$1" >> "${opened}"\n`);
    chmodSync(join(home, "fakebin", opener), 0o755);
  }
  // Stand-ins for the terminals: record the arguments instead of opening a window.
  for (const terminal of ["gnome-terminal", "osascript"]) {
    writeFileSync(join(home, "fakebin", terminal), `#!/bin/sh\nprintf '%s\\0' "$@" > "${terminalArgs}"\n`);
    chmodSync(join(home, "fakebin", terminal), 0o755);
  }
});

after(async () => {
  await run(["off"]);
});

test("hooks do nothing while sidenote is off", async () => {
  const result = await run(["hook-stop"], hookInput({ last_assistant_message: "hi" }));
  assert.equal(result.code, 0);
  assert.equal(existsSync(join(home, ".sidenote", "server.json")), false);
  assert.equal((await run(["hook-session"], hookInput({ source: "startup" }))).stdout, "");
});

test("windows open with a single-use launch code, never the token", async () => {
  const on = await run(["on"]);
  assert.equal(on.code, 0);
  assert.match(on.stdout, /sidenote is on\. Opened the sidenote window/);
  const url = await lastOpened();
  assert.equal(url.host, `${PAGE_HOST}:${server().port}`);
  assert.equal(url.pathname, "/");
  assert.equal(url.search, "", "no session yet");
  assert.match(url.hash, /^#launch=[\w-]{32}$/);
  assert.ok(!url.href.includes(server().token));
  assert.equal(await statusWithHost(`${PAGE_HOST}:${server().port}`), 200, "the server answers its page host");

  // Node may resolve the page host to ::1, where the server doesn't listen.
  const redeem = (): Promise<Response> =>
    fetch(`http://127.0.0.1:${server().port}/api/launch/redeem`, {
      method: "POST",
      body: JSON.stringify({ code: url.hash.slice("#launch=".length) }),
    });
  assert.equal(((await (await redeem()).json()) as RedeemResult).token, server().token);
  assert.equal((await redeem()).status, 403, "the code works once");

  // A placeholder that wasn't expanded falls back to the latest session (none yet).
  await run(["open", "${CLAUDE_SESSION_ID}"]);
  assert.equal((await lastOpened()).search, "");
});

test("Stop, Send now waking Claude with exit code 2, and a terminal prompt instead", async () => {
  // Claude finishes a session's first reply: the hook posts it and opens that session's window.
  assert.equal((await run(["hook-stop"], hookInput({ last_assistant_message: "Para one." }))).code, 0);
  const url = await lastOpened();
  assert.equal(url.pathname, "/demo", "the window is the session's folder");
  assert.equal(url.searchParams.get("s"), SESSION);
  const waiter = run(["hook-wait"], hookInput({}));
  await sleep(1500);
  let state = await api<StateSnapshot>("GET", `/api/state?v=-1&s=${SESSION}`);
  assert.equal(state.session?.status, "listening");
  assert.equal(state.session?.name, "", "no transcript, so no name");

  // The user writes a note and clicks Send now.
  const note = await api<Note>("POST", "/api/comments", {
    response_id: state.responses[0]!.id,
    block_index: 0,
    quote: "Para one.",
    body: "Expand",
  });
  await api("POST", "/api/send", { session_ids: [SESSION] });
  const woke = await waiter;
  assert.equal(woke.code, 2);
  assert.match(woke.stderr, /clicked Send now/);
  assert.match(woke.stderr, new RegExp(`Note ${note.id}, on your response`));

  // Claude answers under the marker; the answer lands in the note's thread.
  await run(["hook-stop"], hookInput({ last_assistant_message: `**↳ Re: note ${note.id}**\nExpanded.` }));
  state = await api<StateSnapshot>("GET", `/api/state?v=-1&s=${SESSION}`);
  assert.equal(state.responses.at(-1)?.text, "");
  assert.equal(state.responses.at(-1)?.note_answers[String(note.id)], "Expanded.");

  // A terminal prompt instead: the next waiter stands down, and the prompt carries the notes.
  const nextWaiter = run(["hook-wait"], hookInput({}));
  await sleep(1200);
  await api("POST", "/api/comments", { parent_id: note.id, body: "Shorter please" });
  const prompt = await run(["hook-prompt"], hookInput({}));
  const context = (JSON.parse(prompt.stdout) as { hookSpecificOutput: { additionalContext: string } })
    .hookSpecificOutput.additionalContext;
  assert.match(context, /Their earlier note: Expand\nFollow-up: Shorter please/);
  assert.equal((await nextWaiter).code, 0);
});

test("a message typed in the page wakes Claude through the waiter, like Send now", async () => {
  const waiter = run(["hook-wait"], hookInput({}));
  await sleep(1500);
  await api("POST", "/api/prompt", { session_id: SESSION, text: "Now write the README" });
  const woke = await waiter;
  assert.equal(woke.code, 2);
  assert.match(woke.stderr, /sent you this message from the sidenote browser window/);
  assert.match(woke.stderr, /Now write the README/);

  await run(["hook-stop"], hookInput({ last_assistant_message: "Wrote it." }));
  let state = await api<StateSnapshot>("GET", `/api/state?v=-1&s=${SESSION}`);
  assert.equal(state.messages.at(-1)?.text, "Now write the README");

  // Prompts typed in the terminal show too, but sidenote's own wake-up text never does.
  await run(["hook-prompt"], hookInput({ prompt: "And a changelog" }));
  await run(["hook-prompt"], hookInput({ prompt: woke.stderr }));
  state = await api<StateSnapshot>("GET", `/api/state?v=-1&s=${SESSION}`);
  assert.deepEqual(
    state.messages.map((m) => [m.text, m.source]),
    [
      ["Now write the README", "page"],
      ["And a changelog", "terminal"],
    ],
  );
});

test("while on, each session start asks Claude for code changes as diffs", async () => {
  const result = await run(["hook-session"], hookInput({ source: "startup" }));
  const output = JSON.parse(result.stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(output.hookSpecificOutput.additionalContext, /```diff block/);
});

test("while on, each session start asks Claude to put its questions in its reply", async () => {
  const result = await run(["hook-session"], hookInput({ source: "startup" }));
  const output = JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } };
  assert.match(output.hookSpecificOutput.additionalContext, /don't use the AskUserQuestion tool/);
  assert.match(output.hookSpecificOutput.additionalContext, /then end your turn/);
});

test("status and open act on the session", async () => {
  const status = await run(["status", SESSION]);
  assert.match(status.stdout, /enabled: yes/);
  assert.match(status.stdout, /replies: 3/);
  assert.match(status.stdout, /pending notes: 0/);
  assert.match(status.stdout, new RegExp(`window: +http://${PAGE_HOST}:\\d+/demo\\n`));
  assert.doesNotMatch(status.stdout, new RegExp(server().token), "status never prints the token");

  await run(["open"]);
  assert.equal((await lastOpened()).searchParams.get("s"), SESSION, "open without a session picks the latest");
});

test("the server opens a session's folder with the system's opener", async () => {
  await api("POST", "/api/sessions", { session_id: "folder-session", cwd: home });
  const { port, token } = server();
  const response = await fetch(`http://127.0.0.1:${port}/api/open-folder`, {
    method: "POST",
    headers: { "X-Review-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: "folder-session" }),
  });
  assert.equal(response.status, 204);
  assert.equal(await nextOpened(), home);
});

test("starting a session opens a terminal running claude in the session's folder", async () => {
  await api("POST", "/api/sessions", { session_id: "folder-session", cwd: home });
  const { port, token } = server();
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions/start`, {
    method: "POST",
    headers: { "X-Review-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: "folder-session", prompt: "-v fix it" }),
  });
  assert.equal(response.status, 201);
  const { session_id } = (await response.json()) as StartSessionResult;
  const args = readFileSync(terminalArgs, "utf8").split("\0").slice(0, -1);
  if (process.platform === "darwin") {
    assert.equal(args[0], "-e");
    assert.deepEqual(args.slice(-3), [home, session_id, "-v fix it"]);
  } else {
    assert.deepEqual(args, [
      `--working-directory=${home}`,
      "--",
      "claude",
      "--session-id",
      session_id,
      "--",
      "-v fix it",
    ]);
  }
});

test("clients starting the server at the same moment all end up on one server", async () => {
  // Enabled, with no server running: as when a server crashes.
  await run(["off"]);
  await sleep(300);
  writeFileSync(join(home, ".sidenote", "enabled"), "");
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      run(["hook-stop"], hookInput({ last_assistant_message: `Reply ${index}` })),
    ),
  );
  assert.deepEqual(
    results.map((result) => result.code),
    [0, 0, 0, 0],
  );
  const state = await api<StateSnapshot>("GET", `/api/state?v=-1&s=${SESSION}`);
  for (const index of [0, 1, 2, 3]) {
    assert.ok(
      state.responses.some((response) => response.text === `Reply ${index}`),
      `reply ${index} reached the server that is left`,
    );
  }
});

test("a tool call shows in the window while Claude works, and a subagent's doesn't", async () => {
  const session = "activity-session";
  const activity = async () => (await api<StateSnapshot>("GET", `/api/state?v=-1&s=${session}`)).session?.activity;
  const input = (fields: Record<string, unknown>): string =>
    JSON.stringify({ session_id: session, cwd: "/w/demo", tool_name: "Edit", ...fields });

  await run(["hook-stop"], hookInput({ session_id: session, last_assistant_message: "Hello." }));
  await run(["hook-prompt"], hookInput({ session_id: session, prompt: "Fix it" }));
  await run(["hook-activity"], input({ tool_input: { file_path: "/w/demo/a.ts", new_string: "code" } }));
  assert.equal(await activity(), "Editing a.ts");

  await run(["hook-activity"], input({ tool_input: { file_path: "/w/demo/b.ts" }, agent_id: "agent-1" }));
  assert.equal(await activity(), "Editing a.ts");
});

test("what Claude writes between tool calls shows in the window, and a subagent's doesn't", async () => {
  const session = "progress-session";
  const progress = async () => (await api<StateSnapshot>("GET", `/api/state?v=-1&s=${session}`)).session?.progress;
  const input = (fields: Record<string, unknown>): string =>
    JSON.stringify({ session_id: session, cwd: "/w/demo", message_id: "m1", index: 0, final: true, ...fields });

  await run(["hook-stop"], hookInput({ session_id: session, last_assistant_message: "Hello." }));
  await run(["hook-prompt"], hookInput({ session_id: session, prompt: "Fix it" }));
  await run(["hook-progress"], input({ delta: "Looking at it." }));
  assert.deepEqual(await progress(), ["Looking at it."]);

  await run(["hook-progress"], input({ message_id: "m2", delta: "Subagent text.", agent_id: "agent-1" }));
  await run(["hook-progress"], input({ message_id: "m3", delta: "" }));
  assert.deepEqual(await progress(), ["Looking at it."]);
});

test("restart replaces the server, keeps the replies and opens the window", async () => {
  const before = server();
  const result = await run(["restart", SESSION]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /sidenote restarted\. Opened the/);
  assert.notEqual(server().token, before.token, "a new server");
  assert.ok(await lastOpened());
  const state = await api<StateSnapshot>("GET", `/api/state?v=-1&s=${SESSION}`);
  assert.ok(state.responses.length > 0);
});

test("off stops the server and hooks go quiet", async () => {
  assert.match((await run(["off"])).stdout, /sidenote is off/);
  await sleep(300);
  const prompt = await run(["hook-prompt"], hookInput({}));
  assert.equal(prompt.code, 0);
  assert.equal(prompt.stdout, "");
});
