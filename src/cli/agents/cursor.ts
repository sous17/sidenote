// Cursor (https://cursor.com/docs/agent/hooks). The agent's reply text arrives in
// afterAgentResponse, which can fire for more than one message in a turn, so the latest one is
// kept and recorded when the turn stops. No hook adds context to a prompt, so notes go in a
// follow-up: when a stop hook returns followup_message, Cursor submits it as the next message.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../node/paths.ts";
import { SESSION_ID_PATTERN } from "../../shared/types.ts";
import {
  json,
  notesAtTurnEnd,
  recordReply,
  sessionContext,
  startTurn,
  text,
  type HookHandler,
  type HookInput,
} from "./core.ts";

const conversation = (input: HookInput): string | undefined => {
  const id = text(input, "conversation_id", "session_id");
  return id && SESSION_ID_PATTERN.test(id) ? id : undefined;
};

/** The workspace folder, for the window's title. */
function workspace(input: HookInput): string {
  const roots = input["workspace_roots"];
  return Array.isArray(roots) && typeof roots[0] === "string" ? roots[0] : "";
}

/** The latest reply of a turn, kept between afterAgentResponse and stop. */
const latestReplyFile = (id: string): string => join(paths.stateDir(), "turns", `cursor-${id}.txt`);

export const cursor: Record<string, HookHandler> = {
  "session-start": async () => json({ additional_context: sessionContext() }),

  "after-response": async (input) => {
    const id = conversation(input);
    const reply = text(input, "text");
    if (id && reply) {
      mkdirSync(join(paths.stateDir(), "turns"), { recursive: true, mode: 0o700 });
      writeFileSync(latestReplyFile(id), reply, { mode: 0o600 });
    }
    return {};
  },

  /** beforeSubmitPrompt: the prompt goes through; unsent notes follow when this turn ends. */
  prompt: async (input) => {
    const id = conversation(input);
    if (id) await startTurn(id);
    return json({ continue: true });
  },

  stop: async (input) => {
    const id = conversation(input);
    if (!id) return json({});
    let reply = "";
    try {
      reply = readFileSync(latestReplyFile(id), "utf8");
      rmSync(latestReplyFile(id), { force: true });
    } catch {
      // No reply this turn.
    }
    if (reply) await recordReply({ agent: "cursor", id, cwd: workspace(input) }, reply);
    const notes = await notesAtTurnEnd(id);
    return json(notes ? { followup_message: notes } : {});
  },
};
