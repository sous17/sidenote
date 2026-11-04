// Claude starts each note's answer with a line like "**↳ Re: note 41**" (see cli/format.ts).
const NOTE_MARKER =
  /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*↳?\s*Re:?\s*notes?\s+(?<ids>#?\d+(?:\s*(?:,|and|&)\s*#?\d+)*)\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i;
const TRAILING_RULES = /(?:\n\s*(?:-{3,}|\*{3,}|_{3,})\s*)+$/;
const FENCE = /^\s*(?:```|~~~)/;

export interface SplitReply {
  mainText: string;
  /** Answer text per note id; only notes that got a non-empty section appear. */
  answers: Map<number, string>;
}

/** Splits a reply into its main answer and the sections answering each note in noteIds. */
export function splitNoteAnswers(text: string, noteIds: ReadonlySet<number>): SplitReply {
  const main: string[] = [];
  const sections = new Map<number, string[]>();
  let current: number[] | null = null;
  let inFence = false;

  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) inFence = !inFence;
    const ids = inFence ? [] : markerIds(line).filter((id) => noteIds.has(id));
    if (ids.length) {
      current = ids;
      for (const id of ids) if (!sections.has(id)) sections.set(id, []);
      continue;
    }
    if (current === null) main.push(line);
    else for (const id of current) sections.get(id)!.push(line);
  }

  const answers = new Map<number, string>();
  for (const [id, lines] of sections) {
    const body = lines.join("\n").trim();
    if (body) answers.set(id, body);
  }
  // A trailing rule usually separated the main answer from the note sections.
  const mainText = main.join("\n").trim().replace(TRAILING_RULES, "").trim();
  return { mainText, answers };
}

const MAX_PROGRESS_MESSAGES = 20;
const MAX_PROGRESS_CHARS = 4000;

/**
 * A turn's messages as the page shows them while Claude works: without note markers, which would
 * only make sense once the reply is split, and bounded, because every poll carries them.
 */
export function liveProgress(messages: readonly string[]): string[] {
  return messages
    .map((text) =>
      text
        .split(/\r?\n/)
        .filter((line) => !NOTE_MARKER.test(line))
        .join("\n")
        .trim(),
    )
    .filter(Boolean)
    .slice(-MAX_PROGRESS_MESSAGES)
    .map((text) => (text.length > MAX_PROGRESS_CHARS ? `…${text.slice(-MAX_PROGRESS_CHARS)}` : text));
}

function markerIds(line: string): number[] {
  const ids = NOTE_MARKER.exec(line)?.groups?.["ids"];
  return ids ? [...ids.matchAll(/\d+/g)].map((match) => Number(match[0])) : [];
}
