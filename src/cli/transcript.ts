import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EpochSeconds } from "../shared/types.ts";

const QUESTION_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
}

interface TranscriptEntry {
  type?: string;
  cwd?: string;
  customTitle?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  timestamp?: string;
  message?: { id?: string; content?: string | ContentBlock[] };
}

export function findTranscript(transcriptsDir: string, sessionId: string): string | null {
  if (!existsSync(transcriptsDir)) return null;
  for (const project of readdirSync(transcriptsDir)) {
    const file = join(transcriptsDir, project, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * The last assistant text before each user prompt, i.e. the reply the user read.
 *
 * The transcript format is undocumented: one JSON object per line, assistant messages split
 * into one line per content block, sharing message.id. The final turn is skipped on purpose:
 * the Stop hook already delivered it.
 */
export function finalResponsesPerTurn(transcript: string): Array<{ createdAt: EpochSeconds; text: string }> {
  const replies: Array<{ createdAt: EpochSeconds; text: string }> = [];
  let lastMessageId: string | undefined;
  let lastBlocks: string[] = [];
  let lastTimestamp: EpochSeconds = 0;
  const flush = () => {
    replies.push({ createdAt: lastTimestamp, text: lastBlocks.join("\n\n").trim() });
    lastMessageId = undefined;
    lastBlocks = [];
  };

  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as TranscriptEntry;
    if (entry.isSidechain) continue;
    if (entry.type === "user" && isUserPrompt(entry) && lastBlocks.length) {
      flush();
    } else if (entry.type === "assistant") {
      const content = entry.message?.content;
      const blocks = Array.isArray(content) ? content : [];
      // Text right before a question to the user is a reply the user reads.
      if (blocks.some((b) => b.name && QUESTION_TOOLS.has(b.name)) && lastBlocks.length) {
        flush();
        continue;
      }
      const texts = blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text!);
      if (!texts.length) continue;
      if (entry.message?.id !== lastMessageId) {
        lastMessageId = entry.message?.id;
        lastBlocks = [];
      }
      lastBlocks.push(...texts);
      if (entry.timestamp) lastTimestamp = Date.parse(entry.timestamp) / 1000;
    }
  }
  return replies;
}

/**
 * The name the user gave the session with /rename. Claude Code records it in the transcript as
 * {"type":"custom-title","customTitle":...}; the format is undocumented, so any surprise means
 * "no name" and the page falls back to the project folder.
 */
export function sessionNameFromTranscript(transcript: string): string {
  // Search backwards: the latest rename wins, and lines that merely mention the text are skipped.
  let marker = transcript.lastIndexOf('"custom-title"');
  while (marker !== -1) {
    const start = transcript.lastIndexOf("\n", marker) + 1;
    const end = transcript.indexOf("\n", marker);
    try {
      const entry = JSON.parse(transcript.slice(start, end === -1 ? undefined : end)) as TranscriptEntry;
      if (entry.type === "custom-title" && typeof entry.customTitle === "string") return entry.customTitle.trim();
    } catch {
      // Not a whole entry; keep looking.
    }
    marker = start > 0 ? transcript.lastIndexOf('"custom-title"', start - 1) : -1;
  }
  return "";
}

/** The working directory the session ran in, from the first entry that records one. */
export function cwdFromTranscript(transcript: string): string {
  for (const line of transcript.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    try {
      const cwd = (JSON.parse(line) as TranscriptEntry).cwd;
      if (cwd) return cwd;
    } catch {
      // Skip a malformed line.
    }
  }
  return "";
}

export function readTranscript(file: string): string {
  return readFileSync(file, "utf8");
}

function isUserPrompt(entry: TranscriptEntry): boolean {
  if (entry.isMeta) return false;
  const content = entry.message?.content;
  if (typeof content === "string") return true;
  return Array.isArray(content) && !content.some((b) => b.type === "tool_result");
}
