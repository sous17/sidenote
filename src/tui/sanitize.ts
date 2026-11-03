// Replies are untrusted, and a terminal obeys escape sequences: a reply could retitle the
// window, write to the clipboard (OSC 52), draw fake links or move the cursor over sidenote's own
// controls. Everything shown in the terminal passes through here first, the way the page's
// markdown passes through DOMPurify.

/** C0 controls other than tab and newline, and DEL: shown as their visible Control Pictures. */
const C0_AND_DEL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
/** C1 controls (U+009B is a one-byte CSI) and bidi overrides, which can reorder what is shown. */
const C1_AND_BIDI = /[\u0080-\u009F‪-‮⁦-⁩]/g;

/** Text that is safe to write to a terminal: no escape sequences, only tabs and newlines kept. */
export function terminalSafe(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(C0_AND_DEL, (char) => (char === "\u007F" ? "␡" : String.fromCharCode(0x2400 + char.charCodeAt(0))))
    .replace(C1_AND_BIDI, "");
}
