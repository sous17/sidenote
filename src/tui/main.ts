// sidenote tui: a session's replies in this terminal, to leave notes without a browser.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ApiError, SidenoteClient } from "../cli/client.ts";
import { paths } from "../node/paths.ts";
import { SESSION_ID_PATTERN } from "../shared/types.ts";
import type { AnsiOptions } from "./ansi.ts";
import { ClientApi } from "./api.ts";
import { App, type Terminal } from "./app.ts";
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

/** sidenote's own palettes need 24-bit color. SIDENOTE_COLOR can say otherwise. */
function supportsPalette(env: NodeJS.ProcessEnv): boolean {
  const choice = env["SIDENOTE_COLOR"];
  if (choice === "basic") return false;
  if (choice === "truecolor" || choice === "light" || choice === "dark") return true;
  const program = env["TERM_PROGRAM"] ?? "";
  return (
    ["truecolor", "24bit"].includes(env["COLORTERM"] ?? "") ||
    ["iTerm.app", "WezTerm", "vscode", "ghostty"].includes(program) ||
    Boolean(env["KITTY_WINDOW_ID"] || env["WT_SESSION"])
  );
}

/** The first guess at the theme. Most terminals then report their real background to the app. */
function startsLight(env: NodeJS.ProcessEnv): boolean {
  if (env["SIDENOTE_COLOR"] === "light") return true;
  if (env["SIDENOTE_COLOR"] === "dark") return false;
  const background = Number((env["COLORFGBG"] ?? "").split(";").pop());
  return background === 7 || background === 15;
}

export function terminalOptions(env: NodeJS.ProcessEnv): AnsiOptions {
  return {
    color: !env["NO_COLOR"] && env["TERM"] !== "dumb",
    hyperlinks: supportsHyperlinks(env),
    truecolor: supportsPalette(env),
    light: startsLight(env),
    themeFixed: env["SIDENOTE_COLOR"] === "light" || env["SIDENOTE_COLOR"] === "dark",
  };
}

export async function runTui(args: string[]): Promise<void> {
  if (!needsTerminal("sidenote tui")) return;
  if (!existsSync(paths.enabledFlag())) {
    console.error("sidenote is off. Turn it on in Claude Code with /sidenote:on, then run sidenote tui again.");
    process.exitCode = 1;
    return;
  }
  const requested = sessionArgument(args);
  if (requested === false) return;

  const { client } = await SidenoteClient.ensure();
  const { app, running } = startScreen(
    (terminal) =>
      new App({
        api: new ClientApi(client),
        ansi: terminalOptions(process.env),
        sessionId: requested ?? null,
        cwd: process.cwd(),
        terminal,
      }),
    () => {},
  );
  while (running()) {
    await app.refresh();
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * sidenote chat: a session sidenote runs, in this terminal. Without a session id, a new one
 * starts in this folder. The agent runs in the sidenote server, so it keeps working if this
 * window closes, and `sidenote chat <id>` picks the session up again.
 */
export async function runChat(args: string[]): Promise<void> {
  if (!needsTerminal("sidenote chat")) return;
  const requested = sessionArgument(args);
  if (requested === false) return;

  const { client } = await SidenoteClient.ensure();
  const api = new ClientApi(client, { startServer: true });
  let sessionId: string;
  try {
    sessionId = await api.startConversation(process.cwd(), requested);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
    console.error(error.detail);
    process.exitCode = 1;
    return;
  }
  const { app, running } = startScreen(
    (terminal) =>
      new App({
        api,
        chat: api,
        ansi: terminalOptions(process.env),
        sessionId,
        cwd: process.cwd(),
        home: homedir(),
        terminal,
      }),
    () => process.stderr.write(`To continue this session: sidenote chat ${sessionId}\n`),
  );
  // The working timer in the top line moves on even while nothing else changes.
  setInterval(() => app.render(), 1000).unref();
  // Two long polls: one for replies and notes, one for the turn in progress.
  const poll = async (step: () => Promise<void>): Promise<void> => {
    while (running()) {
      try {
        await step();
      } catch {
        await sleep(POLL_INTERVAL_MS);
      }
    }
  };
  await Promise.all([poll(() => app.refresh({ wait: true })), poll(() => app.refreshConversation({ wait: true }))]);
}

function needsTerminal(command: string): boolean {
  if (process.stdin.isTTY && process.stdout.isTTY) return true;
  console.error(`${command} needs a terminal.`);
  process.exitCode = 1;
  return false;
}

/** The session id given on the command line, undefined if none, or false if it is malformed. */
function sessionArgument(args: string[]): string | undefined | false {
  const requested = args.find((arg) => !arg.startsWith("-"));
  if (requested === undefined || SESSION_ID_PATTERN.test(requested)) return requested;
  console.error("That doesn't look like a Claude Code session id.");
  process.exitCode = 2;
  return false;
}

/** Takes over the terminal for the app, feeding it keys in order; onExit runs as it quits. */
function startScreen(create: (terminal: Terminal) => App, onExit: () => void): { app: App; running: () => boolean } {
  const screen = new Screen(process.stdin, process.stdout);
  let running = true;
  const quit = (code = 0): never => {
    running = false;
    screen.stop();
    onExit();
    process.exit(code);
  };
  const app = create({
    size: () => screen.size(),
    draw: (rows, cursor) => screen.draw(rows, cursor),
    editText: async (text) => screen.suspend(() => editInEditor(text)),
    quit: () => quit(),
  });
  for (const signal of ["SIGTERM", "SIGHUP"] as const) process.on(signal, () => quit());
  process.on("uncaughtException", (error) => {
    screen.stop();
    onExit();
    console.error(`sidenote stopped: ${error.message}`);
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
  return { app, running: () => running };
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
