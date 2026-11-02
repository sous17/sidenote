// Loaded without defer, so the chosen theme is on <html> before the page first paints.
type ThemeChoice = "light" | "dark" | "system";

const STORAGE_KEY = "sidenote-theme";
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

let choice: ThemeChoice = "system";
try {
  choice = (localStorage.getItem(STORAGE_KEY) as ThemeChoice | null) ?? "system";
} catch {
  // Storage can be blocked; the page then follows the system setting.
}

function themeButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]")];
}

function apply(): void {
  const dark = choice === "dark" || (choice === "system" && systemDark.matches);
  document.documentElement.dataset["theme"] = dark ? "dark" : "light";
  for (const button of themeButtons()) {
    button.setAttribute("aria-pressed", String(button.dataset["themeChoice"] === choice));
  }
}

systemDark.addEventListener("change", apply);
apply();

document.addEventListener("DOMContentLoaded", () => {
  for (const button of themeButtons()) {
    button.addEventListener("click", () => {
      choice = (button.dataset["themeChoice"] as ThemeChoice | undefined) ?? "system";
      try {
        localStorage.setItem(STORAGE_KEY, choice);
      } catch {
        // Not saved, but still applied for this visit.
      }
      apply();
    });
  }
  apply();
});
