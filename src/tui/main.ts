// sidenote tui: a session's replies in this terminal, to leave notes without a browser.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SidenoteClient } from "../cli/client.ts";
import { claimPane } from "../cli/panes.ts";
import { paths } from "../node/paths.ts";
import { SESSION_ID_PATTERN } from "../shared/types.ts";
import type { AnsiOptions } from "./ansi.ts";
import { ClientApi } from "./api.ts";
import { App } from "./app.ts";
import { Screen } from "./screen.ts";

const POLL_INTERVAL_MS = 1000;

/** Terminals known to draw OSC 8 hyperlinks; others get the link's address as text only. */
function supportsHyperlinks(env: NodeJS.ProcessEnv): boolean {
  if (env["SIDENOTE_HYPERLINKS"] === "0") return false;
  if (env["SIDENOTE_HYPERLINKS"] === "1") return true;
  const program = env["TERM_PROGRAM"] ?? "";
  return (
    ["iTerm.app", "WezTerm", "vscode", "ghostty"].includes(program) ||
    Boolean(env["KITTY_WINDOW_ID"] || env["WT_SESSION"]) ||
    Number(env["VTE_VERSION"] ?? 0) >= 5000
  );
}

export function terminalOptions(env: NodeJS.ProcessEnv): AnsiOptions {
  return { color: !env["NO_COLOR"] && env["TERM"] !== "dumb", hyperlinks: supportsHyperlinks(env) };
}

export async function runTui(args: string[]): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("sidenote tui needs a terminal.");
    process.exitCode = 1;
    return;
  }
  if (!existsSync(paths.enabledFlag())) {
    console.error("sidenote is off. Turn it on in Claude Code with /sidenote:on, then run sidenote tui again.");
    process.exitCode = 1;
    return;
  }
  const requested = args.find((arg) => !arg.startsWith("-"));
  if (requested !== undefined && !SESSION_ID_PATTERN.test(requested)) {
    console.error("That doesn't look like a Claude Code session id.");
    process.exitCode = 2;
    return;
  }

  const { client } = await SidenoteClient.ensure();
  const screen = new Screen(process.stdin, process.stdout);
  let running = true;
  let releasePane = (): void => {};
  const quit = (code = 0): never => {
    running = false;
    screen.stop();
    releasePane();
    process.exit(code);
  };
  const app = new App({
    api: new ClientApi(client),
    ansi: terminalOptions(process.env),
    sessionId: requested ?? null,
    cwd: process.cwd(),
    terminal: {
      size: () => screen.size(),
      draw: (rows, cursor) => screen.draw(rows, cursor),
      editText: async (text) => screen.suspend(() => editInEditor(text)),
      quit: () => quit(),
    },
  });

  for (const signal of ["SIGTERM", "SIGHUP"] as const) process.on(signal, () => quit());
  process.on("uncaughtException", (error) => {
    screen.stop();
    releasePane();
    console.error(`sidenote tui stopped: ${error.message}`);
    process.exit(1);
  });

  // Keys are handled one at a time, in order, even when one waits for the server.
  let queue = Promise.resolve();
  screen.start(
    (keys) => {
      for (const key of keys) queue = queue.then(() => app.handleKey(key));
    },
    () => app.render(),
  );
  let claimed: string | null = null;
  while (running) {
    await app.refresh();
    // Once the session is known, record this pane, so sidenote doesn't open a second one for it.
    if (app.sessionId && app.sessionId !== claimed) {
      releasePane();
      releasePane = claimPane(app.sessionId);
      claimed = app.sessionId;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Opens the note in $VISUAL or $EDITOR in a private temporary file; null if that fails. */
function editInEditor(text: string): string | null {
  const editor = (process.env["VISUAL"] || process.env["EDITOR"] || "vi").trim().split(/\s+/);
  const dir = mkdtempSync(join(tmpdir(), "sidenote-note-"));
  const file = join(dir, "note.md");
  try {
    writeFileSync(file, text, { mode: 0o600 });
    const result = spawnSync(editor[0]!, [...editor.slice(1), file], { stdio: "inherit" });
    return result.status === 0 ? readFileSync(file, "utf8") : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
