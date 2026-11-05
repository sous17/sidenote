import { homedir } from "node:os";
import { join } from "node:path";

// User state lives outside the plugin, so it survives plugin updates and reinstalls.
// Each path is computed on use, so tests can point HOME at a scratch directory.
const stateDir = (): string => join(homedir(), ".sidenote");

export const paths = {
  stateDir,
  serverFile: (): string => join(stateDir(), "server.json"),
  lockFile: (): string => join(stateDir(), "server.lock"),
  portFile: (): string => join(stateDir(), "port"),
  logFile: (): string => join(stateDir(), "server.log"),
  enabledFlag: (): string => join(stateDir(), "enabled"),
  /** Where the installed plugin's launcher is now, for the command below. */
  launcherFile: (): string => join(stateDir(), "launcher"),
  /** The `sidenote` command. Claude Code's own installer uses this folder too. */
  commandFile: (): string => join(homedir(), ".local", "bin", "sidenote"),
  transcriptsDir: (): string => join(homedir(), ".claude", "projects"),
  claudeSettings: (): string => join(process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), "settings.json"),
  /** Claude Code's own state, which records the folders the user trusted. */
  claudeConfig: (): string => join(process.env["CLAUDE_CONFIG_DIR"] ?? homedir(), ".claude.json"),
  managedClaudeSettings: (): string =>
    process.platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-settings.json"
      : "/etc/claude-code/managed-settings.json",
};
