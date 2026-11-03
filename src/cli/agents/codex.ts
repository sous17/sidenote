// Codex CLI (https://learn.chatgpt.com/docs/hooks). Its hooks follow Claude Code's closely:
// SessionStart and UserPromptSubmit add context, Stop carries the final message. It can't wake an
// idle session, so Send now goes out when the current turn ends: a Stop hook that answers
// {"decision": "block", "reason": …} makes Codex continue with the reason as its next prompt.
import { json, notesAtTurnEnd, notesForPrompt, recordReply, sessionContext, text, type HookHandler } from "./core.ts";

export const codex: Record<string, HookHandler> = {
  "session-start": async () =>
    json({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sessionContext() } }),

  prompt: async (input) => {
    const id = text(input, "session_id");
    const notes = id ? await notesForPrompt(id) : null;
    return notes ? json({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: notes } }) : {};
  },

  /** Records the reply, then continues the turn with any notes sent while Codex was working. */
  stop: async (input) => {
    const id = text(input, "session_id");
    if (!id) return json({});
    const reply = text(input, "last_assistant_message");
    if (reply) await recordReply({ agent: "codex", id, cwd: text(input, "cwd") ?? "" }, reply);
    const notes = await notesAtTurnEnd(id);
    // Codex requires JSON on stdout when a Stop hook exits 0.
    return json(notes ? { decision: "block", reason: notes } : {});
  },
};
