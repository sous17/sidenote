// Text helpers shared by the page and the terminal.

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

export function projectName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? "unknown";
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
