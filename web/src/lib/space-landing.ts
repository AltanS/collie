// THE DASHBOARD, LANDED ON A SPACE (`open_space`, large screen). Where the space page exists (the phone, the
// tablet, Large-screen layout Off) a pane's way to its space is that page. On a large screen the space has no
// page (ADR 0173): the Dashboard IS its overview, one column for each space. So the move goes to the
// Dashboard, and the Dashboard lands on that space: its column in view, the focus on the first row.
//
// The pane view only says WHICH space (`queueSpaceLanding`, before it moves); the Dashboard reads the ask when
// it mounts, finds out what of the device's own choices would hide the space, clears only that, and lands
// (components/space-landing.tsx). This file holds the ask and the decision, with no React and no DOM.

/** How long an ask waits for a Dashboard to take it. A Dashboard that never mounts (the window left the large
 *  screen on the way) must not land on a later, unrelated visit. */
export const SPACE_LANDING_TTL_MS = 10_000;

interface Ask {
  /** The space's group key (`workspaceGroupKey` of a pane in it): machine, session and workspace id. */
  readonly key: string;
  readonly at: number;
}

let ask: Ask | null = null;

/** The space the Dashboard is about to open on: its column is brought into view on arrival. */
export function queueSpaceLanding(key: string): void {
  ask = { key, at: Date.now() };
}

/** The space asked for, or null: none, or one that nobody took in time. Does not spend the ask. */
export function peekSpaceLanding(): string | null {
  if (ask === null) return null;
  if (Date.now() - ask.at > SPACE_LANDING_TTL_MS) {
    ask = null;
    return null;
  }
  return ask.key;
}

/** Spend the ask: the landing happened, or there is nothing to land on. */
export function dropSpaceLanding(): void {
  ask = null;
}

/** What the device stores, or the box holds, that can hide one space from the Dashboard's grid. */
export type LandingClear = "workspaceChoice" | "hiddenSpace" | "hiddenMachine" | "needsYouOnly" | "query";

/** What the Dashboard knows about the space, with the filters as they are drawn now. */
export interface LandingFacts {
  /** The space is a group of the herd. False: it closed on the way, and there is nothing to land on. */
  readonly exists: boolean;
  /** A workspace choice is stored (the select's chosen workspaces) and the space is not among them. */
  readonly choiceExcludes: boolean;
  /** The space is on the device's hidden list, and no workspace choice is set (a choice wins over hide). */
  readonly hiddenSpace: boolean;
  /** The space's machine is left off the Dashboard, and no workspace choice is set. */
  readonly hiddenMachine: boolean;
  /** The needs-you switch is on and none of the space's rows needs you. */
  readonly needsYouHides: boolean;
  /** The filter text is set and none of the space's rows matches it. */
  readonly queryHides: boolean;
  /** The space has a column, or at least one row, on screen now. */
  readonly drawn: boolean;
}

export type LandingStep =
  /** Clear this one thing, then ask again on the next render. */
  | { readonly kind: "clear"; readonly what: LandingClear }
  /** Scroll to the space and focus its first row. */
  | { readonly kind: "land" }
  /** Nothing to land on: spend the ask. */
  | { readonly kind: "none" };

/**
 * The next step, in the order the Dashboard's own filters run (the workspace choice wins over hide, then the
 * machine, then the needs-you switch, then the filter text). One step at a time: each clear is a stored
 * change that draws again, and the next render asks again. The SORT is never one of them.
 */
export function landingStep(facts: LandingFacts): LandingStep {
  if (!facts.exists) return { kind: "none" };
  if (facts.choiceExcludes) return { kind: "clear", what: "workspaceChoice" };
  if (facts.hiddenSpace) return { kind: "clear", what: "hiddenSpace" };
  if (facts.hiddenMachine) return { kind: "clear", what: "hiddenMachine" };
  if (facts.needsYouHides) return { kind: "clear", what: "needsYouOnly" };
  if (facts.queryHides) return { kind: "clear", what: "query" };
  return facts.drawn ? { kind: "land" } : { kind: "none" };
}
