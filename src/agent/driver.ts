// What sidenote needs from a coding agent it runs itself: start or resume a session, send it
// messages, stream what it does, interrupt it, and answer its permission prompts. Each agent
// gets an adapter (claude.ts for Claude Code); the session host only sees this interface.

/** A tool the agent asks to use, and what the user is asked to allow. */
export interface PermissionRequest {
  request_id: string;
  tool_name: string;
  /** The agent's one-line description of the call, such as a file name, or "". */
  description: string;
  input: Record<string, unknown>;
}

export type PermissionDecision = "allow" | "deny" | "always";

/** How a turn ended. */
export interface TurnEnd {
  outcome: "done" | "interrupted" | "error";
  /** The agent's error text, for outcome "error". */
  error: string;
  cost_usd: number | null;
}

export type AgentEvent =
  | { type: "ready"; session_id: string; model: string }
  /** Streamed text of the reply being written. */
  | { type: "text_delta"; text: string }
  /** A finished text block; replaces whatever its deltas built up. */
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; failed: boolean }
  | { type: "permission"; request: PermissionRequest }
  /** Context the conversation uses so far, and the model's limit, in tokens; null if unknown. */
  | { type: "usage"; context_tokens: number | null; context_window: number | null }
  | { type: "turn_end"; end: TurnEnd }
  /** The agent process is gone; a new message starts it again. */
  | { type: "exit"; message: string };

export interface StartOptions {
  sessionId: string;
  cwd: string;
  /** Continue the session's earlier conversation instead of starting a new one. */
  resume: boolean;
}

export interface AgentDriver {
  send(text: string): void;
  interrupt(): void;
  answer(request: PermissionRequest, decision: PermissionDecision): void;
  /** Ends the agent process. */
  close(): void;
}

export interface Agent {
  /** Shown in the top line, such as "Claude Code". */
  readonly name: string;
  start(options: StartOptions, onEvent: (event: AgentEvent) => void): AgentDriver;
}
