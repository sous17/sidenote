import assert from "node:assert/strict";
import { test } from "node:test";
import { canStartSessions, terminalCommand } from "../src/node/terminal.ts";

const session = { cwd: "/home/me/shop api", sessionId: "11111111-2222-3333-4444-555555555555", prompt: "" };
const hostile = `--dangerously-skip-permissions "; rm -rf ~ #' $(id)`;

test("on Linux, GNOME Terminal runs claude in the folder, the prompt one argument after --", () => {
  assert.deepEqual(terminalCommand("linux", { ...session, prompt: hostile }), [
    "gnome-terminal",
    [`--working-directory=/home/me/shop api`, "--", "claude", "--session-id", session.sessionId, "--", hostile],
  ]);
  assert.deepEqual(terminalCommand("linux", session)?.[1].slice(2), ["claude", "--session-id", session.sessionId]);
});

test("on macOS, the folder, id and prompt reach the script as arguments, never as script text", () => {
  const command = terminalCommand("darwin", { ...session, prompt: hostile });
  assert.equal(command?.[0], "osascript");
  const args = command![1];
  assert.deepEqual(args.slice(-3), [session.cwd, session.sessionId, hostile]);
  const script = args.slice(0, -3);
  assert.ok(
    script.every((arg, index) => (index % 2 === 0 ? arg === "-e" : !arg.includes(hostile) && !arg.includes("shop"))),
  );
  assert.match(script.join("\n"), /quoted form of item 3 of argv/, "the prompt is shell-quoted by AppleScript");
  assert.match(script.join("\n"), /" -- " & quoted form of item 3/, "and comes after --");
  assert.deepEqual(terminalCommand("darwin", session)?.[1].slice(-2), [session.cwd, session.sessionId]);
});

test("other systems have no terminal to start sessions in", () => {
  assert.equal(terminalCommand("win32", session), null);
  assert.equal(canStartSessions("win32"), false);
  assert.equal(canStartSessions("darwin"), true);
});
