import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenWindows, WINDOW_SEEN_MS } from "../src/server/windows.ts";
import { FakeClock } from "./helpers.ts";

test("a folder's window counts as open until its polls stop, however slow a hidden tab polls", () => {
  const clock = new FakeClock();
  const windows = new OpenWindows(clock);
  assert.equal(windows.isOpen("shop"), false);

  windows.seen("shop");
  clock.advanceMs(60_000);
  assert.equal(windows.isOpen("shop"), true, "a hidden tab polls about once a minute");
  assert.equal(windows.isOpen("other"), false);

  clock.advanceMs(WINDOW_SEEN_MS);
  assert.equal(windows.isOpen("shop"), false);
});
