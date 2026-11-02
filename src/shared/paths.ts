import { homedir } from "node:os";
import { join } from "node:path";

// User state lives outside the plugin, so it survives plugin updates and reinstalls.
// Computed on each call so tests can point HOME at a scratch directory.
export const paths = {
  stateDir: () => join(homedir(), ".sidenote"),
  storeFile: () => join(paths.stateDir(), "store.json"),
  serverFile: () => join(paths.stateDir(), "server.json"),
  portFile: () => join(paths.stateDir(), "port"),
  logFile: () => join(paths.stateDir(), "server.log"),
  enabledFlag: () => join(paths.stateDir(), "enabled"),
  transcriptsDir: () => join(homedir(), ".claude", "projects"),
};
