import { useSyncExternalStore } from "react";

import { asJsonString, parseJsonObject } from "@/lib/json";
import { readSourceRef, stamp, type ThemeSourceRef } from "./origin";
import { THEME_MAX_BYTES, parseTheme, type Theme } from "./schema";
import { activeThemeId, applyTheme, initTheme, installTheme, themeEscaped, type AddResult } from "./store";

// Try a theme (M59 spec 08): wear a theme across the whole app, with the session as it is, without
// keeping it. The ribbon (components/theme-trial-ribbon.tsx) is the way out: Keep or Back.
//
// WHAT A TRIAL NEVER DOES. It never writes the library and never writes the active id in the design
// store: `applyTheme` puts the tokens on <html> and nothing else. So a new tab, a crash or a closed
// browser leaves the device exactly as it was. The trial itself lives in `sessionStorage`, which a
// reload of this tab keeps and a new tab does not.
//
// ONE TRIAL AT A TIME. Trying a second theme replaces the first and keeps the id the device wore
// before either, so Back always lands where the person started.
//
// THE THEME IS CHECKED AGAIN, at start and at every read of the stored trial: `parseTheme` with the
// import cap and no shipped id, the same check an import passes. A stored trial that fails is
// dropped, and the device shows its own theme.
//
// Keep is the import's Apply (`installTheme`): the eight-theme cap, the shipped-id rule and the
// duplicate check refuse it the same way, and a refused Keep leaves the trial running.

const TRIAL_KEY = "collie:theme-trial:v1";

export interface Trial {
  theme: Theme;
  /** The id the device wore before the trial, for the record. Back re-applies the stored choice. */
  previous: string;
  /** Where the theme came from, so Keep records it as Apply would (origin.ts). Absent for none. */
  source?: ThemeSourceRef;
}

type Listener = () => void;
const listeners = new Set<Listener>();

function check(theme: Theme): Theme | undefined {
  const parsed = parseTheme(JSON.stringify(theme), { maxBytes: THEME_MAX_BYTES });
  return parsed.ok ? parsed.theme : undefined;
}

function load(): Trial | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(TRIAL_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const doc = parseJsonObject(raw);
  const previous = asJsonString(doc?.previous);
  const text = asJsonString(doc?.theme);
  if (previous === undefined || text === undefined) return drop();
  const parsed = parseTheme(text, { maxBytes: THEME_MAX_BYTES });
  if (!parsed.ok) return drop();
  // A source that fails its check is left out; the trial itself goes on.
  const source = readSourceRef(doc?.source);
  return source === undefined ? { theme: parsed.theme, previous } : { theme: parsed.theme, previous, source };
}

function drop(): null {
  try {
    sessionStorage.removeItem(TRIAL_KEY);
  } catch {
    // Storage that cannot be written cannot hold a stale trial either.
  }
  return null;
}

function save(trial: Trial): void {
  try {
    sessionStorage.setItem(TRIAL_KEY, JSON.stringify({ previous: trial.previous, theme: JSON.stringify(trial.theme), source: trial.source }));
  } catch {
    // A private window that refuses storage still runs the trial for this page.
  }
}

let current: Trial | null = load();

function emit(): void {
  for (const fn of listeners) fn();
}

/** The trial running in this tab, or null. */
export function currentTrial(): Trial | null {
  return current;
}

/** Wear `theme` without keeping it. False when it does not pass the import check. */
export function startTrial(theme: Theme, source?: ThemeSourceRef): boolean {
  const checked = check(theme);
  if (checked === undefined) return false;
  current = { theme: checked, previous: current?.previous ?? activeThemeId() };
  if (source !== undefined) current.source = source;
  save(current);
  applyTheme(checked, "imported");
  emit();
  return true;
}

/** Back: end the trial and put the device's own theme on again. */
export function endTrial(): void {
  if (current === null) return;
  current = null;
  drop();
  initTheme();
  emit();
}

/**
 * Forget the trial without touching the page, for a caller that is about to apply a theme itself
 * (a pick in the Theme card, an Apply, a Remove).
 */
export function dropTrial(): void {
  if (current === null) return;
  current = null;
  drop();
  emit();
}

/** Keep: the import's Apply. On a refusal the trial goes on and the reason comes back. */
export function keepTrial(): AddResult {
  if (current === null) return { ok: false, reason: "invalid" };
  const added = installTheme(current.theme, current.source === undefined ? undefined : stamp(current.source, Date.now()));
  if (!added.ok) return added;
  current = null;
  drop();
  emit();
  return added;
}

/**
 * At startup, after `initTheme`: a reload of this tab puts the running trial back on, unless the page
 * opened with `#theme=collie` (escape.ts), which drops the trial too.
 */
export function resumeTrial(): void {
  if (themeEscaped()) return dropTrial();
  if (current !== null) applyTheme(current.theme, "imported");
}

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Hear every change of the trial. */
export const subscribeTrial = subscribe;

/** The running trial, reactive. */
export function useTrial(): Trial | null {
  return useSyncExternalStore(subscribe, currentTrial, currentTrial);
}

/** Test seam: read the stored trial again, as a fresh page would. */
export function __resetTrial(): void {
  current = load();
  emit();
}
