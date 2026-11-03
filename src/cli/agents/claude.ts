// Claude Code: the plugin's hooks/hooks.json runs these. Claude Code has every capability sidenote
// uses, including waking an idle session for Send now (an asyncRewake hook that exits 2).
import { readFileSync } from "node:fs";
import { sessionNameFromTranscript } from "../transcript.ts";
import {
  json,
  notesForPrompt,
  recordReply,
  sessionContext,
  text,
  waitForSendNow,
  type HookHandler,
  type HookInput,
  type SessionRef,
} from "./core.ts";

function session(input: HookInput): SessionRef | null {
  const id = text(input, "session_id");
  return id ? { agent: "claude", id, cwd: text(input, "cwd") ?? "", name: renameOf(input) } : null;
}

/** The name given with /rename, read from the session's transcript; "" when it has none. */
function renameOf(input: HookInput): string {
  const path = text(input, "transcript_path");
  if (!path) return "";
  try {
    return sessionNameFromTranscript(readFileSync(path, "utf8"));
  } catch {
    return "";
  }
}

export const claude: Record<string, HookHandler> = {
  /** SessionStart: how to show code changes. */
  "session-start": async () =>
    json({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sessionContext() } }),

  /** Stop: the finished reply goes to the session's window. */
  stop: async (input) => {
    const ref = session(input);
    const reply = text(input, "last_assistant_message");
    if (ref && reply) await recordReply(ref, reply);
    return {};
  },

  /** UserPromptSubmit: unsent notes go with the prompt. */
  prompt: async (input) => {
    const id = text(input, "session_id");
    const notes = id ? await notesForPrompt(id) : null;
    return notes ? json({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: notes } }) : {};
  },

  /** Stop, in the background (asyncRewake): exit 2 with the notes on stderr wakes Claude. */
  wait: async (input) => {
    const id = text(input, "session_id");
    const notes = id ? await waitForSendNow(id) : null;
    return notes ? { stderr: notes, exitCode: 2 } : {};
  },
};
