import { useSyncExternalStore } from "react";

import { asJsonObject, asJsonString, parseJsonObject, type JsonValue } from "@/lib/json";
import { OPERATOR_FONT_PREFIX, type OperatorFontFace } from "@/lib/operator-fonts";

// The device's own look — today one field, `font`, and the shape is an OBJECT on purpose.
//
// WHY AN OBJECT FOR ONE FIELD. This is the seed of theming: an accent colour, a density, a corner
// radius are all the same kind of decision and all belong in the same key. A bare string here would
// mean a second localStorage key per idea, a second pre-paint read in theme-init.js, and a second
// migration when the first one grew a sibling. One key that already parses as a record costs
// nothing today and is the difference between adding a field and adding a store.
//
// THE FACE IS A CLASS, NOT A PROPERTY. Nothing in this file knows what Space Grotesk's fallback
// stack is, or Aldrich's, or the system one — index.css owns all three under `:root.font-*`, and
// this module only ever swaps which class is on <html>. That is what keeps the pre-paint script
// (public/theme-init.js, which cannot import anything) and the app agreeing about the same values:
// they agree on a KEY NAME and a CLASS NAME, and neither carries a font list. `design.test.ts`
// reads both files and fails when they drift.
//
// STORE SHAPE is lib/zen.ts / lib/haptics.ts: module state, a listener set, and a
// useSyncExternalStore hook — no context, no provider, no prop drilling to a settings card.

const STORAGE_KEY = "collie:design:v1";

/**
 * The shipped faces, and the only strings that may ever become a class name.
 *
 * A CLOSED LIST, checked on both the pre-paint path and this one. The stored value is attacker-
 * adjacent in exactly one narrow sense — it is a string from localStorage that is about to be
 * concatenated into `classList.add()` — and a closed list is the answer that cannot be got wrong,
 * where a sanitiser is one someone has to keep right.
 *
 * `aldrich` is the DEFAULT and adds no class at all: no class means the `--font-sans` already in
 * index.css's @theme block, which is the stack index.html preloads. A device that never opens the
 * setting runs no JavaScript before its first paint.
 */
export const SHIPPED_FONTS = ["system", "grotesk", "aldrich"] as const;

export type ShippedFont = (typeof SHIPPED_FONTS)[number];

/** The face a device gets before it says otherwise. */
export const DEFAULT_FONT: ShippedFont = "aldrich";

export interface DesignPrefs {
  /** A {@link ShippedFont}, or `op:<basename>`. Never validated by its type — always by a predicate. */
  font: string;
  /**
   * The accepted face behind an `op:` choice, mirrored here at the moment it is chosen.
   *
   * WHY STORE IT AT ALL, when /api/config carries the same row. Because /api/config has not answered
   * yet on a cold load, and it may never answer offline. Without this mirror, every cold start on an
   * operator face would paint in the default and swap once the config landed — a visible change of
   * voice on every launch. With it, the `@font-face` is injected from the first frame and the swap
   * happens ONCE, when the reader picks the face, and never again.
   *
   * It is a CACHE, never the authority: when /api/config does answer, the server's rows replace this
   * wholesale, including by removing a face the operator has deleted.
   */
  operatorFont?: OperatorFontFace;
}

const DEFAULT_PREFS: DesignPrefs = { font: DEFAULT_FONT };

let prefs: DesignPrefs = load();
const listeners = new Set<() => void>();

/** True for a shipped key. Total over any string, which is the whole reason it exists. */
export function isShippedFont(value: string): value is ShippedFont {
  return SHIPPED_FONTS.some((font) => font === value);
}

/** True for a value the select may hold: a shipped key, or a namespaced operator basename. */
export function isDesignFont(value: string): boolean {
  return isShippedFont(value) || value.startsWith(OPERATOR_FONT_PREFIX);
}

/**
 * The class `<html>` should carry for `font`, or `""` for the default (which wears none).
 *
 * The one place a stored string turns into a class name, and it can only ever return one of four
 * literals spelled right here. public/theme-init.js holds the pre-paint twin of this function —
 * minus the operator branch, which has no pre-paint path by design.
 */
export function fontClass(font: string): string {
  if (font === "system") return "font-system";
  if (font === "grotesk") return "font-grotesk";
  if (font.startsWith(OPERATOR_FONT_PREFIX)) return "font-operator";
  return "";
}

const FONT_CLASSES = ["font-system", "font-grotesk", "font-operator"] as const;

function load(): DesignPrefs {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_PREFS;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_PREFS;
    return parseDesignPrefs(raw);
  } catch {
    return DEFAULT_PREFS; // private mode / SSR
  }
}

/**
 * Read a stored blob into prefs, keeping the default for anything that fails to convince.
 *
 * Exported for the coupling test, and total: a truncated write, a blob from a future version with
 * fields this build has never heard of, and a hand-edited string all resolve to something usable.
 * A stale `font` key — a face the operator has since deleted — is DELIBERATELY kept: index.css's
 * `var()` fallback renders the default shipped stack for it, and a preference the app can honour
 * again tomorrow must not be thrown away today.
 */
export function parseDesignPrefs(raw: string): DesignPrefs {
  // lib/json is the app's parse boundary for exactly this shape of input: it turns a string into a
  // JsonObject or into `undefined`, with no assertion and no `any` anywhere in the middle. Every
  // field below then comes back through an `asJson*` reader, so a number where a string was
  // expected is `undefined` rather than a value this module has to remember to distrust.
  const doc = parseJsonObject(raw);
  if (doc === undefined) return DEFAULT_PREFS;
  const stored = asJsonString(doc.font);
  const font = stored !== undefined && isDesignFont(stored) ? stored : DEFAULT_FONT;
  const next: DesignPrefs = { font };
  const face = readOperatorFace(doc.operatorFont);
  if (face !== undefined) next.operatorFont = face;
  return next;
}

/** The mirrored face, or `undefined` for anything that fails to convince. Same readers, one level in. */
function readOperatorFace(value: JsonValue | undefined): OperatorFontFace | undefined {
  const row = asJsonObject(value);
  if (row === undefined) return undefined;
  const family = asJsonString(row.family);
  const basename = asJsonString(row.basename);
  if (family === undefined || basename === undefined) return undefined;
  const face: OperatorFontFace = { family, basename };
  const weight = asJsonString(row.weight);
  // Assigned, never spread: a face with no weight must carry NO key, matching the wire row.
  if (weight !== undefined) face.weight = weight;
  return face;
}

function persist(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore quota / SSR write errors — the in-memory value still applies for this session.
  }
}

/**
 * Put the right class on `<html>` and take every other one off.
 *
 * Idempotent, and safe to call before or after the pre-paint script has already done it: at store
 * init this RECONCILES rather than applies, which matters because theme-init.js deliberately knows
 * nothing about operator faces and will have left the element bare for one.
 */
export function applyFontClass(font: string): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const wanted = fontClass(font);
  for (const name of FONT_CLASSES) {
    if (name !== wanted) root.classList.remove(name);
  }
  if (wanted !== "") root.classList.add(wanted);
}

export function designPrefs(): DesignPrefs {
  return prefs;
}

/**
 * Choose a face. `face` is the accepted operator row when `font` is an `op:` value, and is what
 * gets mirrored into storage for the next cold load (see {@link DesignPrefs.operatorFont}).
 */
export function setDesignFont(font: string, face?: OperatorFontFace): void {
  if (!isDesignFont(font)) return;
  const next: DesignPrefs = { font };
  if (face !== undefined) next.operatorFont = face;
  // A shipped choice drops the mirror: keeping a face nobody is using would leave the next cold load
  // injecting an `@font-face` for a font it does not render.
  prefs = next;
  persist();
  applyFontClass(prefs.font);
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Subscribe to a change of face, for the one consumer that is not a component: the operator-font
 * injector, which has to rewrite `--font-operator-family` when the choice moves onto or off one of
 * its faces. Exported rather than folded into `setDesignFont` because THIS module must not know the
 * operator's face list — that is what would put these two files in an import cycle.
 */
export const subscribeDesign = subscribe;

/** Reactive read for the Typeface card. Module-scoped store, mirroring lib/zen. */
export function useDesignPrefs(): DesignPrefs {
  return useSyncExternalStore(subscribe, designPrefs, () => DEFAULT_PREFS);
}

/**
 * Reconcile the DOM with what was stored, once, at startup (main.tsx).
 *
 * "Reconcile" and not "apply": for a shipped face `public/theme-init.js` has already done this
 * before first paint and this call is a no-op. It earns its place on the operator path, which has no
 * pre-paint step, and on the Safari-private-mode path, where theme-init.js threw and fell through.
 */
export function initDesign(): void {
  applyFontClass(prefs.font);
}

/**
 * Test seam — RE-READS storage, as if the page had just opened.
 *
 * Re-read rather than reset-to-default, and the difference is the whole reason this is useful: the
 * store is a module singleton that loads once at import, so a case that wants "a device that
 * already chose Aldrich" has no other way to say it. After `localStorage.clear()` this still lands
 * on the defaults, which is what every other case wants.
 */
export function __resetDesign(): void {
  prefs = load();
  applyFontClass(prefs.font);
  for (const fn of listeners) fn();
}

/** The storage key, exported so the coupling test can hold theme-init.js to the same string. */
export const DESIGN_STORAGE_KEY = STORAGE_KEY;
