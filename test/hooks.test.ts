// End to end: the built launcher and CLI against a real server, in a scratch HOME.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Note, RedeemResult, ServerInfo, StateSnapshot } from "../src/shared/types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(root, "bin", "sidenote");
const home = mkdtempSync(join(tmpdir(), "sidenote-home-"));
const opened = join(home, "opened.txt");
const tmuxArgs = join(home, "tmux-args.txt");
const SESSION = "e2e-session";

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Set by terminals that can split; a test that runs inside tmux must not split it for real. */
const TERMINAL_VARIABLES = ["TMUX", "TMUX_PANE", "WEZTERM_PANE", "KITTY_WINDOW_ID", "KITTY_LISTEN_ON"];

function run(args: string[], stdin = "", terminal: Record<string, string> = {}): Promise<Run> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${join(home, "fakebin")}:${process.env["PATH"]}`,
    SIDENOTE_NODE: process.execPath,
  };
  for (const name of TERMINAL_VARIABLES) delete env[name];
  const child = spawn(launcher, args, { env: { ...env, ...terminal } });
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

let openedCount = 0;

/** The next URL the stand-in browser is asked to open. The opener runs detached, so wait for it. */
async function lastOpened(): Promise<URL> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const lines = existsSync(opened) ? readFileSync(opened, "utf8").trim().split("\n") : [];
    if (lines.length > openedCount) {
      openedCount = lines.length;
      return new URL(lines.at(-1)!);
    }
    if (Date.now() > deadline) throw new Error("the browser was not opened");
    await sleep(50);
  }
}

before(() => {
  assert.ok(existsSync(join(root, "dist", "cli.js")), "run npm run build first");
  // Stand-ins for the browser openers: record the URL instead of opening a tab.
  mkdirSync(join(home, "fakebin"));
  for (const opener of ["open", "xdg-open"]) {
    writeFileSync(join(home, "fakebin", opener), `#!/bin/sh\necho "$1" >> "${opened}"\n`);
    chmodSync(join(home, "fakebin", opener), 0o755);
  }
  // A stand-in tmux that records how it was asked to split.
  writeFileSync(join(home, "fakebin", "tmux"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${tmuxArgs}"\n`);
  chmodSync(join(home, "fakebin", "tmux"), 0o755);
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
  assert.equal(url.search, "", "no session yet");
  assert.match(url.hash, /^#launch=[\w-]{32}$/);
  assert.ok(!url.href.includes(server().token));

  const redeem = (): Promise<Response> =>
    fetch(`${url.origin}/api/launch/redeem`, {
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
  assert.equal((await lastOpened()).searchParams.get("s"), SESSION);
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

test("while on, each session start asks Claude for code changes as diffs", async () => {
  const result = await run(["hook-session"], hookInput({ source: "startup" }));
  const output = JSON.parse(result.stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(output.hookSpecificOutput.additionalContext, /```diff block/);
});

test("status and open act on the session", async () => {
  const status = await run(["status", SESSION]);
  assert.match(status.stdout, /enabled: yes/);
  assert.match(status.stdout, /replies: 2/);
  assert.match(status.stdout, /pending notes: 0/);
  assert.match(
    status.stdout,
    new RegExp(`terminal: '${launcher}' tui ${SESSION}\n`),
    "the command for a terminal pane",
  );
  assert.doesNotMatch(status.stdout, new RegExp(server().token), "status never prints the token");

  await run(["open"]);
  assert.equal((await lastOpened()).searchParams.get("s"), SESSION, "open without a session picks the latest");
});

test("in the terminal, a new session opens a pane beside Claude, or says how to", async () => {
  const on = await run(["on", "", "terminal"]);
  assert.match(on.stdout, /^sidenote is on\. To read replies and leave notes in the terminal/);
  assert.ok(on.stdout.includes(`'${launcher}' tui ${SESSION}`), "the command to run in another pane");
  assert.match((await run(["status"])).stdout, /shows in: terminal/);

  const tmux = { TMUX: "/tmp/tmux-501/default,1234,0", TMUX_PANE: "%3" };
  const reply = (session: string): string =>
    JSON.stringify({ session_id: session, cwd: "/w/other", last_assistant_message: "hello" });
  const browserOpens = readFileSync(opened, "utf8").split("\n").length;
  const split = await run(["hook-stop"], reply("term-1"), tmux);
  assert.equal(split.stdout, "", "nothing to tell the user when the pane opened");
  assert.deepEqual(readFileSync(tmuxArgs, "utf8").trim().split("\n"), [
    "split-window",
    "-h",
    "-d",
    "-l",
    "45%",
    "-t",
    "%3",
    "-c",
    "/w/other",
    launcher,
    "tui",
    "term-1",
  ]);
  assert.equal(readFileSync(opened, "utf8").split("\n").length, browserOpens, "no browser window");

  // A terminal that can't split gets the command once, with the session's first reply.
  const first = await run(["hook-stop"], reply("term-2"));
  const message = (JSON.parse(first.stdout) as { systemMessage: string }).systemMessage;
  assert.ok(message.includes(`'${launcher}' tui term-2`));
  assert.equal((await run(["hook-stop"], reply("term-2"))).stdout, "", "not again on later replies");

  // A running pane isn't opened twice.
  mkdirSync(join(home, ".sidenote", "panes"), { recursive: true });
  writeFileSync(join(home, ".sidenote", "panes", "term-1.pid"), `${process.pid}\n`);
  rmSync(tmuxArgs);
  assert.match((await run(["open", "term-1"], "", tmux)).stdout, /already open in a terminal pane/);
  assert.equal(existsSync(tmuxArgs), false);

  assert.match((await run(["on", "", "sideways"])).stdout, /isn't a choice/);
  assert.match((await run(["on", "", "browser"])).stdout, /^sidenote is on\. Opened the .* window in your browser/);
  await lastOpened();
});

test("off stops the server and hooks go quiet", async () => {
  assert.match((await run(["off"])).stdout, /sidenote is off/);
  await sleep(300);
  const prompt = await run(["hook-prompt"], hookInput({}));
  assert.equal(prompt.code, 0);
  assert.equal(prompt.stdout, "");
});
