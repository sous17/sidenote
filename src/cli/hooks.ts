import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  ClaimResult,
  NewResponseRequest,
  NewResponseResult,
  ServerInfo,
  WaiterPollResult,
} from "../shared/types.ts";
import { SERVER_START_TIMEOUT_MS, callApi, ensureServer, openBrowser, pageUrl, runningServer } from "./client.ts";
import { formatNotesForClaude } from "./format.ts";
import { sessionNameFromTranscript } from "./transcript.ts";

const WAITER_POLL_MS = 1000;

/** The fields sidenote reads from Claude Code's hook input. */
export interface HookInput {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  last_assistant_message?: string;
}

function sessionName(transcriptPath: string | undefined): string {
  if (!transcriptPath) return "";
  try {
    return sessionNameFromTranscript(readFileSync(transcriptPath, "utf8"));
  } catch {
    return "";
  }
}

/** Stop: sends the finished reply to the session's window, opening it for a new session. */
export async function hookStop(input: HookInput): Promise<void> {
  const text = (input.last_assistant_message ?? "").trim();
  const sessionId = input.session_id ?? "";
  if (!text || !sessionId) return;
  const { server, started } = await ensureServer();
  const body: NewResponseRequest = {
    session_id: sessionId,
    session_name: sessionName(input.transcript_path),
    cwd: input.cwd ?? "",
    text,
  };
  const result = await callApi<NewResponseResult>(server, "POST", "/api/responses", body);
  if (started || result.new_session) openBrowser(pageUrl(server, sessionId));
}

/** UserPromptSubmit: attaches this session's pending notes to the prompt. */
export async function hookPrompt(input: HookInput): Promise<void> {
  const server = await runningServer();
  if (!server) return;
  const { comments } = await callApi<ClaimResult>(server, "POST", "/api/claim", { session_id: input.session_id ?? "" });
  if (!comments.length) return;
  const output = {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: formatNotesForClaude(comments) },
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

/**
 * Stop, run in the background with asyncRewake: waits for the user to click Send now in the
 * browser, then prints the notes to stderr and exits 2, which wakes Claude to answer them.
 */
export async function hookWait(input: HookInput): Promise<void> {
  const sessionId = input.session_id;
  if (!sessionId) return;
  // The Stop hook that starts the server runs alongside this one, so give it time.
  let server: ServerInfo | null = null;
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (!(server = await runningServer())) {
    if (Date.now() > deadline) return;
    await sleep(500);
  }
  const waiter = { session_id: sessionId, waiter_id: randomBytes(8).toString("hex") };
  await callApi(server, "POST", "/api/waiters", waiter);
  for (;;) {
    await sleep(WAITER_POLL_MS);
    let result: WaiterPollResult;
    try {
      result = await callApi<WaiterPollResult>(server, "POST", "/api/waiters/poll", waiter);
    } catch {
      return; // sidenote was turned off or restarted
    }
    if (result.action === "exit") return;
    if (result.action === "send") {
      process.stderr.write(formatNotesForClaude(result.comments, { fromBrowser: true }));
      // Exit code 2 is what wakes Claude. Set it rather than calling process.exit, so stderr
      // finishes writing first (pipes are asynchronous on macOS).
      process.exitCode = 2;
      return;
    }
  }
}
