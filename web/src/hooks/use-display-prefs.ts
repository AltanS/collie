import { useCallback, useState } from "react";

// Terminal mirror display preferences, persisted in localStorage.
// Safe to call in SSR contexts (localStorage guarded throughout).

export interface DisplayPrefs {
  /** Whether the mirror wraps long lines (default: true). */
  wrap: boolean;
  /** Font size in px for the mirror pre (default: 11, range: 9–16). */
  fontSize: number;
  /**
   * Raw-terminal escape hatch (default: false). When on, the mirror renders the PLAIN terminal —
   * every Claude grammar (chrome stripping, native prompt-select buttons, the status strip) is
   * bypassed, so a misdetected/mis-rendered dialog can always be driven manually with the keys pad.
   * The universal fallback, made user-controllable.
   */
  rawTerminal: boolean;
}

const STORAGE_KEY = "collie:display-prefs";
const FONT_MIN = 9;
const FONT_MAX = 16;
const DEFAULTS: DisplayPrefs = { wrap: true, fontSize: 11, rawTerminal: false };

function clampFont(n: number): number {
  return Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));
}

function loadPrefs(): DisplayPrefs {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return DEFAULTS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULTS;
    const p = parsed as Record<string, unknown>;
    return {
      wrap: typeof p.wrap === "boolean" ? p.wrap : DEFAULTS.wrap,
      fontSize: typeof p.fontSize === "number" ? clampFont(p.fontSize) : DEFAULTS.fontSize,
      rawTerminal: typeof p.rawTerminal === "boolean" ? p.rawTerminal : DEFAULTS.rawTerminal,
    };
  } catch {
    return DEFAULTS;
  }
}

function savePrefs(prefs: DisplayPrefs): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    }
  } catch {
    // Ignore quota / SSR write errors.
  }
}

export interface UseDisplayPrefsReturn {
  prefs: DisplayPrefs;
  /** Toggle or explicitly set line-wrap. */
  setWrap: (wrap: boolean) => void;
  /** Set font size, clamped to 9–16. */
  setFontSize: (size: number) => void;
  /** Step font size by delta (positive = larger), clamped to 9–16. */
  stepFontSize: (delta: number) => void;
  /** Toggle or explicitly set the raw-terminal escape hatch. */
  setRawTerminal: (raw: boolean) => void;
}

export function useDisplayPrefs(): UseDisplayPrefsReturn {
  const [prefs, setPrefs] = useState<DisplayPrefs>(loadPrefs);

  const setWrap = useCallback((wrap: boolean) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, wrap };
      savePrefs(next);
      return next;
    });
  }, []);

  const setFontSize = useCallback((size: number) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, fontSize: clampFont(size) };
      savePrefs(next);
      return next;
    });
  }, []);

  const stepFontSize = useCallback((delta: number) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, fontSize: clampFont(p.fontSize + delta) };
      savePrefs(next);
      return next;
    });
  }, []);

  const setRawTerminal = useCallback((rawTerminal: boolean) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, rawTerminal };
      savePrefs(next);
      return next;
    });
  }, []);

  return { prefs, setWrap, setFontSize, stepFontSize, setRawTerminal };
}
