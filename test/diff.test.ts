import assert from "node:assert/strict";
import { test } from "node:test";
import { CODE_CHANGE_RULE, formatNotesForClaude, sessionContext } from "../src/shared/format.ts";
import { editedParts, looksLikeDiff, parseUnifiedDiff } from "../src/shared/diff.ts";
import type { ClaimedNote } from "../src/shared/types.ts";

const TWO_FILES = `diff --git a/src/rateLimit.ts b/src/rateLimit.ts
index 3f2a1c4..9b8e7d2 100644
--- a/src/rateLimit.ts
+++ b/src/rateLimit.ts
@@ -18,4 +18,5 @@ export function rateLimit(bucket) {
     const result = await bucket.take(req.apiKey);
+    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
-      res.setHeader("Retry-After", String(result.retryAfter));
+      res.setHeader("Retry-After", String(Math.ceil(result.retryAfter)));
--- a/test/old.test.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-it("old", () => {});
-
`;

test("splits a diff into files, with paths and counts", () => {
  const files = parseUnifiedDiff(TWO_FILES);
  assert.deepEqual(
    files.map((f) => [f.path, f.additions, f.deletions]),
    [
      ["src/rateLimit.ts", 2, 1],
      ["test/old.test.ts", 0, 2],
    ],
    "a deleted file keeps its old path",
  );
  assert.deepEqual(
    files[0]!.lines.map((l) => l.kind),
    ["hunk", "context", "add", "del", "add"],
    "git metadata lines are dropped",
  );
  assert.equal(files[0]!.lines[0]!.text, "export function rateLimit(bucket) {");
});

test("marks the edited words of a line changed in place", () => {
  const [, , added, removed, replaced] = parseUnifiedDiff(TWO_FILES)[0]!.lines;
  assert.equal(added!.parts, undefined, "a plain addition has nothing to compare with");
  // Common prefix and suffix around the edit; "Math.ceil(...)" adds a ")", so the suffix is "));".
  assert.deepEqual(removed!.parts, ['      res.setHeader("Retry-After", String(', "result.retryAfter", "));"]);
  assert.deepEqual(replaced!.parts, [
    '      res.setHeader("Retry-After", String(',
    "Math.ceil(result.retryAfter)",
    "));",
  ]);
  const lines = parseUnifiedDiff("-a(x)\n+a(Math.ceil(x))\n")[0]!.lines;
  assert.deepEqual(lines[0]!.parts, ["a(", "x", ")"]);
  assert.deepEqual(lines[1]!.parts, ["a(", "Math.ceil(x)", ")"]);
  assert.deepEqual(editedParts("same", "same"), [
    ["same", "", ""],
    ["same", "", ""],
  ]);
});

test("accepts hand-written diffs without headers", () => {
  const files = parseUnifiedDiff("@@ -1 +1 @@\n-old\n+new\nplain line without a prefix\n");
  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, "");
  assert.deepEqual(
    files[0]!.lines.map((l) => [l.kind, l.text]),
    [
      ["hunk", ""],
      ["del", "old"],
      ["add", "new"],
      ["context", "plain line without a prefix"],
    ],
  );
  assert.deepEqual(parseUnifiedDiff(""), []);
});

test("the instructions sent with notes ask for code as diffs", () => {
  const note: ClaimedNote = {
    id: 1,
    response_id: 1,
    block_index: 0,
    quote: "",
    body: "Show me the code",
    parent_id: null,
    created_at: 0,
    delivered_at: 0,
    answered_by: null,
    response_created_at: 0,
    root_body: null,
  };
  assert.ok(formatNotesForClaude([note]).includes(CODE_CHANGE_RULE));
  assert.ok(formatNotesForClaude([note], { sendNow: true }).includes(CODE_CHANGE_RULE));
  assert.match(CODE_CHANGE_RULE, /```diff/);
});

test("recognizes unlabeled diffs, and leaves plain code alone", () => {
  assert.equal(looksLikeDiff("--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b"), true);
  assert.equal(looksLikeDiff("@@ -3,2 +3,2 @@\n-old\n+new"), true);
  assert.equal(looksLikeDiff("diff --git a/x b/x\n+added"), true);
  assert.equal(looksLikeDiff("const a = 1;\n-x;\n+y;"), false, "no header: could be plain code");
  assert.equal(looksLikeDiff("- item one\n- item two"), false, "a markdown list is not a diff");
  assert.equal(looksLikeDiff("@@ -1 +1 @@\n unchanged only"), false, "a header with no changes");
});

test("every session is asked for diffs while sidenote is on", () => {
  assert.ok(sessionContext().includes(CODE_CHANGE_RULE));
  assert.match(CODE_CHANGE_RULE, /not only in command output/);
});
