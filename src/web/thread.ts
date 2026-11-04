// The thread pane: one note's whole conversation beside the feed, with a reply box.
import type { Note } from "../shared/types.ts";
import { button, el, formatTime, tag } from "./dom.ts";
import { createMeta, createTypingIndicator, setTypingActivity, type Feed } from "./feed.ts";
import { renderMarkdownInto } from "./markdown.ts";
import { isAnswered, type Model } from "./model.ts";
import { isSendNow, submitOnModEnter, type Sending } from "./sending.ts";

export class ThreadPane {
  readonly #model: Model;
  readonly #feed: Feed;
  readonly #sending: Sending;
  readonly #deleteNote: (noteId: number) => void;
  readonly #onError: (error: unknown) => void;
  readonly #app: HTMLElement;
  readonly #meta: HTMLElement;
  readonly #quote: HTMLElement;
  readonly #timeline: HTMLElement;
  readonly #composer: HTMLFormElement;
  readonly #text: HTMLTextAreaElement;

  constructor(options: {
    model: Model;
    feed: Feed;
    sending: Sending;
    deleteNote: (noteId: number) => void;
    onError: (error: unknown) => void;
    app: HTMLElement;
    meta: HTMLElement;
    quote: HTMLElement;
    timeline: HTMLElement;
    composer: HTMLFormElement;
    composerText: HTMLTextAreaElement;
    close: HTMLButtonElement;
  }) {
    this.#model = options.model;
    this.#feed = options.feed;
    this.#sending = options.sending;
    this.#deleteNote = options.deleteNote;
    this.#onError = options.onError;
    this.#app = options.app;
    this.#meta = options.meta;
    this.#quote = options.quote;
    this.#timeline = options.timeline;
    this.#composer = options.composer;
    this.#text = options.composerText;

    options.close.addEventListener("click", () => this.close());
    this.#sending.track({
      send: this.#composer.querySelector<HTMLButtonElement>("button[value=send]")!,
      hint: this.#composer.querySelector<HTMLElement>(".editor-hint")!,
    });
    submitOnModEnter(this.#text, this.#composer);
    this.#text.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.#text.blur();
    });
    this.#composer.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#reply(isSendNow(event)).catch(this.#onError);
    });
  }

  get isOpen(): boolean {
    return this.#model.openThreadId !== null;
  }

  /** Opens the thread a note belongs to. */
  open(noteId: number): void {
    const note = this.#model.note(noteId);
    if (!note) return;
    const rootId = note.parent_id ?? note.id;
    if (rootId !== this.#model.openThreadId) {
      // Don't throw away a half-written reply in another thread.
      if (this.isOpen && this.#text.value.trim()) {
        this.#text.focus();
        return;
      }
      this.#text.value = "";
    }
    this.#model.openThreadId = rootId;
    this.#app.classList.add("split");
    this.#feed.hideNewReply();
    history.replaceState(null, "", `${location.pathname}${location.search}#n${rootId}`);
    this.render();
    this.#feed.markSelected();
    this.#feed.revealNote(rootId);
  }

  /** Closes the pane, unless a reply is half-written and force is false. */
  close(force = false): void {
    if (!force && this.#text.value.trim()) {
      this.#text.focus();
      return;
    }
    const previous = this.#model.openThreadId;
    this.#model.openThreadId = null;
    this.#text.value = "";
    this.#app.classList.remove("split");
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    this.#feed.markSelected();
    if (previous !== null) this.#feed.revealNote(previous);
  }

  render(): void {
    const root = this.#model.note(this.#model.openThreadId);
    const response = this.#model.response(root?.response_id);
    if (!root || !response) {
      if (this.isOpen) this.close(true);
      return;
    }
    const showInFeed = button("link-button", "Show in feed", () =>
      this.#feed.showBlock(root.response_id, root.block_index),
    );
    this.#meta.replaceChildren(...createMeta(response).childNodes, showInFeed);
    this.#quote.replaceChildren(
      el("blockquote", root.quote ? "pane-quote" : "pane-quote whole", root.quote || "On the whole reply"),
    );

    const entries = this.#model.thread(root.id);
    const timeline: HTMLElement[] = [];
    entries.forEach((note, index) => {
      timeline.push(this.#entry(note));
      const next = entries[index + 1];
      // One reply from Claude can answer several notes in a row; show it once, after the last.
      if (isAnswered(note) && next?.answered_by !== note.answered_by) {
        timeline.push(
          this.#answer(
            note.answered_by,
            entries.filter((n) => n.answered_by === note.answered_by),
          ),
        );
      } else if (note.delivered_at !== null && note.answered_by === null && !next) {
        timeline.push(this.#waiting());
      }
    });
    this.#timeline.replaceChildren(...timeline);
  }

  /** Under a sent note: the dots and what Claude is doing, once it has the note. */
  #waiting(): HTMLElement {
    if (this.#model.sendStatus().status !== "busy")
      return el("div", "waiting", "Sent. Claude's reply will appear here.");
    const typing = createTypingIndicator();
    setTypingActivity(typing, this.#model.activity());
    return typing;
  }

  async #reply(sendNow: boolean): Promise<void> {
    const rootId = this.#model.openThreadId;
    if (!this.#text.value.trim() || rootId === null) return;
    const buttons = this.#composer.querySelectorAll<HTMLButtonElement>("button[type=submit]");
    for (const submit of buttons) submit.disabled = true;
    try {
      await this.#sending.save({ parent_id: rootId, body: this.#text.value }, sendNow);
      this.#text.value = "";
    } finally {
      for (const submit of buttons) submit.disabled = false;
      this.#sending.render();
    }
  }

  #entry(note: Note): HTMLElement {
    const delivered = note.delivered_at !== null;
    const element = el("div", delivered ? "entry delivered" : "entry pending");
    const head = el("div", "entry-head");
    const status =
      note.delivered_at !== null
        ? `Sent ${formatTime(note.delivered_at)}`
        : this.#model.isQueued(note)
          ? "Sending…"
          : "Pending";
    head.append(
      el("b", "", note.parent_id === null ? "Your note" : "Your follow-up"),
      tag(delivered ? "delivered" : "pending", status),
    );
    if (!delivered) head.append(button("link-button", "Delete", () => this.#deleteNote(note.id)));
    element.append(head, el("div", "entry-body", note.body));
    return element;
  }

  /**
   * Claude's answer to a group of notes: the sections it wrote for them, or, when it wrote no
   * marked sections, a link to the reply in the feed rather than a copy of it.
   */
  #answer(responseId: number, group: Note[]): HTMLElement {
    const element = el("div", "answer");
    const head = el("div", "entry-head");
    head.append(el("b", "", "Claude"));
    element.append(head);

    const response = this.#model.response(responseId);
    if (!response) {
      head.append("answered in a reply that is no longer stored");
      return element;
    }
    head.append(el("span", "", formatTime(response.created_at)));
    const texts = [...new Set(group.map((note) => this.#model.answerText(note)).filter(Boolean))];
    if (!texts.length) {
      element.classList.add("linked-answer");
      element.append(
        button("link-button", "Answered in the reply in the feed →", () => this.#feed.showBlock(responseId, -1)),
      );
      return element;
    }
    for (const text of texts) {
      const body = el("div", "markdown");
      renderMarkdownInto(body, text);
      element.append(body);
    }
    return element;
  }
}
