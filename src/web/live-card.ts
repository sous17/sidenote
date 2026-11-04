// The card at the end of the feed while Claude works: its latest message, the dots and what it is
// doing, and the turn's earlier messages on request. It goes when the reply lands, so nothing
// stays on the page twice. Messages are plain text: they can stop mid-sentence, so markdown would
// look broken, and they aren't stored, so notes can't attach to them.
import type { Model } from "../shared/model.ts";
import { button, el } from "./dom.ts";

export class LiveCard {
  readonly element = el("div", "live");
  readonly #model: Model;
  readonly #earlier = el("div", "live-earlier");
  readonly #latest = el("div", "live-latest");
  readonly #activity = el("div", "typing-activity");
  readonly #toggle = button("link-button live-toggle", "", () => this.#setOpen(!this.#open));
  #open = false;
  #shown = "";

  constructor(model: Model) {
    this.#model = model;
    const typing = el("div", "typing");
    typing.setAttribute("role", "status");
    typing.setAttribute("aria-label", "Claude is working");
    typing.append(el("span"), el("span"), el("span"), this.#activity, this.#toggle);
    this.element.append(this.#earlier, this.#latest, typing);
    this.element.hidden = true;
  }

  /** Brings the card in line with the model. Returns whether its text changed. */
  render(): boolean {
    const progress = this.#model.progress();
    const earlier = progress.slice(0, -1);
    const latest = progress.at(-1) ?? "";
    this.element.hidden = !this.#model.awaitingReply();
    this.element.classList.toggle("has-text", latest !== "");
    if (this.element.hidden || !earlier.length) this.#open = false;

    this.#activity.textContent = this.#model.activity();
    this.#activity.hidden = !this.#activity.textContent;
    this.#latest.textContent = latest;
    this.#latest.hidden = !latest;
    this.#earlier.replaceChildren(...earlier.map((text) => el("p", "", text)));
    this.#toggle.hidden = !earlier.length;
    this.#showOpenState(earlier.length);

    const shown = progress.join("\n");
    const changed = shown !== this.#shown;
    this.#shown = shown;
    return changed;
  }

  #setOpen(open: boolean): void {
    this.#open = open;
    this.#showOpenState(this.#model.progress().length - 1);
  }

  #showOpenState(earlier: number): void {
    this.element.classList.toggle("open", this.#open);
    this.#earlier.hidden = !this.#open;
    this.#toggle.textContent = this.#open ? "⌃ hide earlier" : `⌄ ${earlier} earlier`;
    this.#toggle.setAttribute("aria-expanded", String(this.#open));
  }
}
