import type { ClaimedNote, EpochSeconds } from "../shared/types.ts";

/** Claude Code caps hook context at 10,000 characters. */
export const MAX_CONTEXT_CHARS = 9500;

/**
 * Describes delivered notes for Claude, and asks it to answer each under a marker line
 * ("**↳ Re: note 41**") so the server can file each answer into that note's thread.
 */
export function formatNotesForClaude(notes: readonly ClaimedNote[], options: { fromBrowser?: boolean } = {}): string {
  const first = notes[0];
  if (!first) return "";
  const [intro, formatRule] = options.fromBrowser
    ? [
        "The user clicked Send now in the sidenote browser window. There is no new " +
          "terminal message: answer only these inline notes on your earlier responses.",
        "Format: skip any main answer. Answer each note in its own section that " +
          "starts with a line containing only its marker, for example:",
      ]
    : [
        "The user reviewed your earlier responses in the sidenote browser window and left " +
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
