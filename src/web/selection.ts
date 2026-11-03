// Two ways to start a note: the "+" beside a hovered paragraph, and a button under selected text.
import { button, elementOf } from "./dom.ts";

export function installNoteStarters(options: {
  feed: HTMLElement;
  selectionButton: HTMLButtonElement;
  /** Starts a note on a block of a reply, quoting the given text. */
  startNote: (block: HTMLElement, quote: string) => void;
}): void {
  const { feed, selectionButton, startNote } = options;

  const blockButton = button("block-comment", "+");
  blockButton.title = "Add a sidenote on this paragraph";
  blockButton.hidden = true;
  document.body.append(blockButton);
  let hoveredBlock: HTMLElement | null = null;

  feed.addEventListener("mouseover", (event) => {
    const target = event.target as Element;
    const block = target.closest<HTMLElement>(".block");
    if (!block || target.closest(".margin-thread")) return;
    hoveredBlock = block;
    const rect = block.getBoundingClientRect();
    blockButton.style.top = `${rect.top}px`;
    blockButton.style.left = `${rect.left - 30}px`;
    blockButton.hidden = false;
  });
  feed.addEventListener("mouseleave", (event) => {
    if (event.relatedTarget !== blockButton) blockButton.hidden = true;
  });
  blockButton.addEventListener("click", () => {
    if (hoveredBlock) startNote(hoveredBlock, hoveredBlock.innerText.trim());
  });

  let selected: { block: HTMLElement; text: string } | null = null;
  document.addEventListener("mouseup", () => {
    // Wait for the browser to settle the selection.
    setTimeout(() => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? "";
      const anchor = elementOf(selection?.anchorNode ?? null);
      const block = anchor?.closest<HTMLElement>(".block");
      if (!selection || !text || !block || anchor?.closest(".margin-thread") || !feed.contains(block)) {
        selectionButton.hidden = true;
        selected = null;
        return;
      }
      selected = { block, text };
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      selectionButton.style.top = `${rect.bottom + 6}px`;
      selectionButton.style.left = `${Math.max(8, rect.right - 60)}px`;
      selectionButton.hidden = false;
    }, 0);
  });
  // mousedown would otherwise clear the selection before the click lands.
  selectionButton.addEventListener("mousedown", (event) => event.preventDefault());
  selectionButton.addEventListener("click", () => {
    if (!selected) return;
    startNote(selected.block, selected.text);
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
}
