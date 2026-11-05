import type { ClaimedNote, EpochSeconds } from "./types.ts";

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

/**
 * Questions should come as replies. The AskUserQuestion tool pauses mid-turn, so no hook fires and
 * the window shows nothing, while a question in a reply ends the turn and can be answered from
 * the message box.
 */
export const QUESTION_RULE =
  "When you need the user to answer a question or choose between options, don't use the " +
  "AskUserQuestion tool: it waits in the terminal, where the sidenote window can't show it. " +
  "Write the question in your reply instead, with any options as a numbered list and your " +
  "recommendation if you have one, then end your turn. The user answers in their next message.";

/** Added to every session while sidenote is on, so requests typed in the terminal follow it too. */
export function sessionContext(): string {
  return (
    "The user follows this session in sidenote, which shows your replies and draws ```diff blocks as diffs. " +
    `${CODE_CHANGE_RULE} ${QUESTION_RULE}`
  );
}

/**
 * Describes delivered notes for Claude, and asks it to answer each under a marker line
 * ("**↳ Re: note 41**") so the server can file each answer into that note's thread.
 */
export function formatNotesForClaude(notes: readonly ClaimedNote[], options: { sendNow?: boolean } = {}): string {
  const first = notes[0];
  if (!first) return "";
  const [intro, formatRule] = options.sendNow
    ? [
        "The user clicked Send now in sidenote. There is no new " +
          "message: answer only these inline notes on your earlier responses.",
        "Format: skip any main answer. Answer each note in its own section that " +
          "starts with a line containing only its marker, for example:",
      ]
    : [
        "The user reviewed your earlier responses in sidenote and left " +
          "these inline notes. Address them together with the user's message.",
        "Format: first answer the user's message as usual (skip this part if their " +
          "message only asks you to look at the notes). Then answer each note in its " +
          "own section that starts with a line containing only its marker, for example:",
      ];
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

/** Opens what the waiter prints to wake Claude. It isn't something the user typed. */
const WAKE_MARKERS = ["The user clicked Send now in sidenote", "from the sidenote browser window"];

/** Whether a prompt is sidenote's own wake-up text rather than the user's words. */
export function isWakeText(prompt: string): boolean {
  return WAKE_MARKERS.some((marker) => prompt.includes(marker));
}

/**
 * A message the user typed in sidenote instead of the terminal, with any notes that ride along.
 * withTerminalPrompt: it waited out Claude's turn and now rides along with a prompt typed in the terminal.
 */
export function formatPromptForClaude(
  prompt: string,
  notes: readonly ClaimedNote[],
  options: { withTerminalPrompt?: boolean } = {},
): string {
  const intro = options.withTerminalPrompt
    ? "While you were working, the user also sent you this message from the sidenote browser " +
      "window. Treat it as part of their message:"
    : "The user sent you this message from the sidenote browser window instead of the terminal. " +
      "Treat it exactly as if they had typed it to you:";
  const text = `${intro}\n\n${prompt.trim()}`;
  if (!notes.length) return text;
  const combined = `${text}\n\n${formatNotesForClaude(notes)}`;
  return combined.length > MAX_CONTEXT_CHARS
    ? `${combined.slice(0, MAX_CONTEXT_CHARS)}\n[truncated: more comments are visible in the sidenote window]`
    : combined;
}
