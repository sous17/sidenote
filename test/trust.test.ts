import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isTrustedFolder } from "../src/node/trust.ts";

function scratch(): { root: string; config: string; trust: (...folders: string[]) => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sidenote-trust-")));
  const config = join(root, "claude.json");
  const trust = (...folders: string[]): void => {
    const projects = Object.fromEntries(folders.map((folder) => [folder, { hasTrustDialogAccepted: true }]));
    writeFileSync(config, JSON.stringify({ projects }));
  };
  return { root, config, trust };
}

function folder(...parts: string[]): string {
  const path = join(...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

test("a repository is trusted through its root, for every folder inside it", () => {
  const { root, config, trust } = scratch();
  const repository = folder(root, "shop");
  mkdirSync(join(repository, ".git"));
  const inside = folder(repository, "src", "api");

  trust(repository);
  assert.equal(isTrustedFolder(repository, config), true);
  assert.equal(isTrustedFolder(inside, config), true);
});

test("trusting a parent doesn't cover a repository inside it", () => {
  const { root, config, trust } = scratch();
  const clone = folder(root, "work", "clone");
  mkdirSync(join(clone, ".git"));

  trust(join(root, "work"));
  assert.equal(isTrustedFolder(clone, config), false);
});

test("outside a repository, trust covers subfolders but not parents or neighbors", () => {
  const { root, config, trust } = scratch();
  const trusted = folder(root, "notes");
  const below = folder(trusted, "2026");
  const neighbor = folder(root, "other");

  trust(trusted);
  assert.equal(isTrustedFolder(below, config), true);
  assert.equal(isTrustedFolder(neighbor, config), false);
  assert.equal(isTrustedFolder(root, config), false);
});

function worktree(root: string, main: string, listed: boolean): string {
  const tree = folder(root, "tree");
  const gitDir = folder(main, ".git", "worktrees", "tree");
  writeFileSync(join(tree, ".git"), `gitdir: ${gitDir}\n`);
  writeFileSync(join(gitDir, "gitdir"), listed ? `${join(tree, ".git")}\n` : "/somewhere/else/.git\n");
  return tree;
}

test("a worktree is trusted through its main checkout", () => {
  const { root, config, trust } = scratch();
  const main = folder(root, "main");
  const tree = worktree(root, main, true);

  trust(main);
  assert.equal(isTrustedFolder(tree, config), true);
});

test("a .git file can't borrow the trust of a repository that doesn't list it", () => {
  const { root, config, trust } = scratch();
  const main = folder(root, "main");
  const tree = worktree(root, main, false);

  trust(main);
  assert.equal(isTrustedFolder(tree, config), false);
});

test("a folder is not trusted when the answer is anything but a clear yes", () => {
  const { root, config } = scratch();
  const place = folder(root, "place");

  assert.equal(isTrustedFolder(place, join(root, "missing.json")), false);
  for (const contents of ["not json", "{}", '{"projects": 7}', '{"projects": null}']) {
    writeFileSync(config, contents);
    assert.equal(isTrustedFolder(place, config), false, contents);
  }
  writeFileSync(config, JSON.stringify({ projects: { [place]: { hasTrustDialogAccepted: false } } }));
  assert.equal(isTrustedFolder(place, config), false);
  writeFileSync(config, JSON.stringify({ projects: { [place]: { hasTrustDialogAccepted: "yes" } } }));
  assert.equal(isTrustedFolder(place, config), false);
});
