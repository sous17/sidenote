// Small DOM and text helpers for the page.

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing from index.html`);
  return element as T;
}

/** Creates an element with a class and optional text. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function button(className: string, text: string, onClick?: (event: MouseEvent) => void): HTMLButtonElement {
  const element = el("button", className, text);
  element.type = "button";
  if (onClick) element.addEventListener("click", onClick);
  return element;
}

export function tag(kind: string, text: string): HTMLSpanElement {
  return el("span", `tag ${kind}`, text);
}

export function flash(element: HTMLElement): void {
  element.classList.remove("flash");
  void element.offsetWidth; // restart the animation
  element.classList.add("flash");
}

export function elementOf(node: Node | null): Element | null {
  return node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element | null);
}

/** Rough markdown-to-text for one-line snippets. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/[#>*_`~]|\[([^\]]*)\]\([^)]*\)/g, (_match, linkText?: string) => linkText ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
