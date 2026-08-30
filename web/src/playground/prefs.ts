// Page-wide presentation prefs for the states playground. DEV-ONLY, like everything else here.
//
// WHY A MODULE STORE AND NOT STATE IN PlaygroundApp: three readers sit in three different trees —
// the root wrapper (applies the style), the sidebar Controls (offers the knobs), and the typeface
// card (whose switcher is the same choice with commentary attached). Threading props through
// BrandSection to reach the card is exactly the ceremony the harness's other global (the connection
// clock) already declined; same pattern here. Nothing persists: a dev page should open in the app's
// real dress every time, so the comparison always starts from truth.
//
// WHAT "APPLIED THROUGHOUT" MEANS. The chosen face lands on the playground root twice — as an
// inherited `font-family` for everything that just inherits (which is most text), and as a
// `--font-sans` override for anything that re-asserts the token. `font-mono` surfaces (the mirror,
// key caps) name their own family and are deliberately untouched. The accent overrides `--primary`/
// `--primary-foreground` the same way; every `bg-primary` button on the page resolves the token at
// its own element, so the override cascades to all of them without touching a component.

import { useSyncExternalStore } from "react";
import type { CSSProperties } from "react";

/** The stack each choice puts on the page. The three real webfonts keep their metric-matched
 *  fallbacks, so what you see for them is what the app renders — including on the very first paint.
 *  The four techno candidates after Geist have no fallback twin, so their first paint is the system
 *  face and the swap shifts layout — a playground-only allowance. */
export const FACES = {
  system: {
    label: "System",
    stack:
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
    note: "Today. The baseline the operator called flat next to the mark.",
  },
  grotesk: {
    label: "Space Grotesk",
    stack: '"Space Grotesk", "Space Grotesk Fallback", ui-sans-serif, system-ui, sans-serif',
    note: "27 KB. Geometric, monotone, cut terminals — the mark's own drawing logic. Lowest x-height of the three: judge it on the 11px label and the counts column.",
  },
  plex: {
    label: "IBM Plex Sans",
    stack: '"IBM Plex Sans", "IBM Plex Sans Fallback", ui-sans-serif, system-ui, sans-serif',
    note: "34 KB. Drawn for an engineering company; the only one whose figures are tabular by default. Humanist, not geometric — warmer than the mark.",
  },
  geist: {
    label: "Geist",
    stack: '"Geist", "Geist Fallback", ui-sans-serif, system-ui, sans-serif',
    note: "23 KB. Highest x-height and cap height, so the 11px tier holds best. Swiss-neutral — the risk is that it reads as no decision at all.",
  },
  // The four below are dev-only long shots: Google CDN, no metric-matched fallback, so first paint
  // shows the system face and the swap shifts layout. Declared in playground.css, never index.css.
  orbitron: {
    label: "Orbitron",
    stack: '"Orbitron", ui-sans-serif, system-ui, sans-serif',
    note: "Geometric square techno face, variable 400–700 here. CDN-loaded with no fallback twin, so the swap shifts layout — judge the shape, not the timing.",
  },
  audiowide: {
    label: "Audiowide",
    stack: '"Audiowide", ui-sans-serif, system-ui, sans-serif',
    note: "Rounded display face, single 400 weight only — every bold in this specimen is browser faux-bold, which matters because the specimen leans on 500/600.",
  },
  novaRound: {
    label: "Nova Round",
    stack: '"Nova Round", ui-sans-serif, system-ui, sans-serif',
    note: "Rounded, display-leaning, single 400 weight only — the same faux-bold caveat as Audiowide applies wherever the specimen calls for 500/600.",
  },
  aldrich: {
    label: "Aldrich",
    stack: '"Aldrich", ui-sans-serif, system-ui, sans-serif',
    note: "Squared industrial sans, single 400 weight only — every bold you see here is the browser faking it, not the font drawing it.",
  },
} as const;

export type FaceId = keyof typeof FACES;

// SAFETY: `FACES` is a closed `as const` object literal declared above, so its own keys ARE the
// FaceId union — `Object.keys` just loses that at the type level.
const faceIds = Object.keys(FACES) as FaceId[];

export const FACE_OPTIONS = faceIds.map((value) => ({
  value,
  label: FACES[value].label,
}));

/** The accent presets. `default` overrides nothing, so the app's own light-dark(--primary) pair
 *  stays in charge — that asymmetry is why `primary` is nullable rather than restating the token. */
export const ACCENTS = {
  default: { label: "Default", primary: null, fg: null },
  blue: { label: "Blue", primary: "oklch(0.55 0.18 250)", fg: "oklch(0.985 0 0)" },
  violet: { label: "Violet", primary: "oklch(0.55 0.21 300)", fg: "oklch(0.985 0 0)" },
  green: { label: "Green", primary: "oklch(0.58 0.15 155)", fg: "oklch(0.985 0 0)" },
  amber: { label: "Amber", primary: "oklch(0.75 0.15 75)", fg: "oklch(0.205 0 0)" },
  red: { label: "Red", primary: "oklch(0.55 0.2 25)", fg: "oklch(0.985 0 0)" },
} as const;

export type AccentId = keyof typeof ACCENTS;

// SAFETY: `ACCENTS` is a closed `as const` object literal declared above, so its own keys ARE the
// AccentId union — `Object.keys` just loses that at the type level.
const accentIds = Object.keys(ACCENTS) as AccentId[];

export const ACCENT_IDS: readonly AccentId[] = accentIds;

let face: FaceId = "system";
let accent: AccentId = "default";
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setFace(next: FaceId): void {
  face = next;
  emit();
}

export function setAccent(next: AccentId): void {
  accent = next;
  emit();
}

export function useFace(): FaceId {
  return useSyncExternalStore(subscribe, () => face);
}

export function useAccent(): AccentId {
  return useSyncExternalStore(subscribe, () => accent);
}

/** CSSProperties plus the three custom properties the root override sets — typed as an
 *  intersection so no cast is needed where the object is built. */
type PrefStyle = CSSProperties &
  Partial<Record<"--font-sans" | "--primary" | "--primary-foreground", string>>;

/** The style the playground root wears. See the header for why the face lands twice. */
export function prefStyle(faceId: FaceId, accentId: AccentId): CSSProperties {
  const stack = FACES[faceId].stack;
  const style: PrefStyle = { fontFamily: stack, "--font-sans": stack };
  const a = ACCENTS[accentId];
  if (a.primary !== null) {
    style["--primary"] = a.primary;
    style["--primary-foreground"] = a.fg;
  }
  return style;
}
