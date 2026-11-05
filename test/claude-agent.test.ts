import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ClaudeAgent, ClaudeStream, claudeArgs, overridingSettings, startingMode } from "../src/agent/claude.ts";
import type { AgentDriver, AgentEvent } from "../src/agent/driver.ts";
import { paths } from "../src/node/paths.ts";

const FAKE_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");

const lines = (...messages: object[]): string[] => messages.map((message) => JSON.stringify(message));

test("reads Claude Code's stream-json output as agent events", () => {
  const stream = new ClaudeStream();
  const events = lines(
    { type: "system", subtype: "init", session_id: "s1", model: "claude-x" },
    {
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
    },
    {
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } },
    },
    {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "text", text: "Hello" },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
        ],
        usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
      },
    },
    {
      type: "user",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }] },
    },
    { type: "result", subtype: "success", total_cost_usd: 0.5, modelUsage: { "claude-x": { contextWindow: 1000 } } },
  ).flatMap((line) => stream.read(line));
  assert.deepEqual(events, [
    { type: "ready", session_id: "s1", model: "claude-x" },
    { type: "text_delta", text: "Hel" },
    { type: "text", text: "Hello" },
    { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
    { type: "usage", context_tokens: 152, context_window: null },
    { type: "tool_result", id: "t1", failed: true },
    { type: "usage", context_tokens: null, context_window: 1000 },
    { type: "turn_end", end: { outcome: "done", error: "", cost_usd: 0.5 } },
  ]);
});

test("leaves out subagents' messages and lines that aren't JSON objects", () => {
  const stream = new ClaudeStream();
  const events = [
    ...lines({
      type: "assistant",
      parent_tool_use_id: "agent-1",
      message: { content: [{ type: "text", text: "inner" }] },
    }),
    "not json",
    "[1,2]",
    "null",
  ].flatMap((line) => stream.read(line));
  assert.deepEqual(events, []);
});

test("an error result after an interrupt reads as interrupted, otherwise as an error", () => {
  const stream = new ClaudeStream();
  stream.interrupting = true;
  const [interrupted] = stream.read(
    JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }),
  );
  assert.deepEqual(interrupted, { type: "turn_end", end: { outcome: "interrupted", error: "", cost_usd: null } });
  const [failed] = stream.read(
    JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in" }),
  );
  assert.deepEqual(failed, { type: "turn_end", end: { outcome: "error", error: "Not logged in", cost_usd: null } });
});

test("permission requests keep Claude Code's suggestions for an always-allow answer", () => {
  const stream = new ClaudeStream();
  const suggestion = { type: "setMode", mode: "acceptEdits", destination: "session" };
  const [event] = stream.read(
    JSON.stringify({
      type: "control_request",
      request_id: "r1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Write",
        description: "a.txt",
        input: { a: 1 },
        permission_suggestions: [suggestion],
      },
    }),
  );
  assert.deepEqual(event, {
    type: "permission",
    request: { request_id: "r1", tool_name: "Write", description: "a.txt", input: { a: 1 } },
  });
  assert.deepEqual(stream.takeSuggestions("r1"), [suggestion]);
  assert.deepEqual(stream.takeSuggestions("r1"), []);
});

test("starts new sessions with their id and resumes earlier ones", () => {
  const fresh = claudeArgs({ sessionId: "abc", cwd: "/w", resume: false });
  assert.ok(
    fresh.includes("--permission-prompt-tool") && fresh.at(fresh.indexOf("--permission-prompt-tool") + 1) === "stdio",
  );
  assert.deepEqual(fresh.slice(-2), ["--session-id", "abc"]);
  const resumed = claudeArgs({ sessionId: "abc", cwd: "/w", resume: true, instructions: "Use diffs." });
  assert.deepEqual(resumed.slice(-4), ["--resume", "abc", "--append-system-prompt", "Use diffs."]);
});

test("sessions start in auto mode, as at the terminal, unless the user's settings chose a mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "sidenote-settings-"));
  const file = join(dir, "settings.json");
  const modeFor = (contents: string): string | null => {
    writeFileSync(file, contents);
    return startingMode(file);
  };
  const withMode = (defaultMode: unknown): string => JSON.stringify({ permissions: { defaultMode } });

  assert.equal(startingMode(join(dir, "missing.json")), "auto", "no settings file");
  assert.equal(modeFor("{}"), "auto");
  assert.equal(modeFor('{"permissions":{"allow":["Bash(ls)"]}}'), "auto", "rules alone choose no mode");
  for (const mode of ["auto", "acceptEdits", "dontAsk", "plan"]) assert.equal(modeFor(withMode(mode)), mode);

  assert.equal(modeFor(withMode("manual")), null, "the user asked to be asked");
  assert.equal(modeFor(withMode("default")), null);
  assert.equal(modeFor(withMode("bypassPermissions")), null, "sidenote never turns the checks off");
  assert.equal(modeFor(withMode("--dangerously-skip-permissions")), null, "only known modes reach the command");
  assert.equal(modeFor(withMode(7)), null);
  assert.equal(modeFor("{ not json"), null, "a choice we can't read still keeps it asking");
  assert.equal(modeFor("null"), null);
  assert.equal(startingMode(dir), null, "unreadable, not missing");
});

test("a mode set above the user's settings means no flag, so Claude Code applies its own rules", () => {
  const dir = mkdtempSync(join(tmpdir(), "sidenote-settings-"));
  const user = join(dir, "user.json");
  const project = join(dir, "project.json");
  const withMode = (defaultMode: unknown): string => JSON.stringify({ permissions: { defaultMode } });
  writeFileSync(user, withMode("acceptEdits"));

  assert.equal(startingMode(user, [join(dir, "missing.json")]), "acceptEdits");
  writeFileSync(project, "{}");
  assert.equal(startingMode(user, [project]), "acceptEdits", "a project file that chooses nothing");
  for (const mode of ["plan", "default", "auto", "bypassPermissions"]) {
    writeFileSync(project, withMode(mode));
    assert.equal(startingMode(user, [project]), null, `${mode} never reaches the flag from a project`);
  }
  writeFileSync(project, "{ not json");
  assert.equal(startingMode(user, [project]), null, "a choice we can't read still keeps it asking");
});

test("a folder's project settings are found, with the local file at the repository's root", () => {
  const root = mkdtempSync(join(tmpdir(), "sidenote-repo-"));
  const folder = join(root, "packages", "shop");
  mkdirSync(folder, { recursive: true });
  mkdirSync(join(root, ".git"));
  const files = overridingSettings(folder);
  assert.ok(files.includes(join(folder, ".claude", "settings.json")));
  assert.ok(files.includes(join(folder, ".claude", "settings.local.json")));
  assert.ok(files.includes(join(root, ".claude", "settings.local.json")));
  assert.ok(!files.includes(join(root, ".claude", "settings.json")), "the shared file is read from cwd only");
});

test("a cancelled control request becomes an event, and drops its suggestions", () => {
  const stream = new ClaudeStream();
  stream.read(
    JSON.stringify({
      type: "control_request",
      request_id: "r1",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: {}, permission_suggestions: [{ type: "x" }] },
    }),
  );
  assert.deepEqual(stream.read(JSON.stringify({ type: "control_cancel_request", request_id: "r1" })), [
    { type: "permission_cancelled", request_id: "r1" },
  ]);
  assert.deepEqual(stream.takeSuggestions("r1"), []);
});

test("the mode goes to Claude Code as a flag, and no mode passes none", () => {
  const start = { sessionId: "abc", cwd: "/w", resume: false };
  const args = claudeArgs({ ...start, permissionMode: "auto" });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "auto");
  assert.equal(claudeArgs({ ...start, permissionMode: null }).includes("--permission-mode"), false);
  assert.equal(claudeArgs(start).includes("--permission-mode"), false);
});

test("Claude Code's settings are found through CLAUDE_CONFIG_DIR when it is set", (t) => {
  const before = process.env["CLAUDE_CONFIG_DIR"];
  t.after(() => {
    if (before === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = before;
  });
  process.env["CLAUDE_CONFIG_DIR"] = "/w/config";
  assert.equal(paths.claudeSettings(), "/w/config/settings.json");
  delete process.env["CLAUDE_CONFIG_DIR"];
  assert.match(paths.claudeSettings(), /\/\.claude\/settings\.json$/);
});

/** Runs the fake claude, collecting its events; next() waits for the next one of a type. */
function startFake(resume = false, settings?: object) {
  const dir = mkdtempSync(join(tmpdir(), "sidenote-agent-"));
  const settingsFile = join(dir, "settings.json");
  if (settings) writeFileSync(settingsFile, JSON.stringify(settings));
  const logFile = join(dir, "log.jsonl");
  process.env["FAKE_CLAUDE_LOG"] = logFile;
  const events: AgentEvent[] = [];
  const waiters: Array<() => void> = [];
  const agent = new ClaudeAgent({ command: FAKE_CLAUDE, instructions: "Use diffs.", settingsFile });
  const driver: AgentDriver = agent.start({ sessionId: "sess-1", cwd: dir, resume }, (event) => {
    events.push(event);
    for (const wake of waiters.splice(0)) wake();
  });
  let seen = 0;
  const next = async <T extends AgentEvent["type"]>(type: T): Promise<Extract<AgentEvent, { type: T }>> => {
    for (;;) {
      const index = events.findIndex((event, i) => i >= seen && event.type === type);
      if (index >= 0) {
        seen = index + 1;
        return events[index] as Extract<AgentEvent, { type: T }>;
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  const log = () =>
    readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { dir, driver, events, next, log };
}

test("a new process gets the mode from the settings at that moment", async () => {
  for (const [settings, expected] of [
    [undefined, "auto"],
    [{ permissions: { defaultMode: "acceptEdits" } }, "acceptEdits"],
    [{ permissions: { defaultMode: "manual" } }, undefined],
  ] as const) {
    const { driver, next, log } = startFake(false, settings);
    driver.send("hello");
    await next("turn_end");
    driver.close();
    const args = log()[0]!["args"] as string[];
    const flag = args.indexOf("--permission-mode");
    assert.equal(flag < 0 ? undefined : args[flag + 1], expected);
  }
});

test("runs Claude Code headless: messages, streamed replies and the session's folder", async () => {
  const { dir, driver, next, log } = startFake();
  driver.send("hello");
  assert.deepEqual(await next("ready"), { type: "ready", session_id: "sess-1", model: "fake-model" });
  assert.equal((await next("text_delta")).text, "Thinking ");
  assert.equal((await next("text")).text, "You said: hello");
  assert.equal((await next("turn_end")).end.outcome, "done");
  driver.send("again");
  assert.equal((await next("text")).text, "You said: again");
  driver.close();
  assert.equal((await next("exit")).message, "Claude Code stopped.");
  const [start] = log();
  assert.equal(realpathSync(start!["cwd"] as string), realpathSync(dir));
  assert.equal(start!["headless"], "1", "sidenote's own hooks must be able to tell they run headless");
});

test("answers permission prompts, with Claude Code's suggestion for always", async () => {
  const { driver, next, log } = startFake();
  driver.send("please write a file");
  const { request } = await next("permission");
  assert.equal(request.tool_name, "Write");
  driver.answer(request, "always");
  assert.deepEqual(await next("tool_result"), { type: "tool_result", id: "tool-1", failed: false });
  assert.equal((await next("text")).text, "Wrote the file.");
  driver.send("write another");
  driver.answer((await next("permission")).request, "deny");
  assert.equal((await next("text")).text, "Okay, I won't.");
  driver.close();
  await next("exit");
  const answers = log()
    .map((entry) => entry["received"] as { type: string; response?: { response: object } } | undefined)
    .filter((message) => message?.type === "control_response")
    .map((message) => message!.response!.response);
  assert.deepEqual(answers, [
    {
      behavior: "allow",
      updatedInput: { file_path: "a.txt", content: "hi" },
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    },
    { behavior: "deny", message: "The user declined this in sidenote." },
  ]);
});

test("interrupts a turn and keeps the process for the next message", async () => {
  const { driver, next } = startFake();
  driver.send("something slow");
  await next("text_delta");
  driver.interrupt();
  assert.equal((await next("turn_end")).end.outcome, "interrupted");
  driver.send("still there?");
  assert.equal((await next("text")).text, "You said: still there?");
  driver.close();
  await next("exit");
});

test("reports a crash with the last line Claude Code printed", async () => {
  const { driver, next } = startFake(true);
  driver.send("crash now");
  assert.equal((await next("exit")).message, "Claude Code stopped (exit 3): something broke");
});

test("reports a missing claude command instead of throwing", async () => {
  const events: AgentEvent[] = [];
  const driver = new ClaudeAgent({ command: "/nonexistent/claude" }).start(
    { sessionId: "s", cwd: tmpdir(), resume: false },
    (event) => events.push(event),
  );
  driver.send("hello");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(events.length, 1);
  assert.match((events[0] as { message: string }).message, /^Couldn't start Claude Code: .*ENOENT/);
});
