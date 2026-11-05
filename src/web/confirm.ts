// A question over the page, for a step that stops or deletes something. It stays open until the
// step is done, so an error shows where it was asked. Cancel comes first, so it holds the focus and
// Enter on an opened dialog never does the step.
import { button, el } from "./dom.ts";

export interface Question {
  title: string;
  text: string;
  /** The label of the button that does it. */
  action: string;
  danger?: boolean;
}

export function confirmAction(question: Question, work: () => Promise<void>): void {
  const dialog = el("dialog", "confirm-dialog");
  const body = el("div", "confirm-body");
  const error = el("p", "confirm-error");
  error.hidden = true;
  let busy = false;

  const setBusy = (value: boolean): void => {
    busy = value;
    cancel.disabled = value;
    confirm.disabled = value;
  };
  const run = async (): Promise<void> => {
    setBusy(true);
    error.hidden = true;
    try {
      await work();
      dialog.close();
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : String(failure);
      error.hidden = false;
      setBusy(false);
    }
  };
  const cancel = button("secondary-button", "Cancel", () => dialog.close());
  const confirm = button(question.danger ? "danger-button" : "send-button", question.action, () => void run());

  const actions = el("div", "confirm-actions");
  actions.append(cancel, confirm);
  body.append(el("h2", "", question.title), el("p", "", question.text), error, actions);
  dialog.append(body);

  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  // Only the backdrop is the dialog itself: its contents sit in the body.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && !busy) dialog.close();
  });
  // The page's Escape closes the thread; this one is only for the dialog.
  dialog.addEventListener("keydown", (event) => event.stopPropagation());
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
