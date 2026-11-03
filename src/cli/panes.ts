// Opening sidenote tui in a pane beside Claude Code, in the terminals that can split from the
// command line: tmux, WezTerm, and kitty with remote control. Claude's pane keeps the focus.
// Each running pane records its pid, so a session never gets a second one.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../node/paths.ts";
import { SESSION_ID_PATTERN } from "../shared/types.ts";

/** The launcher, next to dist/: the plugin's bin/ isn't on the user's PATH. */
export const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "sidenote");

const PANE_PERCENT = 45;
const SPLIT_TIMEOUT_MS = 5000;

export interface Step {
  command: string;
  args: string[];
}

export interface PanePlan {
  terminal: "tmux" | "WezTerm" | "kitty";
  steps: Step[];
}

/** Quoted for a POSIX shell, so a folder with spaces or quotes still pastes as one word. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** The command that runs sidenote tui, for the session if known. */
export function tuiCommand(sessionId: string | undefined): string[] {
  return [LAUNCHER, "tui", ...(sessionId ? [sessionId] : [])];
}

/**
 * How to split the terminal Claude Code runs in, from the variables each terminal sets in its
 * panes. Commands run without a shell, and pane ids must look like ids, so nothing is
 * interpreted. kitty needs KITTY_LISTEN_ON: a hook may have no terminal to send the request to.
 */
export function panePlan(env: NodeJS.ProcessEnv, command: string[], cwd: string): PanePlan | null {
  const tmuxPane = env["TMUX_PANE"] ?? "";
  if (env["TMUX"] && /^%\d+$/.test(tmuxPane)) {
    const directory = cwd ? ["-c", cwd] : [];
    const split = ["split-window", "-h", "-d", "-l", `${PANE_PERCENT}%`, "-t", tmuxPane, ...directory, ...command];
    return { terminal: "tmux", steps: [{ command: "tmux", args: split }] };
  }
  const wezPane = env["WEZTERM_PANE"] ?? "";
  if (/^\d+$/.test(wezPane)) {
    const directory = cwd ? ["--cwd", cwd] : [];
    const split = ["cli", "split-pane", "--pane-id", wezPane, "--right", "--percent", `${PANE_PERCENT}`, ...directory];
    return {
      terminal: "WezTerm",
      steps: [
        { command: "wezterm", args: [...split, "--", ...command] },
        // The docs don't promise where focus goes after a split, so give it back to Claude.
        { command: "wezterm", args: ["cli", "activate-pane", "--pane-id", wezPane] },
      ],
    };
  }
  const kittyWindow = env["KITTY_WINDOW_ID"] ?? "";
  if (env["KITTY_LISTEN_ON"] && /^\d+$/.test(kittyWindow)) {
    const launch = [
      "@",
      "launch",
      "--type=window",
      "--location=vsplit",
      "--keep-focus",
      `--bias=${PANE_PERCENT}`,
      `--next-to=id:${kittyWindow}`,
      ...(cwd ? [`--cwd=${cwd}`] : []),
      ...command,
    ];
    return { terminal: "kitty", steps: [{ command: "kitten", args: launch }] };
  }
  return null;
}

/** Runs a plan; true when the split itself worked. */
export async function openPane(plan: PanePlan): Promise<boolean> {
  const [split, ...rest] = plan.steps;
  if (!split || !(await run(split))) return false;
  for (const step of rest) await run(step);
  return true;
}

function run({ command, args }: Step): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, SPLIT_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function paneFile(sessionId: string): string | null {
  return SESSION_ID_PATTERN.test(sessionId) ? join(paths.panesDir(), `${sessionId}.pid`) : null;
}

/** Whether a sidenote tui for this session is running. */
export function hasLivePane(sessionId: string): boolean {
  const file = paneFile(sessionId);
  if (!file) return false;
  let pid: number;
  try {
    pid = Number(readFileSync(file, "utf8").trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Gone, or EPERM: a process of another user took the pid, so it isn't our pane either.
    return false;
  }
}

/** Records this process as the session's pane; the returned function removes the record. */
export function claimPane(sessionId: string): () => void {
  const file = paneFile(sessionId);
  if (!file) return () => {};
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${process.pid}\n`, { mode: 0o600 });
  return () => {
    try {
      // Only remove it if no newer pane for the session has replaced the record.
      if (readFileSync(file, "utf8").trim() === String(process.pid)) rmSync(file, { force: true });
    } catch {
      // Already gone.
    }
  };
}

export interface PaneResult {
  opened: boolean;
  /** For the user: where the pane opened, or the command to run in one. */
  message: string;
}

/** Opens the session's sidenote tui beside Claude Code, unless one is running already. */
export async function openTerminal(
  sessionId: string | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<PaneResult> {
  if (sessionId && hasLivePane(sessionId)) {
    return { opened: true, message: "sidenote is already open in a terminal pane for this session." };
  }
  const command = tuiCommand(sessionId);
  const plan = panePlan(env, command, cwd);
  if (plan && (await openPane(plan))) {
    return { opened: true, message: `Opened sidenote in a ${plan.terminal} pane beside this one.` };
  }
  return {
    opened: false,
    message:
      `To read replies and leave notes in the terminal, run this in another pane: ` +
      `${command.map((part, i) => (i ? part : shellQuote(part))).join(" ")} ` +
      `(sidenote opens the pane itself in tmux, WezTerm, or kitty with remote control.)`,
  };
}
