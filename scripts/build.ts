// Builds dist/: the CLI and server for Node, and the page for the browser.
// dist/ is committed, so installing the plugin needs no npm install or build step.
import { build, type BuildOptions } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const web = join(root, "src", "web");

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "web"), { recursive: true });

const shared: BuildOptions = { bundle: true, legalComments: "none", logLevel: "warning" };

await Promise.all([
  build({
    ...shared,
    entryPoints: { cli: join(root, "src/cli/main.ts"), server: join(root, "src/server/main.ts") },
    outdir: dist,
    platform: "node",
    format: "esm",
    target: "node20",
  }),
  build({
    ...shared,
    entryPoints: { app: join(web, "main.ts"), theme: join(web, "theme.ts") },
    outdir: join(dist, "web"),
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: true,
  }),
]);

for (const file of ["index.html", "app.css", "logo.svg"]) {
  copyFileSync(join(web, file), join(dist, "web", file));
}
console.log("built dist/");
