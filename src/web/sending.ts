// Send now and Save: the top bar's pending count and Send now button, and the send controls in the
// note editor and the thread's reply box.
import type { NewNoteRequest, SessionState } from "../shared/types.ts";
import type { Api } from "./api.ts";
import type { Model } from "./model.ts";

function hintFor(status: SessionState, model: Model): string {
  const agent = model.agentName;
  switch (status) {
    case "listening":
      return "⌘↵ send now · Save keeps it for your next prompt";
    case "busy":
      return `${agent} is working: Send now goes as soon as it finishes`;
    case "offline":
      return model.canWake
        ? "Session not listening: saved notes go with your next prompt there"
        : `Saved notes go with your next prompt to ${agent}`;
  }
}

function offlineTitle(model: Model): string {
  return model.canWake
    ? `This ${model.agentName} session isn't listening: it may be closed, or hasn't finished a reply since sidenote started`
    : `${model.agentName} can't be woken while idle: Send now works while it's working on a prompt`;
}

/** A Send now button and the hint beside it, in an editor or the reply box. */
export interface SendControl {
  send: HTMLButtonElement;
  hint: HTMLElement;
}

export class Sending {
  readonly #model: Model;
  readonly #api: Api;
  readonly #refresh: () => Promise<void>;
  readonly #summary: HTMLButtonElement;
  readonly #sendNow: HTMLButtonElement;
  readonly #controls = new Set<SendControl>();

  constructor(options: {
    model: Model;
    api: Api;
    refresh: () => Promise<void>;
    summary: HTMLButtonElement;
    sendNow: HTMLButtonElement;
    onError: (error: unknown) => void;
  }) {
    this.#model = options.model;
    this.#api = options.api;
    this.#refresh = options.refresh;
    this.#summary = options.summary;
    this.#sendNow = options.sendNow;
    this.#sendNow.addEventListener("click", () => {
      this.#sendNow.disabled = true;
      this.#sendPending().catch(options.onError);
    });
  }

  /** Keeps a control in step with the session's status until the returned function is called. */
  track(control: SendControl): () => void {
    this.#controls.add(control);
    this.#updateControl(control);
    return () => this.#controls.delete(control);
  }

  /** Saves a note; with sendNow, also asks the session's agent to answer right away. */
  async save(note: NewNoteRequest, sendNow: boolean): Promise<void> {
    await this.#api.addNote(note);
    if (sendNow) await this.#api.send(this.#model.sessionId);
    await this.#refresh();
  }

  render(): void {
    const pending = this.#model.pendingCount();
    const { status, send_requested: queued } = this.#model.sendStatus();
    this.#summary.hidden = pending === 0;
    this.#summary.textContent = queued ? `${pending} sending…` : `${pending} pending`;
    this.#summary.title =
      (status === "offline" ? "This session isn't listening; these go with your next prompt there. " : "") +
      "Click to jump to the first one.";

    this.#sendNow.hidden = pending === 0 || queued || status === "offline";
    this.#sendNow.disabled = false;
    this.#sendNow.title =
      status === "busy"
        ? `${this.#model.agentName} is working: your notes go as soon as it finishes`
        : `Send pending notes to ${this.#model.agentName} now, without typing a prompt`;
    for (const control of this.#controls) this.#updateControl(control);
  }

  async #sendPending(): Promise<void> {
    await this.#api.send(this.#model.sessionId);
    await this.#refresh();
  }

  #updateControl({ send, hint }: SendControl): void {
    const { status } = this.#model.sendStatus();
    send.disabled = status === "offline";
    send.title = status === "offline" ? offlineTitle(this.#model) : "";
    hint.textContent = hintFor(status, this.#model);
  }
}

/** ⌘↵ sends now when the session can take it, otherwise saves. */
export function defaultSubmitter(form: HTMLFormElement): HTMLButtonElement | null {
  const send = form.querySelector<HTMLButtonElement>("button[value=send]");
  return send && !send.disabled ? send : form.querySelector<HTMLButtonElement>("button[value=save]");
}

/** Whether a submit came from a Send now button. */
export function isSendNow(event: SubmitEvent): boolean {
  return (event.submitter as HTMLButtonElement | null)?.value === "send";
}

export function submitOnModEnter(field: HTMLTextAreaElement, form: HTMLFormElement): void {
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      form.requestSubmit(defaultSubmitter(form));
    }
  });
}
