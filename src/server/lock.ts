// One server per machine. Two servers would each hold their own copy of the store and overwrite
// each other's store.json, so a server that finds another one running exits before loading it.
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import type { ServerInfo } from "../shared/types.ts";

/** A new server writes server.json within moments of taking the lock. */
const STARTUP_GRACE_MS = 30_000;

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function registeredPid(serverFile: string): number | null {
  try {
    return (JSON.parse(readFileSync(serverFile, "utf8")) as ServerInfo).pid;
  } catch {
    return null;
  }
}

/** Whether the lock file's owner is a live server, rather than left over from a crash. */
function isHeld(lockFile: string, serverFile: string): boolean {
  let pid: number;
  let ageMs: number;
  try {
    pid = Number.parseInt(readFileSync(lockFile, "utf8"), 10);
    ageMs = Date.now() - statSync(lockFile).mtimeMs;
  } catch {
    return false; // its owner just released it
  }
  // An empty lock file is a server between creating the file and writing its pid.
  if (ageMs < STARTUP_GRACE_MS) return Number.isNaN(pid) || isRunning(pid);
  // After a reboot the pid can belong to something else; a real server has registered by now.
  return !Number.isNaN(pid) && isRunning(pid) && registeredPid(serverFile) === pid;
}

/**
 * Takes the lock for this process. Returns false when another server holds it. Creating the file
 * is atomic, so of any number of servers starting at once, one wins. Only two starting at the same
 * moment over a crashed server's lock could both clear it, and that needs a crash first.
 */
export function acquireServerLock(lockFile: string, serverFile: string): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockFile, "wx", 0o600);
      writeSync(descriptor, String(process.pid));
      closeSync(descriptor);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (isHeld(lockFile, serverFile)) return false;
    rmSync(lockFile, { force: true });
  }
  return false;
}

export function releaseServerLock(lockFile: string): void {
  try {
    if (Number.parseInt(readFileSync(lockFile, "utf8"), 10) === process.pid) rmSync(lockFile);
  } catch {
    // Already gone.
  }
}
