import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { findClaude, isSameProcess, pidInUse, processInfo, type ProcessInfo } from "../src/node/process.ts";

/** A made-up process tree: node under a shell under Claude under a terminal. */
const tree = new Map<number, ProcessInfo>([
  [40, { ppid: 30, started: "t40", name: "node", args: "/usr/bin/node /p/dist/cli.js hook-stop" }],
  [30, { ppid: 20, started: "t30", name: "sh", args: "/bin/sh -c /p/bin/sidenote hook-stop" }],
  [20, { ppid: 10, started: "t20", name: "claude", args: "claude --session-id abc" }],
  [10, { ppid: 1, started: "t10", name: "gnome-terminal-", args: "/usr/libexec/gnome-terminal-server" }],
]);

test("a hook finds the Claude process above it, with its start time", () => {
  assert.deepEqual(
    findClaude(40, (pid) => tree.get(pid) ?? null),
    { pid: 20, started: "t20" },
  );
});

test("Claude run by node from an npm install counts too, and nothing else does", () => {
  const npm = new Map(tree);
  npm.set(20, { ppid: 10, started: "t20", name: "node", args: "node /n/@anthropic-ai/claude-code/cli.js" });
  assert.deepEqual(
    findClaude(40, (pid) => npm.get(pid) ?? null),
    { pid: 20, started: "t20" },
  );
  const none = new Map(tree);
  none.set(20, { ppid: 10, started: "t20", name: "bash", args: "bash" });
  assert.equal(
    findClaude(40, (pid) => none.get(pid) ?? null),
    null,
    "a hook run outside Claude reports nothing",
  );
});

test("this system's process table reads the running test, and tells a reused pid from the original", async () => {
  const self = processInfo(process.pid);
  assert.ok(self, "the test's own process is readable");
  assert.equal(self.ppid, process.ppid);
  assert.ok(self.started);
  assert.equal(isSameProcess({ pid: process.pid, started: self.started }), true);
  assert.equal(isSameProcess({ pid: process.pid, started: `${self.started}x` }), false, "same pid, other process");

  const child = spawn(process.execPath, ["-e", ""]);
  await once(child, "exit");
  assert.equal(processInfo(child.pid!), null, "a process that ended is gone");
  assert.equal(pidInUse(child.pid!), false);
  assert.equal(pidInUse(process.pid), true);
});
