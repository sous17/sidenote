// Tool calls in a few words for a one-line row, and in full for a permission prompt. Tool names
// are Claude Code's; other agents' tools fall back to their first string argument.

const MAX_DETAIL_CHARS = 4000;
const MAX_DETAIL_LINES = 40;

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

/** The call in full, for the user to read before allowing it. */
export function toolDetail(tool: string, input: Input, cwd: string): string {
  let detail: string;
  if (tool === "Bash") {
    detail = str(input["command"]);
  } else if (tool === "Write") {
    detail = `${shortPath(str(input["file_path"]), cwd)}\n${str(input["content"])}`;
  } else if (tool === "Edit") {
    const removed = prefixed(str(input["old_string"]), "- ");
    const added = prefixed(str(input["new_string"]), "+ ");
    detail = `${shortPath(str(input["file_path"]), cwd)}\n${removed}\n${added}`;
  } else {
    detail = JSON.stringify(input, null, 2);
  }
  return clip(detail);
}

function firstLine(text: string): string {
  const lines = text.trim().split("\n");
  return lines.length > 1 ? `${lines[0]} …` : (lines[0] ?? "");
}

function prefixed(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

function clip(text: string): string {
  const lines = text.split("\n");
  let clipped = lines.slice(0, MAX_DETAIL_LINES).join("\n");
  if (clipped.length > MAX_DETAIL_CHARS) clipped = clipped.slice(0, MAX_DETAIL_CHARS);
  return clipped.length < text.length ? `${clipped}\n…` : clipped;
}
