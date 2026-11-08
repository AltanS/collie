import { useSyncExternalStore } from "react";

import { designPrefs, setDesignFont, setDesignTheme, type DesignPrefs } from "@/lib/design";
import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "@/lib/json";

import { readOrigin, type ThemeOrigin } from "./origin";
import { THEME_MAX_BYTES, parseTheme, type Theme } from "./schema";
import { initTheme, originOf, putBackImported, library } from "./store";

// Keep this look? (the way back in an installed app). An installed app has no address bar, so
// `#theme=collie` (escape.ts) cannot be typed there. After an imported theme goes on through Apply,
// Install, a trial's Keep or an Update, the theme-proof ribbon asks "Keep this look?" with Keep and
// Back, and counts {@link CONFIRM_SECONDS} down. Nobody taps: Back, by itself, as a screen does after
// a resolution change. A theme that hides the whole app therefore takes itself off.
//
// KEEP WRITES NOTHING NEW. The theme is already kept and worn; Keep only ends the question.
// BACK PUTS THE DEVICE WHERE IT WAS: the theme it wore and the face it used, and after an Update the
// file and origin the slot held before. A theme that was added stays in the library, not worn, so
// Back never deletes anything.
//
// THE RIBBON KEEPS THE TIME. Its tick calls {@link expireLookConfirm}; this module holds no timer, so a
// question nobody draws never acts by itself, and nothing outlives a test.
//
// IT SURVIVES A RELOAD. The question lives in `sessionStorage` with its deadline, so a theme that
// makes the person reload still meets the countdown, and one whose deadline passed during the reload
// goes back at once. `#theme=collie` drops the question with the theme. A shipped theme never asks.

/** How long the ribbon waits for Keep before it goes back by itself. */
export const CONFIRM_SECONDS = 15;

const CONFIRM_KEY = "collie:theme-confirm:v1";

/** What Back restores after an Update: the file and origin the slot held before. */
interface SlotBefore {
  /** The id the slot has now, after the Update. */
  id: string;
  theme: Theme;
  origin?: ThemeOrigin;
}

/** The look before the change, captured by {@link lookBefore} just before it. */
export interface LookBefore {
  /** The theme id the device wore, as the design store holds it (undefined: Collie). */
  theme: string | undefined;
  font: string;
  operatorFont: DesignPrefs["operatorFont"];
  slot?: SlotBefore;
}

export interface LookConfirm {
  before: LookBefore;
  /** When the ribbon goes back by itself, in milliseconds since the epoch. */
  deadline: number;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let current: LookConfirm | null = load();

function emit(): void {
  for (const fn of listeners) fn();
}

/**
 * The look on the device now. Call it BEFORE the change, and pass `slot` for an Update, so Back can
 * put the old file back in its place.
 */
export function lookBefore(slotId?: string): LookBefore {
  const prefs = designPrefs();
  const before: LookBefore = { theme: prefs.theme, font: prefs.font, operatorFont: prefs.operatorFont };
  if (slotId === undefined) return before;
  const theme = library().find((t) => t.id === slotId);
  if (theme === undefined) return before;
  const origin = originOf(slotId);
  before.slot = origin === undefined ? { id: slotId, theme } : { id: slotId, theme, origin };
  return before;
}

/**
 * Ask "Keep this look?" for the imported theme now worn. `newSlotId` is the id the updated slot has
 * now, when `before.slot` is set (an Update may change the id).
 */
export function confirmLook(before: LookBefore, now: number = Date.now(), newSlotId?: string): void {
  const kept: LookBefore = { ...before };
  if (before.slot !== undefined) kept.slot = { ...before.slot, id: newSlotId ?? before.slot.id };
  current = { before: kept, deadline: now + CONFIRM_SECONDS * 1000 };
  save(current);
  emit();
}

/** Keep: end the question. Nothing is written; the theme is already kept and worn. */
export function keepLook(): void {
  if (current === null) return;
  clear();
}

/** Back: put the device's theme, face and (after an Update) slot back as they were. */
export function backLook(): void {
  if (current === null) return;
  const { before } = current;
  clear();
  if (before.slot !== undefined) putBackImported(before.slot.id, before.slot.theme, before.slot.origin);
  setDesignTheme(before.theme ?? "collie");
  if (designPrefs().font !== before.font) setDesignFont(before.font, before.operatorFont);
  initTheme();
}

/** Forget the question without touching the page: `#theme=collie` already put Collie on. */
export function dropLookConfirm(): void {
  if (current === null) return;
  clear();
}

/** At startup, after the theme and the trial: an open question resumes, or goes back if its time ran out. */
export function resumeLookConfirm(escaped: boolean, now: number = Date.now()): void {
  if (current === null) return;
  if (escaped) return dropLookConfirm();
  if (now >= current.deadline) backLook();
}

/** The ribbon's tick: Back, by itself, once the deadline has passed. True when it went back. */
export function expireLookConfirm(now: number = Date.now()): boolean {
  if (current === null || now < current.deadline) return false;
  backLook();
  return true;
}

/** The open question, or null. */
export function currentLookConfirm(): LookConfirm | null {
  return current;
}

function clear(): void {
  current = null;
  drop();
  emit();
}

function save(confirm: LookConfirm): void {
  const { before } = confirm;
  const slot = before.slot === undefined ? undefined : { id: before.slot.id, theme: JSON.stringify(before.slot.theme), origin: before.slot.origin };
  try {
    sessionStorage.setItem(
      CONFIRM_KEY,
      JSON.stringify({ deadline: confirm.deadline, theme: before.theme, font: before.font, slot }),
    );
  } catch {
    // A page that cannot store it still asks, for this page.
  }
}

function drop(): void {
  try {
    sessionStorage.removeItem(CONFIRM_KEY);
  } catch {
    // Nothing stored, nothing to drop.
  }
}

/**
 * The stored question, checked as everything stored is: a deadline that is a number, a font that is
 * a string, and for an Update the old file through `parseTheme` and its origin through `readOrigin`.
 * Anything else drops the question; the device keeps the theme it wears.
 */
function load(): LookConfirm | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(CONFIRM_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const doc = parseJsonObject(raw);
  const deadline = asJsonNumber(doc?.deadline);
  const font = asJsonString(doc?.font);
  if (doc === undefined || deadline === undefined || font === undefined) return forget();
  // The operator face's mirror is not stored here: the design store keeps it while the face is chosen.
  const before: LookBefore = { theme: asJsonString(doc.theme), font, operatorFont: designPrefs().operatorFont };
  const slotDoc = asJsonObject(doc.slot);
  if (slotDoc !== undefined) {
    const id = asJsonString(slotDoc.id);
    const text = asJsonString(slotDoc.theme);
    const parsed = text === undefined ? undefined : parseTheme(text, { maxBytes: THEME_MAX_BYTES });
    if (id === undefined || parsed === undefined || !parsed.ok) return forget();
    const origin = readOrigin(slotDoc.origin);
    before.slot = origin === undefined ? { id, theme: parsed.theme } : { id, theme: parsed.theme, origin };
  }
  return { before, deadline };
}

function forget(): null {
  drop();
  return null;
}

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The open question, reactive. */
export function useLookConfirm(): LookConfirm | null {
  return useSyncExternalStore(subscribe, currentLookConfirm, currentLookConfirm);
}

/** Test seam: read the stored question again, as a fresh page would. */
export function __resetLookConfirm(): void {
  current = load();
  emit();
}
