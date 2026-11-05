import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stagePlugin } from "../scripts/stage-plugin.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = (): string => mkdtempSync(join(tmpdir(), "sidenote-stage-"));

test("a release holds what runs, at its own version, and none of the source", () => {
  const target = scratch();
  stagePlugin(root, target, "9.8.7");

  for (const file of ["bin/sidenote", "dist/cli.js", "dist/web/index.html", "hooks/hooks.json", "skills/on/SKILL.md"]) {
    assert.ok(existsSync(join(target, file)), file);
  }
  for (const entry of ["src", "test", "docs", "scripts", "node_modules"]) {
    assert.equal(existsSync(join(target, entry)), false, entry);
  }
  const manifest = JSON.parse(readFileSync(join(target, ".claude-plugin", "plugin.json"), "utf8")) as {
    version: string;
  };
  assert.equal(manifest.version, "9.8.7");
});

test("a release runs from where it lands", () => {
  const target = scratch();
  stagePlugin(root, target, "9.8.7");
  const home = scratch();

  const output = execFileSync(join(target, "bin", "sidenote"), ["status"], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  assert.match(output, /enabled: no/);
});

test("a checkout that wasn't built is refused", () => {
  const checkout = scratch();
  mkdirSync(join(checkout, "dist"));
  writeFileSync(join(checkout, "README.md"), "");
  assert.throws(() => stagePlugin(checkout, scratch(), "1.0.0"), /npm run build/);
  rmSync(checkout, { recursive: true });
});
