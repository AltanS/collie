import { useCallback, useSyncExternalStore } from "react";

// App theme preference, persisted in localStorage.
//
// The *visual* switch is pure CSS and none of this hook's business: index.css declares every themed
// token as light-dark(<light>, <dark>), and `color-scheme` picks the half. A System user's theme
// works with JavaScript disabled entirely.
//
// What CSS can't do, and this owns:
//   1. The pin class on <html> — bidirectionally. A stale class MUST come off, or Dark → System
//      leaves `.dark` stamped and the page stays dark until a full reload.
//   2. The theme-color metas, which carry `media` attributes and so follow the OS rather than a pin.
//
// State lives at module scope rather than in component state, so the OS listener survives App.tsx
// unmounting the router for the idle lock — a component-scoped listener would stop tracking the OS
// for as long as the lock holds, and you'd come back to yesterday's appearance. It also means any
// number of readers agree without prop-drilling, which is why the control can live in Settings
// alone without the rest of the app having to be told.

export type Theme = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "collie:theme:v1";
const DEFAULT: Theme = "system";

/** Browser chrome — Android's URL bar and task-switcher card. These are --background's two halves
 *  rasterized: oklch(0.97) is rgb(245,245,245) and oklch(0.145) is rgb(10,10,10). Not #ffffff for
 *  light — the page is a step off white on purpose (index.css), and a pure-white URL bar above it
 *  shows the seam. Re-measure these if --background moves. */
const META_COLOR: Record<ResolvedTheme, string> = { light: "#f5f5f5", dark: "#0a0a0a" };

/** Read the pin. BARE string, not JSON — public/theme-init.js does the same strict compare before
 *  first paint, and JSON.stringify would write `"dark"` with the quotes and silently break it. */
function loadTheme(): Theme {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    return raw === "light" || raw === "dark" || raw === "system" ? raw : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

function saveTheme(theme: Theme): void {
  try {
    if (typeof localStorage === "undefined") return;
    // Absent means system, so un-pinning removes the key rather than storing a sentinel — that way
    // theme-init.js's `getItem` returns null and it does nothing, which is exactly right.
    if (theme === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Ignore quota / private-mode write errors: the theme still applies for this session.
  }
}

function darkMediaQuery(): MediaQueryList | null {
  return typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
}

function prefersDark(): boolean {
  return darkMediaQuery()?.matches ?? false;
}

function apply(theme: Theme, resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  if (theme !== "system") root.classList.add(theme);

  // When pinned, give BOTH metas the pinned colour so whichever one the browser's media query
  // selects is the right answer. On System, hand each back its own value and let the query decide.
  const pinned = theme !== "system";
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    // getAttribute, not `.media` — that reflected property is not implemented everywhere (jsdom
    // among them), and reading it blind throws on the undefined.
    const own: ResolvedTheme = meta.getAttribute("media")?.includes("dark") ? "dark" : "light";
    meta.content = META_COLOR[pinned ? resolved : own];
  });
}

export interface ThemeState {
  /** What the user chose. */
  theme: Theme;
  /** What that actually renders as right now — `system` resolved against the OS. */
  resolved: ResolvedTheme;
}

function computeState(theme: Theme): ThemeState {
  return { theme, resolved: theme === "system" ? (prefersDark() ? "dark" : "light") : theme };
}

// useSyncExternalStore demands a stable snapshot reference, so recompute only on real change.
let state: ThemeState = computeState(loadTheme());
const listeners = new Set<() => void>();

function refresh(theme: Theme): void {
  state = computeState(theme);
  apply(state.theme, state.resolved);
  for (const listener of listeners) listener();
}

// Apply once at module load. theme-init.js already stamped the class for a pinned user before
// paint; this is idempotent for that, and additionally fixes up the metas.
apply(state.theme, state.resolved);

// Follow the OS while on System, so an evening switch lands without a reload. The CSS half handles
// itself — this keeps the JS-derived readouts (the header icon, its aria-label, the metas) honest.
darkMediaQuery()?.addEventListener("change", () => {
  if (state.theme === "system") refresh("system");
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ThemeState {
  return state;
}

export interface UseThemeReturn extends ThemeState {
  setTheme: (theme: Theme) => void;
}

export function useTheme(): UseThemeReturn {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const setTheme = useCallback((theme: Theme) => {
    saveTheme(theme);
    refresh(theme);
  }, []);

  return { ...snapshot, setTheme };
}
