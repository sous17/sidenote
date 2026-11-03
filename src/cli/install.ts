// `sidenote install <agent>` and `uninstall <agent>`: adds sidenote's hooks to an agent's own hook
// config, or removes them, leaving the user's other hooks as they are.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId } from "../shared/types.ts";
import type { InstallSpec } from "./agents/index.ts";

const HOOK_TIMEOUT_SECONDS = 30;

type HookEntry = Record<string, unknown>;
interface HookConfig {
  version?: number;
  hooks?: Record<string, unknown[]>;
  [key: string]: unknown;
}

/** bin/sidenote in this checkout, found by walking up from this file (src/ or dist/). */
export function launcherPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "bin", "sidenote");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("bin/sidenote not found next to the sidenote code");
    dir = parent;
  }
}

/** The command an agent runs for one of sidenote's hooks. */
export function hookCommand(agent: AgentId, hook: string): string {
  return `"${launcherPath()}" hook ${agent} ${hook}`;
}

/** Whether a hook entry is one of sidenote's for this agent. */
function isOurs(entry: unknown, agent: AgentId): boolean {
  const command = (entry as HookEntry | null)?.["command"];
  return typeof command === "string" && command.includes("sidenote") && command.includes(` hook ${agent} `);
}

function readConfig(file: string): HookConfig {
  if (!existsSync(file)) return {};
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} isn't a JSON object; fix or move it, then install again`);
  }
  return parsed as HookConfig;
}

function writeConfig(file: string, config: HookConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

/** The config with sidenote's hooks for this agent removed, and empty events dropped. */
function withoutOurs(config: HookConfig, spec: InstallSpec, agent: AgentId): HookConfig {
  const hooks: Record<string, unknown[]> = { ...config.hooks };
  for (const event of Object.values(spec.events)) {
    const entries = hooks[event] ?? [];
    const kept =
      spec.shape === "grouped"
        ? entries
            .map((group) => {
              const inner = (group as { hooks?: unknown[] }).hooks ?? [];
              return { ...(group as object), hooks: inner.filter((entry) => !isOurs(entry, agent)) };
            })
            .filter((group) => group.hooks.length > 0)
        : entries.filter((entry) => !isOurs(entry, agent));
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  return { ...config, hooks };
}

function entryFor(spec: InstallSpec, agent: AgentId, hook: string): unknown {
  const command = hookCommand(agent, hook);
  switch (spec.shape) {
    case "grouped":
      return { hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] };
    case "flat":
      return { command, timeout: HOOK_TIMEOUT_SECONDS };
    case "own-file":
      return { type: "command", command, timeoutSec: HOOK_TIMEOUT_SECONDS };
  }
}

/** Adds sidenote's hooks to the agent's config, replacing any older sidenote entries. */
export function install(agent: AgentId, spec: InstallSpec): string {
  const file = spec.configFile();
  const base = spec.shape === "own-file" ? {} : withoutOurs(readConfig(file), spec, agent);
  const config: HookConfig = spec.shape === "grouped" ? { ...base } : { version: 1, ...base };
  const hooks: Record<string, unknown[]> = { ...config.hooks };
  for (const [hook, event] of Object.entries(spec.events)) {
    hooks[event] = [...(hooks[event] ?? []), entryFor(spec, agent, hook)];
  }
  writeConfig(file, { ...config, hooks });
  return file;
}

/** Removes sidenote's hooks from the agent's config. Returns the file it changed, if any. */
export function uninstall(agent: AgentId, spec: InstallSpec): string | null {
  const file = spec.configFile();
  if (!existsSync(file)) return null;
  if (spec.shape === "own-file") {
    rmSync(file);
    return file;
  }
  writeConfig(file, withoutOurs(readConfig(file), spec, agent));
  return file;
}
