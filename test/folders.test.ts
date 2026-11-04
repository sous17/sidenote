import assert from "node:assert/strict";
import { test } from "node:test";
import { folderFromPath, folderName, folderPath } from "../src/shared/folders.ts";

test("a session's folder is the last segment of its cwd", () => {
  assert.equal(folderName("/home/me/github/shop-api"), "shop-api");
  assert.equal(folderName("/home/me/github/shop-api/"), "shop-api");
  assert.equal(folderName(""), "", "an unknown cwd names no folder");
});

test("folder paths survive the round trip through the URL", () => {
  for (const folder of ["shop-api", "my project", "ä?#%", ".claude"]) {
    assert.equal(folderFromPath(new URL(folderPath(folder), "http://h").pathname), folder);
  }
  assert.equal(folderPath(""), "/");
});

test("only a single path segment names a folder", () => {
  assert.equal(folderFromPath("/"), "");
  assert.equal(folderFromPath("/a/b"), "");
  assert.equal(folderFromPath("/%E0%A4%A"), "", "malformed percent-encoding");
});
