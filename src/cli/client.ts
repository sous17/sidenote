import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { paths } from "../shared/paths.ts";
import { TOKEN_HEADER, type ServerInfo } from "../shared/types.ts";

export const SERVER_START_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 3000;
// Bundled to dist/cli.js, next to dist/server.js.
const SERVER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "server.js");

export function readServerInfo(): ServerInfo | null {
  try {
    return JSON.parse(readFileSync(paths.serverFile(), "utf8")) as ServerInfo;
  } catch {
    return null;
  }
}

export async function callApi<T>(server: ServerInfo, method: string, path: string, payload?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { [TOKEN_HEADER]: server.token, "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}`);
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** The running server, or null when none answers. */
export async function runningServer(): Promise<ServerInfo | null> {
  const server = readServerInfo();
  if (!server) return null;
  try {
    await callApi(server, "GET", "/api/health");
    return server;
  } catch {
    return null;
  }
}

export async function startServer(): Promise<ServerInfo> {
  mkdirSync(paths.stateDir(), { recursive: true, mode: 0o700 });
  rmSync(paths.serverFile(), { force: true });
  const log = openSync(paths.logFile(), "a");
  spawn(process.execPath, [SERVER_SCRIPT], { detached: true, stdio: ["ignore", log, log] }).unref();
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const server = await runningServer();
    if (server) return server;
    await sleep(100);
  }
  throw new Error(`sidenote server did not start, see ${paths.logFile()}`);
}

/** The window for one session. Without a session, the page asks to be opened from one. */
export function pageUrl(server: ServerInfo, sessionId?: string): string {
  const session = sessionId ? `&s=${encodeURIComponent(sessionId)}` : "";
  return `http://127.0.0.1:${server.port}/?t=${server.token}${session}`;
}

export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => console.error(`Open ${url} in your browser.`));
  child.unref();
}

/** The running server, starting one if needed; started says whether this call started it. */
export async function ensureServer(): Promise<{ server: ServerInfo; started: boolean }> {
  const existing = await runningServer();
  if (existing) return { server: existing, started: false };
  return { server: await startServer(), started: true };
}
