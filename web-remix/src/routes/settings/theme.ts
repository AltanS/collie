// The theme pin, without React: web/src/hooks/use-theme.ts with its hook swapped for a store.
//
// Same key (`collie:theme:v1`), same BARE string value (public/theme-init.js compares it before first
// paint), same `light`/`dark` class on <html>, same theme-color rewrite. "System" removes the key.
import { createStore } from "../../lib/store";

export type Theme = "system" | "light" | "dark";
type Resolved = "light" | "dark";

const STORAGE_KEY = "collie:theme:v1";
/** --background's two halves rasterized, as web/ writes them into <meta name=theme-color>. */
const META_COLOR = { light: "#f5f5f5", dark: "#0a0a0a" } satisfies Record<Resolved, string>;

function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
  } catch {
    return "system";
  }
}

function saveTheme(theme: Theme): void {
  try {
    if (theme === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // the choice still applies for this session
  }
}

function prefersDark(): boolean {
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

function apply(theme: Theme): void {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  if (theme !== "system") root.classList.add(theme);
  const resolved: Resolved = theme === "system" ? (prefersDark() ? "dark" : "light") : theme;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const own: Resolved = meta.getAttribute("media")?.includes("dark") ? "dark" : "light";
    meta.content = META_COLOR[theme === "system" ? own : resolved];
  }
}

export const theme = createStore<Theme>(loadTheme());

export function setTheme(next: Theme): void {
  saveTheme(next);
  apply(next);
  theme.set(next);
}
