// The HTTP API and the page's static files. Bound to 127.0.0.1 by main.ts.
//
// Defenses, in the order a request meets them:
// - Host must be this server's own 127.0.0.1/localhost address, which blocks DNS rebinding.
// - /api/* needs the token in a custom header. Browsers can't send that header cross-origin
//   without a CORS preflight, which this server never approves, so other sites can't call it.
// - Bodies are size-limited JSON objects, parsed by requests.ts before any handler runs.
// - Every response carries nosniff, no-referrer and same-origin headers; the page also gets a
//   content security policy that allows no inline or remote scripts.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { NewSession } from "../node/terminal.ts";
import { folderName } from "../shared/folders.ts";
import {
  MAX_PROMPT_CHARS,
  TOKEN_HEADER,
  type ClaimResult,
  type ClearedSessionResult,
  type ErrorResult,
  type LaunchCodeResult,
  type NewResponseResult,
  type PromptResult,
  type RedeemResult,
  type SendResult,
  type SessionListResult,
  type StartSessionResult,
  type StateSnapshot,
  type WaiterPollResult,
} from "../shared/types.ts";
import type { Delivery } from "./delivery.ts";
import type { SessionProcesses } from "./processes.ts";
import type { LaunchCodes } from "./launch.ts";
import {
  BadRequest,
  parseActivity,
  parseProgress,
  parseClaim,
  parseNewNote,
  parseNewResponse,
  parseRename,
  parsePrompt,
  parseRedeem,
  parseSend,
  parseSessionRequest,
  parseStartSession,
  parseTouchSession,
  parseWaiter,
} from "./requests.ts";
import type { Store } from "./store.ts";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const FOLDER_PATH = /^\/[^/]+$/;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const COMMON_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
};

export interface AppOptions {
  store: Store;
  delivery: Delivery;
  launchCodes: LaunchCodes;
  token: string;
  /** Called for each API request that passed the token check. */
  onActivity?: () => void;
  /** Host header values to accept. Filled in by main.ts once the port is known. */
  allowedHosts: ReadonlySet<string>;
  /** Directory holding index.html and the page's other files. */
  webDir: string;
  /** Opens a folder on the desktop, with whatever app the system opens folders with. */
  openFolder: (path: string) => void;
  /** Opens a terminal running a new Claude session; null where this machine has no terminal for it. */
  startSession: ((session: NewSession) => Promise<void>) | null;
  /** The Claude process behind each session, so the page can end it. */
  processes: SessionProcesses;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message = "") {
    super(message);
    this.status = status;
  }
}

type Json = object;

interface Reply {
  status: number;
  body?: Json;
}

interface Route {
  method: "GET" | "POST" | "DELETE";
  /** A path, or a pattern whose first group is passed on as the route parameter. */
  path: string | RegExp;
  /** false only for the launch code exchange, which is how a page gets the token. */
  needsToken: boolean;
  handle(context: { body: unknown; query: URLSearchParams; param: string }): Reply | Promise<Reply>;
}

const ok = (body: Json, status = 200): Reply => ({ status, body });
const empty = (status: number): Reply => ({ status });

function routes({ store, delivery, launchCodes, token, openFolder, startSession, processes }: AppOptions): Route[] {
  /** The session asked for, else the folder's most recently active one, with its folder's sessions. */
  const snapshot = (sessionId: string | null, folder: string | null): StateSnapshot => {
    const latest = folder === null ? undefined : store.folderSessions(folder)[0];
    const session = store.session(sessionId ?? "") ?? store.session(latest?.id ?? "");
    const version = store.revision.value;
    const can_start_sessions = startSession !== null;
    if (!session) {
      return {
        version,
        session: null,
        folder: folder ?? "",
        sessions: [],
        can_start_sessions,
        responses: [],
        comments: [],
        messages: [],
      };
    }
    const windowFolder = folderName(session.cwd);
    return {
      version,
      session: { ...session, ...delivery.status(session.id) },
      folder: windowFolder,
      sessions: store.folderSessions(windowFolder).map((row) => ({
        ...row,
        status: delivery.status(row.id).status,
        process: processes.state(row.id),
      })),
      can_start_sessions,
      ...store.sessionContent(session.id),
    };
  };

  /** The folder sidenote recorded for a session, if it still exists. Requests never name a path. */
  const recordedFolder = (sessionId: string): string => {
    const cwd = store.session(sessionId)?.cwd;
    if (!cwd) throw new HttpError(404, "sidenote doesn't know this session's folder");
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new HttpError(404, `${cwd} no longer exists`);
    return cwd;
  };

  return [
    {
      method: "GET",
      path: "/api/state",
      needsToken: true,
      handle: ({ query }) => {
        delivery.refresh();
        processes.refresh();
        // The page passes the version it has; an unchanged store costs one empty reply.
        if (query.get("v") === String(store.revision.value)) return empty(204);
        return ok(snapshot(query.get("s"), query.get("f")));
      },
    },
    {
      method: "GET",
      path: "/api/sessions",
      needsToken: true,
      handle: () => ok({ sessions: store.listSessions() } satisfies SessionListResult),
    },
    { method: "GET", path: "/api/health", needsToken: true, handle: () => ok({ ok: true }) },
    {
      method: "POST",
      path: "/api/sessions",
      needsToken: true,
      handle: ({ body }) => {
        const input = parseTouchSession(body);
        store.touchSession(input.session_id, input.session_name, input.cwd);
        return ok({ ok: true });
      },
    },
    {
      method: "POST",
      path: "/api/responses",
      needsToken: true,
      handle: ({ body }) => {
        const input = parseNewResponse(body);
        processes.record(input.session_id, input.claude_process);
        const { response, newSession } = store.addResponse({
          sessionId: input.session_id,
          sessionName: input.session_name,
          cwd: input.cwd,
          text: input.text,
          createdAt: input.created_at,
        });
        return ok({ response, new_session: newSession } satisfies NewResponseResult, 201);
      },
    },
    {
      method: "POST",
      path: "/api/comments",
      needsToken: true,
      handle: ({ body }) => {
        const note = store.addNote(parseNewNote(body));
        if (!note) throw new HttpError(404, "unknown reply or thread");
        return ok(note, 201);
      },
    },
    {
      method: "DELETE",
      path: /^\/api\/comments\/(\d{1,15})$/,
      needsToken: true,
      handle: ({ param }) => empty(store.deletePendingNote(Number(param)) ? 204 : 404),
    },
    {
      method: "POST",
      path: "/api/claim",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id, prompt: typed, claude_process } = parseClaim(body);
        processes.record(session_id, claude_process);
        delivery.markBusy(session_id);
        // A message still waiting from the page rides along with this terminal prompt.
        const prompt = store.claimMessages(session_id);
        if (typed?.trim()) store.addMessage(session_id, typed.trim(), "terminal");
        const result: ClaimResult = { comments: store.claimPending(session_id) };
        if (prompt !== undefined) result.prompt = prompt;
        return ok(result);
      },
    },
    {
      method: "POST",
      path: "/api/activity",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id, text } = parseActivity(body);
        delivery.setActivity(session_id, text);
        return ok({ ok: true });
      },
    },
    {
      method: "POST",
      path: "/api/progress",
      needsToken: true,
      handle: ({ body }) => {
        delivery.addProgress(parseProgress(body));
        return ok({ ok: true });
      },
    },
    {
      method: "POST",
      path: "/api/waiters",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id, waiter_id, claude_process } = parseWaiter(body);
        processes.record(session_id, claude_process);
        delivery.registerWaiter(session_id, waiter_id);
        return ok({ ok: true });
      },
    },
    {
      method: "POST",
      path: "/api/waiters/poll",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id, waiter_id } = parseWaiter(body);
        return ok(delivery.pollWaiter(session_id, waiter_id) satisfies WaiterPollResult);
      },
    },
    {
      method: "POST",
      path: "/api/send",
      needsToken: true,
      handle: ({ body }) => ok({ sessions: delivery.requestSend(parseSend(body).session_ids) } satisfies SendResult),
    },
    {
      method: "POST",
      path: "/api/prompt",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id, text } = parsePrompt(body);
        if (!store.session(session_id)) throw new HttpError(404, "sidenote doesn't know this session");
        const outcome = delivery.requestPrompt(session_id, text);
        if (outcome === "offline") {
          throw new HttpError(
            409,
            "this session isn't listening: it may be closed, or hasn't finished a reply since sidenote started",
          );
        }
        if (outcome === "too-long") {
          throw new HttpError(413, `messages to a terminal session are limited to ${MAX_PROMPT_CHARS} characters`);
        }
        return ok({ delivery: outcome } satisfies PromptResult, 202);
      },
    },
    {
      method: "POST",
      path: "/api/open-folder",
      needsToken: true,
      handle: ({ body }) => {
        openFolder(recordedFolder(parseSessionRequest(body).session_id));
        return empty(204);
      },
    },
    {
      method: "POST",
      path: "/api/sessions/rename",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id, label } = parseRename(body);
        if (!store.renameSession(session_id, label)) throw new HttpError(404, "sidenote doesn't know this session");
        return empty(204);
      },
    },
    {
      method: "POST",
      path: "/api/sessions/end",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id } = parseSessionRequest(body);
        if (processes.state(session_id) === "unknown") {
          throw new HttpError(409, "sidenote learns this session's process with its next prompt or reply");
        }
        // Only the process the session's own hooks reported, and only while it is still that one.
        const running = processes.running(session_id);
        if (running) process.kill(running.pid, "SIGTERM");
        processes.forget(session_id);
        store.forgetSession(session_id);
        return empty(204);
      },
    },
    {
      method: "POST",
      path: "/api/sessions/forget",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id } = parseSessionRequest(body);
        if (processes.running(session_id)) throw new HttpError(409, "this session is still running: end it instead");
        processes.forget(session_id);
        if (!store.forgetSession(session_id)) throw new HttpError(404, "sidenote doesn't know this session");
        return empty(204);
      },
    },
    {
      method: "POST",
      path: "/api/sessions/cleared",
      needsToken: true,
      handle: ({ body }) => {
        const { session_id } = parseSessionRequest(body);
        // Claude moved on to a new session either way, so a kept session must not wake it.
        delivery.forgetSession(session_id);
        processes.forget(session_id);
        // Words the user wrote and Claude never saw aren't cleared away unasked.
        const forgotten = !store.hasUnsent(session_id) && store.forgetSession(session_id);
        return ok({ forgotten } satisfies ClearedSessionResult);
      },
    },
    {
      method: "POST",
      path: "/api/sessions/start",
      needsToken: true,
      handle: async ({ body }) => {
        const { session_id, prompt, name } = parseStartSession(body);
        const cwd = recordedFolder(session_id);
        if (!startSession) throw new HttpError(501, "starting sessions needs GNOME Terminal on Linux, or macOS");
        const id = randomUUID();
        try {
          await startSession({ cwd, sessionId: id, prompt, name });
        } catch (error) {
          throw new HttpError(502, `couldn't open a terminal: ${error instanceof Error ? error.message : error}`);
        }
        // Listed right away, so the page can select it before Claude's first reply.
        store.touchSession(id, "", cwd);
        if (name) store.renameSession(id, name);
        return ok({ session_id: id } satisfies StartSessionResult, 201);
      },
    },
    {
      method: "POST",
      path: "/api/launch",
      needsToken: true,
      handle: () => ok({ code: launchCodes.issue() } satisfies LaunchCodeResult),
    },
    {
      method: "POST",
      path: "/api/launch/redeem",
      needsToken: false,
      handle: ({ body }) => {
        if (!launchCodes.redeem(parseRedeem(body).code))
          throw new HttpError(403, "this link was already used or has expired");
        return ok({ token } satisfies RedeemResult);
      },
    },
  ];
}

export function createApp(options: AppOptions): RequestListener {
  const webDir = resolve(options.webDir);
  const tokenBytes = Buffer.from(options.token);
  const table = routes(options);

  const tokenValid = (request: IncomingMessage): boolean => {
    const given = Buffer.from(String(request.headers[TOKEN_HEADER.toLowerCase()] ?? ""));
    return given.length === tokenBytes.length && timingSafeEqual(given, tokenBytes);
  };

  const serveApi = async (request: IncomingMessage, url: URL): Promise<Reply> => {
    let param = "";
    const route = table.find((candidate) => {
      if (candidate.method !== request.method) return false;
      if (typeof candidate.path === "string") return candidate.path === url.pathname;
      const match = candidate.path.exec(url.pathname);
      param = match?.[1] ?? "";
      return match !== null;
    });
    if (!route) throw new HttpError(404);
    if (route.needsToken && !tokenValid(request)) throw new HttpError(403);
    // Only a real client counts: a stale tab, refused above, mustn't keep the server running.
    if (route.needsToken) options.onActivity?.();
    const body = request.method === "POST" ? await readJson(request) : undefined;
    return route.handle({ body, query: url.searchParams, param });
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!options.allowedHosts.has(request.headers.host ?? "")) throw new HttpError(403);
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) return send(response, await serveApi(request, url));
    if (request.method !== "GET") throw new HttpError(405);
    // "/<folder>" is a folder's window; the page reads the folder from its own path. The path as
    // sent is checked, so "/static/../x", which URL parsing turns into "/x", isn't taken for one.
    if (url.pathname === "/" || FOLDER_PATH.test((request.url ?? "").split("?")[0]!)) {
      return sendFile(response, resolve(webDir, "index.html"));
    }
    if (url.pathname.startsWith("/static/")) return sendFile(response, staticPath(webDir, url.pathname));
    throw new HttpError(404);
  };

  return (request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) return response.destroy();
      if (error instanceof HttpError) return send(response, errorReply(error.status, error.message));
      if (error instanceof BadRequest) return send(response, errorReply(400, error.message));
      console.error(error);
      send(response, errorReply(500, "internal error"));
    });
  };
}

function errorReply(status: number, message: string): Reply {
  return message ? { status, body: { error: message } satisfies ErrorResult } : { status };
}

/** The file a /static/ path names, refusing anything outside the page directory. */
function staticPath(webDir: string, pathname: string): string {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice("/static/".length));
  } catch {
    throw new HttpError(404); // malformed percent-encoding
  }
  const file = resolve(webDir, relative);
  if (relative.includes("\0") || !file.startsWith(webDir + sep)) throw new HttpError(404);
  return file;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) throw new HttpError(413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? (JSON.parse(text) as unknown) : {};
  } catch {
    throw new BadRequest("invalid JSON");
  }
}

async function sendFile(response: ServerResponse, file: string): Promise<void> {
  const content = await readFile(file).catch(() => {
    throw new HttpError(404);
  });
  response.writeHead(200, {
    ...COMMON_HEADERS,
    ...(extname(file) === ".html" ? PAGE_HEADERS : {}),
    "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    "Content-Length": content.length,
  });
  response.end(content);
}

function send(response: ServerResponse, reply: Reply): void {
  const content = reply.body === undefined ? undefined : Buffer.from(JSON.stringify(reply.body));
  response.writeHead(reply.status, {
    ...COMMON_HEADERS,
    ...(content ? { "Content-Type": "application/json" } : {}),
    "Content-Length": content?.length ?? 0,
  });
  response.end(content);
}
