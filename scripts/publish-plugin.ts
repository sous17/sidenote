// Publishes the built plugin to the release branch, which is what users install from. Runs in
// semantic-release's prepare step, so a failed push stops the release before anything is tagged.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stagePlugin } from "./stage-plugin.ts";

const BRANCH = "release";
const version = process.argv[2];
if (!version) throw new Error("usage: publish-plugin.ts <version>");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const remote = process.env["RELEASE_REMOTE"] ?? `https://github.com/${process.env["GITHUB_REPOSITORY"]}.git`;
const target = mkdtempSync(join(tmpdir(), "sidenote-release-"));

// The token stays in the environment: a helper reads it, so it is never in a URL or an argument.
const credentials = [
  "-c",
  "credential.helper=",
  "-c",
  'credential.helper=!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f',
];
const identity = [
  "-c",
  "user.name=github-actions[bot]",
  "-c",
  "user.email=41898282+github-actions[bot]@users.noreply.github.com",
];
const git = (...args: string[]): void => {
  execFileSync("git", [...credentials, ...identity, ...args], { cwd: target, stdio: "inherit" });
};

try {
  git("init", "-q", "-b", BRANCH);
  git("remote", "add", "origin", remote);
  const lookup = ["ls-remote", "--exit-code", "origin", `refs/heads/${BRANCH}`];
  const published = spawnSync("git", [...credentials, ...lookup], { cwd: target }).status === 0;
  if (published) {
    git("fetch", "-q", "--depth=1", "origin", BRANCH);
    git("reset", "-q", "--soft", "FETCH_HEAD");
  }
  stagePlugin(root, target, version);
  git("add", "-A");
  git("commit", "-q", "-m", `chore(release): ${version}`);
  git("push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
} finally {
  rmSync(target, { recursive: true, force: true });
}
