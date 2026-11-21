import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { contrast, parseColour } from "../../src/lib/theme/derive";
import type { Break, R5Rule } from "./r5";

// THE KNOWN BREAKS OF R5, BY CAUSE. A break of the rule is a defect of the product; one that is not fixed yet is waived
// here under its cause, with a reason that starts with `FINDING:`, and its count on each screen and look is held in
// `ceilings.json`. A case fails when a screen breaks more than its ceiling (a new defect) and when it breaks fewer (a
// fixed one: lower the ceiling, so it cannot come back unseen). `bun e2e/themes/ceilings.ts <out-dir>` writes the
// file from a run's results and refuses to raise a count unless it is told `--raise`.
//
// A break belongs to the FIRST waiver whose rule it has and whose `where` takes it, so the order below goes from the
// narrow cause to the broad one. The numbers in a reason are the worst seen when the waiver was written (2026-11-21).

export interface Waiver {
  id: string;
  rule: R5Rule;
  /** Which breaks of the rule are this cause: the break, and the look it was measured in. Absent: every break of the rule. */
  where?: (b: Break, look: string) => boolean;
  reason: `FINDING: ${string}`;
}

const el = (re: RegExp) => (b: Break) => re.test(b.el);
/** A ring's contrast against its other side, the one R5 did not report as the worst (`text: "other side #rrggbb"`). */
const outerSide = (b: Break): number => {
  const other = /other side (#[0-9a-f]{6})/u.exec(b.text ?? "")?.[1];
  return other === undefined ? 0 : contrast(parseColour(b.ink), parseColour(other));
};
const gen = (look: string) => look.startsWith("gen-");
const profile = (look: string, re: RegExp) => gen(look) && re.test(look);

export const WAIVERS: readonly Waiver[] = [
  // ── Text ──
  {
    id: "ink-thinned",
    rule: "text",
    where: (b) => (b.alpha ?? 1) < 0.99,
    reason: "FINDING: an ink thinned on its way to the screen (text-muted-foreground/60 and /70, text-destructive/70, opacity-80 and opacity-60 on a run of text, a parent's opacity) lands under 4.5:1; the token itself passes, the thinning does not. Every bundled look, worst 1.58 (Nightwatch light, the pane row's place words)",
  },
  {
    id: "accent-ink-off-accent",
    rule: "text",
    where: (b, look) => profile(look, /-accent$/u) && b.value < 2,
    reason: "FINDING: the selected sidebar row stands on the paper but keeps accent's ink (`text-accent-foreground`): with a dark accent on a light theme, or the reverse, the row's words vanish (1.04 to 1.18)",
  },
  {
    id: "theme-ink-low",
    rule: "text",
    where: (_b, look) => profile(look, /-(?:low-contrast|mid-grey)$/u),
    reason: "FINDING: the theme's own text tokens are under 4.5:1 on its own grounds (the contrast report warns, the schema takes it): no derivation can save body text, this is the schema question",
  },
  {
    id: "muted-on-recess",
    rule: "text",
    where: el(/crossfade-in|sidebar-|settings-list|space-position|space-title|new-space|column-header|column-width/u),
    reason: "FINDING: muted ink on the recess and the derived planes: muted-foreground is held to 4.5:1 on background and card only, and the light recess is 0.05 darker than the page it was checked on (Nightwatch light 2.74 to 3.67 in the sidebar)",
  },
  {
    id: "belt-pill-ink",
    rule: "text",
    where: el(/data-slot=button\] "(?:Keys|Show the screen)/u),
    reason: "FINDING: the Belt's pills draw muted ink on a filled pill, a ground the token was never checked on (Harbour light 4.18, Nightwatch light 4.29, Harbour dark 4.47)",
  },
  {
    id: "status-ink-on-tint",
    rule: "text",
    where: (b) => /session-stream code|walky|badge/u.test(b.el),
    reason: "FINDING: a status ink as text on its own tint over a tinted ground (inline code's info blue, the WalkyTalky card): the report checks the chip on background and card, not on the plane or a saturated ground",
  },
  {
    id: "filled-collie-ink",
    rule: "text",
    where: (_b, look) => gen(look),
    reason: "FINDING: a theme that sets few tokens gets Collie's own inks for the rest (muted-foreground, the Belt, the chat stream) on its own grounds; fill-from-Collie is not a derivation and fails on any ground Collie did not pick",
  },
  // ── Icons and edges ──
  {
    id: "icon-on-mid-ground",
    rule: "icon",
    reason: "FINDING: generated themes only. The views switch's selected segment draws accent's ink on the paper (1.04 to 1.17 with an accent of the other polarity), and on a mid-grey ground the icon-only controls' fixed inks (status-working, destructive) fall under 3:1",
  },
  {
    id: "field-edge",
    rule: "edge",
    reason: "FINDING: a field's edge is `--border` (or `--input` on a select) against the ground beside it: 1.03 to 2.4:1 in every bundled look, under WCAG 1.4.11's 3:1 for the boundary of a field (the session filter, the dashboard's selects, the trick settings field)",
  },
  // ── The focus ring ──
  {
    id: "ring-on-mark-drawing",
    rule: "ring",
    where: (b) => /sidebar-mark/u.test(b.el) && outerSide(b) >= 3,
    reason: "FINDING: the mark's button is no larger than its drawing, so the house ring's inner side touches the mark's own ink (Collie dark: the white mark, 2.05) while its outer side holds 3:1 on the recess. A pad inside the button would end it; that moves the mark, which waits for Altan's word",
  },
  {
    id: "ring-browser-default",
    rule: "ring",
    where: el(/wide-command-row/u),
    reason: "FINDING: a control with no house ring (`FOCUS_RING`) shows the browser's own two-tone ring, which touches the row's own fill. The pane rows, the palette's rows, the sidebar's mark and its word wear the house ring, whose `--ring` is held at 3:1 on every plane by deriveTokens (ADR 0172)",
  },
  {
    id: "ring-clipped",
    rule: "ring",
    where: el(/no ring shows/u),
    reason: "FINDING: a focused control shows no ring at all: the block-more button's ring is clipped by the chat stream's overflow",
  },
  {
    id: "ring-on-tinted-ground",
    rule: "ring",
    reason: "FINDING: `--ring` is one fixed colour per half, 3:1 only against the page: on the Belt, a filled pill, the primary button (Harbour's teal ring on its teal button 1.46) or a mid-grey ground it falls under 3:1 on one side; more positions under the sticky prompt since the 44 px phone rows (ADR 0171): the message actions ring is no longer cut, and is now read on the mid-grey ground of three generated themes",
  },
  // ── States ──
  {
    id: "hover-muted-on-plane",
    rule: "hover",
    reason: "FINDING: the hover fill is `--muted` at 60% (or `--accent`) laid on a ground it was never measured against: on the recess (`--background` 0.05 darker) and on the band the light half's muted equals the ground, so the hover vanishes (0.003 to 0.03 in OKLab, light looks)",
  },
  {
    id: "selected-fill-close",
    rule: "selected",
    reason: "FINDING: a selected item's fill (`--accent` or `--control-on`) is under 0.06 in OKLab from its neighbour's on this ground (the sidebar's current row on the paper, a segment of the views switch)",
  },
  {
    id: "open-trigger-fill",
    rule: "open",
    reason: "FINDING: an open trigger's `--control-on` fill is under 0.06 in OKLab from the header or the Belt around it, read through the open dialog's scrim (Nightwatch light 0.021, Collie light 0.038): TRIGGER_OPEN's fill is a fixed token, not a step off the ground",
  },
];

export type Ceilings = Record<string, Record<string, number>>;

const CEILINGS_PATH = fileURLToPath(new URL("./ceilings.json", import.meta.url));

export function readCeilings(): Ceilings {
  try {
    // SAFETY: ceilings.json is written only by e2e/themes/ceilings.ts, from a `Ceilings` value.
    return JSON.parse(readFileSync(CEILINGS_PATH, "utf8")) as Ceilings;
  } catch {
    return {};
  }
}

export { CEILINGS_PATH };

/** The waiver a break belongs to, or undefined when no cause is known for it. */
export function waiverOf(b: Break, look: string): Waiver | undefined {
  return WAIVERS.find((w) => w.rule === b.rule && (w.where === undefined || w.where(b, look)));
}

/** How a case's breaks fall into the waivers. */
export interface Tally {
  /** The breaks of each waiver, by its id. */
  counts: Map<string, Break[]>;
  /** The breaks no waiver names. */
  loose: Break[];
}

/** How a case's breaks fall into the waivers: a count per waiver, and the breaks no waiver names. */
export function tally(breaks: readonly Break[], look: string): Tally {
  const counts = new Map<string, Break[]>();
  const loose: Break[] = [];
  for (const b of breaks) {
    const w = waiverOf(b, look);
    if (w === undefined) {
      loose.push(b);
      continue;
    }
    counts.set(w.id, [...(counts.get(w.id) ?? []), b]);
  }
  return { counts, loose };
}
