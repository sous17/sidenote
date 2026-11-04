// Starting a new Claude session in this window's folder: the "+" above the session list opens a box
// for its first prompt, and the server opens a terminal running Claude with it.
import { ApiError } from "./api.ts";

export class NewSessionForm {
  readonly #button: HTMLButtonElement;
  readonly #form: HTMLFormElement;
  readonly #prompt: HTMLTextAreaElement;
  readonly #submit: HTMLButtonElement;
  readonly #hint: HTMLElement;
  readonly #start: (prompt: string) => Promise<void>;
  #cwd = "";
  #starting = false;

  constructor(options: {
    button: HTMLButtonElement;
    form: HTMLFormElement;
    prompt: HTMLTextAreaElement;
    cancel: HTMLButtonElement;
    hint: HTMLElement;
    start: (prompt: string) => Promise<void>;
  }) {
    this.#button = options.button;
    this.#form = options.form;
    this.#prompt = options.prompt;
    this.#submit = options.form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    this.#hint = options.hint;
    this.#start = options.start;

    this.#button.addEventListener("click", () => (this.#form.hidden ? this.#open() : this.#close()));
    options.cancel.addEventListener("click", () => this.#close());
    this.#prompt.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.#form.requestSubmit();
      }
    });
    this.#form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#run();
    });
  }

  /** The "+" shows only where the server has a terminal to open, and only for a folder it knows. */
  render(canStart: boolean, cwd: string): void {
    this.#cwd = cwd;
    this.#button.hidden = !canStart || !cwd;
    if (this.#button.hidden) this.#close();
    else if (!this.#starting && !this.#form.hidden && !this.#form.classList.contains("failed")) this.#showHint();
  }

  #open(): void {
    this.#form.hidden = false;
    this.#button.setAttribute("aria-expanded", "true");
    this.#form.classList.remove("failed");
    this.#showHint();
    this.#prompt.focus();
  }

  #close(): void {
    this.#form.hidden = true;
    this.#button.setAttribute("aria-expanded", "false");
  }

  #showHint(): void {
    this.#hint.textContent = `Opens a terminal in ${this.#cwd}, where Claude asks for permissions.`;
  }

  async #run(): Promise<void> {
    if (this.#starting) return;
    this.#starting = true;
    this.#submit.disabled = true;
    this.#form.classList.remove("failed");
    this.#hint.textContent = "Opening a terminal…";
    try {
      await this.#start(this.#prompt.value);
      this.#prompt.value = "";
      this.#close();
    } catch (error) {
      // The prompt stays in the box, so nothing typed is lost.
      this.#form.classList.add("failed");
      this.#hint.textContent = `Not started: ${error instanceof ApiError ? error.message : "sidenote can't be reached"}`;
    } finally {
      this.#starting = false;
      this.#submit.disabled = false;
    }
  }
}
