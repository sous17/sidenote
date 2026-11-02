// The sidenote server: started in the background by the CLI, one per machine.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../shared/paths.ts";
import type { ServerInfo } from "../shared/types.ts";
import { createApp } from "./http.ts";
import { Store } from "./store.ts";

// Bundled to dist/server.js, next to the page files in dist/web.
const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "web");

/** Reuses the last port when it is free, so the page keeps one origin and its saved theme. */
function listen(server: Server): Promise<number> {
  let preferred = 0;
  try {
    preferred = Number.parseInt(readFileSync(paths.portFile(), "utf8"), 10) || 0;
  } catch {
    // First run: any free port.
  }
  const tryPort = (port: number) =>
    new Promise<number>((resolvePort, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        const address = server.address();
        resolvePort(typeof address === "object" && address ? address.port : port);
      });
    });
  return tryPort(preferred).catch((error: NodeJS.ErrnoException) => {
    if (preferred && error.code === "EADDRINUSE") return tryPort(0);
    throw error;
  });
}

async function main(): Promise<void> {
  mkdirSync(paths.stateDir(), { recursive: true, mode: 0o700 });
  const store = new Store({ file: paths.storeFile() });
  const token = randomBytes(24).toString("base64url");
  const allowedHosts = new Set<string>();
  const server = createServer(createApp({ store, token, allowedHosts, webDir: WEB_DIR }));
  // Long-lived keep-alive sockets would otherwise hold shutdown open.
  server.keepAliveTimeout = 2000;

  const port = await listen(server);
  allowedHosts.add(`127.0.0.1:${port}`);
  allowedHosts.add(`localhost:${port}`);
  writeFileSync(paths.portFile(), String(port));
  const info: ServerInfo = { port, token, pid: process.pid };
  writeFileSync(paths.serverFile(), JSON.stringify(info), { mode: 0o600 });
  chmodSync(paths.serverFile(), 0o600);
  console.error(`sidenote listening on http://127.0.0.1:${port}`);

  const shutDown = () => {
    try {
      const current = JSON.parse(readFileSync(paths.serverFile(), "utf8")) as ServerInfo;
      if (current.pid === process.pid) rmSync(paths.serverFile());
    } catch {
      // Already gone.
    }
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
