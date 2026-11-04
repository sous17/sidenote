// Tool calls in a few words, for the line beside the typing dots. Tool names are Claude Code's.

/** The longest activity line; the page shows one row of it. */
export const MAX_ACTIVITY_CHARS = 200;
/** The most text one MessageDisplay batch may carry to the server. */
export const MAX_PROGRESS_DELTA_CHARS = 20_000;

const ACTIVITY_VERBS: ReadonlyMap<string, string> = new Map([
  ["Read", "Reading"],
  ["Edit", "Editing"],
  ["MultiEdit", "Editing"],
  ["NotebookEdit", "Editing"],
  ["Write", "Writing"],
  ["Bash", "Running"],
  ["Grep", "Searching for"],
  ["Glob", "Searching for"],
  ["WebFetch", "Fetching"],
  ["WebSearch", "Searching the web for"],
  ["Task", "Delegating:"],
  ["Agent", "Delegating:"],
]);

type Input = Readonly<Record<string, unknown>>;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** A path inside the session's folder is shown relative to it. */
function shortPath(path: string, cwd: string): string {
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  return path;
}

/** "src/app.ts" for Edit, "npm test" for Bash: what the call works on. */
export function toolSummary(tool: string, input: Input, cwd: string): string {
  const path = str(input["file_path"]) || str(input["notebook_path"]);
  if (path) return shortPath(path, cwd);
  switch (tool) {
    case "Bash":
      return firstLine(str(input["command"]));
    case "Glob":
    case "Grep": {
      const where = str(input["path"]);
      return where ? `${str(input["pattern"])} in ${shortPath(where, cwd)}` : str(input["pattern"]);
    }
    case "WebFetch":
      return str(input["url"]);
    case "WebSearch":
      return str(input["query"]);
    case "Task":
    case "Agent":
      return str(input["description"]);
    case "TodoWrite":
      return "";
  }
  const first = Object.values(input).find((value) => typeof value === "string" && value.trim());
  return firstLine(str(first));
}

/**
 * "Editing src/app.ts": a tool call as a line of what Claude is doing, or "" if it isn't worth
 * showing. Other tools show only their name, because their first argument could be anything.
 */
export function toolActivity(tool: string, input: Input, cwd: string): string {
  return activityLine(tool, toolSummary(tool, input, cwd));
}

/** The same line from a call's summary, for callers that kept only that. */
export function activityLine(tool: string, summary: string): string {
  if (tool === "TodoWrite") return "";
  const verb = ACTIVITY_VERBS.get(tool);
  const line = verb ? `${verb} ${summary}`.trim() : `Using ${tool}`;
  return line.slice(0, MAX_ACTIVITY_CHARS);
}

function firstLine(text: string): string {
  const lines = text.trim().split("\n");
  return lines.length > 1 ? `${lines[0]} …` : (lines[0] ?? "");
}
