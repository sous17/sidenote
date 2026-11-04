// Finds the Claude Code process a hook runs under, and checks later that it is still the same one.
// A process is known by its pid and start time together, because the system reuses pids.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ClaudeProcess } from "../shared/types.ts";

/** Hooks sit a few processes below Claude: a shell, then node. */
const MAX_DEPTH = 8;

export interface ProcessInfo {
  ppid: number;
  /** When the process started, in whatever form the system gives; only ever compared. */
  started: string;
  name: string;
  args: string;
}

/** Reads a process from /proc on Linux, or from ps on macOS; null when it doesn't exist. */
export function processInfo(pid: number, platform: NodeJS.Platform = process.platform): ProcessInfo | null {
  try {
    return platform === "linux" ? linuxInfo(pid) : platform === "darwin" ? psInfo(pid) : null;
  } catch {
    return null;
  }
}

function linuxInfo(pid: number): ProcessInfo {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  // The name sits in parentheses and may contain spaces; the fields after it are space-separated,
  // starting with field 3, so field N is fields[N - 3].
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).split(" ");
  return {
    ppid: Number(fields[1]),
    started: fields[19]!,
    name: stat.slice(stat.indexOf("(") + 1, close),
    args: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim(),
  };
}

function psInfo(pid: number): ProcessInfo | null {
  const ps = (field: string): string =>
    spawnSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  const ppid = ps("ppid");
  if (!ppid) return null;
  return { ppid: Number(ppid), started: ps("lstart"), name: ps("comm"), args: ps("args") };
}

/** Whether a process is Claude Code: the native binary, or the older install that runs it with node. */
export function isClaude(info: ProcessInfo): boolean {
  const base = (path: string): string => path.split("/").pop() ?? "";
  return (
    base(info.name) === "claude" ||
    base(info.args.split(" ")[0] ?? "") === "claude" ||
    /@anthropic-ai\/claude-code\/cli\.js/.test(info.args)
  );
}

/** The nearest Claude process above `pid`, read through `info`; null when there is none. */
export function findClaude(pid: number, info: (pid: number) => ProcessInfo | null): ClaudeProcess | null {
  let current = pid;
  for (let depth = 0; depth < MAX_DEPTH && current > 1; depth += 1) {
    const found = info(current);
    if (!found) return null;
    if (isClaude(found)) return { pid: current, started: found.started };
    current = found.ppid;
  }
  return null;
}

/** The Claude process this hook runs under. */
export function claudeProcess(): ClaudeProcess | null {
  return findClaude(process.ppid, (pid) => processInfo(pid));
}

/** Whether the process still runs and is the one that was recorded, not a later one with its pid. */
export function isSameProcess(recorded: ClaudeProcess): boolean {
  return processInfo(recorded.pid)?.started === recorded.started;
}

/** Whether a pid is in use at all: cheap enough to ask on every poll, unlike isSameProcess on macOS. */
export function pidInUse(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
