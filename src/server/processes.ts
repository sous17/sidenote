// The Claude process behind each session, as its hooks report it, so the page can end a session and
// tell an ended one from one that is only quiet. Kept in memory: after a restart, each session's
// process is known again from its next prompt, reply or waiter.
import type { ClaudeProcess, FolderSession } from "../shared/types.ts";
import type { Revision } from "./store.ts";

export interface ProcessProbe {
  /** Cheap: whether anything has the pid. Good enough to show a session as ended. */
  pidInUse(pid: number): boolean;
  /** Thorough: whether the pid is still the recorded process. Checked before ending one. */
  isSameProcess(recorded: ClaudeProcess): boolean;
}

export class SessionProcesses {
  readonly #processes = new Map<string, ClaudeProcess>();
  readonly #probe: ProcessProbe;
  readonly #revision: Revision;
  #signature = "";

  constructor(probe: ProcessProbe, revision: Revision) {
    this.#probe = probe;
    this.#revision = revision;
  }

  record(sessionId: string, claudeProcess: ClaudeProcess | undefined): void {
    if (claudeProcess) this.#processes.set(sessionId, claudeProcess);
  }

  forget(sessionId: string): void {
    this.#processes.delete(sessionId);
  }

  state(sessionId: string): FolderSession["process"] {
    const recorded = this.#processes.get(sessionId);
    if (!recorded) return "unknown";
    return this.#probe.pidInUse(recorded.pid) ? "running" : "ended";
  }

  /** The session's process, if it still runs as recorded; undefined when it ended or is unknown. */
  running(sessionId: string): ClaudeProcess | undefined {
    const recorded = this.#processes.get(sessionId);
    return recorded && this.#probe.isSameProcess(recorded) ? recorded : undefined;
  }

  /** Bumps the revision when a process ended, so pages see the session as ended. */
  refresh(): void {
    const signature = JSON.stringify([...this.#processes.keys()].map((id) => [id, this.state(id)]));
    if (signature === this.#signature) return;
    this.#signature = signature;
    this.#revision.bump();
  }
}
