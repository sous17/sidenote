import assert from "node:assert/strict";
import { test } from "node:test";
import { canStartSessions, terminalCommand } from "../src/node/terminal.ts";

const session = { cwd: "/home/me/shop api", sessionId: "11111111-2222-3333-4444-555555555555", prompt: "", name: "" };
const hostile = `--dangerously-skip-permissions "; rm -rf ~ #' $(id)`;

test("on Linux, GNOME Terminal runs claude in the folder, the prompt one argument after --", () => {
  assert.deepEqual(terminalCommand("linux", { ...session, prompt: hostile, name: "-x DM-1782" }), [
    "gnome-terminal",
    [
      `--working-directory=/home/me/shop api`,
      "--",
      "claude",
      "--session-id",
      session.sessionId,
      "--name=-x DM-1782",
      "--",
      hostile,
    ],
  ]);
  assert.deepEqual(terminalCommand("linux", session)?.[1].slice(2), ["claude", "--session-id", session.sessionId]);
});

test("on macOS, the folder, id, name and prompt reach the script as arguments, never as script text", () => {
  const command = terminalCommand("darwin", { ...session, prompt: hostile, name: hostile });
  assert.equal(command?.[0], "osascript");
  const args = command![1];
  assert.deepEqual(args.slice(-5), [session.cwd, "--session-id", session.sessionId, hostile, hostile]);
  const script = args.slice(0, -5).join("\n");
  assert.ok(!script.includes(hostile) && !script.includes("shop"));
  assert.match(script, /quoted form of \("--name=" & item 4 of argv\)/, "the name stays one shell word");
  assert.match(script, /" -- " & quoted form of item 5 of argv/, "the prompt comes after --");
  assert.deepEqual(terminalCommand("darwin", session)?.[1].slice(-4), [
    session.cwd,
    "--session-id",
    session.sessionId,
    "",
  ]);
});

test("other systems have no terminal to start sessions in", () => {
  assert.equal(terminalCommand("win32", session), null);
  assert.equal(canStartSessions("win32"), false);
  assert.equal(canStartSessions("darwin"), true);
});

test("resuming continues the session's id instead of starting one with it", () => {
  const resumed = { ...session, prompt: "", name: "", resume: true };
  assert.deepEqual(terminalCommand("linux", resumed)?.[1].slice(2), ["claude", "--resume", session.sessionId]);
  assert.deepEqual(terminalCommand("darwin", resumed)?.[1].slice(-4), [session.cwd, "--resume", session.sessionId, ""]);
});
