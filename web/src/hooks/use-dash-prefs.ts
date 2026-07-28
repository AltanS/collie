import { useCallback, useState } from "react";

import type { RecentDir } from "@/lib/triage";

// Dashboard layout preferences, persisted in localStorage. Deliberately separate from
// use-display-prefs (which is about the terminal mirror) — these are about the herd list.
// Safe in SSR contexts: every localStorage touch is guarded.

export interface DashPrefs {
  /**
   * Whether the Spaces section is expanded. `null` means "never chosen" — the count threshold
   * decides (see {@link spacesOpenFor}), so a two-space install isn't handed a mystery collapsed
   * header while a forty-space one isn't handed a wall. An explicit choice always wins.
   */
  spacesOpen: boolean | null;
  /**
   * Whether the Shells section of the pane switcher is expanded. `null` = never chosen, so the
   * count decides — a herd with 37 bare shells shouldn't bury the agents you actually switch to.
   */
  shellsOpen: boolean | null;
  /** Whether the Recent section is expanded. Defaults open — it's the recency list itself. */
  recentOpen: boolean;
  /** Which way Recent runs. Attention sections are never affected. */
  recentDir: RecentDir;
}

const STORAGE_KEY = "collie:dash-prefs:v1";

/** Above this many rows, an un-chosen foldable section starts collapsed. */
export const COLLAPSE_THRESHOLD = 8;

const DEFAULTS: DashPrefs = {
  spacesOpen: null,
  shellsOpen: null,
  recentOpen: true,
  recentDir: "newest",
};

/**
 * The effective open state of a count-sensitive section: an explicit choice always wins, otherwise
 * it opens only while it's short enough to be worth showing. Used by Spaces on the dashboard and by
 * Shells in the pane switcher — a two-item list shouldn't greet you as a mystery collapsed header,
 * and a forty-item one shouldn't greet you as a wall.
 */
export function openForCount(pref: boolean | null, count: number): boolean {
  if (pref !== null) return pref;
  return count <= COLLAPSE_THRESHOLD;
}

/**
 * Coerce an untrusted parsed value into {@link DashPrefs}, filling anything missing or wrong-typed
 * from the defaults. Pure + exported so the file-shape handling is unit-tested.
 */
export function coerceDashPrefs(raw: unknown): DashPrefs {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULTS };
  const p = raw as Record<string, unknown>;
  return {
    spacesOpen: typeof p.spacesOpen === "boolean" ? p.spacesOpen : DEFAULTS.spacesOpen,
    shellsOpen: typeof p.shellsOpen === "boolean" ? p.shellsOpen : DEFAULTS.shellsOpen,
    recentOpen: typeof p.recentOpen === "boolean" ? p.recentOpen : DEFAULTS.recentOpen,
    recentDir: p.recentDir === "oldest" || p.recentDir === "newest" ? p.recentDir : DEFAULTS.recentDir,
  };
}

function loadPrefs(): DashPrefs {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { ...DEFAULTS };
    return coerceDashPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULTS };
  }
}

function savePrefs(prefs: DashPrefs): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    }
  } catch {
    // Ignore quota / SSR write errors — a lost layout preference is not worth a broken render.
  }
}

export interface UseDashPrefsReturn {
  prefs: DashPrefs;
  setSpacesOpen: (open: boolean) => void;
  setShellsOpen: (open: boolean) => void;
  setRecentOpen: (open: boolean) => void;
  setRecentDir: (dir: RecentDir) => void;
}

export function useDashPrefs(): UseDashPrefsReturn {
  const [prefs, setPrefs] = useState<DashPrefs>(loadPrefs);

  const update = useCallback((patch: Partial<DashPrefs>) => {
    setPrefs((p) => {
      const next: DashPrefs = { ...p, ...patch };
      savePrefs(next);
      return next;
    });
  }, []);

  const setSpacesOpen = useCallback((spacesOpen: boolean) => update({ spacesOpen }), [update]);
  const setShellsOpen = useCallback((shellsOpen: boolean) => update({ shellsOpen }), [update]);
  const setRecentOpen = useCallback((recentOpen: boolean) => update({ recentOpen }), [update]);
  const setRecentDir = useCallback((recentDir: RecentDir) => update({ recentDir }), [update]);

  return { prefs, setSpacesOpen, setShellsOpen, setRecentOpen, setRecentDir };
}
