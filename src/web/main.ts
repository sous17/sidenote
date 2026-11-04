// The sidenote page: a folder's Claude Code sessions in a list, the selected one's replies with
// notes in the margin.
import { folderFromPath, folderPath } from "../shared/folders.ts";
import { Api, ApiError, obtainToken, onTokenStored } from "./api.ts";
import { byId } from "./dom.ts";
import { NoteEditor } from "./editor.ts";
import { Feed } from "./feed.ts";
import { Model, sessionLabel } from "./model.ts";
import { SessionPanel, rememberSession, rememberedSession } from "./panel.ts";
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

/** Top left: the window's folder, the selected session, and a button to open the folder. */
function renderWindowTitle(model: Model, panel: SessionPanel): void {
  const { session, folder, sessions } = model.snapshot;
  byId("window-title").hidden = false;
  byId("folder-name").textContent = folder;
  byId("folder-name").title = session?.cwd ?? "";
  const selected = sessions.find((row) => row.id === model.sessionId);
  byId("session-name").textContent = selected ? sessionLabel(selected) : "";
  byId("open-folder").hidden = !session?.cwd;
  byId("open-folder").title = session?.cwd ? `Open ${session.cwd}` : "";
  panel.render(sessions, model.sessionId);
  document.title = folder ? `${folder} · sidenote` : "sidenote";
}

/** Keeps the address on the folder, so it can be bookmarked. A session with no known folder keeps ?s=. */
function syncAddress(model: Model): void {
  const { folder } = model.snapshot;
  const address = folder ? folderPath(folder) : `/?s=${encodeURIComponent(model.sessionId)}`;
  if (`${location.pathname}${location.search}` !== address) history.replaceState(null, "", address + location.hash);
}

async function start(): Promise<void> {
  // Links from the CLI name the session; a typed or bookmarked address names only the folder.
  let folder = folderFromPath(location.pathname);
  const sessionId = new URLSearchParams(location.search).get("s") ?? rememberedSession(folder) ?? "";
  if (!folder && !sessionId) {
    showUnavailable(
      "Open this window from a Claude Code session",
      "Each folder has its own sidenote window. Run /sidenote:open in a session to open its folder's window.",
    );
    return;
  }
  const token = await obtainToken().catch(() => null);
  if (!token) {
    showUnavailable(
      "Not connected yet",
      "Run /sidenote:open in a Claude Code session once. After that, sidenote addresses work in any tab of this browser.",
    );
    setConnection("error", "Run /sidenote:open");
    onTokenStored(() => location.reload());
    return;
  }

  const api = new Api(token);
  const model = new Model(sessionId);
  // A note in the URL (#n12) opens its thread on load. Read it before anything rewrites the URL.
  const threadFromUrl = Number(/^#n(\d+)$/.exec(location.hash)?.[1]) || null;

  const refresh = async (): Promise<void> => {
    const asked = model.sessionId;
    try {
      const next = await api.state(model.snapshot.version, asked, folder);
      // Another tab was selected while this was on its way; its own refresh brings its state.
      if (model.sessionId !== asked) return;
      if (next) {
        model.snapshot = next;
        // The server picks the folder's latest session when the page names none, or one it forgot.
        if (next.session) model.sessionId = next.session.id;
        folder = next.folder || folder;
        render();
      }
      setConnection("live", "Live");
    } catch (error) {
      // A restarted server has a new token; a window opened since then stored it for every tab.
      if (error instanceof ApiError && error.status === 403 && api.adoptStoredToken()) return;
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

  const panel = new SessionPanel({
    panel: byId("session-panel"),
    list: byId("session-list"),
    toggle: byId<HTMLButtonElement>("panel-toggle"),
    app: byId("app"),
    onSelect: (selected) => {
      // Don't throw away a half-written note or thread reply: each takes the focus instead.
      if (selected === model.sessionId || !editor.release() || !thread.release()) return;
      model.select(selected);
      feed.reset();
      panel.render(model.snapshot.sessions, selected);
      void refresh();
    },
  });

  let rendered = false;
  let shownSessionId = "";
  function render(): void {
    if (!model.snapshot.session) {
      if (folder) {
        showUnavailable(
          `Nothing from ${folder} yet`,
          `This window shows the Claude Code sessions in a folder named ${folder}. Run /sidenote:open in one of them.`,
        );
      }
    } else {
      syncAddress(model);
      if (model.sessionId !== shownSessionId) {
        shownSessionId = model.sessionId;
        rememberSession(folder, model.sessionId);
        promptBox.load();
      }
    }
    renderWindowTitle(model, panel);
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
  byId("open-folder").addEventListener("click", () => {
    api.openFolder(model.sessionId).catch(showError);
  });
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
