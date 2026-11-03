// The agents sidenote supports: their hooks, and where and how those hooks are installed.
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "../../shared/types.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { copilot } from "./copilot.ts";
import type { HookHandler } from "./core.ts";
import { cursor } from "./cursor.ts";

/** How an agent's hook config file is laid out. */
export type ConfigShape =
  /** {"hooks": {"Event": [{"hooks": [{"type": "command", "command", "timeout"}]}]}} (Codex) */
  | "grouped"
  /** {"version": 1, "hooks": {"event": [{"command", "timeout"}]}} (Cursor) */
  | "flat"
  /** A file of sidenote's own, {"version": 1, "hooks": {"event": [{"type", "command", "timeoutSec"}]}} (Copilot) */
  | "own-file";

export interface InstallSpec {
  configFile: () => string;
  shape: ConfigShape;
  /** The agent's event name for each of sidenote's hooks. */
  events: Readonly<Record<string, string>>;
  /** What the user still has to do after installing. */
  nextSteps: readonly string[];
}

export interface Agent {
  id: AgentId;
  hooks: Readonly<Record<string, HookHandler>>;
  /** Claude Code installs through its plugin system instead. */
  install?: InstallSpec;
  /**
   * What to print when a hook can't run (sidenote off, or an error), for agents that expect
   * output from some hooks. Keyed by hook name.
   */
  fallbackOutput?: Readonly<Record<string, string>>;
}

const home = (envVar: string, fallback: string): string => process.env[envVar] || join(homedir(), fallback);

export const AGENT_ADAPTERS: Readonly<Record<AgentId, Agent>> = {
  claude: { id: "claude", hooks: claude },
  codex: {
    id: "codex",
    hooks: codex,
    install: {
      configFile: () => join(home("CODEX_HOME", ".codex"), "hooks.json"),
      shape: "grouped",
      events: { "session-start": "SessionStart", prompt: "UserPromptSubmit", stop: "Stop" },
      nextSteps: ["In Codex, run /hooks and trust the three sidenote hooks. Codex skips hooks until you do."],
    },
    // Codex requires JSON on stdout when a Stop hook exits 0.
    fallbackOutput: { stop: "{}" },
  },
  cursor: {
    id: "cursor",
    hooks: cursor,
    install: {
      configFile: () => join(homedir(), ".cursor", "hooks.json"),
      shape: "flat",
      events: {
        "session-start": "sessionStart",
        "after-response": "afterAgentResponse",
        prompt: "beforeSubmitPrompt",
        stop: "stop",
      },
      nextSteps: ["Restart Cursor, or open a new agent chat, so it loads the hooks."],
    },
    fallbackOutput: { prompt: '{"continue":true}' },
  },
  copilot: {
    id: "copilot",
    hooks: copilot,
    install: {
      configFile: () => join(home("COPILOT_HOME", ".copilot"), "hooks", "sidenote.json"),
      shape: "own-file",
      events: { "session-start": "sessionStart", prompt: "userPromptSubmitted", stop: "agentStop" },
      nextSteps: [
        "Start a new Copilot CLI session so it loads the hooks.",
        "Copilot support is experimental: replies are read from Copilot's session log, whose format isn't documented.",
      ],
    },
  },
};
