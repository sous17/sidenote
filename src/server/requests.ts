// Parsers for request bodies. Each one turns untrusted JSON into a typed, bounded value, or
// throws BadRequest. Handlers never touch raw input.
import { isAbsolute } from "node:path";
import { MAX_ACTIVITY_CHARS, MAX_PROGRESS_DELTA_CHARS } from "../shared/tools.ts";
import {
  MAX_PROMPT_CHARS,
  SESSION_ID_PATTERN,
  type ActivityRequest,
  type ClaimRequest,
  type ClaudeProcess,
  type ConversationMessageRequest,
  type PermissionAnswerRequest,
  type ProgressRequest,
  type PromptRequest,
  type StartConversationRequest,
  type StartSessionRequest,
  type EpochSeconds,
  type NewResponseRequest,
  type RedeemRequest,
  type RegisterSessionRequest,
  type RenameSessionRequest,
  type SendRequest,
  type SessionRequest,
  type TouchSessionRequest,
  type WaiterRequest,
} from "../shared/types.ts";

export class BadRequest extends Error {}

/** Size limits, generous for real use and small enough to keep the store bounded. */
export const LIMITS = {
  replyText: 1_000_000,
  noteBody: 20_000,
  quote: 2_000,
  sessionName: 200,
  cwd: 4_096,
  sessionIds: 100,
  message: 100_000,
} as const;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DECISIONS: ReadonlySet<string> = new Set(["allow", "deny", "always"]);

const WAITER_ID_PATTERN = /^[a-f0-9]{16,64}$/;
const LAUNCH_CODE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

type JsonObject = Readonly<Record<string, unknown>>;

/** Request bodies must be JSON objects; arrays and primitives are refused. */
export function asObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequest("expected a JSON object");
  }
  return value as JsonObject;
}

function string(body: JsonObject, key: string, max: number): string {
  const value = body[key];
  if (typeof value !== "string") throw new BadRequest(`${key} must be a string`);
  if (value.length > max) throw new BadRequest(`${key} is longer than ${max} characters`);
  return value;
}

function optionalString(body: JsonObject, key: string, max: number): string | undefined {
  return body[key] === undefined || body[key] === null ? undefined : string(body, key, max);
}

function integer(body: JsonObject, key: string, min: number): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new BadRequest(`${key} must be an integer of at least ${min}`);
  }
  return value;
}

function matching(body: JsonObject, key: string, pattern: RegExp): string {
  const value = string(body, key, 256);
  if (!pattern.test(value)) throw new BadRequest(`${key} is malformed`);
  return value;
}

export function sessionId(value: string): string {
  if (!SESSION_ID_PATTERN.test(value)) throw new BadRequest("session_id is malformed");
  return value;
}

function nonEmpty(value: string, key: string): string {
  if (!value.trim()) throw new BadRequest(`${key} must not be empty`);
  return value;
}

export function parseNewResponse(input: unknown): Required<
  Omit<NewResponseRequest, "created_at" | "claude_process">
> & {
  created_at: EpochSeconds | undefined;
  claude_process: ClaudeProcess | undefined;
} {
  const body = asObject(input);
  const createdAt = body["created_at"];
  if (createdAt !== undefined && (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt <= 0)) {
    throw new BadRequest("created_at must be a positive number of seconds");
  }
  return {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    session_name: (optionalString(body, "session_name", LIMITS.sessionName) ?? "").trim(),
    cwd: optionalString(body, "cwd", LIMITS.cwd) ?? "",
    text: string(body, "text", LIMITS.replyText),
    created_at: createdAt,
    claude_process: optionalProcess(body),
  };
}

export type ParsedNote =
  | { kind: "root"; responseId: number; blockIndex: number; quote: string; body: string }
  | { kind: "follow-up"; parentId: number; body: string };

export function parseNewNote(input: unknown): ParsedNote {
  const body = asObject(input);
  const text = nonEmpty(string(body, "body", LIMITS.noteBody), "body").trim();
  if (body["parent_id"] !== undefined && body["parent_id"] !== null) {
    return { kind: "follow-up", parentId: integer(body, "parent_id", 1), body: text };
  }
  return {
    kind: "root",
    responseId: integer(body, "response_id", 1),
    blockIndex: integer(body, "block_index", -1),
    quote: string(body, "quote", LIMITS.quote),
    body: text,
  };
}

export function parseTouchSession(input: unknown): Required<TouchSessionRequest> {
  const body = asObject(input);
  return {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    session_name: (optionalString(body, "session_name", LIMITS.sessionName) ?? "").trim(),
    cwd: optionalString(body, "cwd", LIMITS.cwd) ?? "",
  };
}

export function parseClaim(input: unknown): ClaimRequest {
  const body = asObject(input);
  const prompt = optionalString(body, "prompt", LIMITS.message);
  const session_id = matching(body, "session_id", SESSION_ID_PATTERN);
  const claim: ClaimRequest = prompt === undefined ? { session_id } : { session_id, prompt };
  const claudeProcess = optionalProcess(body);
  if (claudeProcess) claim.claude_process = claudeProcess;
  return claim;
}

export function parseActivity(input: unknown): ActivityRequest {
  const body = asObject(input);
  return {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    text: nonEmpty(string(body, "text", MAX_ACTIVITY_CHARS), "text"),
  };
}

export function parseProgress(input: unknown): ProgressRequest {
  const body = asObject(input);
  return {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    message_id: matching(body, "message_id", REQUEST_ID_PATTERN),
    index: integer(body, "index", 0),
    delta: string(body, "delta", MAX_PROGRESS_DELTA_CHARS),
  };
}

export function parseWaiter(input: unknown): WaiterRequest {
  const body = asObject(input);
  const waiter: WaiterRequest = {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    waiter_id: matching(body, "waiter_id", WAITER_ID_PATTERN),
  };
  const claudeProcess = optionalProcess(body);
  if (claudeProcess) waiter.claude_process = claudeProcess;
  return waiter;
}

export function parseSend(input: unknown): SendRequest {
  const ids = asObject(input)["session_ids"];
  if (!Array.isArray(ids) || ids.length > LIMITS.sessionIds || !ids.every((id) => typeof id === "string")) {
    throw new BadRequest("session_ids must be a list of session ids");
  }
  return { session_ids: ids.map(sessionId) };
}

export function parseRedeem(input: unknown): RedeemRequest {
  return { code: matching(asObject(input), "code", LAUNCH_CODE_PATTERN) };
}

export function parseRegisterSession(input: unknown): RegisterSessionRequest {
  const body = asObject(input);
  const cwd = string(body, "cwd", LIMITS.cwd);
  if (!isAbsolute(cwd) || cwd.includes("\0")) throw new BadRequest("cwd must be an absolute path");
  const id = optionalString(body, "session_id", 256);
  return id === undefined ? { cwd } : { cwd, session_id: sessionId(id) };
}

export function parseStartConversation(input: unknown): Required<StartConversationRequest> {
  const body = asObject(input);
  const resume = body["resume"] ?? false;
  if (typeof resume !== "boolean") throw new BadRequest("resume must be true or false");
  return { session_id: matching(body, "session_id", SESSION_ID_PATTERN), resume };
}

export function parseConversationMessage(input: unknown): ConversationMessageRequest {
  const body = asObject(input);
  return {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    text: string(body, "text", LIMITS.message),
  };
}

export function parsePrompt(input: unknown): PromptRequest {
  const body = asObject(input);
  return {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    text: nonEmpty(string(body, "text", LIMITS.message), "text").trim(),
  };
}

export function parsePermissionAnswer(input: unknown): PermissionAnswerRequest {
  const body = asObject(input);
  const decision = string(body, "decision", 16);
  if (!DECISIONS.has(decision)) throw new BadRequest("decision must be allow, deny or always");
  return {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    request_id: matching(body, "request_id", REQUEST_ID_PATTERN),
    decision: decision as PermissionAnswerRequest["decision"],
  };
}

export function parseSessionRequest(input: unknown): SessionRequest {
  return { session_id: matching(asObject(input), "session_id", SESSION_ID_PATTERN) };
}

export function parseRename(input: unknown): RenameSessionRequest {
  const body = asObject(input);
  return {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    label: string(body, "label", LIMITS.sessionName).replace(/\s+/g, " ").trim(),
  };
}

/** The Claude process a hook reports, if it found one. */
function optionalProcess(body: JsonObject): ClaudeProcess | undefined {
  const value = body["claude_process"];
  if (value === undefined || value === null) return undefined;
  const fields = asObject(value);
  return { pid: integer(fields, "pid", 2), started: nonEmpty(string(fields, "started", 64), "started") };
}

export function parseStartSession(input: unknown): Required<StartSessionRequest> {
  const body = asObject(input);
  return {
    session_id: matching(body, "session_id", SESSION_ID_PATTERN),
    prompt: (optionalString(body, "prompt", MAX_PROMPT_CHARS) ?? "").trim(),
    name: (optionalString(body, "name", LIMITS.sessionName) ?? "").replace(/\s+/g, " ").trim(),
  };
}
