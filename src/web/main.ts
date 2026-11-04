// The sidenote page: one Claude Code session's replies, with notes in the margin.
import { Api, ApiError, obtainToken } from "./api.ts";
import { projectName } from "../shared/text.ts";
import { byId } from "./dom.ts";
import { NoteEditor } from "./editor.ts";
import { Feed } from "./feed.ts";
import { Model } from "../shared/model.ts";
import { PromptBox } from "./prompt.ts";
import { installNoteStarters } from "./selection.ts";
import { Sending } from "./sending.ts";
import { ThreadPane } from "./thread.ts";

const POLL_INTERVAL_MS = 1500;

const connection = byId("connection");

function setConnection(state: "live" | "error", label: string): void {
  connection.dataset["state"] = state;
  connection.textContent = label;
}

function showError(error: unknown): void {
  setConnection("error", error instanceof Error ? error.message : String(error));
}

/** Replaces the empty state's text when the page can't show a session. */
function showUnavailable(title: string, text: string): void {
  byId("empty-title").textContent = title;
  byId("empty-intro").textContent = text;
  byId("empty-help").hidden = true;
}

/** Top left: the session's /rename name, or its folder; then folder and short id. */
function renderSessionTitle(model: Model): void {
  const { session } = model.snapshot;
  const folder = session ? projectName(session.cwd) : "";
  const shortId = model.sessionId.slice(0, 8);
  const name = session?.name || folder || `Session ${shortId}`;
  byId("session-title").hidden = false;
  byId("session-name").textContent = name;
  byId("session-detail").textContent = session?.name && folder ? `${folder} · ${shortId}` : shortId;
  byId("session-title").title = `Session ${model.sessionId}${session?.cwd ? `\n${session.cwd}` : ""}`;
  document.title = `${name} · sidenote`;
}

async function start(): Promise<void> {
  const sessionId = new URLSearchParams(location.search).get("s");
  if (!sessionId) {
    showUnavailable(
      "Open this window from a Claude Code session",
      "Each session has its own sidenote window. Run /sidenote:open in the session you want to see.",
    );
    return;
  }
  const token = await obtainToken().catch(() => null);
  if (!token) {
    showUnavailable(
      "This link has expired",
      "Links to a sidenote window work once. Run /sidenote:open in the session to open it again.",
    );
    setConnection("error", "Run /sidenote:open");
    return;
  }

  const api = new Api(token);
  const model = new Model(sessionId);
  // A note in the URL (#n12) opens its thread on load. Read it before anything rewrites the URL.
  const threadFromUrl = Number(/^#n(\d+)$/.exec(location.hash)?.[1]) || null;

  const refresh = async (): Promise<void> => {
    try {
      const next = await api.state(model.snapshot.version, sessionId);
      if (next) {
        model.snapshot = next;
        render();
      }
      setConnection("live", "Live");
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) setConnection("error", "Stale tab: run /sidenote:open");
      else if (error instanceof ApiError) setConnection("error", `Server error ${error.status}`);
      else setConnection("error", "Disconnected: is sidenote on?");
    }
  };

  const deleteNote = (noteId: number): void => {
    api.deleteNote(noteId).then(refresh).catch(showError);
  };

  const sending = new Sending({
    model,
    api,
    refresh,
    summary: byId<HTMLButtonElement>("pending-summary"),
    sendNow: byId<HTMLButtonElement>("send-now"),
    onError: showError,
  });
  const feed: Feed = new Feed({
    model,
    handlers: {
      openThread: (noteId) => thread.open(noteId),
      startNote: (card, blockIndex, quote) => editor.start(card, blockIndex, quote),
      deleteNote,
    },
    app: byId("app"),
    feed: byId("feed"),
    inner: byId("feed-inner"),
    emptyState: byId("feed-inner").querySelector<HTMLElement>(".empty")!,
    newReply: byId<HTMLButtonElement>("new-reply"),
  });
  const editor = new NoteEditor({ feed, sending, onError: showError });
  const promptBox = new PromptBox({
    model,
    api,
    refresh,
    onSent: () => feed.scrollToLatest(),
    onError: showError,
    form: byId<HTMLFormElement>("prompt-form"),
    field: byId<HTMLTextAreaElement>("prompt-text"),
    send: byId<HTMLButtonElement>("prompt-send"),
    hint: byId("prompt-hint"),
  });
  const thread: ThreadPane = new ThreadPane({
    model,
    feed,
    sending,
    deleteNote,
    onError: showError,
    app: byId("app"),
    meta: byId("pane-meta"),
    quote: byId("pane-quote"),
    timeline: byId("pane-timeline"),
    composer: byId<HTMLFormElement>("composer"),
    composerText: byId<HTMLTextAreaElement>("composer-text"),
    close: byId<HTMLButtonElement>("pane-close"),
  });

  let rendered = false;
  function render(): void {
    renderSessionTitle(model);
    feed.render();
    sending.render();
    promptBox.render();
    if (thread.isOpen) thread.render();
    if (!rendered && threadFromUrl) thread.open(threadFromUrl);
    rendered = true;
  }

  installNoteStarters({
    feed: byId("feed-inner"),
    selectionButton: byId<HTMLButtonElement>("selection-comment"),
    startNote: (block, quote) => {
      const card = feed.cardOf(block);
      if (card) editor.start(card, Number(block.dataset["blockIndex"]), quote);
    },
  });
  byId("pending-summary").addEventListener("click", () => feed.showFirstPending());
  document.addEventListener("keydown", (event) => {
    if ((event.target as Element | null)?.closest?.("textarea, input, select")) return;
    if (event.key === "Escape" && thread.isOpen) thread.close();
  });

  const poll = async (): Promise<void> => {
    await refresh();
    setTimeout(() => void poll(), POLL_INTERVAL_MS);
  };
  await poll();
}

start().catch(showError);
