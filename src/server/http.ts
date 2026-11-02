import { timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import {
  TOKEN_HEADER,
  type ClaimRequest,
  type ClaimResult,
  type NewResponseRequest,
  type NewResponseResult,
  type SessionListResult,
  type TouchSessionRequest,
  type SendRequest,
  type SendResult,
  type WaiterPollResult,
  type WaiterRequest,
} from "../shared/types.ts";
import type { Store } from "./store.ts";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

// No inline scripts and no remote loads: even if a reply smuggles HTML past the sanitizer,
// it cannot run code that reads the token and posts fake notes.
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export interface AppOptions {
  store: Store;
  token: string;
  /** Host header values to accept; rejecting others blocks DNS-rebinding pages. */
  allowedHosts: ReadonlySet<string>;
  /** Directory holding index.html, app.js, app.css and the other page files. */
  webDir: string;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message = "") {
    super(message);
    this.status = status;
  }
}

export function createApp(options: AppOptions): RequestListener {
  const { store, token, allowedHosts } = options;
  const webDir = resolve(options.webDir);
  const tokenBytes = Buffer.from(token);

  function tokenValid(request: IncomingMessage): boolean {
    const given = Buffer.from(String(request.headers[TOKEN_HEADER.toLowerCase()] ?? ""));
    return given.length === tokenBytes.length && timingSafeEqual(given, tokenBytes);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!allowedHosts.has(request.headers.host ?? "")) throw new HttpError(403);
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";

    if (method === "GET" && url.pathname === "/") return sendFile(response, resolve(webDir, "index.html"));
    if (method === "GET" && url.pathname.startsWith("/static/")) {
      const file = resolve(webDir, decodeURIComponent(url.pathname.slice("/static/".length)));
      if (!file.startsWith(webDir + sep)) throw new HttpError(404);
      return sendFile(response, file);
    }
    if (!url.pathname.startsWith("/api/")) throw new HttpError(404);
    if (!tokenValid(request)) throw new HttpError(403);

    if (method === "GET") {
      switch (url.pathname) {
        case "/api/state": {
          store.refreshStatus();
          if (url.searchParams.get("v") === String(store.version)) return sendEmpty(response, 204);
          return sendJson(response, 200, store.snapshot(url.searchParams.get("s")));
        }
        case "/api/sessions": {
          const result: SessionListResult = { sessions: store.listSessions() };
          return sendJson(response, 200, result);
        }
        case "/api/health":
          return sendJson(response, 200, { ok: true });
      }
    }

    if (method === "POST") {
      const body = await readJson(request);
      switch (url.pathname) {
        case "/api/responses": {
          const input = body as Partial<NewResponseRequest>;
          const sessionId = str(input.session_id);
          if (!sessionId) throw new HttpError(400, "session_id is required");
          const { response: created, newSession } = store.addResponse({
            sessionId,
            cwd: str(input.cwd),
            text: str(input.text),
            createdAt: Number(input.created_at) || undefined,
            sessionName: str(input.session_name).trim().slice(0, 200),
          });
          const result: NewResponseResult = { response: created, new_session: newSession };
          return sendJson(response, 201, result);
        }
        case "/api/sessions": {
          const input = body as Partial<TouchSessionRequest>;
          const sessionId = str(input.session_id);
          if (!sessionId) throw new HttpError(400, "session_id is required");
          store.touchSession(sessionId, str(input.session_name).trim().slice(0, 200), str(input.cwd));
          return sendJson(response, 200, { ok: true });
        }
        case "/api/comments": {
          const input = body as Record<string, unknown>;
          const text = str(input["body"]).trim();
          if (!text) throw new HttpError(400, "empty note");
          const parentId = input["parent_id"];
          const target =
            parentId !== undefined && parentId !== null
              ? { parentId: Number(parentId) }
              : {
                  responseId: Number(input["response_id"] ?? 0),
                  blockIndex: Number(input["block_index"] ?? -1),
                  quote: str(input["quote"]),
                };
          const comment = store.addComment(target, text);
          if (!comment) throw new HttpError(404, "unknown reply or thread");
          return sendJson(response, 201, comment);
        }
        case "/api/claim": {
          const sessionId = str((body as Partial<ClaimRequest>).session_id);
          store.markBusy(sessionId);
          const result: ClaimResult = { comments: store.claimPending(sessionId) };
          return sendJson(response, 200, result);
        }
        case "/api/waiters": {
          const input = body as Partial<WaiterRequest>;
          store.registerWaiter(str(input.session_id), str(input.waiter_id));
          return sendJson(response, 200, { ok: true });
        }
        case "/api/waiters/poll": {
          const input = body as Partial<WaiterRequest>;
          const result: WaiterPollResult = store.pollWaiter(str(input.session_id), str(input.waiter_id));
          return sendJson(response, 200, result);
        }
        case "/api/send": {
          const ids = (body as SendRequest).session_ids;
          const result: SendResult = {
            sessions: store.requestSend(Array.isArray(ids) ? ids.map(String) : undefined),
          };
          return sendJson(response, 200, result);
        }
      }
    }

    if (method === "DELETE" && url.pathname.startsWith("/api/comments/")) {
      const id = url.pathname.slice("/api/comments/".length);
      const deleted = /^\d+$/.test(id) && store.deletePendingComment(Number(id));
      return sendEmpty(response, deleted ? 204 : 404);
    }
    throw new HttpError(404);
  }

  return (request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) return response.destroy();
      if (error instanceof HttpError) {
        return error.message ? sendJson(response, error.status, { error: error.message }) : sendEmpty(response, error.status);
      }
      console.error(error);
      sendEmpty(response, 500);
    });
  };
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    return parsed;
  } catch {
    throw new HttpError(400, "invalid json");
  }
}

async function sendFile(response: ServerResponse, file: string): Promise<void> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new HttpError(404);
  const content = await readFile(file);
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    "Content-Length": content.length,
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "Cache-Control": "no-store",
  });
  response.end(content);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const content = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": content.length });
  response.end(content);
}

function sendEmpty(response: ServerResponse, status: number): void {
  response.writeHead(status, { "Content-Length": 0 });
  response.end();
}
