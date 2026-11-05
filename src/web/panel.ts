// The session list on the left: one row per session that ran in this window's folder. In a wide
// window it is docked beside the feed, and beside a thread too, until the user folds it; otherwise
// it folds away and the button in the top bar opens it over the feed.
import type { FolderSession, SessionState } from "../shared/types.ts";
import { sessionLabel } from "../shared/model.ts";
import { formatTime } from "../shared/text.ts";
import { el } from "./dom.ts";

/** Docked, the panel's 260px still leave the feed the 1000px that notes in the margin need. */
const DOCK_MIN_WIDTH = 1280;
const DOCKED_STORAGE_KEY = "sidenote-panel";
const SELECTED_STORAGE_KEY = "sidenote-tab";

const STATUS_TEXT: Readonly<Record<SessionState, string>> = {
  listening: "Listening",
  busy: "Claude is working",
  offline: "Not listening",
};

/** What a session's row and the top bar call its state. */
export function sessionStateText(session: FolderSession): string {
  return session.process === "ended" ? "Ended" : STATUS_TEXT[session.status];
}

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
  remove(sessionId: string): Promise<void>;
}

/** A row that shows its menu, its name field, or asks to confirm, instead of just the session. */
interface OpenRow {
  sessionId: string;
  mode: "menu" | "rename" | "end" | "remove";
  error: string;
  busy: boolean;
}

export class SessionPanel {
  readonly #panel: HTMLElement;
  readonly #list: HTMLElement;
  readonly #toggle: HTMLButtonElement;
  readonly #actions: SessionActions;
  /** Whether the user wants the panel docked when the window has room; folding it is remembered. */
  #wantsDocked = readWantsDocked();
  /** Opened over the feed from the top bar, where it can't dock. */
  #overlay = false;
  #open: OpenRow | null = null;
  #sessions: readonly FolderSession[] = [];
  #selectedId = "";

  constructor(options: { panel: HTMLElement; list: HTMLElement; toggle: HTMLButtonElement; actions: SessionActions }) {
    this.#panel = options.panel;
    this.#list = options.list;
    this.#toggle = options.toggle;
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
      const target = event.target as Node;
      if (this.#overlay && !this.#panel.contains(target) && !this.#toggle.contains(target)) this.#close();
    });
    // Ahead of the page's own Escape, which closes the thread: one key, one thing closed.
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape" || (!this.#open && !this.#overlay)) return;
        event.stopPropagation();
        if (this.#open) this.#setOpen(null);
        else this.#close();
      },
      { capture: true },
    );
    window.addEventListener("resize", () => this.#apply());
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
    text.append(
      el("span", "session-row-label", sessionLabel(session)),
      el("span", "session-row-meta", `${sessionStateText(session)} · ${lastActive(session.last_active)}`),
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
    more.title = "Rename, end or remove this session";
    more.setAttribute("aria-label", more.title);
    more.setAttribute("aria-expanded", String(open !== null));
    more.addEventListener("click", () => this.#setOpen(open ? null : { sessionId: session.id, mode: "menu" }));

    row.append(main, more);
    if (open) row.append(this.#rowPanel(session, open));
    return row;
  }

  /** Below a row: its menu, its name field, or a question before ending or removing it. */
  #rowPanel(session: FolderSession, open: OpenRow): HTMLElement {
    const box = el("div", "session-row-panel");
    const action = (text: string, onClick: () => void, className = "link-button"): HTMLButtonElement => {
      const element = el("button", className, text);
      element.type = "button";
      element.disabled = open.busy;
      element.addEventListener("click", onClick);
      return element;
    };
    const cancel = (): HTMLButtonElement => action("Cancel", () => this.#setOpen(null));
    const run = (work: () => Promise<void>): void => void this.#run(open, work);

    if (open.mode === "menu") {
      box.append(action("Rename", () => this.#setOpen({ sessionId: session.id, mode: "rename" })));
      if (session.process === "running") {
        box.append(action("End session", () => this.#setOpen({ sessionId: session.id, mode: "end" })));
      } else {
        if (session.process === "unknown") {
          const end = action("End session", () => {});
          end.disabled = true;
          end.title = "sidenote learns this session's process with its next prompt or reply";
          box.append(end);
        }
        box.append(action("Remove from list", () => this.#setOpen({ sessionId: session.id, mode: "remove" })));
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
    } else if (open.mode === "end") {
      box.append(
        el("p", "session-row-hint", "End this session? Claude stops, even in the middle of a turn."),
        action("End session", () => run(() => this.#actions.end(session.id)), "danger-button"),
        cancel(),
      );
    } else {
      box.append(
        el("p", "session-row-hint", "Remove it from the list? Its replies and notes in sidenote go too."),
        action("Remove", () => run(() => this.#actions.remove(session.id)), "danger-button"),
        cancel(),
      );
    }
    if (open.error) box.append(el("p", "session-row-error", open.error));
    return box;
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
    return window.innerWidth >= DOCK_MIN_WIDTH;
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
