import DOMPurify from "dompurify";
import { marked } from "marked";
import type { NewNoteRequest, Note, SessionState, StateSnapshot, StoredResponse } from "../shared/types.ts";
import { ApiError, api } from "./api.ts";
import {
  button,
  byId,
  el,
  elementOf,
  flash,
  formatTime,
  plainText,
  plural,
  projectName,
  tag,
  truncate,
} from "./dom.ts";

const POLL_INTERVAL_MS = 1500;
const MAX_QUOTE_CHARS = 600;
const NOTE_GAP_PX = 8;
// Must match the @container feed min-width in app.css that moves notes into the margin.
const MARGIN_LAYOUT_MIN_WIDTH = 1000;
// The split view needs this much window width; narrower, the thread pane covers the feed.
const SPLIT_MIN_WIDTH = 900;
const BLOCK_SELECTOR = [
  ":scope > p", ":scope > pre", ":scope > blockquote", ":scope > table",
  ":scope > h1", ":scope > h2", ":scope > h3", ":scope > h4", ":scope > h5", ":scope > h6",
  "li",
].join(", ");

const app = byId("app");
const feed = byId("feed");
const feedInner = byId("feed-inner");
const emptyState = feedInner.querySelector<HTMLElement>(".empty")!;
const paneMeta = byId("pane-meta");
const paneQuote = byId("pane-quote");
const paneTimeline = byId("pane-timeline");
const composer = byId<HTMLFormElement>("composer");
const composerText = byId<HTMLTextAreaElement>("composer-text");
const sessionTitle = byId("session-title");
const sessionName = byId("session-name");
const sessionDetail = byId("session-detail");
const emptyTitle = byId("empty-title");
const emptyIntro = byId("empty-intro");
const emptyHelp = byId("empty-help");
/** The Claude Code session this window shows; each session has its own window. */
const sessionId = new URLSearchParams(location.search).get("s");
const pendingSummary = byId<HTMLButtonElement>("pending-summary");
const sendNowButton = byId<HTMLButtonElement>("send-now");
const connection = byId("connection");
const selectionButton = byId<HTMLButtonElement>("selection-comment");
const newReplyButton = byId<HTMLButtonElement>("new-reply");

/** A reply in the feed: a full card, or a one-line row for replies that only answered notes. */
interface Card {
  element: HTMLElement;
  response: StoredResponse;
  meta: HTMLElement;
  blocks: HTMLElement[];
  /** One margin thread per block, holding the notes on that block. */
  threads: HTMLElement[];
  /** Notes on the whole reply; null for one-line rows, which hold no notes. */
  wholeThread: HTMLElement | null;
  count: HTMLElement | null;
  answered: HTMLElement;
}

interface Editor {
  form: HTMLFormElement;
  textarea: HTMLTextAreaElement;
  card: Card;
  send: HTMLButtonElement;
  hint: HTMLElement;
}

let knownVersion = -1;
let state: StateSnapshot = { version: -1, session: null, responses: [], comments: [] };
const cards = new Map<number, Card>();
let openThreadId: number | null = null;
let editor: Editor | null = null;
let firstRender = true;

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

function renderMarkdown(markdown: string): string {
  return DOMPurify.sanitize(marked.parse(markdown, { async: false }));
}

function setConnection(stateName: "live" | "error", label: string): void {
  connection.dataset["state"] = stateName;
  connection.textContent = label;
}

function showError(error: unknown): void {
  setConnection("error", error instanceof Error ? error.message : String(error));
}

async function refresh(): Promise<void> {
  try {
    const next = await api.state(knownVersion, sessionId);
    if (next) {
      state = next;
      knownVersion = next.version;
      render();
    }
    setConnection("live", "Live");
  } catch (error) {
    if (error instanceof ApiError) {
      setConnection("error", error.status === 403 ? "Stale tab: run /sidenote:open" : `Server error ${error.status}`);
    } else {
      setConnection("error", "Disconnected: is sidenote on?");
    }
  }
}

async function pollForever(): Promise<void> {
  await refresh();
  setTimeout(pollForever, POLL_INTERVAL_MS);
}

// ---- Lookups -------------------------------------------------------------------

function noteById(id: number | null): Note | undefined {
  return id === null ? undefined : state.comments.find((c) => c.id === id);
}

function responseById(id: number | null | undefined): StoredResponse | undefined {
  return id === null || id === undefined ? undefined : state.responses.find((r) => r.id === id);
}

function isAnswered(note: Note): note is Note & { answered_by: number } {
  return note.answered_by !== null && note.answered_by > 0;
}

// ---- Feed ----------------------------------------------------------------------

function render(): void {
  const scroller = feedScroller();
  const wasNearBottom = isNearBottom(scroller);
  let addedCard = false;

  for (const response of state.responses) {
    if (!cards.has(response.id)) {
      const card = createCard(response);
      if (!firstRender) card.element.classList.add("fresh");
      cards.set(response.id, card);
      addedCard = true;
    }
  }
  // Backfilled replies are older than cards already shown, so restore time order.
  if (addedCard) {
    for (const response of state.responses) feedInner.append(cards.get(response.id)!.element);
  }
  const liveIds = new Set(state.responses.map((r) => r.id));
  for (const [responseId, card] of cards) {
    if (!liveIds.has(responseId)) {
      card.element.remove();
      cards.delete(responseId);
    }
  }

  emptyState.hidden = state.responses.length > 0;
  renderSessionTitle();
  for (const card of cards.values()) renderNotes(card);
  renderPendingSummary();
  if (openThreadId !== null) renderPane();
  layoutAllNotes();

  if (firstRender) {
    const fromHash = Number(/^#n(\d+)$/.exec(location.hash)?.[1]);
    scrollToEnd(feedScroller());
    if (fromHash) openThread(fromHash);
  } else if (addedCard && wasNearBottom) {
    scrollToEnd(scroller);
  } else if (addedCard) {
    newReplyButton.hidden = false;
  }
  firstRender = false;
}

function answeredNoteIds(response: StoredResponse): number[] {
  return Object.keys(response.note_answers).map(Number);
}

function createCard(response: StoredResponse): Card {
  if (!response.text.trim() && answeredNoteIds(response).length) return createAnswerRow(response);
  const element = el("article", "card");
  element.dataset["responseId"] = String(response.id);

  const meta = createMeta(response);
  const count = el("span", "card-count");
  const wholeReplyButton = button("link-button", "Note on whole reply");
  meta.append(count, wholeReplyButton);

  const body = el("div", "markdown");
  body.innerHTML = renderMarkdown(response.text);

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
  feedInner.append(element);
  const card: Card = { element, response, meta, blocks, threads, wholeThread, count, answered };
  wholeReplyButton.addEventListener("click", () => startNote(card, -1, ""));
  return card;
}

// A reply that only answered notes: its text lives in those threads, so the feed just records it.
function createAnswerRow(response: StoredResponse): Card {
  const element = el("article", "card answer-row");
  element.dataset["responseId"] = String(response.id);
  const meta = createMeta(response);
  const answered = el("div", "answered");
  meta.append(answered);
  element.append(meta);
  feedInner.append(element);
  return { element, response, meta, blocks: [], threads: [], wholeThread: null, count: null, answered };
}

// "↳ Claude answered 2 notes" followed by one button per thread, each opening that thread.
function renderAnswered(card: Card): void {
  // Notes this reply answered: those it wrote marked sections for, and those it was the
  // next reply to (Claude may skip the markers; the thread then links here).
  const noteIds = new Set(answeredNoteIds(card.response));
  for (const comment of state.comments) {
    if (comment.answered_by === card.response.id) noteIds.add(comment.id);
  }
  if (!noteIds.size) {
    card.answered.replaceChildren();
    return;
  }
  const rootIds: number[] = [];
  for (const noteId of noteIds) {
    const note = noteById(noteId);
    const rootId = note ? (note.parent_id ?? note.id) : null;
    if (rootId !== null && !rootIds.includes(rootId) && noteById(rootId)) rootIds.push(rootId);
  }
  const label = el("span", "answered-label", `↳ Claude answered ${plural(noteIds.size, "note", "notes")}`);
  const links = rootIds.map((rootId) => {
    const link = button("answered-link", truncate(noteById(rootId)!.body, 48), () => openThread(rootId));
    link.dataset["rootId"] = String(rootId);
    link.classList.toggle("selected", rootId === openThreadId);
    link.title = "Open this thread";
    return link;
  });
  card.answered.replaceChildren(label, ...links);
}

function createMeta(response: StoredResponse): HTMLElement {
  // The whole window is one session, so a card only needs its time.
  const meta = el("div", "meta");
  meta.append(el("span", "", formatTime(response.created_at)));
  return meta;
}

function createMarginThread(): HTMLElement {
  const thread = el("div", "margin-thread");
  thread.append(el("div", "margin-notes"));
  return thread;
}

// Hovering a note highlights the text it is about, and the other way round.
function linkOnHover(anchor: HTMLElement, thread: HTMLElement): void {
  const toggle = (on: boolean) => {
    anchor.classList.toggle("linked", on);
    thread.classList.toggle("linked", on);
  };
  for (const element of [anchor, thread]) {
    element.addEventListener("mouseenter", () => toggle(true));
    element.addEventListener("mouseleave", () => toggle(false));
  }
}

function threadContainer(card: Card, blockIndex: number): HTMLElement {
  return card.threads[blockIndex] ?? card.wholeThread!;
}

function renderNotes(card: Card): void {
  renderAnswered(card);
  if (!card.wholeThread || !card.count) return;
  const comments = state.comments.filter((c) => c.response_id === card.response.id);
  const roots = comments.filter((c) => c.parent_id === null).sort((a, b) => a.created_at - b.created_at);
  const byContainer = new Map<HTMLElement, HTMLElement[]>();
  for (const root of roots) {
    const container = threadContainer(card, root.block_index);
    const followUps = comments.filter((c) => c.parent_id === root.id);
    byContainer.set(container, [...(byContainer.get(container) ?? []), createMarginNote(root, followUps)]);
  }
  for (const container of [...card.threads, card.wholeThread]) {
    container.querySelector(".margin-notes")!.replaceChildren(...(byContainer.get(container) ?? []));
  }
  card.blocks.forEach((block, index) => block.classList.toggle("has-notes", byContainer.has(card.threads[index]!)));

  const pending = comments.filter((c) => c.delivered_at === null).length;
  const tags: HTMLElement[] = [];
  if (roots.length) tags.push(tag("count", `· ${plural(roots.length, "note", "notes")}`));
  if (pending) tags.push(tag("pending", `${pending} pending`));
  card.count.replaceChildren(...tags);
}

function createMarginNote(root: Note, followUps: Note[]): HTMLElement {
  const entries = [root, ...followUps];
  const pending = entries.some((c) => c.delivered_at === null);
  const element = el("div", `mnote ${pending ? "pending" : "delivered"}`);
  element.classList.toggle("selected", root.id === openThreadId);
  element.dataset["rootId"] = String(root.id);
  element.tabIndex = 0;
  element.title = "Open this thread";

  if (root.quote) element.append(el("div", "mnote-quote", root.quote));
  element.append(el("div", "mnote-body", root.body));

  const footer = el("div", "mnote-footer");
  const lastSent = Math.max(...entries.map((c) => c.delivered_at ?? 0));
  const queued = entries.some(isQueued);
  footer.append(
    tag(pending ? "pending" : "delivered", queued ? "Sending…" : pending ? "Pending" : `Sent ${formatTime(lastSent)}`),
  );

  const answers = new Set(entries.filter(isAnswered).map((c) => c.answered_by)).size;
  const replies = answers + followUps.length;
  const latestAnswer = [...entries].reverse().map(answerTextFor).find(Boolean);
  if (latestAnswer) {
    const snippet = el("div", "mnote-answer");
    snippet.append(el("b", "", "Claude "), truncate(plainText(latestAnswer), 110));
    element.append(snippet);
  }
  if (replies) footer.append(el("span", "replies", plural(replies, "reply", "replies")));
  if (root.delivered_at === null) {
    footer.append(
      button("link-button", "Delete", (event) => {
        event.stopPropagation();
        void deleteNote(root.id, openThreadId === root.id);
      }),
    );
  }
  element.append(footer);

  element.addEventListener("click", () => openThread(root.id));
  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter") openThread(root.id);
  });
  return element;
}

async function deleteNote(id: number, closesThread: boolean): Promise<void> {
  try {
    await api.deleteNote(id);
    if (closesThread) closeThread(true);
    await refresh();
  } catch (error) {
    showError(error);
  }
}

// In margin layout, each note sits level with its block; notes that would overlap stack downwards.
function layoutNotes(card: Card): void {
  const { wholeThread } = card;
  if (!wholeThread) return; // one-line rows have no notes
  const containers = [wholeThread, ...card.threads];
  if (feed.clientWidth < MARGIN_LAYOUT_MIN_WIDTH || card.element.hidden) {
    for (const container of containers) container.style.top = "";
    card.element.style.minHeight = "";
    return;
  }
  const cardTop = card.element.getBoundingClientRect().top;
  const placed: Array<{ container: HTMLElement; wanted: number }> = [];
  for (const container of containers) {
    if (container.offsetParent === null) continue; // empty threads are display: none
    const anchor = container === wholeThread ? card.meta : card.blocks[card.threads.indexOf(container)]!;
    placed.push({ container, wanted: anchor.getBoundingClientRect().top - cardTop });
  }
  placed.sort((a, b) => a.wanted - b.wanted);
  let nextFree = 0;
  for (const { container, wanted } of placed) {
    const top = Math.max(wanted, nextFree);
    container.style.top = `${top}px`;
    nextFree = top + container.offsetHeight + NOTE_GAP_PX;
  }
  card.element.style.minHeight = nextFree > 0 ? `${nextFree}px` : "";
}

function layoutAllNotes(): void {
  for (const card of cards.values()) layoutNotes(card);
}

new ResizeObserver(layoutAllNotes).observe(feed);

// ---- Writing a new note in the feed --------------------------------------------

function sendButtons(): { send: HTMLButtonElement; save: HTMLButtonElement } {
  const send = el("button", "send-button", "Send now");
  send.type = "submit";
  send.value = "send";
  const save = el("button", "secondary-button", "Save");
  save.type = "submit";
  save.value = "save";
  return { send, save };
}

function startNote(card: Card, blockIndex: number, quote: string): void {
  if (editor) {
    if (editor.textarea.value.trim()) {
      editor.textarea.focus();
      return;
    }
    closeEditor();
  }
  const form = el("form", "editor");
  if (quote) form.append(el("div", "editor-quote", quote));
  const textarea = el("textarea");
  textarea.rows = 3;
  textarea.placeholder = quote ? "Your note for Claude…" : "Your note on the whole reply…";
  const { send, save } = sendButtons();
  const cancel = button("link-button", "Cancel", closeEditor);
  const hint = el("span", "editor-hint");
  const actions = el("div", "editor-actions");
  actions.append(send, save, cancel, hint);
  updateSendControls(send, hint);
  form.append(textarea, actions);
  threadContainer(card, blockIndex).append(form);

  textarea.addEventListener("input", () => layoutNotes(card));
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeEditor();
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) form.requestSubmit(defaultSubmitter(form));
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!textarea.value.trim()) return;
    send.disabled = save.disabled = true;
    const sendNow = (event.submitter as HTMLButtonElement | null)?.value === "send";
    try {
      await saveNote(
        { response_id: card.response.id, block_index: blockIndex, quote: truncate(quote, MAX_QUOTE_CHARS), body: textarea.value },
        sendNow,
      );
      closeEditor();
    } catch (error) {
      save.disabled = false;
      updateSendControls(send, hint);
      showError(error);
    }
  });

  editor = { form, textarea, card, send, hint };
  layoutNotes(card);
  textarea.focus({ preventScroll: true });
  form.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function closeEditor(): void {
  if (!editor) return;
  const { form, card } = editor;
  editor = null;
  form.remove();
  layoutNotes(card);
}

// ---- The thread pane -----------------------------------------------------------

function openThread(noteId: number): void {
  const note = noteById(noteId);
  if (!note) return;
  const rootId = note.parent_id ?? note.id;
  if (rootId !== openThreadId) {
    // Don't throw away a half-written reply in another thread.
    if (composerText.value.trim() && openThreadId !== null) {
      composerText.focus();
      return;
    }
    composerText.value = "";
  }
  openThreadId = rootId;
  app.classList.add("split");
  newReplyButton.hidden = true;
  history.replaceState(null, "", `${location.pathname}${location.search}#n${rootId}`);
  renderPane();
  markSelectedNotes();
  revealNote(rootId);
}

function closeThread(force = false): void {
  if (!force && composerText.value.trim()) {
    composerText.focus();
    return;
  }
  const previous = openThreadId;
  openThreadId = null;
  composerText.value = "";
  app.classList.remove("split");
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  markSelectedNotes();
  if (previous !== null) revealNote(previous);
}

function markSelectedNotes(): void {
  for (const element of feedInner.querySelectorAll<HTMLElement>(".mnote, .answered-link")) {
    element.classList.toggle("selected", Number(element.dataset["rootId"]) === openThreadId);
  }
}

function revealNote(rootId: number): void {
  feedInner.querySelector(`.mnote[data-root-id="${rootId}"]`)?.scrollIntoView({ block: "nearest" });
}

function renderPane(): void {
  const root = noteById(openThreadId);
  const response = responseById(root?.response_id);
  if (!root || !response) {
    closeThread(true);
    return;
  }

  const showInFeed = button("link-button", "Show in feed", () => showBlock(root.response_id, root.block_index));
  paneMeta.replaceChildren(...createMeta(response).childNodes, showInFeed);

  const quote = el("blockquote", root.quote ? "pane-quote" : "pane-quote whole", root.quote || "On the whole reply");
  paneQuote.replaceChildren(quote);

  const entries = [root, ...state.comments.filter((c) => c.parent_id === root.id)].sort(
    (a, b) => a.created_at - b.created_at,
  );
  const timeline: HTMLElement[] = [];
  entries.forEach((note, index) => {
    timeline.push(createEntry(note));
    const next = entries[index + 1];
    // One reply from Claude can answer several notes in a row; show it once, after the last.
    if (isAnswered(note) && next?.answered_by !== note.answered_by) {
      const group = entries.filter((c) => c.answered_by === note.answered_by);
      timeline.push(createAnswer(note.answered_by, group));
    } else if (note.delivered_at !== null && note.answered_by === null && !next) {
      timeline.push(el("div", "waiting", "Sent. Claude's reply will appear here."));
    }
  });
  paneTimeline.replaceChildren(...timeline);
  updateComposerControls();
}

function createEntry(note: Note): HTMLElement {
  const delivered = note.delivered_at !== null;
  const element = el("div", delivered ? "entry delivered" : "entry pending");
  element.dataset["commentId"] = String(note.id);

  const head = el("div", "entry-head");
  const status = tag(
    delivered ? "delivered" : "pending",
    note.delivered_at !== null ? `Sent ${formatTime(note.delivered_at)}` : isQueued(note) ? "Sending…" : "Pending",
  );
  head.append(el("b", "", note.parent_id === null ? "Your note" : "Your follow-up"), status);
  if (!delivered) {
    head.append(button("link-button", "Delete", () => void deleteNote(note.id, note.parent_id === null)));
  }
  element.append(head, el("div", "entry-body", note.body));
  return element;
}

function answerTextFor(note: Note): string {
  if (!isAnswered(note)) return "";
  return responseById(note.answered_by)?.note_answers[String(note.id)] ?? "";
}

// Claude's answer to a group of notes: the sections it wrote for them, or, when it wrote
// no marked sections, a link to the reply in the feed rather than a copy of it.
function createAnswer(responseId: number, group: Note[]): HTMLElement {
  const element = el("div", "answer");
  const head = el("div", "entry-head");
  head.append(el("b", "", "Claude"));
  element.append(head);

  const response = responseById(responseId);
  if (!response) {
    head.append("answered in a reply that is no longer stored");
    return element;
  }
  head.append(el("span", "", formatTime(response.created_at)));

  const texts = [...new Set(group.map(answerTextFor).filter(Boolean))];
  if (!texts.length) {
    element.classList.add("linked-answer");
    element.append(button("link-button", "Answered in the reply in the feed →", () => showBlock(responseId, -1)));
    return element;
  }
  for (const text of texts) {
    const body = el("div", "markdown");
    body.innerHTML = renderMarkdown(text);
    element.append(body);
  }
  return element;
}

function showBlock(responseId: number, blockIndex: number): void {
  const card = cards.get(responseId);
  if (!card) return;
  const target = card.blocks[blockIndex] ?? card.element;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  flash(target);
}

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!composerText.value.trim() || openThreadId === null) return;
  const buttons = composer.querySelectorAll<HTMLButtonElement>("button[type=submit]");
  for (const submit of buttons) submit.disabled = true;
  try {
    const sendNow = (event.submitter as HTMLButtonElement | null)?.value === "send";
    await saveNote({ parent_id: openThreadId, body: composerText.value }, sendNow);
    composerText.value = "";
  } catch (error) {
    showError(error);
  } finally {
    for (const submit of buttons) submit.disabled = false;
    updateComposerControls();
  }
});

composerText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    composer.requestSubmit(defaultSubmitter(composer));
  }
  if (event.key === "Escape") composerText.blur();
});

byId("pane-close").addEventListener("click", () => closeThread());

// ---- Sending ---------------------------------------------------------------------

sendNowButton.addEventListener("click", async () => {
  sendNowButton.disabled = true;
  try {
    if (sessionId) await api.send({ session_ids: [sessionId] });
    await refresh();
  } catch (error) {
    showError(error);
  }
});

/** Saves a note; with sendNow, also asks this session's Claude to answer right away. */
async function saveNote(note: NewNoteRequest, sendNow: boolean): Promise<void> {
  await api.addNote(note);
  if (sendNow && sessionId) await api.send({ session_ids: [sessionId] });
  await refresh();
}

function sendState(): { status: SessionState; send_requested: boolean } {
  return state.session ?? { status: "offline", send_requested: false };
}

function canSend(): boolean {
  return sendState().status !== "offline";
}

/** ⌘↵ sends now when the session can take it, otherwise saves. */
function defaultSubmitter(form: HTMLFormElement): HTMLButtonElement | null {
  const send = form.querySelector<HTMLButtonElement>("button[value=send]");
  return send && !send.disabled ? send : form.querySelector<HTMLButtonElement>("button[value=save]");
}

const SEND_HINTS: Record<SessionState, string> = {
  listening: "⌘↵ send now · Save keeps it for your next prompt",
  busy: "Claude is working: Send now goes as soon as it finishes",
  offline: "Session not listening: saved notes go with your next prompt there",
};

function updateSendControls(sendButton: HTMLButtonElement, hint: HTMLElement): void {
  const { status } = sendState();
  sendButton.disabled = status === "offline";
  sendButton.title =
    status === "offline"
      ? "This Claude session isn't listening (it may be closed, or hasn't finished a turn since sidenote started)"
      : "";
  hint.textContent = SEND_HINTS[status];
}

function updateComposerControls(): void {
  const send = composer.querySelector<HTMLButtonElement>("button[value=send]");
  const hint = composer.querySelector<HTMLElement>(".editor-hint");
  if (send && hint) updateSendControls(send, hint);
}

function pendingCount(): number {
  return state.comments.filter((note) => note.delivered_at === null).length;
}

function isQueued(note: Note): boolean {
  return note.delivered_at === null && sendState().send_requested;
}

function renderPendingSummary(): void {
  const pending = pendingCount();
  const { send_requested: queued, status } = sendState();
  pendingSummary.hidden = pending === 0;
  pendingSummary.textContent = queued ? `${pending} sending…` : `${pending} pending`;
  pendingSummary.title =
    (status === "offline" ? "This session isn't listening; these go with your next prompt there. " : "") +
    "Click to jump to the first one.";

  sendNowButton.hidden = pending === 0 || !canSend() || queued;
  sendNowButton.disabled = false;
  sendNowButton.title =
    status === "busy"
      ? "Claude is working: your notes go as soon as it finishes"
      : "Send pending notes to Claude now, without typing in the terminal";
  if (editor) updateSendControls(editor.send, editor.hint);
  if (openThreadId !== null) updateComposerControls();
}

/** Top left: the session's /rename name, or its folder; then folder and short id. */
function renderSessionTitle(): void {
  const { session } = state;
  if (!sessionId) {
    sessionTitle.hidden = true;
    emptyTitle.textContent = "Open this window from a Claude Code session";
    emptyIntro.textContent = "Each session has its own sidenote window. Run /sidenote:open in the session you want to see.";
    emptyHelp.hidden = true;
    return;
  }
  const folder = session ? projectName(session.cwd) : "";
  const shortId = sessionId.slice(0, 8);
  const name = session?.name || folder || `Session ${shortId}`;
  sessionTitle.hidden = false;
  sessionName.textContent = name;
  sessionDetail.textContent = session?.name && folder ? `${folder} · ${shortId}` : shortId;
  sessionTitle.title = `Session ${sessionId}${session?.cwd ? `\n${session.cwd}` : ""}`;
  document.title = `${name} · sidenote`;
}

pendingSummary.addEventListener("click", () => {
  const first = state.comments.find((c) => c.delivered_at === null);
  if (!first) return;
  const note = feedInner.querySelector<HTMLElement>(`.mnote[data-root-id="${first.parent_id ?? first.id}"]`);
  if (!note || note.offsetParent === null) return;
  note.scrollIntoView({ block: "center", behavior: "smooth" });
  flash(note);
});

// ---- Adding notes: "+" beside a paragraph, or selecting text ------------------------

const blockButton = button("block-comment", "+");
blockButton.title = "Add a sidenote on this paragraph";
blockButton.hidden = true;
document.body.append(blockButton);
let hoveredBlock: HTMLElement | null = null;

feedInner.addEventListener("mouseover", (event) => {
  const target = event.target as Element;
  const block = target.closest<HTMLElement>(".block");
  if (!block || target.closest(".margin-thread")) return;
  hoveredBlock = block;
  const rect = block.getBoundingClientRect();
  blockButton.style.top = `${rect.top}px`;
  blockButton.style.left = `${rect.left - 30}px`;
  blockButton.hidden = false;
});
feedInner.addEventListener("mouseleave", (event) => {
  if (event.relatedTarget !== blockButton) blockButton.hidden = true;
});

blockButton.addEventListener("click", () => {
  if (hoveredBlock) commentOnBlock(hoveredBlock, hoveredBlock.innerText.trim());
});

function commentOnBlock(block: HTMLElement, quote: string): void {
  const card = cards.get(Number(block.closest<HTMLElement>(".card")?.dataset["responseId"]));
  if (card) startNote(card, Number(block.dataset["blockIndex"]), quote);
}

let selectionTarget: { block: HTMLElement; text: string } | null = null;

document.addEventListener("mouseup", () => {
  setTimeout(() => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    const anchor = elementOf(selection?.anchorNode ?? null);
    const block = anchor?.closest<HTMLElement>(".block");
    if (!selection || !text || !anchor || !block || anchor.closest(".margin-thread") || !feedInner.contains(block)) {
      selectionButton.hidden = true;
      selectionTarget = null;
      return;
    }
    selectionTarget = { block, text };
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    selectionButton.style.top = `${rect.bottom + 6}px`;
    selectionButton.style.left = `${Math.max(8, rect.right - 60)}px`;
    selectionButton.hidden = false;
  }, 0);
});

// mousedown would otherwise clear the selection before the click lands.
selectionButton.addEventListener("mousedown", (event) => event.preventDefault());
selectionButton.addEventListener("click", () => {
  if (!selectionTarget) return;
  commentOnBlock(selectionTarget.block, selectionTarget.text);
  selectionButton.hidden = true;
  window.getSelection()?.removeAllRanges();
});

// The floating buttons use viewport positions, so any scroll makes them stale.
document.addEventListener(
  "scroll",
  () => {
    blockButton.hidden = true;
    selectionButton.hidden = true;
  },
  { capture: true, passive: true },
);

// ---- Keyboard, feed controls, session filter ---------------------------------------

document.addEventListener("keydown", (event) => {
  if ((event.target as Element | null)?.closest?.("textarea, input, select")) return;
  if (event.key === "Escape" && openThreadId !== null) closeThread();
});

newReplyButton.addEventListener("click", () => {
  newReplyButton.hidden = true;
  const scroller = feedScroller();
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
});

for (const target of [window, feed]) {
  target.addEventListener(
    "scroll",
    () => {
      if (isNearBottom(feedScroller())) newReplyButton.hidden = true;
    },
    { passive: true },
  );
}

function feedScroller(): Element {
  return app.classList.contains("split") && window.innerWidth >= SPLIT_MIN_WIDTH ? feed : document.scrollingElement!;
}

function isNearBottom(scroller: Element): boolean {
  return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 80;
}

function scrollToEnd(scroller: Element): void {
  scroller.scrollTop = scroller.scrollHeight;
}

void pollForever();
