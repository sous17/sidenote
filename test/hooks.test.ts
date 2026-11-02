// End to end: the built launcher and CLI against a real server, in a scratch HOME.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ServerInfo, StateSnapshot } from "../src/shared/types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(root, "bin", "sidenote");
const home = mkdtempSync(join(tmpdir(), "sidenote-home-"));
const SESSION = "e2e-session";

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], stdin = ""): Promise<Run> {
  // BROWSER=true keeps xdg-open quiet; on macOS "open" is replaced through PATH below.
  const child = spawn(launcher, args, {
    env: { ...process.env, HOME: home, PATH: `${join(home, "fakebin")}:${process.env["PATH"]}`, SIDENOTE_NODE: process.execPath },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
  child.stdin.end(stdin);
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

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

before(async () => {
  assert.ok(existsSync(join(root, "dist", "cli.js")), "run npm run build first");
  // Stand-ins for the browser openers, so tests don't open tabs.
  const { mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
  mkdirSync(join(home, "fakebin"));
  for (const opener of ["open", "xdg-open"]) {
    writeFileSync(join(home, "fakebin", opener), "#!/bin/sh\nexit 0\n");
    chmodSync(join(home, "fakebin", opener), 0o755);
  }
});

after(async () => {
  await run(["off"]);
});

test("hooks do nothing while sidenote is off", async () => {
  const result = await run(["hook-stop"], JSON.stringify({ session_id: SESSION, last_assistant_message: "hi" }));
  assert.equal(result.code, 0);
  assert.equal(existsSync(join(home, ".sidenote", "server.json")), false);
});

test("on, Stop, prompt, and Send now waking Claude with exit code 2", async () => {
  const on = await run(["on"]);
  assert.equal(on.code, 0);
  assert.match(on.stdout, /sidenote on: http:\/\/127\.0\.0\.1:\d+\/\?t=/);
  // A placeholder that wasn't expanded falls back to the latest session (none yet).
  assert.doesNotMatch((await run(["open", "${CLAUDE_SESSION_ID}"])).stdout, /&s=/);

  // Claude finishes a reply: the Stop hooks post it and start a waiter.
  const stop = await run(["hook-stop"], JSON.stringify({ session_id: SESSION, cwd: "/w/demo", last_assistant_message: "Para one." }));
  assert.equal(stop.code, 0);
  const waiter = run(["hook-wait"], JSON.stringify({ session_id: SESSION }));
  await sleep(1500);
  let state = await api<StateSnapshot>("GET", `/api/state?v=-1&s=${SESSION}`);
  assert.equal(state.session?.status, "listening");
  assert.equal(state.session?.name, "", "no transcript, so no name");

  // The user writes a note and clicks Send now.
  const replyId = state.responses[0]!.id;
  const note = await api<{ id: number }>("POST", "/api/comments", { response_id: replyId, block_index: 0, quote: "Para one.", body: "Expand" });
  await api("POST", "/api/send", { session_ids: [SESSION] });
  const woke = await waiter;
  assert.equal(woke.code, 2);
  assert.match(woke.stderr, /clicked Send now/);
  assert.match(woke.stderr, new RegExp(`Note ${note.id}, on your response`));

  // Claude answers under the marker; the answer lands in the note's thread.
  await run(["hook-stop"], JSON.stringify({ session_id: SESSION, cwd: "/w/demo", last_assistant_message: `**↳ Re: note ${note.id}**\nExpanded.` }));
  state = await api<StateSnapshot>("GET", `/api/state?v=-1&s=${SESSION}`);
  assert.equal(state.responses.at(-1)?.text, "");
  assert.equal(state.responses.at(-1)?.note_answers[String(note.id)], "Expanded.");

  // A terminal prompt instead: the next waiter stands down, and the prompt carries the notes.
  const nextWaiter = run(["hook-wait"], JSON.stringify({ session_id: SESSION }));
  await sleep(1200);
  await api("POST", "/api/comments", { parent_id: note.id, body: "Shorter please" });
  const prompt = await run(["hook-prompt"], JSON.stringify({ session_id: SESSION }));
  const context = JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext as string;
  assert.match(context, /Their earlier note: Expand\nFollow-up: Shorter please/);
  assert.equal((await nextWaiter).code, 0);

  const status = await run(["status", SESSION]);
  assert.match(status.stdout, /enabled: yes/);
  assert.match(status.stdout, /pending notes: 0/);
  assert.match(status.stdout, new RegExp(`window:  http://127\\.0\\.0\\.1:\\d+/\\?t=[^&]+&s=${SESSION}`));
  assert.match((await run(["open"])).stdout, new RegExp(`&s=${SESSION}`), "open without a session picks the latest");
});

test("off stops the server and hooks go quiet", async () => {
  const off = await run(["off"]);
  assert.match(off.stdout, /sidenote off/);
  await sleep(300);
  const prompt = await run(["hook-prompt"], JSON.stringify({ session_id: SESSION }));
  assert.equal(prompt.code, 0);
  assert.equal(prompt.stdout, "");
});
