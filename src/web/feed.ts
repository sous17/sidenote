// The feed: one card per reply, with notes in the margin beside the text they are about.
import type { Note, StoredResponse, UserMessage } from "../shared/types.ts";
import { button, el, flash, formatTime, plainText, plural, tag, truncate } from "./dom.ts";
import { LiveCard } from "./live-card.ts";
import { renderMarkdownInto } from "./markdown.ts";
import { answeredNoteIds, isAnswered, type Model } from "./model.ts";

// Must match the @container feed min-width in app.css that moves notes into the margin.
const MARGIN_LAYOUT_MIN_WIDTH = 1000;
// The split view needs this much window width; narrower, the thread pane covers the feed.
const SPLIT_MIN_WIDTH = 900;
const NOTE_GAP_PX = 8;
const BLOCK_SELECTOR = [
  ":scope > p",
  ":scope > pre",
  ":scope > blockquote",
  ":scope > table",
  ":scope > .diffview",
  ":scope > h1",
  ":scope > h2",
  ":scope > h3",
  ":scope > h4",
  ":scope > h5",
  ":scope > h6",
  "li",
].join(", ");

/** A reply in the feed: a full card, or a one-line row for a reply that only answered notes. */
export interface Card {
  element: HTMLElement;
  response: StoredResponse;
  meta: HTMLElement;
  /** The paragraphs, list items and other blocks notes can attach to. */
  blocks: HTMLElement[];
  /** One margin thread per block, holding the notes on that block. */
  threads: HTMLElement[];
  /** Notes on the reply as a whole. Absent on one-line rows, which hold no notes. */
  wholeThread?: HTMLElement;
  count?: HTMLElement;
  answered: HTMLElement;
}

export interface FeedHandlers {
  openThread(noteId: number): void;
  startNote(card: Card, blockIndex: number, quote: string): void;
  deleteNote(noteId: number): void;
}

export class Feed {
  readonly #model: Model;
  readonly #handlers: FeedHandlers;
  readonly #app: HTMLElement;
  readonly #feed: HTMLElement;
  readonly #inner: HTMLElement;
  readonly #emptyState: HTMLElement;
  readonly #newReply: HTMLButtonElement;
  readonly #cards = new Map<number, Card>();
  /** The user's messages, which sit between the replies in time order. */
  readonly #messages = new Map<number, HTMLElement>();
  /** After the user's latest message, until Claude's reply arrives. */
  readonly #live: LiveCard;
  #firstRender = true;

  constructor(options: {
    model: Model;
    handlers: FeedHandlers;
    app: HTMLElement;
    feed: HTMLElement;
    inner: HTMLElement;
    emptyState: HTMLElement;
    newReply: HTMLButtonElement;
  }) {
    this.#model = options.model;
    this.#handlers = options.handlers;
    this.#app = options.app;
    this.#feed = options.feed;
    this.#inner = options.inner;
    this.#emptyState = options.emptyState;
    this.#newReply = options.newReply;
    this.#live = new LiveCard(options.model);

    new ResizeObserver(() => this.layout()).observe(this.#feed);
    this.#newReply.addEventListener("click", () => {
      this.#newReply.hidden = true;
      const scroller = this.scroller();
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    });
    for (const target of [window, this.#feed]) {
      target.addEventListener("scroll", () => this.#hideNewReplyAtBottom(), { passive: true });
    }
  }

  /** Brings the feed in line with the model. */
  render(): void {
    const scroller = this.scroller();
    const wasNearBottom = isNearBottom(scroller);
    const added = this.#syncCards();
    const liveGrew = this.#syncLive();

    this.#emptyState.hidden = this.#model.responses.length + this.#model.messages.length > 0;
    for (const card of this.#cards.values()) this.#renderNotes(card);
    this.layout();

    if (this.#firstRender) {
      scrollToEnd(this.scroller());
    } else if ((added || liveGrew) && wasNearBottom) {
      scrollToEnd(scroller);
    } else if (added) {
      this.#newReply.hidden = false;
    }
    this.#firstRender = false;
  }

  card(responseId: number): Card | undefined {
    return this.#cards.get(responseId);
  }

  /** The card a block in the feed belongs to. */
  cardOf(block: Element): Card | undefined {
    return this.#cards.get(Number(block.closest<HTMLElement>(".card")?.dataset["responseId"]));
  }

  /** Where notes on this block go: its margin thread, or the whole-reply thread for -1. */
  noteContainer(card: Card, blockIndex: number): HTMLElement | undefined {
    return card.threads[blockIndex] ?? card.wholeThread;
  }

  /** Scrolls a reply, or one block of it, into view and flashes it. */
  showBlock(responseId: number, blockIndex: number): void {
    const card = this.#cards.get(responseId);
    if (!card) return;
    const target = card.blocks[blockIndex] ?? card.element;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    flash(target);
  }

  /** Highlights the margin note and answer links of the open thread. */
  markSelected(): void {
    for (const element of this.#inner.querySelectorAll<HTMLElement>("[data-root-id]")) {
      element.classList.toggle("selected", Number(element.dataset["rootId"]) === this.#model.openThreadId);
    }
  }

  revealNote(rootId: number): void {
    this.#marginNote(rootId)?.scrollIntoView({ block: "nearest" });
  }

  /** Scrolls to the first unsent note and flashes it. */
  showFirstPending(): void {
    const first = this.#model.notes.find((note) => note.delivered_at === null);
    const element = first && this.#marginNote(first.parent_id ?? first.id);
    if (!element || element.offsetParent === null) return;
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    flash(element);
  }

  /** For another tab's session: its replies arrive like a first load, at the end and without flashing. */
  reset(): void {
    this.#firstRender = true;
    this.#newReply.hidden = true;
  }

  /** The element that scrolls the feed: the feed itself in the split view, the page otherwise. */
  scroller(): Element {
    return this.#app.classList.contains("split") && window.innerWidth >= SPLIT_MIN_WIDTH
      ? this.#feed
      : document.scrollingElement!;
  }

  /** Shows the end of the feed, for a message the user just sent. */
  scrollToLatest(): void {
    scrollToEnd(this.scroller());
    this.#newReply.hidden = true;
  }

  hideNewReply(): void {
    this.#newReply.hidden = true;
  }

  layout(): void {
    for (const card of this.#cards.values()) this.layoutCard(card);
  }

  /** In margin layout, each note sits level with its block; notes that would overlap stack downwards. */
  layoutCard(card: Card): void {
    const { wholeThread } = card;
    if (!wholeThread) return;
    const containers = [wholeThread, ...card.threads];
    if (this.#feed.clientWidth < MARGIN_LAYOUT_MIN_WIDTH || card.element.hidden) {
      for (const container of containers) container.style.top = "";
      card.element.style.minHeight = "";
      return;
    }
    const cardTop = card.element.getBoundingClientRect().top;
    const placed = containers
      .filter((container) => container.offsetParent !== null) // empty threads are display: none
      .map((container) => {
        const anchor = container === wholeThread ? card.meta : card.blocks[card.threads.indexOf(container)]!;
        return { container, wanted: anchor.getBoundingClientRect().top - cardTop };
      })
      .sort((a, b) => a.wanted - b.wanted);
    let nextFree = 0;
    for (const { container, wanted } of placed) {
      const top = Math.max(wanted, nextFree);
      container.style.top = `${top}px`;
      nextFree = top + container.offsetHeight + NOTE_GAP_PX;
    }
    card.element.style.minHeight = nextFree > 0 ? `${nextFree}px` : "";
  }

  // ---- Cards ----------------------------------------------------------------------------

  /** Adds cards for new replies and removes dropped ones. Returns whether any were added. */
  #syncCards(): boolean {
    let added = false;
    for (const response of this.#model.responses) {
      if (this.#cards.has(response.id)) continue;
      const card = this.#createCard(response);
      if (!this.#firstRender) card.element.classList.add("fresh");
      this.#cards.set(response.id, card);
      added = true;
    }
    for (const message of this.#model.messages) {
      if (this.#messages.has(message.id)) continue;
      this.#messages.set(message.id, createMessage(message));
      added = true;
    }
    // Messages go between replies, and backfilled replies are older than cards already shown.
    if (added) for (const element of this.#inTimeOrder()) this.#inner.append(element);

    const live = new Set(this.#model.responses.map((r) => r.id));
    for (const [id, card] of this.#cards) {
      if (live.has(id)) continue;
      card.element.remove();
      this.#cards.delete(id);
    }
    const liveMessages = new Set(this.#model.messages.map((m) => m.id));
    for (const [id, element] of this.#messages) {
      if (liveMessages.has(id)) continue;
      element.remove();
      this.#messages.delete(id);
    }
    return added;
  }

  /** Keeps the live card last in the feed. Returns whether it just appeared or grew. */
  #syncLive(): boolean {
    const card = this.#live.element;
    const wasHidden = card.hidden;
    const changed = this.#live.render();
    if (this.#inner.lastElementChild !== card) this.#inner.append(card);
    return !card.hidden && (changed || Boolean(wasHidden));
  }

  #inTimeOrder(): HTMLElement[] {
    const items = [
      ...this.#model.responses.map((r) => ({ at: r.created_at, element: this.#cards.get(r.id)!.element })),
      ...this.#model.messages.map((m) => ({ at: m.created_at, element: this.#messages.get(m.id)! })),
    ];
    return items.sort((a, b) => a.at - b.at).map((item) => item.element);
  }

  #createCard(response: StoredResponse): Card {
    const onlyAnswers = !response.text.trim() && Object.keys(response.note_answers).length > 0;
    return onlyAnswers ? this.#createAnswerRow(response) : this.#createFullCard(response);
  }

  #createFullCard(response: StoredResponse): Card {
    const element = el("article", "card");
    element.dataset["responseId"] = String(response.id);
    const meta = createMeta(response);
    const count = el("span", "card-count");
    const wholeReplyButton = button("link-button", "Note on whole reply");
    meta.append(count, wholeReplyButton);

    const body = el("div", "markdown");
    renderMarkdownInto(body, response.text);
    const blocks = [...body.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)];
    const threads = blocks.map((block, index) => {
      block.classList.add("block");
      block.dataset["blockIndex"] = String(index);
      const thread = createMarginThread();
      // A thread inside <li> keeps list markup valid; elsewhere it follows the block.
      if (block.tagName === "LI") block.append(thread);
      else block.after(thread);
      linkOnHover(block, thread);
      return thread;
    });
    const wholeThread = createMarginThread();
    linkOnHover(meta, wholeThread);
    const answered = el("div", "answered");
    element.append(meta, body, wholeThread, answered);
    this.#inner.append(element);

    const card: Card = { element, response, meta, blocks, threads, wholeThread, count, answered };
    wholeReplyButton.addEventListener("click", () => this.#handlers.startNote(card, -1, ""));
    return card;
  }

  // A reply that only answered notes: its text lives in those threads, so the feed just records it.
  #createAnswerRow(response: StoredResponse): Card {
    const element = el("article", "card answer-row");
    element.dataset["responseId"] = String(response.id);
    const meta = createMeta(response);
    const answered = el("div", "answered");
    meta.append(answered);
    element.append(meta);
    this.#inner.append(element);
    return { element, response, meta, blocks: [], threads: [], answered };
  }

  // ---- Notes ----------------------------------------------------------------------------

  #renderNotes(card: Card): void {
    this.#renderAnswered(card);
    const { wholeThread, count } = card;
    if (!wholeThread || !count) return;
    const notes = this.#model.notes.filter((note) => note.response_id === card.response.id);
    const roots = notes.filter((note) => note.parent_id === null).sort((a, b) => a.created_at - b.created_at);
    const byContainer = new Map<HTMLElement, HTMLElement[]>();
    for (const root of roots) {
      const container = this.noteContainer(card, root.block_index)!;
      const followUps = notes.filter((note) => note.parent_id === root.id);
      byContainer.set(container, [...(byContainer.get(container) ?? []), this.#createMarginNote(root, followUps)]);
    }
    for (const container of [...card.threads, wholeThread]) {
      container.querySelector(".margin-notes")!.replaceChildren(...(byContainer.get(container) ?? []));
    }
    card.blocks.forEach((block, index) => block.classList.toggle("has-notes", byContainer.has(card.threads[index]!)));

    const pending = notes.filter((note) => note.delivered_at === null).length;
    count.replaceChildren(
      ...(roots.length ? [tag("count", `· ${plural(roots.length, "note", "notes")}`)] : []),
      ...(pending ? [tag("pending", `${pending} pending`)] : []),
    );
  }

  /** "↳ Claude answered 2 notes", then one button per thread, each opening that thread. */
  #renderAnswered(card: Card): void {
    const noteIds = answeredNoteIds(this.#model, card.response);
    if (!noteIds.size) {
      card.answered.replaceChildren();
      return;
    }
    const rootIds = new Set<number>();
    for (const id of noteIds) {
      const note = this.#model.note(id);
      const rootId = note && (note.parent_id ?? note.id);
      if (rootId !== undefined && this.#model.note(rootId)) rootIds.add(rootId);
    }
    const links = [...rootIds].map((rootId) => {
      const link = button("answered-link", truncate(this.#model.note(rootId)!.body, 48), () =>
        this.#handlers.openThread(rootId),
      );
      link.dataset["rootId"] = String(rootId);
      link.classList.toggle("selected", rootId === this.#model.openThreadId);
      link.title = "Open this thread";
      return link;
    });
    const label = el("span", "answered-label", `↳ Claude answered ${plural(noteIds.size, "note", "notes")}`);
    card.answered.replaceChildren(label, ...links);
  }

  #createMarginNote(root: Note, followUps: Note[]): HTMLElement {
    const entries = [root, ...followUps];
    const pending = entries.some((note) => note.delivered_at === null);
    const element = el("div", `mnote ${pending ? "pending" : "delivered"}`);
    element.classList.toggle("selected", root.id === this.#model.openThreadId);
    element.dataset["rootId"] = String(root.id);
    element.tabIndex = 0;
    element.title = "Open this thread";

    if (root.quote) element.append(el("div", "mnote-quote", root.quote));
    element.append(el("div", "mnote-body", root.body));
    const latestAnswer = entries.map((note) => this.#model.answerText(note)).findLast(Boolean);
    if (latestAnswer) {
      const snippet = el("div", "mnote-answer");
      snippet.append(el("b", "", "Claude "), truncate(plainText(latestAnswer), 110));
      element.append(snippet);
    }

    const footer = el("div", "mnote-footer");
    const lastSent = Math.max(...entries.map((note) => note.delivered_at ?? 0));
    const status = entries.some((note) => this.#model.isQueued(note))
      ? "Sending…"
      : pending
        ? "Pending"
        : `Sent ${formatTime(lastSent)}`;
    footer.append(tag(pending ? "pending" : "delivered", status));
    const replies = new Set(entries.filter(isAnswered).map((note) => note.answered_by)).size + followUps.length;
    if (replies) footer.append(el("span", "replies", plural(replies, "reply", "replies")));
    if (root.delivered_at === null) {
      footer.append(
        button("link-button", "Delete", (event) => {
          event.stopPropagation();
          this.#handlers.deleteNote(root.id);
        }),
      );
    }
    element.append(footer);

    element.addEventListener("click", () => this.#handlers.openThread(root.id));
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.#handlers.openThread(root.id);
    });
    return element;
  }

  #marginNote(rootId: number): HTMLElement | null {
    return this.#inner.querySelector<HTMLElement>(`.mnote[data-root-id="${rootId}"]`);
  }

  #hideNewReplyAtBottom(): void {
    if (isNearBottom(this.scroller())) this.#newReply.hidden = true;
  }
}

/** The line above a reply. The whole window is one session, so it only needs the time. */
function createMessage(message: UserMessage): HTMLElement {
  const element = el("article", "user-message");
  element.dataset["messageId"] = String(message.id);
  const meta = el("div", "user-message-meta");
  meta.append(el("b", "", "You"), el("span", "", formatTime(message.created_at)));
  element.append(meta, el("div", "user-message-text", message.text));
  return element;
}

export function createMeta(response: StoredResponse): HTMLElement {
  const meta = el("div", "meta");
  meta.append(el("span", "", formatTime(response.created_at)));
  return meta;
}

function createMarginThread(): HTMLElement {
  const thread = el("div", "margin-thread");
  thread.append(el("div", "margin-notes"));
  return thread;
}

/** Hovering a note highlights the text it is about, and the other way round. */
function linkOnHover(anchor: HTMLElement, thread: HTMLElement): void {
  const toggle = (on: boolean): void => {
    anchor.classList.toggle("linked", on);
    thread.classList.toggle("linked", on);
  };
  for (const element of [anchor, thread]) {
    element.addEventListener("mouseenter", () => toggle(true));
    element.addEventListener("mouseleave", () => toggle(false));
  }
}

function isNearBottom(scroller: Element): boolean {
  return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 80;
}

function scrollToEnd(scroller: Element): void {
  scroller.scrollTop = scroller.scrollHeight;
}
