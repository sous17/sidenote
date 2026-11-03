import { homedir } from "node:os";
import { join } from "node:path";

// User state lives outside the plugin, so it survives plugin updates and reinstalls.
// Each path is computed on use, so tests can point HOME at a scratch directory.
const stateDir = (): string => join(homedir(), ".sidenote");

export const paths = {
  stateDir,
  storeFile: (): string => join(stateDir(), "store.json"),
  serverFile: (): string => join(stateDir(), "server.json"),
  portFile: (): string => join(stateDir(), "port"),
  logFile: (): string => join(stateDir(), "server.log"),
  enabledFlag: (): string => join(stateDir(), "enabled"),
  /** Whether sessions open in the browser or a terminal pane. */
  configFile: (): string => join(stateDir(), "config.json"),
  /** One file per running sidenote tui, holding its pid, so a second pane isn't opened. */
  panesDir: (): string => join(stateDir(), "panes"),
  transcriptsDir: (): string => join(homedir(), ".claude", "projects"),
};
