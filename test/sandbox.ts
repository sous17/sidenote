// A scratch HOME for end-to-end tests: runs the built launcher against a real server, with a
// stand-in browser that records the URLs it is asked to open.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ServerInfo } from "../src/shared/types.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(ROOT, "bin", "sidenote");

export interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class Sandbox {
  readonly home = mkdtempSync(join(tmpdir(), "sidenote-home-"));
  readonly #opened = join(this.home, "opened.txt");
  #openedCount = 0;

  constructor() {
    if (!existsSync(join(ROOT, "dist", "cli.js"))) throw new Error("run npm run build first");
    mkdirSync(join(this.home, "fakebin"));
    for (const opener of ["open", "xdg-open"]) {
      writeFileSync(join(this.home, "fakebin", opener), `#!/bin/sh\necho "$1" >> "${this.#opened}"\n`);
      chmodSync(join(this.home, "fakebin", opener), 0o755);
    }
  }

  run(args: string[], stdin: object | string = "", env: Record<string, string> = {}): Promise<Run> {
    const child = spawn(LAUNCHER, args, {
      env: {
        ...process.env,
        HOME: this.home,
        PATH: `${join(this.home, "fakebin")}:${process.env["PATH"]}`,
        SIDENOTE_NODE: process.execPath,
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.stdin.end(typeof stdin === "string" ? stdin : JSON.stringify(stdin));
    return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
  }

  /** Runs `sidenote hook <agent> <hook>` and parses its JSON output, if any. */
  async hook(agent: string, hook: string, input: object): Promise<Record<string, unknown>> {
    const { stdout, code } = await this.run(["hook", agent, hook], input);
    if (code !== 0) throw new Error(`hook ${agent} ${hook} exited ${code}`);
    return stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>) : {};
  }

  server(): ServerInfo {
    return JSON.parse(readFileSync(join(this.home, ".sidenote", "server.json"), "utf8")) as ServerInfo;
  }

  async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { port, token } = this.server();
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "X-Review-Token": token, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await response.json()) as T;
  }

  /** The next URL the stand-in browser is asked to open. The opener runs detached, so wait for it. */
  async nextOpened(): Promise<URL> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const lines = existsSync(this.#opened) ? readFileSync(this.#opened, "utf8").trim().split("\n") : [];
      if (lines.length > this.#openedCount) {
        this.#openedCount = lines.length;
        return new URL(lines.at(-1)!);
      }
      if (Date.now() > deadline) throw new Error("the browser was not opened");
      await sleep(50);
    }
  }
}
