// Renders Claude's markdown safely.
//
// Raw HTML in a reply is shown as text, not rendered: a reply is markdown, and HTML in it is
// almost always an example. DOMPurify then cleans what marked produced, as a second line of
// defense, and strips anything that could imitate sidenote's own controls (forms, ids, data-*
// attributes, classes other than code-highlighting ones). The page's CSP blocks scripts either way.
import DOMPurify, { type Config } from "dompurify";
import { Marked } from "marked";
import { renderDiffs } from "./diffview.ts";

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const marked = new Marked({
  async: false,
  gfm: true,
  renderer: {
    html: ({ text }) => escapeHtml(text),
  },
});

const SANITIZE: Config = {
  FORBID_TAGS: [
    "form",
    "input",
    "button",
    "select",
    "option",
    "textarea",
    "label",
    "style",
    "iframe",
    "object",
    "embed",
  ],
  FORBID_ATTR: ["id", "name", "style"],
  ALLOW_DATA_ATTR: false,
};

const KEPT_CLASS = /^language-[\w-]+$/;

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
  if (node.hasAttribute("class")) {
    const kept = [...node.classList].filter((name) => KEPT_CLASS.test(name));
    if (kept.length) node.setAttribute("class", kept.join(" "));
    else node.removeAttribute("class");
  }
});

/** Renders markdown into an element, drawing any ```diff blocks as diffs. */
export function renderMarkdownInto(element: HTMLElement, markdown: string): void {
  element.innerHTML = renderMarkdown(markdown);
  renderDiffs(element);
}

/** Markdown to sanitized HTML, ready for innerHTML. */
export function renderMarkdown(markdown: string): string {
  return DOMPurify.sanitize(marked.parse(markdown) as string, SANITIZE) as string;
}
