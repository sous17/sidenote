// The sidenote server: one per machine, started in the background by the CLI.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openWithSystem } from "../node/open.ts";
import { paths } from "../node/paths.ts";
import { isSameClaude, pidInUse } from "../node/process.ts";
import { isTrustedFolder } from "../node/trust.ts";
import { canStartSessions, startInTerminal, terminalCommand } from "../node/terminal.ts";
import { ClaudeAgent } from "../agent/claude.ts";
import { sessionContext } from "../shared/format.ts";
import { PAGE_HOST, type ServerInfo } from "../shared/types.ts";
import { Delivery } from "./delivery.ts";
import { SessionHost } from "./host.ts";
import { createApp } from "./http.ts";
import { SessionProcesses } from "./processes.ts";
import { LaunchCodes } from "./launch.ts";
import { acquireServerLock, holdServerLock, releaseServerLock, serverLockOwner } from "./lock.ts";
import { Store } from "./store.ts";
import { ServerWatch, WATCH_INTERVAL_MS } from "./watch.ts";

// Bundled to dist/server.js, next to the page files in dist/web.
const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "web");

function listenOn(server: Server, port: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolvePort(typeof address === "object" && address ? address.port : port);
    });
  });
}

/** Reuses the last port when it is free, so the page keeps one origin and its saved theme. */
async function listen(server: Server): Promise<number> {
  let preferred = 0;
  try {
    preferred = Number.parseInt(readFileSync(paths.portFile(), "utf8"), 10) || 0;
  } catch {
    // First run: any free port.
  }
  try {
    return await listenOn(server, preferred);
  } catch (error) {
    if (preferred && (error as NodeJS.ErrnoException).code === "EADDRINUSE") return listenOn(server, 0);
    throw error;
  }
}

function registeredPid(): number | null {
  try {
    return (JSON.parse(readFileSync(paths.serverFile(), "utf8")) as ServerInfo).pid;
  } catch {
    return null;
  }
}

function removeServerFile(): void {
  // The lock's owner owns server.json: another server may be writing it between our read and remove.
  const owner = serverLockOwner(paths.lockFile());
  if (owner !== null && owner !== process.pid) return;
  if (registeredPid() === process.pid) rmSync(paths.serverFile(), { force: true });
}

async function main(): Promise<void> {
  mkdirSync(paths.stateDir(), { recursive: true, mode: 0o700 });
  // Whoever started this one finds the running server through server.json.
  if (!acquireServerLock(paths.lockFile())) return;
  process.on("exit", () => releaseServerLock(paths.lockFile()));
  const store = new Store({ dir: paths.stateDir() });
  const isTrusted = (folder: string): boolean => isTrustedFolder(folder);
  const host = new SessionHost({ store, agent: new ClaudeAgent({ instructions: sessionContext() }), isTrusted });
  const token = randomBytes(32).toString("base64url");
  const allowedHosts = new Set<string>();
  let serverInfo = "";
  // Atomically: a client reading during a plain write would find an empty file, and no server.
  const register = (): void => {
    const temp = `${paths.serverFile()}.tmp`;
    writeFileSync(temp, serverInfo, { mode: 0o600 });
    renameSync(temp, paths.serverFile());
  };
  const watch = new ServerWatch({
    holdsLock: () => holdServerLock(paths.lockFile()),
    isRegistered: () => registeredPid() === process.pid,
    register,
    working: () => host.working(),
  });
  const server = createServer(
    createApp({
      store,
      delivery: new Delivery(store),
      host,
      launchCodes: new LaunchCodes(),
      token,
      allowedHosts,
      webDir: WEB_DIR,
      onActivity: () => watch.active(),
      openFolder: (path) => openWithSystem(path, () => console.error(`couldn't open ${path}`)),
      processes: new SessionProcesses({ pidInUse, isSameProcess: isSameClaude }, store.revision),
      isTrusted,
      startSession: canStartSessions()
        ? (session) => startInTerminal(terminalCommand(process.platform, session)!)
        : null,
    }),
  );
  // Long-lived keep-alive sockets would otherwise hold shutdown open.
  server.keepAliveTimeout = 2000;

  const port = await listen(server);
  allowedHosts.add(`127.0.0.1:${port}`);
  allowedHosts.add(`localhost:${port}`);
  allowedHosts.add(`${PAGE_HOST}:${port}`);
  writeFileSync(paths.portFile(), String(port), { mode: 0o600 });
  serverInfo = JSON.stringify({ port, token, pid: process.pid } satisfies ServerInfo);
  register();
  console.error(`sidenote listening on http://127.0.0.1:${port}`);

  const shutDown = (): void => {
    host.closeAll();
    removeServerFile();
    server.close();
    server.closeAllConnections();
    process.exit(0);
  };
  process.on("SIGTERM", shutDown);
  process.on("SIGINT", shutDown);

  const interval = Number(process.env["SIDENOTE_WATCH_INTERVAL_MS"]) || WATCH_INTERVAL_MS;
  setInterval(() => {
    let reason: string | null;
    try {
      reason = watch.tick();
    } catch (error) {
      reason = `its files can't be reached: ${String(error)}`;
    }
    if (!reason) return;
    console.error(`sidenote stopping: ${reason}`);
    shutDown();
  }, interval);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
