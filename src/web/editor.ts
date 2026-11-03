// Writing a new note in the margin of a reply.
import { truncate } from "../shared/text.ts";
import { button, el } from "./dom.ts";
import type { Card, Feed } from "./feed.ts";
import { isSendNow, submitOnModEnter, type Sending } from "./sending.ts";

const MAX_QUOTE_CHARS = 600;

interface OpenEditor {
  form: HTMLFormElement;
  textarea: HTMLTextAreaElement;
  card: Card;
  untrack: () => void;
}

export class NoteEditor {
  readonly #feed: Feed;
  readonly #sending: Sending;
  readonly #onError: (error: unknown) => void;
  #open: OpenEditor | null = null;

  constructor(options: { feed: Feed; sending: Sending; onError: (error: unknown) => void }) {
    this.#feed = options.feed;
    this.#sending = options.sending;
    this.#onError = options.onError;
  }

  /** Opens an editor for a note on one block of a reply, or on the whole reply (-1). */
  start(card: Card, blockIndex: number, quote: string): void {
    if (this.#open) {
      // Don't throw away a half-written note.
      if (this.#open.textarea.value.trim()) {
        this.#open.textarea.focus();
        return;
      }
      this.close();
    }
    const container = this.#feed.noteContainer(card, blockIndex);
    if (!container) return;

    const form = el("form", "editor");
    if (quote) form.append(el("div", "editor-quote", quote));
    const textarea = el("textarea");
    textarea.rows = 3;
    textarea.placeholder = quote ? "Your note for Claude…" : "Your note on the whole reply…";
    const send = el("button", "send-button", "Send now");
    send.type = "submit";
    send.value = "send";
    const save = el("button", "secondary-button", "Save");
    save.type = "submit";
    save.value = "save";
    const hint = el("span", "editor-hint");
    const actions = el("div", "editor-actions");
    actions.append(
      send,
      save,
      button("link-button", "Cancel", () => this.close()),
      hint,
    );
    form.append(textarea, actions);
    container.append(form);

    textarea.addEventListener("input", () => this.#feed.layoutCard(card));
    textarea.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      this.close();
    });
    submitOnModEnter(textarea, form);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!textarea.value.trim()) return;
      send.disabled = save.disabled = true;
      const note = {
        response_id: card.response.id,
        block_index: blockIndex,
        quote: truncate(quote, MAX_QUOTE_CHARS),
        body: textarea.value,
      };
      this.#sending
        .save(note, isSendNow(event))
        .then(() => this.close())
        .catch((error: unknown) => {
          save.disabled = false;
          this.#sending.render();
          this.#onError(error);
        });
    });

    this.#open = { form, textarea, card, untrack: this.#sending.track({ send, hint }) };
    this.#feed.layoutCard(card);
    textarea.focus({ preventScroll: true });
    form.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  close(): void {
    if (!this.#open) return;
    const { form, card, untrack } = this.#open;
    this.#open = null;
    untrack();
    form.remove();
    this.#feed.layoutCard(card);
  }
}
