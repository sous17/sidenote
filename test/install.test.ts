// `sidenote install` and `uninstall`: they add and remove only sidenote's own hooks.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Sandbox } from "./sandbox.ts";

const read = (file: string): Record<string, any> => JSON.parse(readFileSync(file, "utf8"));

test("Codex: merges into hooks.json, keeps the user's hooks, and reinstalls without duplicates", async () => {
  const sandbox = new Sandbox();
  const codexHome = join(sandbox.home, "codex-home");
  const file = join(codexHome, "hooks.json");
  mkdirSync(codexHome);
  const userHook = { hooks: [{ type: "command", command: "/usr/local/bin/my-audit.sh" }] };
  writeFileSync(file, JSON.stringify({ hooks: { Stop: [userHook] } }));
  const env = { CODEX_HOME: codexHome };

  const installed = await sandbox.run(["install", "codex"], "", env);
  assert.match(installed.stdout, /run \/hooks and trust/);
  await sandbox.run(["install", "codex"], "", env);
  const config = read(file);
  assert.deepEqual(Object.keys(config["hooks"]).sort(), ["SessionStart", "Stop", "UserPromptSubmit"]);
  assert.equal(config["hooks"]["Stop"].length, 2, "the user's hook and one of sidenote's");
  assert.deepEqual(config["hooks"]["Stop"][0], userHook);
  const ours = config["hooks"]["Stop"][1]["hooks"][0];
  assert.match(ours.command, /bin\/sidenote" hook codex stop$/);
  assert.equal(ours.type, "command");

  await sandbox.run(["uninstall", "codex"], "", env);
  assert.deepEqual(read(file), { hooks: { Stop: [userHook] } });
});

test("Cursor: writes version 1 flat entries and removes only its own", async () => {
  const sandbox = new Sandbox();
  const file = join(sandbox.home, ".cursor", "hooks.json");
  await sandbox.run(["install", "cursor"]);
  const config = read(file);
  assert.equal(config["version"], 1);
  assert.deepEqual(Object.keys(config["hooks"]).sort(), [
    "afterAgentResponse",
    "beforeSubmitPrompt",
    "sessionStart",
    "stop",
  ]);
  assert.match(config["hooks"]["afterAgentResponse"][0].command, /hook cursor after-response$/);

  config["hooks"]["stop"].push({ command: "./my-stop.sh" });
  writeFileSync(file, JSON.stringify(config));
  await sandbox.run(["uninstall", "cursor"]);
  assert.deepEqual(read(file), { version: 1, hooks: { stop: [{ command: "./my-stop.sh" }] } });
});

test("Copilot: a file of sidenote's own, removed on uninstall", async () => {
  const sandbox = new Sandbox();
  const file = join(sandbox.home, ".copilot", "hooks", "sidenote.json");
  const installed = await sandbox.run(["install", "copilot"]);
  assert.match(installed.stdout, /experimental/);
  const config = read(file);
  assert.equal(config["version"], 1);
  assert.deepEqual(Object.keys(config["hooks"]).sort(), ["agentStop", "sessionStart", "userPromptSubmitted"]);
  assert.equal(config["hooks"]["agentStop"][0].timeoutSec, 30);
  await sandbox.run(["uninstall", "copilot"]);
  assert.equal(existsSync(file), false);
});

test("refuses to touch a config that isn't a JSON object, and explains Claude Code's plugin", async () => {
  const sandbox = new Sandbox();
  mkdirSync(join(sandbox.home, ".cursor"));
  writeFileSync(join(sandbox.home, ".cursor", "hooks.json"), "[]");
  const result = await sandbox.run(["install", "cursor"]);
  assert.match(readFileSync(join(sandbox.home, ".cursor", "hooks.json"), "utf8"), /^\[\]$/);
  assert.notEqual(result.code, 0);
  assert.match((await sandbox.run(["install", "claude"])).stdout, /plugin install sidenote@sidenote/);
  assert.match((await sandbox.run(["install"])).stdout, /Usage: sidenote install/);
});
