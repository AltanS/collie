// NEW OVER THE SCREEN IT WAS CALLED FROM (ADR 0173). On a large screen (`expanded`, with
// Large-screen layout not Off) the New page and "Add your own" are not pages that replace the screen: the
// screen keeps its own address and gains `over=<the New address>`, and the root draws New as a dialog over it
// (components/new-over.tsx). Back pops that entry, so New is gone and the screen is exactly where it was. A
// reload keeps it, and `/new` opened directly is New over the Dashboard. The phone, the tablet and Off keep
// the pages.
//
// `hooks/use-nav.ts` reads `newOverScreen()` on every move and rewrites a move to a New address into this
// shape. The host sets it on every render from the width class, so a move made at any width obeys the width
// the screen is drawn at.

import { pathOnly } from "@/lib/nav";

/** The query key that holds the New address drawn over this screen. */
export const OVER_PARAM = "over";

let live = false;

/** Set by the New dialog's host on every render: whether New opens over the screen at this width. */
export function setNewOverScreen(on: boolean): void {
  live = on;
}

/** Whether New opens over the screen right now. */
export function newOverScreen(): boolean {
  return live;
}

/** `/new` or `/new/add`, with or without a query. */
export function isNewAddress(to: string): boolean {
  const path = pathOnly(to);
  return path === "/new" || path === "/new/add";
}

/** The New address drawn over `href`, or undefined. */
export function overOf(href: string): string | undefined {
  const cut = href.indexOf("?");
  if (cut === -1) return undefined;
  const value = new URLSearchParams(href.slice(cut + 1)).get(OVER_PARAM);
  return value !== null && isNewAddress(value) ? value : undefined;
}

/** `href` with no New over it. */
export function withoutOver(href: string): string {
  const cut = href.indexOf("?");
  if (cut === -1) return href;
  const q = new URLSearchParams(href.slice(cut + 1));
  q.delete(OVER_PARAM);
  const rest = q.toString();
  return rest === "" ? href.slice(0, cut) : `${href.slice(0, cut)}?${rest}`;
}

/** `href` with the New address `to` over it (any New already over it is replaced). */
export function withOver(href: string, to: string): string {
  const base = withoutOver(href);
  const cut = base.indexOf("?");
  const q = new URLSearchParams(cut === -1 ? "" : base.slice(cut + 1));
  q.set(OVER_PARAM, to);
  return `${cut === -1 ? base : base.slice(0, cut)}?${q.toString()}`;
}

// ── The space address on a large screen ───────────────────────────────────────────────────────────────────
// `/space/:id` opens the pane view of the Space's open tab (routes/space.tsx), and the sidebar shows the row
// it landed on. The pane view reveals that row once, for this arrival only: a tap on a sidebar row moves
// nothing in the sidebar.

let revealPending: string | null = null;

/** The pane the space address is about to open: its sidebar row is brought into view on arrival. */
export function queueSidebarReveal(paneId: string): void {
  revealPending = paneId;
}

/** Whether this arrival at `paneId` came from the space address. Spends the mark. */
export function takeSidebarReveal(paneId: string): boolean {
  if (revealPending !== paneId) return false;
  revealPending = null;
  return true;
}
