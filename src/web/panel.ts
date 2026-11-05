// The session list on the left: one row per session that ran in this window's folder. In a wide
// window it is docked beside the feed; otherwise, and while a thread is open, it folds away and the
// button in the top bar opens it over the feed.
import type { FolderSession, SessionState } from "../shared/types.ts";
import { sessionLabel } from "../shared/model.ts";
import { formatTime } from "../shared/text.ts";
import { confirmAction } from "./confirm.ts";
import { el } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";

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

/** What the page does when a row asks for it. Each returns once the server has done it. */
export interface SessionActions {
  select(sessionId: string): void;
  rename(sessionId: string, label: string): Promise<void>;
  end(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
}

/** A row that shows its menu, its name field, or asks to confirm, instead of just the session. */
interface OpenRow {
  sessionId: string;
  mode: "menu" | "rename";
  error: string;
  busy: boolean;
}

export class SessionPanel {
  readonly #panel: HTMLElement;
  readonly #list: HTMLElement;
  readonly #toggle: HTMLButtonElement;
  readonly #app: HTMLElement;
  readonly #actions: SessionActions;
  /** Whether the user wants the panel docked when the window has room; folding it is remembered. */
  #wantsDocked = readWantsDocked();
  /** Opened over the feed from the top bar, where it can't dock. */
  #overlay = false;
  #open: OpenRow | null = null;
  #sessions: readonly FolderSession[] = [];
  #selectedId = "";

  constructor(options: {
    panel: HTMLElement;
    list: HTMLElement;
    toggle: HTMLButtonElement;
    app: HTMLElement;
    actions: SessionActions;
  }) {
    this.#panel = options.panel;
    this.#list = options.list;
    this.#toggle = options.toggle;
    this.#app = options.app;
    this.#actions = options.actions;

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
      const target = event.target as Element;
      if (target.closest?.("dialog")) return;
      if (this.#overlay && !this.#panel.contains(target) && !this.#toggle.contains(target)) this.#close();
    });
    // Ahead of the page's own Escape, which closes the thread: one key, one thing closed.
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape" || (!this.#open && !this.#overlay) || document.querySelector("dialog[open]")) return;
        event.stopPropagation();
        if (this.#open) this.#setOpen(null);
        else this.#close();
      },
      { capture: true },
    );
    window.addEventListener("resize", () => this.#apply());
    // The thread pane takes the room the panel would dock in.
    new MutationObserver(() => this.#apply()).observe(this.#app, { attributeFilter: ["class"] });
    this.#apply();
  }

  render(sessions: readonly FolderSession[], selectedId: string): void {
    this.#sessions = sessions;
    this.#selectedId = selectedId;
    this.#toggle.dataset["count"] = String(sessions.length);
    if (this.#open && !sessions.some((session) => session.id === this.#open?.sessionId)) this.#open = null;
    // Rebuilding the list would take the half-typed name, and the focus, out of the name field.
    if (this.#open?.mode === "rename") return;
    this.#list.replaceChildren(...sessions.map((session) => this.#row(session, session.id === selectedId)));
  }

  #row(session: FolderSession, selected: boolean): HTMLElement {
    const row = el("div", "session-row");
    row.dataset["status"] = session.process === "ended" ? "ended" : session.status;
    if (selected) row.setAttribute("aria-current", "true");

    const main = el("button", "session-row-main");
    main.type = "button";
    main.title = `Session ${session.id}`;
    const text = el("span", "session-row-text");
    const state = session.process === "ended" ? "Ended" : STATUS_TEXT[session.status];
    text.append(
      el("span", "session-row-label", sessionLabel(session)),
      el("span", "session-row-meta", `${state} · ${lastActive(session.last_active)}`),
    );
    main.append(el("span", "status-dot"), text);
    if (session.pending_notes) main.append(el("span", "note-count", String(session.pending_notes)));
    main.addEventListener("click", () => {
      this.#close();
      this.#actions.select(session.id);
    });

    const open = this.#open?.sessionId === session.id ? this.#open : null;
    const more = el("button", "session-row-more", "⋯");
    more.type = "button";
    more.title = "Rename, end, resume or remove this session";
    more.setAttribute("aria-label", more.title);
    more.setAttribute("aria-expanded", String(open !== null));
    more.addEventListener("click", () => this.#setOpen(open ? null : { sessionId: session.id, mode: "menu" }));

    row.append(main, more);
    if (open) row.append(this.#rowPanel(session, open));
    return row;
  }

  /** Below a row: its menu or its name field. Questions open over the page. */
  #rowPanel(session: FolderSession, open: OpenRow): HTMLElement {
    const box = el("div", "session-row-panel");
    const action = (text: string, onClick: () => void, className = "link-button"): HTMLButtonElement => {
      const element = el("button", className, text);
      element.type = "button";
      element.disabled = open.busy;
      element.addEventListener("click", onClick);
      return element;
    };
    const iconAction = (name: IconName, label: string, onClick: () => void): HTMLButtonElement => {
      const element = action("", onClick, "session-row-icon");
      element.append(icon(name));
      element.title = label;
      element.setAttribute("aria-label", label);
      return element;
    };
    const cancel = (): HTMLButtonElement => action("Cancel", () => this.#setOpen(null));
    const run = (work: () => Promise<void>): void => void this.#run(open, work);

    if (open.mode === "menu") {
      box.append(iconAction("rename", "Rename", () => this.#setOpen({ sessionId: session.id, mode: "rename" })));
      if (session.process === "running") {
        box.append(iconAction("pause", "End session", () => this.#askToEnd(session)));
      } else {
        if (session.process === "ended") {
          box.append(iconAction("play", "Resume session", () => run(() => this.#actions.resume(session.id))));
        } else if (session.status === "offline") {
          // After a restart sidenote can't tell a closed session from one left open with no waiter.
          box.append(iconAction("play", "Resume session", () => this.#askToResume(session)));
        } else {
          const end = iconAction("pause", "End session", () => {});
          end.disabled = true;
          end.title = "sidenote learns this session's process with its next prompt or reply";
          box.append(end);
        }
        box.append(iconAction("remove", "Remove from list", () => this.#askToRemove(session)));
      }
    } else if (open.mode === "rename") {
      const form = el("form", "session-rename");
      const field = el("input");
      field.type = "text";
      field.maxLength = 200;
      field.value = session.label || session.name;
      field.placeholder = "A name, e.g. DM-1782 OAuth fix";
      field.setAttribute("aria-label", "Name of this session in sidenote");
      form.append(
        field,
        action("Save", () => form.requestSubmit(), "send-button"),
        cancel(),
      );
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        run(() => this.#actions.rename(session.id, field.value));
      });
      box.append(form, el("p", "session-row-hint", "Only sidenote shows this name; empty removes it."));
      queueMicrotask(() => field.focus());
    }
    if (open.error) box.append(el("p", "session-row-error", open.error));
    return box;
  }

  #askToEnd(session: FolderSession): void {
    this.#setOpen(null);
    confirmAction(
      {
        title: "End this session?",
        text: `Claude stops in "${sessionLabel(session)}", even in the middle of a turn. You can resume it later.`,
        action: "End session",
        danger: true,
      },
      () => this.#actions.end(session.id),
    );
  }

  #askToResume(session: FolderSession): void {
    this.#setOpen(null);
    confirmAction(
      {
        title: "Resume this session?",
        text: `"${sessionLabel(session)}" opens in a new terminal. If it is still open in one, close that first.`,
        action: "Resume",
      },
      () => this.#actions.resume(session.id),
    );
  }

  #askToRemove(session: FolderSession): void {
    this.#setOpen(null);
    confirmAction(
      {
        title: "Remove this session?",
        text: `"${sessionLabel(session)}" leaves the list, and its replies and notes in sidenote go too.`,
        action: "Remove",
        danger: true,
      },
      () => this.#actions.remove(session.id),
    );
  }

  async #run(open: OpenRow, work: () => Promise<void>): Promise<void> {
    this.#setOpen({ ...open, busy: true, error: "" });
    try {
      await work();
      this.#setOpen(null);
    } catch (error) {
      this.#setOpen({ ...open, busy: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  #setOpen(open: (Pick<OpenRow, "sessionId" | "mode"> & Partial<OpenRow>) | null): void {
    this.#open = open && { error: "", busy: false, ...open };
    // Leaving the name field: the list was held while typing, so bring it up to date now.
    this.#list.replaceChildren(...this.#sessions.map((session) => this.#row(session, session.id === this.#selectedId)));
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
