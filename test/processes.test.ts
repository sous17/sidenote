import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionProcesses } from "../src/server/processes.ts";
import { Revision } from "../src/server/store.ts";

function fixture() {
  const alive = new Set<number>([100]);
  const revision = new Revision();
  const processes = new SessionProcesses(
    {
      pidInUse: (pid) => alive.has(pid),
      isSameProcess: (recorded) => alive.has(recorded.pid) && recorded.started === "t100",
    },
    revision,
  );
  return { alive, revision, processes };
}

test("a session's process is unknown until a hook reports it, then running until it ends", () => {
  const { alive, processes } = fixture();
  assert.equal(processes.state("s"), "unknown");
  processes.record("s", undefined);
  assert.equal(processes.state("s"), "unknown", "a hook that found no Claude process changes nothing");
  processes.record("s", { pid: 100, started: "t100" });
  assert.equal(processes.state("s"), "running");
  assert.deepEqual(processes.running("s"), { pid: 100, started: "t100" });
  alive.delete(100);
  assert.equal(processes.state("s"), "ended");
  assert.equal(processes.running("s"), undefined);
});

test("only the recorded process counts as running, not a later one that got its pid", () => {
  const { processes } = fixture();
  processes.record("s", { pid: 100, started: "earlier" });
  assert.equal(processes.state("s"), "running", "shown as running: the pid is taken");
  assert.equal(processes.running("s"), undefined, "but never ended: it isn't the same process");
});

test("pages hear about a process ending once", () => {
  const { alive, revision, processes } = fixture();
  processes.record("s", { pid: 100, started: "t100" });
  processes.refresh();
  const before = revision.value;
  processes.refresh();
  assert.equal(revision.value, before, "nothing changed");
  alive.delete(100);
  processes.refresh();
  assert.equal(revision.value, before + 1);
});
