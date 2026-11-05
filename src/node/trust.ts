// Whether the user trusted a folder in Claude Code. `claude -p` never shows the trust dialog, and
// still runs a repository's hooks and MCP servers, so sidenote only starts it where the user has
// already said yes. The rules are Claude Code's own:
// https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { paths } from "./paths.ts";

const WORKTREE_GITDIR = /^gitdir: (.+)\/\.git\/worktrees\/[^/\n]+\s*$/;

function read(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * The main checkout of the worktree at `folder`, or null. A `.git` file can claim anything, so the
 * claim only counts when the repository it names lists this folder as its worktree.
 */
function mainCheckout(folder: string): string | null {
  const gitFile = join(folder, ".git");
  const gitDir = /^gitdir: (.+?)\s*$/.exec(read(gitFile))?.[1];
  const main = WORKTREE_GITDIR.exec(read(gitFile))?.[1];
  if (!gitDir || !main) return null;
  return read(join(resolve(folder, gitDir), "gitdir")).trim() === gitFile ? resolve(folder, main) : null;
}

/** The repository root trust is kept under, or null outside a repository. */
function repositoryRoot(folder: string): string | null {
  for (let dir = folder; ; dir = dirname(dir)) {
    const git = statSync(join(dir, ".git"), { throwIfNoEntry: false });
    if (git) return (git.isFile() && mainCheckout(dir)) || dir;
    if (dir === dirname(dir)) return null;
  }
}

/** Anything that can't be read counts as not trusted. */
export function isTrustedFolder(folder: string, configFile: string = paths.claudeConfig()): boolean {
  let projects: unknown;
  try {
    projects = (JSON.parse(read(configFile)) as { projects?: unknown }).projects;
  } catch {
    return false;
  }
  if (typeof projects !== "object" || projects === null) return false;
  const known = new Map(Object.entries(projects));
  const accepted = (path: string): boolean =>
    (known.get(path) as { hasTrustDialogAccepted?: unknown } | undefined)?.hasTrustDialogAccepted === true;

  const repository = repositoryRoot(folder);
  if (repository) return accepted(repository);
  // Outside a repository, trust covers the subfolders of the folder it was given for.
  for (let dir = folder; ; dir = dirname(dir)) {
    if (accepted(dir)) return true;
    if (dir === dirname(dir)) return false;
  }
}
