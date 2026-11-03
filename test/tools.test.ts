import assert from "node:assert/strict";
import { test } from "node:test";
import { toolDetail, toolSummary } from "../src/shared/tools.ts";

test("tool rows name what the call works on, relative to the session's folder", () => {
  assert.equal(toolSummary("Edit", { file_path: "/w/shop/src/a.ts" }, "/w/shop"), "src/a.ts");
  assert.equal(toolSummary("Read", { file_path: "/etc/hosts" }, "/w/shop"), "/etc/hosts");
  assert.equal(toolSummary("Bash", { command: "npm test\nnpm run lint" }, "/w"), "npm test …");
  assert.equal(toolSummary("Grep", { pattern: "TODO", path: "/w/shop/src" }, "/w/shop"), "TODO in src");
  assert.equal(toolSummary("TodoWrite", { todos: [] }, "/w"), "");
  assert.equal(toolSummary("mcp__x__lookup", { count: 3, query: "pizza" }, "/w"), "pizza");
});

test("permission prompts show the call in full, clipped when long", () => {
  assert.equal(toolDetail("Bash", { command: "rm -rf build" }, "/w"), "rm -rf build");
  assert.equal(
    toolDetail("Edit", { file_path: "/w/a.ts", old_string: "a\nb", new_string: "c" }, "/w"),
    "a.ts\n- a\n- b\n+ c",
  );
  const long = toolDetail("Write", { file_path: "/w/big.txt", content: "line\n".repeat(100) }, "/w");
  assert.equal(long.split("\n").length, 41);
  assert.ok(long.endsWith("\n…"));
  assert.equal(toolDetail("Other", { a: 1 }, "/w"), '{\n  "a": 1\n}');
});
