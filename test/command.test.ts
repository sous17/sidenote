import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");

function scratch(): { home: string; bin: string; command: string; launcherFile: string } {
  const home = mkdtempSync(join(tmpdir(), "sidenote-command-"));
  const bin = join(home, ".local", "bin");
  return { home, bin, command: join(bin, "sidenote"), launcherFile: join(home, ".sidenote", "launcher") };
}

function sidenote(home: string, args: string[], path = process.env["PATH"] ?? "") {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, HOME: home, PATH: path },
    encoding: "utf8",
    input: "{}",
  });
}

test("the installed command runs the plugin, from anywhere", () => {
  const { home, bin, command } = scratch();
  const installed = sidenote(home, ["install-command"], `${bin}:${process.env["PATH"]}`);
  assert.equal(installed.status, 0);
  assert.match(installed.stdout, /Run sidenote chat/);
  assert.doesNotMatch(installed.stdout, /isn't on your PATH/);
  assert.ok(statSync(command).mode & 0o100, "it can be run");

  const output = execFileSync(command, ["status"], {
    cwd: tmpdir(),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  assert.match(output, /enabled: no/);
});

test("a command folder off the PATH comes with the line to add", () => {
  const { home } = scratch();
  const installed = sidenote(home, ["install-command"], "/usr/bin:/bin");
  assert.equal(installed.status, 0);
  assert.match(installed.stdout, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
});

test("someone else's sidenote command is left alone", () => {
  const { home, bin, command, launcherFile } = scratch();
  mkdirSync(bin, { recursive: true });
  writeFileSync(command, "#!/bin/sh\necho mine\n");

  const refused = sidenote(home, ["install-command"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /left alone/);
  assert.equal(readFileSync(command, "utf8"), "#!/bin/sh\necho mine\n");
  assert.equal(existsSync(launcherFile), false);
});

test("a link at the command's path is left alone, even a broken one", () => {
  const { home, bin, command } = scratch();
  mkdirSync(bin, { recursive: true });
  symlinkSync(join(home, "nowhere"), command);

  assert.equal(sidenote(home, ["install-command"]).status, 1);
  assert.equal(existsSync(join(home, "nowhere")), false);
});

test("installing again replaces our own command", () => {
  const { home } = scratch();
  assert.equal(sidenote(home, ["install-command"]).status, 0);
  assert.equal(sidenote(home, ["install-command"]).status, 0);
});

test("each session moves the command to the plugin it runs from, and exits cleanly", () => {
  const { home, launcherFile } = scratch();
  sidenote(home, ["install-command"]);
  writeFileSync(launcherFile, "/old/version/bin/sidenote");

  assert.equal(sidenote(home, ["hook-session"]).status, 0);
  assert.equal(readFileSync(launcherFile, "utf8"), join(root, "bin", "sidenote"));
});

test("a session leaves no trace for someone who never installed the command", () => {
  const { home, launcherFile } = scratch();
  assert.equal(sidenote(home, ["hook-session"]).status, 0);
  assert.equal(existsSync(launcherFile), false);
});

test("a plugin that has gone gets a clear message", () => {
  const { home, command, launcherFile } = scratch();
  sidenote(home, ["install-command"]);
  writeFileSync(launcherFile, "/gone/bin/sidenote");
  chmodSync(launcherFile, 0o600);

  const run = spawnSync(command, ["status"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /can't find its plugin/);
});

test("status gives the short command once it works, and points to it until then", () => {
  const { home, bin } = scratch();
  // sidenote on opens a browser, so a stand-in takes the call.
  const fakebin = join(home, "fakebin");
  mkdirSync(fakebin);
  for (const opener of ["open", "xdg-open"]) {
    writeFileSync(join(fakebin, opener), "#!/bin/sh\n");
    chmodSync(join(fakebin, opener), 0o755);
  }
  const path = `${fakebin}:${bin}:${process.env["PATH"]}`;
  const session = "11111111-2222-3333-4444-555555555555";
  const on = sidenote(home, ["on"], path);
  assert.equal(on.status, 0, on.stderr);
  try {
    const port = readFileSync(join(home, ".sidenote", "port"), "utf8");
    const { token } = JSON.parse(readFileSync(join(home, ".sidenote", "server.json"), "utf8")) as { token: string };
    assert.ok(port && token);
    execFileSync(process.execPath, [
      "-e",
      `fetch("http://127.0.0.1:${port}/api/sessions",{method:"POST",headers:{"X-Review-Token":${JSON.stringify(token)}},body:JSON.stringify({session_id:"${session}",cwd:"/tmp"})}).then(r=>process.exit(r.ok?0:1))`,
    ]);

    assert.match(sidenote(home, ["status", session], path).stdout, /\/sidenote:terminal/);
    sidenote(home, ["install-command"], path);
    assert.match(sidenote(home, ["status", session], path).stdout, new RegExp(`terminal: sidenote tui ${session}`));
  } finally {
    sidenote(home, ["off"], path);
  }
});
