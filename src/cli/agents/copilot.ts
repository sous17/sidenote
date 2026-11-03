// GitHub Copilot CLI (https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference).
// Hooks are configured with camelCase event names, so payloads use camelCase fields.
//
// agentStop doesn't carry the reply text, only a transcript path. That file is the session's
// events.jsonl, whose format GitHub doesn't document; the reply is read from its last top-level
// assistant.message events. This part is experimental. Notes go in at the end of a turn: an
// agentStop answer of {"decision": "block", "reason": …} makes Copilot continue with the reason.
import { readFileSync } from "node:fs";
import { json, notesAtTurnEnd, recordReply, sessionContext, startTurn, text, type HookHandler } from "./core.ts";

interface CopilotEvent {
  type?: string;
  data?: { content?: unknown; parentToolCallId?: unknown };
}

/** The text of the agent's last reply in a Copilot events.jsonl transcript, or "". */
export function lastReplyFromTranscript(transcript: string): string {
  let reply = "";
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let event: CopilotEvent;
    try {
      event = JSON.parse(line) as CopilotEvent;
    } catch {
      continue;
    }
    if (event.type === "user.message") reply = "";
    // Messages inside a subagent's tool call carry a parentToolCallId; they aren't the reply.
    if (event.type !== "assistant.message" || event.data?.parentToolCallId) continue;
    const content = contentText(event.data?.content);
    if (content) reply = content;
  }
  return reply;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) =>
      typeof part === "object" && part && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("")
    .trim();
}

export const copilot: Record<string, HookHandler> = {
  "session-start": async () => json({ additionalContext: sessionContext() }),

  /** userPromptSubmitted can't add context: the turn starts, and unsent notes follow at its end. */
  prompt: async (input) => {
    const id = text(input, "sessionId", "session_id");
    if (id) await startTurn(id);
    return {};
  },

  stop: async (input) => {
    const id = text(input, "sessionId", "session_id");
    if (!id) return {};
    const transcriptPath = text(input, "transcriptPath", "transcript_path");
    let reply = "";
    try {
      if (transcriptPath) reply = lastReplyFromTranscript(readFileSync(transcriptPath, "utf8"));
    } catch {
      // Unreadable transcript: nothing to record.
    }
    if (reply) await recordReply({ agent: "copilot", id, cwd: text(input, "cwd") ?? "" }, reply);
    const notes = await notesAtTurnEnd(id);
    return notes ? json({ decision: "block", reason: notes }) : {};
  },
};
