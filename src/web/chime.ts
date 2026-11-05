// A soft sound when Claude finishes in a window you aren't looking at. It's off until the user turns
// it on, and made here with Web Audio, so there's no file to ship and nothing for the page to fetch.
import { sessionFinished, type SessionActivity } from "../shared/model.ts";

const STORAGE_KEY = "sidenote-chime";
const VOLUME = 0.2;
const ATTACK_SECONDS = 0.012;
/** Two rising notes: frequency in Hz, then when each starts and how long it rings, in seconds. */
const NOTES = [
  [659.25, 0, 0.45],
  [880, 0.14, 0.6],
] as const;

function readOn(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function writeOn(on: boolean): void {
  try {
    if (on) localStorage.setItem(STORAGE_KEY, "on");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Not remembered; the next visit starts with the sound off.
  }
}

/** In another tab, behind another window, or beside the terminal the user is typing in. */
const inBackground = (): boolean => document.hidden || !document.hasFocus();

export class Chime {
  readonly #button: HTMLButtonElement;
  #on = readOn();
  #context: AudioContext | null = null;
  #sessions: readonly SessionActivity[] = [];

  constructor(button: HTMLButtonElement) {
    this.#button = button;
    button.addEventListener("click", () => {
      this.#on = !this.#on;
      writeOn(this.#on);
      this.#show();
      // Hearing it says it works, and a click is what lets a page make sound at all.
      if (this.#on) this.#play();
    });
    // Browsers keep a page silent until the user does something in it, so any click or key will do.
    for (const event of ["pointerdown", "keydown"]) document.addEventListener(event, () => this.#unlock());
    this.#show();
  }

  /** Takes the folder's sessions, and plays once if any of them just finished. */
  update(sessions: readonly SessionActivity[]): void {
    const finished = sessionFinished(this.#sessions, sessions);
    this.#sessions = sessions;
    if (finished && this.#on && inBackground()) this.#play();
  }

  #show(): void {
    this.#button.setAttribute("aria-pressed", String(this.#on));
    this.#button.title = this.#on ? "Sound when Claude finishes: on" : "Sound when Claude finishes: off";
  }

  #unlock(): void {
    if (!this.#on) return;
    this.#context ??= new AudioContext();
    void this.#context.resume();
  }

  #play(): void {
    this.#unlock();
    const context = this.#context;
    if (!context) return;
    const now = context.currentTime + 0.02;
    for (const [frequency, offset, length] of NOTES) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = now + offset;
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(VOLUME, start + ATTACK_SECONDS);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + length + 0.02);
    }
  }
}
