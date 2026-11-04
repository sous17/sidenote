import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_ACTIVITY_CHARS, toolActivity, toolSummary } from "../src/shared/tools.ts";

test("tool rows name what the call works on, relative to the session's folder", () => {
  assert.equal(toolSummary("Edit", { file_path: "/w/shop/src/a.ts" }, "/w/shop"), "src/a.ts");
  assert.equal(toolSummary("Read", { file_path: "/etc/hosts" }, "/w/shop"), "/etc/hosts");
  assert.equal(toolSummary("Bash", { command: "npm test\nnpm run lint" }, "/w"), "npm test …");
  assert.equal(toolSummary("Grep", { pattern: "TODO", path: "/w/shop/src" }, "/w/shop"), "TODO in src");
  assert.equal(toolSummary("TodoWrite", { todos: [] }, "/w"), "");
  assert.equal(toolSummary("mcp__x__lookup", { count: 3, query: "pizza" }, "/w"), "pizza");
});

test("an activity line says what a call works on, and never what it writes", () => {
  const edit = { file_path: "/w/shop/src/a.ts", old_string: "secret old", new_string: "secret new" };
  assert.equal(toolActivity("Edit", edit, "/w/shop"), "Editing src/a.ts");
  assert.equal(toolActivity("Write", { file_path: "/w/a.ts", content: "code" }, "/w"), "Writing a.ts");
  assert.equal(toolActivity("Bash", { command: "npm test\nnpm run lint" }, "/w"), "Running npm test …");
  assert.equal(toolActivity("mcp__mail__send", { body: "private" }, "/w"), "Using mcp__mail__send");
  assert.equal(toolActivity("TodoWrite", { todos: [] }, "/w"), "", "not a step worth showing");
  assert.equal(toolActivity("Bash", { command: "x".repeat(500) }, "/w").length, MAX_ACTIVITY_CHARS);
});
