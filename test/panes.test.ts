import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// paths.ts reads HOME on every call, and each test file runs in its own process.
process.env["HOME"] = mkdtempSync(join(tmpdir(), "sidenote-panes-"));
const { claimPane, hasLivePane, panePlan, shellQuote } = await import("../src/cli/panes.ts");

const COMMAND = ["/plugin/bin/sidenote", "tui", "s1"];

test("splits tmux beside Claude's own pane, keeping the focus there", () => {
  const plan = panePlan({ TMUX: "/tmp/tmux-501/default,1,0", TMUX_PANE: "%12" }, COMMAND, "/w/demo");
  assert.deepEqual(plan, {
    terminal: "tmux",
    steps: [
      {
        command: "tmux",
        args: ["split-window", "-h", "-d", "-l", "45%", "-t", "%12", "-c", "/w/demo", ...COMMAND],
      },
    ],
  });
});

test("splits WezTerm, then gives the focus back to Claude's pane", () => {
  const plan = panePlan({ WEZTERM_PANE: "7" }, COMMAND, "");
  assert.equal(plan?.terminal, "WezTerm");
  assert.deepEqual(plan?.steps, [
    {
      command: "wezterm",
      args: ["cli", "split-pane", "--pane-id", "7", "--right", "--percent", "45", "--", ...COMMAND],
    },
    { command: "wezterm", args: ["cli", "activate-pane", "--pane-id", "7"] },
  ]);
});

test("uses kitty only when its remote control socket is known", () => {
  assert.equal(panePlan({ KITTY_WINDOW_ID: "3" }, COMMAND, "/w"), null);
  const plan = panePlan({ KITTY_WINDOW_ID: "3", KITTY_LISTEN_ON: "unix:/tmp/kitty" }, COMMAND, "/w");
  assert.deepEqual(plan?.steps[0]?.args, [
    "@",
    "launch",
    "--type=window",
    "--location=vsplit",
    "--keep-focus",
    "--bias=45",
    "--next-to=id:3",
    "--cwd=/w",
    ...COMMAND,
  ]);
});

test("ignores pane ids that don't look like ids, and other terminals", () => {
  assert.equal(panePlan({}, COMMAND, "/w"), null);
  assert.equal(panePlan({ TMUX_PANE: "%1" }, COMMAND, "/w"), null, "TMUX_PANE alone isn't tmux");
  assert.equal(panePlan({ TMUX: "x", TMUX_PANE: "%1; kill-server" }, COMMAND, "/w"), null);
  assert.equal(panePlan({ WEZTERM_PANE: "1 --top-level" }, COMMAND, "/w"), null);
  assert.equal(panePlan({ TERM_PROGRAM: "Apple_Terminal" }, COMMAND, "/w"), null);
});

test("a pane is live while its process runs, and its record goes when it quits", () => {
  assert.equal(hasLivePane("s1"), false);
  const release = claimPane("s1");
  assert.equal(hasLivePane("s1"), true);
  release();
  assert.equal(hasLivePane("s1"), false);
  assert.equal(hasLivePane("../escape"), false, "session ids are checked before use as file names");
});

test("quotes the launcher for pasting into a shell", () => {
  assert.equal(shellQuote("/Users/me/my plugins/it's/sidenote"), `'/Users/me/my plugins/it'\\''s/sidenote'`);
});
