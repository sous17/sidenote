// One server per machine. Two servers would each hold their own copy of the store and overwrite
// each other's files, so a server that finds another one running exits before loading it.
//
// The lock says who owns it by pid and start time, because the system reuses pids. Whether its owner
// lives is asked of the system alone: a lost server.json must never make a live server look dead.
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { processInfo } from "../node/process.ts";

/** A new server writes its pid in the same moment it creates the lock. */
const STARTUP_GRACE_MS = 30_000;

function readLock(lockFile: string): { pid: number; started: string } | null {
  try {
    const [pid = "", started = ""] = readFileSync(lockFile, "utf8").split("\n");
    return { pid: Number.parseInt(pid, 10), started };
  } catch {
    return null;
  }
}

/** Whether the pid still is the server that took the lock, not a later process with its pid. */
function isOwner(pid: number, started: string): boolean {
  const info = processInfo(pid);
  if (!info) return false;
  // Locks from before start times were recorded name a pid only.
  return started ? info.started === started : info.args.includes("server.js");
}

/** The pid of the live server holding the lock; null when none does, as after a crash. */
export function serverLockOwner(lockFile: string): number | null {
  const lock = readLock(lockFile);
  return lock && !Number.isNaN(lock.pid) && isOwner(lock.pid, lock.started) ? lock.pid : null;
}

function isHeld(lockFile: string): boolean {
  const lock = readLock(lockFile);
  if (!lock) return false; // its owner just released it
  if (!Number.isNaN(lock.pid)) return serverLockOwner(lockFile) !== null;
  // An empty lock file is a server between creating the file and writing its pid.
  try {
    return Date.now() - statSync(lockFile).mtimeMs < STARTUP_GRACE_MS;
  } catch {
    return false;
  }
}

function createLock(lockFile: string, contents: string): boolean {
  try {
    const descriptor = openSync(lockFile, "wx", 0o600);
    writeSync(descriptor, contents);
    closeSync(descriptor);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
}

const ownLock = (): string => `${process.pid}\n${processInfo(process.pid)?.started ?? ""}`;

/**
 * Takes the lock for this process. Returns false when another server holds it. Creating the file
 * is atomic, so of any number of servers starting at once, one wins. Only two starting at the same
 * moment over a crashed server's lock could both clear it, and the loser finds out at its next
 * holdServerLock.
 */
export function acquireServerLock(lockFile: string): boolean {
  const contents = ownLock();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (createLock(lockFile, contents)) return true;
    if (isHeld(lockFile)) return false;
    rmSync(lockFile, { force: true });
  }
  return false;
}

/** Whether this process still owns the lock, taking it back if the file was deleted. */
export function holdServerLock(lockFile: string): boolean {
  const lock = readLock(lockFile);
  if (lock) return lock.pid === process.pid;
  return createLock(lockFile, ownLock());
}

export function releaseServerLock(lockFile: string): void {
  if (readLock(lockFile)?.pid === process.pid) rmSync(lockFile, { force: true });
}
