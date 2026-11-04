// The message box at the bottom of the feed: talk to Claude from the page instead of the terminal.
// Pending notes ride along with the message, as they do with a prompt typed in the terminal.
import type { Model } from "../shared/model.ts";
import { ApiError, type Api } from "./api.ts";

const MAX_ROWS = 10;
const DRAFT_STORAGE_KEY = "sidenote-prompt-draft";

const OFFLINE_HINT =
  "This session isn't listening, so a message can't reach Claude from here. Type once in the terminal; " +
  "after Claude's next reply you can write here.";

export class PromptBox {
  readonly #model: Model;
  readonly #api: Api;
  readonly #refresh: () => Promise<void>;
  readonly #onSent: () => void;
  readonly #onError: (error: unknown) => void;
  readonly #form: HTMLFormElement;
  readonly #field: HTMLTextAreaElement;
  readonly #send: HTMLButtonElement;
  readonly #hint: HTMLElement;
  #sending = false;
  /** Why the last send failed, shown under the box until the user edits the message. */
  #error = "";

  constructor(options: {
    model: Model;
    api: Api;
    refresh: () => Promise<void>;
    onSent: () => void;
    onError: (error: unknown) => void;
    form: HTMLFormElement;
    field: HTMLTextAreaElement;
    send: HTMLButtonElement;
    hint: HTMLElement;
  }) {
    this.#model = options.model;
    this.#api = options.api;
    this.#refresh = options.refresh;
    this.#onSent = options.onSent;
    this.#onError = options.onError;
    this.#form = options.form;
    this.#field = options.field;
    this.#send = options.send;
    this.#hint = options.hint;

    this.#field.value = readDraft(this.#model.sessionId);
    this.#fitHeight();
    this.#field.addEventListener("input", () => {
      this.#error = "";
      writeDraft(this.#model.sessionId, this.#field.value);
      this.#fitHeight();
      this.render();
    });
    // Enter sends, Shift+Enter starts a new line. Enter that confirms an IME composition doesn't send.
    this.#field.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.#field.blur();
      if (event.key !== "Enter" || event.shiftKey || event.altKey || event.isComposing) return;
      event.preventDefault();
      this.#form.requestSubmit();
    });
    this.#form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#submit();
    });
  }

  render(): void {
    const { status } = this.#model.sendStatus();
    const offline = status === "offline";
    this.#form.classList.toggle("offline", offline);
    this.#form.classList.toggle("failed", this.#error !== "");
    this.#send.disabled = this.#sending || offline || !this.#field.value.trim();
    this.#send.title = offline
      ? OFFLINE_HINT
      : status === "busy"
        ? "Queue for when Claude finishes (Enter)"
        : "Send (Enter)";

    const pending = this.#model.pendingCount();
    const notes = pending
      ? ` Your ${pending === 1 ? "pending note goes" : `${pending} pending notes go`} with it.`
      : "";
    if (this.#error) this.#hint.textContent = this.#error;
    else if (offline) this.#hint.textContent = OFFLINE_HINT;
    else if (status === "busy")
      this.#hint.textContent = `Claude is working: a message waits until it finishes.${notes}`;
    else this.#hint.textContent = `Enter sends · Shift+Enter for a new line.${notes}`;
  }

  async #submit(): Promise<void> {
    const text = this.#field.value.trim();
    if (!text || this.#sending) return;
    if (!this.#model.canSend()) {
      this.#error = `Not sent. ${OFFLINE_HINT}`;
      this.render();
      return;
    }
    this.#sending = true;
    this.#error = "";
    this.render();
    try {
      await this.#api.prompt(this.#model.sessionId, text);
      this.#field.value = "";
      writeDraft(this.#model.sessionId, "");
      this.#fitHeight();
      await this.#refresh();
      this.#onSent();
    } catch (error) {
      // The message stays in the box, so nothing typed is lost.
      this.#error = `Not sent: ${describeFailure(error)}`;
      this.#onError(error);
    } finally {
      this.#sending = false;
      this.render();
    }
  }

  /** Grows the box with its text, up to MAX_ROWS lines, then scrolls. */
  #fitHeight(): void {
    const field = this.#field;
    field.style.height = "auto";
    const line = parseFloat(getComputedStyle(field).lineHeight) || 22;
    field.style.height = `${Math.min(field.scrollHeight, line * MAX_ROWS + 16)}px`;
  }
}

function describeFailure(error: unknown): string {
  if (!(error instanceof ApiError)) return "sidenote can't be reached. Is it on?";
  // A server started before the message box existed has no such endpoint, and says nothing.
  if (error.status === 404 && /failed with 404$/.test(error.message)) {
    return "the sidenote server is older than this page. Run /sidenote:off, then /sidenote:on, to restart it.";
  }
  return error.message;
}

// A draft survives a reload of this tab, per session. Storage can be blocked; the box still works.
function readDraft(sessionId: string): string {
  try {
    return sessionStorage.getItem(`${DRAFT_STORAGE_KEY}:${sessionId}`) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(sessionId: string, text: string): void {
  try {
    if (text) sessionStorage.setItem(`${DRAFT_STORAGE_KEY}:${sessionId}`, text);
    else sessionStorage.removeItem(`${DRAFT_STORAGE_KEY}:${sessionId}`);
  } catch {
    // Storage blocked: the draft lasts as long as the page.
  }
}
