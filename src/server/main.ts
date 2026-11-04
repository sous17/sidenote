// The sidenote server: one per machine, started in the background by the CLI.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openWithSystem } from "../node/open.ts";
import { paths } from "../node/paths.ts";
import { isSameProcess, pidInUse } from "../node/process.ts";
import { canStartSessions, startInTerminal, terminalCommand } from "../node/terminal.ts";
import { PAGE_HOST, type ServerInfo } from "../shared/types.ts";
import { Delivery } from "./delivery.ts";
import { createApp } from "./http.ts";
import { SessionProcesses } from "./processes.ts";
import { LaunchCodes } from "./launch.ts";
import { acquireServerLock, releaseServerLock } from "./lock.ts";
import { Store } from "./store.ts";

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

function removeServerFile(): void {
  try {
    const current = JSON.parse(readFileSync(paths.serverFile(), "utf8")) as ServerInfo;
    if (current.pid === process.pid) rmSync(paths.serverFile());
  } catch {
    // Already gone, or another server's.
  }
}

async function main(): Promise<void> {
  mkdirSync(paths.stateDir(), { recursive: true, mode: 0o700 });
  // Whoever started this one finds the running server through server.json.
  if (!acquireServerLock(paths.lockFile(), paths.serverFile())) return;
  process.on("exit", () => releaseServerLock(paths.lockFile()));
  const store = new Store({ dir: paths.stateDir() });
  const token = randomBytes(32).toString("base64url");
  const allowedHosts = new Set<string>();
  const server = createServer(
    createApp({
      store,
      delivery: new Delivery(store),
      launchCodes: new LaunchCodes(),
      token,
      allowedHosts,
      webDir: WEB_DIR,
      openFolder: (path) => openWithSystem(path, () => console.error(`couldn't open ${path}`)),
      processes: new SessionProcesses({ pidInUse, isSameProcess }, store.revision),
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
  writeFileSync(paths.serverFile(), JSON.stringify({ port, token, pid: process.pid } satisfies ServerInfo), {
    mode: 0o600,
  });
  console.error(`sidenote listening on http://127.0.0.1:${port}`);

  const shutDown = (): void => {
    removeServerFile();
    server.close();
    server.closeAllConnections();
    process.exit(0);
  };
  process.on("SIGTERM", shutDown);
  process.on("SIGINT", shutDown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
