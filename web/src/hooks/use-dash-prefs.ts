import { useCallback, useState } from "react";
import { asJsonBoolean, asJsonObject, asJsonString, type JsonValue } from "@/lib/json";

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
  /**
   * Whether the Launch section is expanded. `null` = never chosen, so the count decides, like
   * Spaces: two launchers are worth showing, and an operator who declared thirty should not have
   * their herd pushed off the first screen by a wall of buttons.
   */
  launchOpen: boolean | null;
  /** Which way Recent runs. Attention sections are never affected. */
  recentDir: RecentDir;
  /** The dashboard's workspace filter: the one workspace shown alone, or null for all of them. */
  isolatedSpace: string | null;
  /** Workspaces hidden from the dashboard list (long-press a chip); their chips stay, dimmed. */
  hiddenSpaces: string[];
}

const STORAGE_KEY = "collie:dash-prefs:v1";

/** Above this many rows, an un-chosen foldable section starts collapsed. */
export const COLLAPSE_THRESHOLD = 8;

const DEFAULTS: DashPrefs = {
  spacesOpen: null,
  shellsOpen: null,
  launchOpen: null,
  recentDir: "newest",
  isolatedSpace: null,
  hiddenSpaces: [],
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
export function coerceDashPrefs(raw: JsonValue | undefined): DashPrefs {
  const p = asJsonObject(raw);
  if (!p) return { ...DEFAULTS };
  return {
    spacesOpen: asJsonBoolean(p.spacesOpen) ?? DEFAULTS.spacesOpen,
    shellsOpen: asJsonBoolean(p.shellsOpen) ?? DEFAULTS.shellsOpen,
    launchOpen: asJsonBoolean(p.launchOpen) ?? DEFAULTS.launchOpen,
    // `p.recentOpen` (the fold's own state, from before the Recent section was removed) is read by
    // nothing here — an older version's stored blob still carries the key, and it is simply ignored,
    // the same way any other unknown field in a persisted object would be.
    recentDir: p.recentDir === "oldest" || p.recentDir === "newest" ? p.recentDir : DEFAULTS.recentDir,
    isolatedSpace: asJsonString(p.isolatedSpace) ?? DEFAULTS.isolatedSpace,
    hiddenSpaces: Array.isArray(p.hiddenSpaces)
      ? p.hiddenSpaces.flatMap((k) => {
          const key = asJsonString(k);
          return key === undefined ? [] : [key];
        })
      : [],
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
  setLaunchOpen: (open: boolean) => void;
  setRecentDir: (dir: RecentDir) => void;
  setIsolatedSpace: (key: string | null) => void;
  toggleHiddenSpace: (key: string) => void;
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
  const setLaunchOpen = useCallback((launchOpen: boolean) => update({ launchOpen }), [update]);
  const setRecentDir = useCallback((recentDir: RecentDir) => update({ recentDir }), [update]);

  const setIsolatedSpace = useCallback((isolatedSpace: string | null) => update({ isolatedSpace }), [update]);
  const toggleHiddenSpace = useCallback((key: string) => {
    setPrefs((p) => {
      const hiddenSpaces = p.hiddenSpaces.includes(key)
        ? p.hiddenSpaces.filter((k) => k !== key)
        : [...p.hiddenSpaces, key];
      const next: DashPrefs = { ...p, hiddenSpaces };
      savePrefs(next);
      return next;
    });
  }, []);

  return {
    prefs,
    setSpacesOpen,
    setShellsOpen,
    setLaunchOpen,
    setRecentDir,
    setIsolatedSpace,
    toggleHiddenSpace,
  };
}
