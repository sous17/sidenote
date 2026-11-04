// Starts a new Claude Code session in a terminal window: GNOME Terminal on Linux, Terminal on macOS.
// A session needs a terminal, because Claude asks for permissions there.
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** A terminal that is still running after this long is waiting for the user, e.g. a permission dialog. */
const STILL_STARTING_MS = 3000;

export interface NewSession {
  cwd: string;
  sessionId: string;
  /** The first prompt; "" starts Claude without one. */
  prompt: string;
  /** The session's name in Claude Code, which also titles the terminal; "" for none. */
  name: string;
}

export type TerminalCommand = readonly [command: string, args: readonly string[]];

// AppleScript's `quoted form of` makes each argument one shell word; nothing from the request is
// ever part of the script itself.
const MACOS_SCRIPT = [
  "on run argv",
  'set theCommand to "cd " & quoted form of item 1 of argv & " && claude --session-id " & quoted form of item 2 of argv',
  'if item 3 of argv is not "" then set theCommand to theCommand & " " & quoted form of ("--name=" & item 3 of argv)',
  'if (count of argv) > 3 then set theCommand to theCommand & " -- " & quoted form of item 4 of argv',
  'tell application "Terminal"',
  "activate",
  "do script theCommand",
  "end tell",
  "end run",
];

/**
 * The command that opens a terminal running Claude in the session's folder, or null where there is
 * none. The prompt goes after `--` and the name inside `--name=`, so neither is read as an option
 * when it starts with a dash.
 */
export function terminalCommand(platform: NodeJS.Platform, session: NewSession): TerminalCommand | null {
  const prompt = session.prompt ? [session.prompt] : [];
  if (platform === "darwin") {
    const args = [session.cwd, session.sessionId, session.name, ...prompt];
    return ["osascript", [...MACOS_SCRIPT.flatMap((line) => ["-e", line]), ...args]];
  }
  if (platform === "linux") {
    const claude = [
      "claude",
      "--session-id",
      session.sessionId,
      ...(session.name ? [`--name=${session.name}`] : []),
      ...(session.prompt ? ["--", session.prompt] : []),
    ];
    return ["gnome-terminal", [`--working-directory=${session.cwd}`, "--", ...claude]];
  }
  return null;
}

/** Whether this machine has the terminal terminalCommand would use. */
export function canStartSessions(platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "darwin") return true;
  return platform === "linux" && onPath("gnome-terminal");
}

/**
 * Opens the terminal. Resolves once it opened, or once it has been starting for a while; rejects
 * with what the terminal said when it failed, e.g. macOS refusing to let it control Terminal.
 */
export function startInTerminal(command: TerminalCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command[1]], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-500);
    });
    const stillStarting = setTimeout(() => {
      child.stderr.destroy();
      child.unref();
      resolve();
    }, STILL_STARTING_MS);
    child.on("error", (error) => {
      clearTimeout(stillStarting);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(stillStarting);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command[0]} exited with ${code}`));
    });
  });
}

function onPath(name: string): boolean {
  return (process.env["PATH"] ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        accessSync(join(dir, name), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}
