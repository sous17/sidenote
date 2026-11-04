// The session list on the left: one row per session that ran in this window's folder. In a wide
// window it is docked beside the feed; otherwise, and while a thread is open, it folds away and the
// button in the top bar opens it over the feed.
import type { FolderSession, SessionState } from "../shared/types.ts";
import { el, formatTime } from "./dom.ts";
import { sessionLabel } from "./model.ts";

/** Docked, the panel's 260px still leave the feed the 1000px that notes in the margin need. */
const DOCK_MIN_WIDTH = 1280;
const DOCKED_STORAGE_KEY = "sidenote-panel";
const SELECTED_STORAGE_KEY = "sidenote-tab";

const STATUS_TEXT: Readonly<Record<SessionState, string>> = {
  listening: "Listening",
  busy: "Claude is working",
  offline: "Not listening",
};

// The selected session survives a reload of this browser tab, per folder. Storage can be blocked;
// the window then opens on the folder's latest session.

export function rememberedSession(folder: string): string | null {
  try {
    return folder ? sessionStorage.getItem(`${SELECTED_STORAGE_KEY}:${folder}`) : null;
  } catch {
    return null;
  }
}

export function rememberSession(folder: string, sessionId: string): void {
  try {
    if (folder) sessionStorage.setItem(`${SELECTED_STORAGE_KEY}:${folder}`, sessionId);
  } catch {
    // Not remembered; a reload shows the folder's latest session.
  }
}

export class SessionPanel {
  readonly #panel: HTMLElement;
  readonly #list: HTMLElement;
  readonly #toggle: HTMLButtonElement;
  readonly #app: HTMLElement;
  readonly #onSelect: (sessionId: string) => void;
  /** Whether the user wants the panel docked when the window has room; folding it is remembered. */
  #wantsDocked = readWantsDocked();
  /** Opened over the feed from the top bar, where it can't dock. */
  #overlay = false;

  constructor(options: {
    panel: HTMLElement;
    list: HTMLElement;
    toggle: HTMLButtonElement;
    app: HTMLElement;
    onSelect: (sessionId: string) => void;
  }) {
    this.#panel = options.panel;
    this.#list = options.list;
    this.#toggle = options.toggle;
    this.#app = options.app;
    this.#onSelect = options.onSelect;

    this.#toggle.addEventListener("click", () => {
      if (this.#canDock()) {
        this.#wantsDocked = !this.#wantsDocked;
        writeWantsDocked(this.#wantsDocked);
      } else {
        this.#overlay = !this.#overlay;
      }
      this.#apply();
    });
    document.addEventListener("click", (event) => {
      const target = event.target as Node;
      if (this.#overlay && !this.#panel.contains(target) && !this.#toggle.contains(target)) this.#close();
    });
    // Ahead of the page's own Escape, which closes the thread: one key, one thing closed.
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape" || !this.#overlay) return;
        event.stopPropagation();
        this.#close();
      },
      { capture: true },
    );
    window.addEventListener("resize", () => this.#apply());
    // The thread pane takes the room the panel would dock in.
    new MutationObserver(() => this.#apply()).observe(this.#app, { attributeFilter: ["class"] });
    this.#apply();
  }

  render(sessions: readonly FolderSession[], selectedId: string): void {
    this.#toggle.dataset["count"] = String(sessions.length);
    this.#list.replaceChildren(...sessions.map((session) => this.#row(session, session.id === selectedId)));
  }

  #row(session: FolderSession, selected: boolean): HTMLButtonElement {
    const row = el("button", "session-row");
    row.type = "button";
    row.dataset["status"] = session.status;
    if (selected) row.setAttribute("aria-current", "true");
    row.title = `Session ${session.id}`;
    const text = el("span", "session-row-text");
    text.append(
      el("span", "session-row-label", sessionLabel(session)),
      el("span", "session-row-meta", `${STATUS_TEXT[session.status]} · ${lastActive(session.last_active)}`),
    );
    row.append(el("span", "status-dot"), text);
    if (session.pending_notes) row.append(el("span", "note-count", String(session.pending_notes)));
    row.addEventListener("click", () => {
      this.#close();
      this.#onSelect(session.id);
    });
    return row;
  }

  #canDock(): boolean {
    return window.innerWidth >= DOCK_MIN_WIDTH && !this.#app.classList.contains("split");
  }

  #close(): void {
    if (!this.#overlay) return;
    this.#overlay = false;
    this.#apply();
  }

  #apply(): void {
    const docked = this.#wantsDocked && this.#canDock();
    if (docked) this.#overlay = false;
    const state = docked ? "docked" : this.#overlay ? "overlay" : "closed";
    if (document.body.dataset["panel"] !== state) document.body.dataset["panel"] = state;
    this.#toggle.setAttribute("aria-expanded", String(state !== "closed"));
  }
}

/** The time for today's activity, the date for older, which a time alone would pass off as today's. */
function lastActive(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  if (date.toDateString() === new Date().toDateString()) return formatTime(epochSeconds);
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function readWantsDocked(): boolean {
  try {
    return localStorage.getItem(DOCKED_STORAGE_KEY) !== "folded";
  } catch {
    return true;
  }
}

function writeWantsDocked(docked: boolean): void {
  try {
    if (docked) localStorage.removeItem(DOCKED_STORAGE_KEY);
    else localStorage.setItem(DOCKED_STORAGE_KEY, "folded");
  } catch {
    // Not remembered; the next visit docks the panel again.
  }
}
