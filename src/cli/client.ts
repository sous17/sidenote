// Talking to the sidenote server from the CLI and the hooks.
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { openWithSystem } from "../node/open.ts";
import { paths } from "../node/paths.ts";
import { serverLockOwner } from "../server/lock.ts";
import { folderName, folderPath } from "../shared/folders.ts";
import {
  LAUNCH_FRAGMENT_KEY,
  PAGE_HOST,
  TOKEN_HEADER,
  type ErrorResult,
  type LaunchCodeResult,
  type ServerInfo,
} from "../shared/types.ts";

export const SERVER_START_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 3000;
// Bundled to dist/cli.js, next to dist/server.js.
const SERVER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "server.js");

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class SidenoteClient {
  readonly #server: ServerInfo;

  constructor(server: ServerInfo) {
    this.#server = server;
  }

  /** The running server, or null when none answers. */
  static async connect(): Promise<SidenoteClient | null> {
    const server = readServerInfo();
    if (!server) return null;
    const client = new SidenoteClient(server);
    try {
      await client.get("/api/health");
      return client;
    } catch {
      return null;
    }
  }

  /** The running server, starting one if needed; `started` says whether this call started it. */
  static async ensure(): Promise<{ client: SidenoteClient; started: boolean }> {
    const running = await SidenoteClient.connect();
    if (running) return { client: running, started: false };
    return { client: await startServer(), started: true };
  }

  get origin(): string {
    return `http://127.0.0.1:${this.#server.port}`;
  }

  /** timeoutMs is for long polls, which the server holds open until something changes. */
  get<T>(path: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    return this.#request<T>("GET", path, undefined, timeoutMs);
  }

  post<T>(path: string, body: object): Promise<T> {
    return this.#request<T>("POST", path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.#request<T>("DELETE", path);
  }

  /**
   * The address of the window for a folder. Only browsers get the page host: Node may resolve it
   * to ::1, where the server doesn't listen, so the CLI's own requests stay on 127.0.0.1.
   */
  windowAddress(cwd: string): string {
    return `http://${PAGE_HOST}:${this.#server.port}${folderPath(folderName(cwd))}`;
  }

  /**
   * A one-time link to a session's window. The launch code sits in the URL fragment, which the
   * browser never sends to the server; the page trades it for the token once.
   */
  async windowUrl(sessionId: string | undefined, cwd = ""): Promise<string> {
    const { code } = await this.post<LaunchCodeResult>("/api/launch", {});
    const query = sessionId ? `?s=${encodeURIComponent(sessionId)}` : "";
    return `${this.windowAddress(cwd)}${query}#${LAUNCH_FRAGMENT_KEY}=${code}`;
  }

  async #request<T>(method: string, path: string, body?: object, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const response = await fetch(this.origin + path, {
      method,
      headers: { [TOKEN_HEADER]: this.#server.token, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = text ? (JSON.parse(text) as Partial<ErrorResult>).error : undefined;
      throw new ApiError(
        response.status,
        `${method} ${path} failed with ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    return (text ? JSON.parse(text) : null) as T;
  }
}

function readServerInfo(): ServerInfo | null {
  try {
    return JSON.parse(readFileSync(paths.serverFile(), "utf8")) as ServerInfo;
  } catch {
    return null;
  }
}

/** The pid of the running server, for `sidenote off`. The lock knows it even if server.json is lost. */
export function serverPid(): number | null {
  return serverLockOwner(paths.lockFile());
}

async function startServer(): Promise<SidenoteClient> {
  mkdirSync(paths.stateDir(), { recursive: true, mode: 0o700 });
  // Leave server.json alone: another process may have just started the server. A stale one fails
  // the health check below until the new server replaces it.
  const log = openSync(paths.logFile(), "a", 0o600);
  spawn(process.execPath, [SERVER_SCRIPT], { detached: true, stdio: ["ignore", log, log] }).unref();
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const client = await SidenoteClient.connect();
    if (client) return client;
    await sleep(100);
  }
  throw new Error(`the sidenote server did not start; see ${paths.logFile()}`);
}

/** Opens a URL in the default browser. */
export function openBrowser(url: string): void {
  openWithSystem(url, () => console.error(`Couldn't open a browser. Open this link instead (valid once): ${url}`));
}
