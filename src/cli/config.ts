// What sidenote opens for a session: its browser window, or a terminal pane beside Claude Code.
// Kept apart from store.json, which holds the replies and notes, so the store's format is unchanged.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "../node/paths.ts";

export type Ui = "browser" | "terminal";

export function isUi(value: string): value is Ui {
  return value === "browser" || value === "terminal";
}

/** The chosen way to show sessions; the browser unless the user picked the terminal. */
export function readUi(): Ui {
  try {
    const config = JSON.parse(readFileSync(paths.configFile(), "utf8")) as { ui?: unknown };
    return config.ui === "terminal" ? "terminal" : "browser";
  } catch {
    return "browser";
  }
}

export function writeUi(ui: Ui): void {
  mkdirSync(paths.stateDir(), { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile(), `${JSON.stringify({ ui })}\n`, { mode: 0o600 });
}
