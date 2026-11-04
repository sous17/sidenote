import { homedir } from "node:os";
import { join } from "node:path";

// User state lives outside the plugin, so it survives plugin updates and reinstalls.
// Each path is computed on use, so tests can point HOME at a scratch directory.
const stateDir = (): string => join(homedir(), ".sidenote");

export const paths = {
  stateDir,
  storeFile: (): string => join(stateDir(), "store.json"),
  serverFile: (): string => join(stateDir(), "server.json"),
  lockFile: (): string => join(stateDir(), "server.lock"),
  portFile: (): string => join(stateDir(), "port"),
  logFile: (): string => join(stateDir(), "server.log"),
  enabledFlag: (): string => join(stateDir(), "enabled"),
  transcriptsDir: (): string => join(homedir(), ".claude", "projects"),
};
