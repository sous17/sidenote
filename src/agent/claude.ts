// Claude Code, run headless: one long-lived `claude -p` process per session, speaking
// newline-delimited JSON on stdin and stdout (https://code.claude.com/docs/en/headless).
//
// - Messages go in as stream-json user messages; the process takes one after another.
// - Permission prompts come out as `can_use_tool` control requests, because the run is started
//   with `--permission-prompt-tool stdio`, the way the Agent SDK runs Claude Code. The answer is
//   a control response on stdin.
// - An `interrupt` control request ends the turn; the process stays up for the next message.
// - Sessions start in auto mode where the user's settings don't choose one: see startingMode.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { paths } from "../node/paths.ts";
import type {
  Agent,
  AgentDriver,
  AgentEvent,
  PermissionDecision,
  PermissionRequest,
  StartOptions,
  TurnEnd,
} from "./driver.ts";

/** Set in the agent's environment, so sidenote's own Claude Code hooks stay out of the way. */
export const HEADLESS_ENV = "SIDENOTE_HEADLESS";
/** How long a closing process gets after its input ends before it is stopped. */
const CLOSE_GRACE_MS = 3000;
const STDERR_TAIL_CHARS = 2000;

/** The modes a user's settings can start a session in. Others leave Claude Code asking. */
const STARTING_MODES: ReadonlySet<string> = new Set(["auto", "acceptEdits", "dontAsk", "plan"]);

/**
 * The permission mode a session starts in, or null to pass none, which asks about each command.
 * `claude -p` starts in manual mode while the terminal starts in auto, so without this every
 * command would wait for a key. Claude Code falls back to asking where auto isn't available.
 *
 * bypassPermissions is left out on purpose: sidenote doesn't turn checks off on the user's behalf.
 * Settings that can't be read keep it asking too, as they may hold a choice we can't see.
 */
export function startingMode(settingsFile: string): string | null {
  let contents: string;
  try {
    contents = readFileSync(settingsFile, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "auto" : null;
  }
  try {
    const settings = JSON.parse(contents) as { permissions?: { defaultMode?: unknown } };
    const chosen = settings.permissions?.defaultMode;
    if (chosen === undefined) return "auto";
    return typeof chosen === "string" && STARTING_MODES.has(chosen) ? chosen : null;
  } catch {
    return null;
  }
}

export function claudeArgs(
  options: StartOptions & { instructions?: string; permissionMode?: string | null },
): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool",
    "stdio",
    ...(options.permissionMode ? ["--permission-mode", options.permissionMode] : []),
    ...(options.resume ? ["--resume", options.sessionId] : ["--session-id", options.sessionId]),
    ...(options.instructions ? ["--append-system-prompt", options.instructions] : []),
  ];
}

export class ClaudeAgent implements Agent {
  readonly name = "Claude Code";
  readonly #command: string;
  readonly #instructions: string;
  readonly #settingsFile: string;

  constructor(options: { command?: string; instructions?: string; settingsFile?: string } = {}) {
    this.#command = options.command ?? process.env["SIDENOTE_CLAUDE"] ?? "claude";
    this.#instructions = options.instructions ?? "";
    this.#settingsFile = options.settingsFile ?? paths.claudeSettings();
  }

  start(options: StartOptions, onEvent: (event: AgentEvent) => void): AgentDriver {
    // Read for each session, so a changed setting applies without restarting the server.
    const permissionMode = startingMode(this.#settingsFile);
    const args = claudeArgs({ ...options, instructions: this.#instructions, permissionMode });
    const child = spawn(this.#command, args, {
      cwd: options.cwd,
      env: { ...process.env, [HEADLESS_ENV]: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new ClaudeProcess(child, onEvent);
  }
}

class ClaudeProcess implements AgentDriver {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #stream: ClaudeStream;
  readonly #onEvent: (event: AgentEvent) => void;
  #stderr = "";
  #exited = false;
  #requests = 0;

  constructor(child: ChildProcessWithoutNullStreams, onEvent: (event: AgentEvent) => void) {
    this.#child = child;
    this.#onEvent = onEvent;
    this.#stream = new ClaudeStream();
    createInterface({ input: child.stdout }).on("line", (line) => {
      for (const event of this.#stream.read(line)) onEvent(event);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
    });
    // A write after the process died fails here rather than crashing the server.
    child.stdin.on("error", () => {});
    child.on("error", (error) => this.#exit(`Couldn't start Claude Code: ${error.message}`));
    child.on("exit", (code, signal) => {
      const detail = this.#stderr.trim().split("\n").at(-1) ?? "";
      this.#exit(
        code === 0
          ? "Claude Code stopped."
          : `Claude Code stopped (${signal ?? `exit ${code}`})${detail ? `: ${detail}` : "."}`,
      );
    });
  }

  send(text: string): void {
    this.#write({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" });
  }

  interrupt(): void {
    this.#stream.interrupting = true;
    this.#write({
      type: "control_request",
      request_id: `sidenote-${++this.#requests}`,
      request: { subtype: "interrupt" },
    });
  }

  answer(request: PermissionRequest, decision: PermissionDecision): void {
    const suggestions = this.#stream.takeSuggestions(request.request_id);
    const response =
      decision === "deny"
        ? { behavior: "deny", message: "The user declined this in sidenote." }
        : {
            behavior: "allow",
            updatedInput: request.input,
            // "Always" applies the rule Claude Code suggested, such as allowing edits for the session.
            ...(decision === "always" && suggestions.length ? { updatedPermissions: suggestions } : {}),
          };
    this.#write({
      type: "control_response",
      response: { subtype: "success", request_id: request.request_id, response },
    });
  }

  close(): void {
    if (this.#exited) return;
    this.#child.stdin.end();
    setTimeout(() => {
      if (!this.#exited) this.#child.kill("SIGTERM");
    }, CLOSE_GRACE_MS).unref();
  }

  #write(message: object): void {
    if (!this.#exited) this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #exit(message: string): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#onEvent({ type: "exit", message });
  }
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * Turns Claude Code's output lines into agent events. Only the main conversation is shown:
 * subagents' messages (those with a parent_tool_use_id) are left out.
 */
export class ClaudeStream {
  /** Set when an interrupt was sent, so the turn's error result reads as interrupted. */
  interrupting = false;
  #model = "";
  readonly #suggestions = new Map<string, unknown[]>();

  read(line: string): AgentEvent[] {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return [];
    }
    if (!isObject(message)) return [];
    if ("parent_tool_use_id" in message && message["parent_tool_use_id"] !== null) return [];
    switch (message["type"]) {
      case "system":
        return this.#system(message);
      case "stream_event":
        return this.#streamEvent(message["event"]);
      case "assistant":
        return this.#assistant(message["message"]);
      case "user":
        return this.#toolResults(message["message"]);
      case "control_request":
        return this.#controlRequest(message);
      case "result":
        return this.#result(message);
      default:
        return [];
    }
  }

  /** The permission rules Claude Code suggested for a request, handed out once. */
  takeSuggestions(requestId: string): unknown[] {
    const suggestions = this.#suggestions.get(requestId) ?? [];
    this.#suggestions.delete(requestId);
    return suggestions;
  }

  #system(message: Json): AgentEvent[] {
    if (message["subtype"] !== "init") return [];
    this.#model = text(message["model"]);
    return [{ type: "ready", session_id: text(message["session_id"]), model: this.#model }];
  }

  #streamEvent(event: unknown): AgentEvent[] {
    if (!isObject(event) || event["type"] !== "content_block_delta") return [];
    const delta = event["delta"];
    if (!isObject(delta) || delta["type"] !== "text_delta") return [];
    return [{ type: "text_delta", text: text(delta["text"]) }];
  }

  #assistant(message: unknown): AgentEvent[] {
    if (!isObject(message) || !Array.isArray(message["content"])) return [];
    const events: AgentEvent[] = [];
    for (const block of message["content"] as unknown[]) {
      if (!isObject(block)) continue;
      if (block["type"] === "text") events.push({ type: "text", text: text(block["text"]) });
      if (block["type"] === "tool_use") {
        events.push({
          type: "tool_use",
          id: text(block["id"]),
          name: text(block["name"]),
          input: isObject(block["input"]) ? block["input"] : {},
        });
      }
    }
    const usage = message["usage"];
    if (isObject(usage)) {
      const tokens =
        count(usage["input_tokens"]) +
        count(usage["cache_read_input_tokens"]) +
        count(usage["cache_creation_input_tokens"]);
      if (tokens) events.push({ type: "usage", context_tokens: tokens, context_window: null });
    }
    return events;
  }

  #toolResults(message: unknown): AgentEvent[] {
    if (!isObject(message) || !Array.isArray(message["content"])) return [];
    return (message["content"] as unknown[])
      .filter((block): block is Json => isObject(block) && block["type"] === "tool_result")
      .map((block) => ({ type: "tool_result", id: text(block["tool_use_id"]), failed: block["is_error"] === true }));
  }

  #controlRequest(message: Json): AgentEvent[] {
    const request = message["request"];
    if (!isObject(request) || request["subtype"] !== "can_use_tool") return [];
    const requestId = text(message["request_id"]);
    if (Array.isArray(request["permission_suggestions"]))
      this.#suggestions.set(requestId, request["permission_suggestions"]);
    return [
      {
        type: "permission",
        request: {
          request_id: requestId,
          tool_name: text(request["tool_name"]),
          description: text(request["description"]),
          input: isObject(request["input"]) ? request["input"] : {},
        },
      },
    ];
  }

  #result(message: Json): AgentEvent[] {
    const interrupted = this.interrupting;
    this.interrupting = false;
    const events: AgentEvent[] = [];
    const usage = message["modelUsage"];
    const model = isObject(usage) ? usage[this.#model] : undefined;
    if (isObject(model) && count(model["contextWindow"])) {
      events.push({ type: "usage", context_tokens: null, context_window: count(model["contextWindow"]) });
    }
    const cost = message["total_cost_usd"];
    const end: TurnEnd = {
      // A failure such as a missing login can come as a "success" with is_error set.
      outcome:
        message["subtype"] === "success" && message["is_error"] !== true
          ? "done"
          : interrupted
            ? "interrupted"
            : "error",
      error: "",
      cost_usd: typeof cost === "number" ? cost : null,
    };
    if (end.outcome === "error") {
      const errors = Array.isArray(message["errors"]) ? (message["errors"] as unknown[]).map(text) : [];
      end.error = text(message["result"]) || errors.filter(Boolean).join("; ") || text(message["subtype"]);
    }
    events.push({ type: "turn_end", end });
    return events;
  }
}
