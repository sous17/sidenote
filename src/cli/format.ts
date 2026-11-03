import type { ClaimedNote, EpochSeconds } from "../shared/types.ts";

/** Claude Code caps hook context at 10,000 characters. */
export const MAX_CONTEXT_CHARS = 9500;

/**
 * Code changes should come as diffs, which the sidenote window draws step by step: each
 * explanation, then the change it describes (see src/web/diffview.ts).
 */
export const CODE_CHANGE_RULE =
  "When you show a code change, or the user asks to see code or a diff, show it as changes to " +
  "the current code, not as whole files: for each change, a sentence or two on what it does and " +
  "why, then a ```diff block in unified diff format. Start each block with `--- a/<path>` and " +
  "`+++ b/<path>` lines and use @@ hunks with about three lines of context. Use one block per " +
  "file or per step. Put the diff in your reply itself, not only in command output such as " +
  "`git diff`, because the sidenote window shows only your replies.";

/** Added to every session while sidenote is on, so requests typed in the terminal follow it too. */
export function sessionContext(): string {
  return (
    "The user follows this session in the sidenote browser window, which shows your replies and draws ```diff blocks as diffs. " +
    CODE_CHANGE_RULE
  );
}

/** Why the notes reach the agent now, which decides how it should answer them. */
export type NoteTrigger =
  /** With a prompt the user typed: answer the prompt, then the notes. */
  | "prompt"
  /** The user clicked Send now and woke the agent: there is no prompt. */
  | "send-now"
  /** The agent just finished a turn and continues with the notes: there is no prompt. */
  | "turn-end";

const INTROS: Readonly<Record<NoteTrigger, [intro: string, format: string]>> = {
  prompt: [
    "The user reviewed your earlier responses in the sidenote browser window and left " +
      "these inline notes. Address them together with the user's message.",
    "Format: first answer the user's message as usual (skip this part if their " +
      "message only asks you to look at the notes). Then answer each note in its " +
      "own section that starts with a line containing only its marker, for example:",
  ],
  "send-now": [
    "The user clicked Send now in the sidenote browser window. There is no new " +
      "terminal message: answer only these inline notes on your earlier responses.",
    "Format: skip any main answer. Answer each note in its own section that " +
      "starts with a line containing only its marker, for example:",
  ],
  "turn-end": [
    "While you were working, the user left these inline notes on your earlier responses in " +
      "the sidenote browser window. There is no new message from the user: answer only the notes.",
    "Format: skip any main answer. Answer each note in its own section that " +
      "starts with a line containing only its marker, for example:",
  ],
};

/**
 * Describes delivered notes for the agent, and asks it to answer each under a marker line
 * ("**↳ Re: note 41**") so the server can file each answer into that note's thread.
 */
export function formatNotes(notes: readonly ClaimedNote[], trigger: NoteTrigger): string {
  const first = notes[0];
  if (!first) return "";
  const [intro, formatRule] = INTROS[trigger];
  const lines = [
    intro,
    "",
    formatRule,
    "",
    `**↳ Re: note ${first.id}**`,
    `Your answer to note ${first.id}.`,
    "",
    "Use one marker per note, with the note numbers given below, and put nothing after a " +
      "note's section that is not about that note. The sidenote window files each section " +
      "into that note's thread, so keep the main answer free of the note answers.",
    "",
    CODE_CHANGE_RULE,
  ];
  for (const note of notes) {
    const time = clockTime(note.response_created_at);
    const quote = note.quote
      ? note.quote
          .split(/\r?\n/)
          .map((line) => `> ${line}`)
          .join("\n")
      : "> (whole response)";
    if (note.root_body) {
      lines.push(
        `\nNote ${note.id}, a follow-up in the thread on your response from ${time}:\n` +
          `${quote}\nTheir earlier note: ${note.root_body}\nFollow-up: ${note.body}`,
      );
    } else {
      lines.push(`\nNote ${note.id}, on your response from ${time}:\n${quote}\n${note.body}`);
    }
  }
  const text = lines.join("\n");
  return text.length > MAX_CONTEXT_CHARS
    ? `${text.slice(0, MAX_CONTEXT_CHARS)}\n[truncated: more comments are visible in the sidenote window]`
    : text;
}

/** Local HH:MM, 24-hour. */
export function clockTime(epochSeconds: EpochSeconds): string {
  const date = new Date(epochSeconds * 1000);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
