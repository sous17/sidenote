// Lays out what users install, from a built checkout. Only what runs: no source, tests or docs.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const COPIED = ["bin", "dist", "hooks", "skills", "LICENSE", "README.md"];

export function stagePlugin(root: string, target: string, version: string): void {
  if (!existsSync(join(root, "dist", "cli.js"))) throw new Error("dist/ is missing: run npm run build first");
  for (const entry of COPIED) cpSync(join(root, entry), join(target, entry), { recursive: true });

  const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")) as object;
  mkdirSync(join(target, ".claude-plugin"));
  // Claude Code keeps users on this version until it changes, so every release must carry its own.
  writeJson(join(target, ".claude-plugin", "plugin.json"), { ...manifest, version });
  copyFileSync(join(root, ".claude-plugin", "icon.png"), join(target, ".claude-plugin", "icon.png"));
  // dist/ is ES modules, which Node only loads as such under a package that says so.
  writeJson(join(target, "package.json"), { name: "sidenote", version, type: "module", private: true, license: "MIT" });
}

function writeJson(file: string, value: object): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
