// Puts `sidenote` on the user's PATH. The plugin's own path has its version in it, so anything that
// names it breaks at the next update. The command reads the current path from a file instead, which
// each session keeps up to date.
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname } from "node:path";
import { paths } from "../node/paths.ts";

const MARKER = "# Made by /sidenote:terminal.";

const SCRIPT = `#!/bin/sh
${MARKER} It runs the installed plugin, wherever its last update put it.
launcher=$(cat "$HOME/.sidenote/launcher" 2>/dev/null)
if [ ! -x "$launcher" ]; then
  echo "sidenote can't find its plugin. Start Claude Code once, or install the plugin again." >&2
  exit 1
fi
exec "$launcher" "$@"
`;

function ours(file: string): boolean {
  try {
    return lstatSync(file).isFile() && readFileSync(file, "utf8").includes(MARKER);
  } catch {
    return false;
  }
}

function writeLauncher(launcher: string): void {
  mkdirSync(paths.stateDir(), { recursive: true, mode: 0o700 });
  writeFileSync(paths.launcherFile(), launcher, { mode: 0o600 });
}

const onPath = (folder: string): boolean => (process.env["PATH"] ?? "").split(delimiter).includes(folder);

/** Installs the command. Returns what to tell the user, and whether it worked. */
export function installCommand(launcher: string): { ok: boolean; message: string } {
  const file = paths.commandFile();
  if (lstatSync(file, { throwIfNoEntry: false }) && !ours(file)) {
    return { ok: false, message: `${file} already exists and isn't sidenote's, so it was left alone.` };
  }
  writeLauncher(launcher);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, SCRIPT, { mode: 0o755 });
  const ready = "Run sidenote chat or sidenote tui from any terminal.";
  if (onPath(dirname(file))) return { ok: true, message: ready };
  return {
    ok: true,
    message:
      `Installed ${file}, but that folder isn't on your PATH. Add this line to your shell's profile, ` +
      `then open a new terminal: export PATH="$HOME/.local/bin:$PATH"\n${ready}`,
  };
}

/** Whether a plain `sidenote` reaches the command. */
export function commandInstalled(): boolean {
  const file = paths.commandFile();
  return ours(file) && onPath(dirname(file));
}

/** Keeps an installed command on the current plugin. Runs in a hook, so it never throws. */
export function refreshLauncher(launcher: string): void {
  try {
    if (lstatSync(paths.launcherFile(), { throwIfNoEntry: false })) writeLauncher(launcher);
  } catch {
    // The command then says it can't find the plugin, and the session is unharmed.
  }
}
