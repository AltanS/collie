// LAB SWITCH, desktop pass 2 (the New page and the space page on a large screen). Step 1 only: three proposals
// behind `?ns=1|2|3`, no switch = today. The value is read off the address once and kept for the tab in
// sessionStorage, so it survives every navigation after the first load; `?ns=0` clears it. Removed in step 2.

import { pathOnly } from "@/lib/nav";

export type LabNs = 0 | 1 | 2 | 3;

const KEY = "collie:lab-ns";

function readStored(): LabNs {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("ns");
    if (fromUrl === "1" || fromUrl === "2" || fromUrl === "3") window.sessionStorage.setItem(KEY, fromUrl);
    if (fromUrl === "0") window.sessionStorage.removeItem(KEY);
    const kept = window.sessionStorage.getItem(KEY);
    return kept === "1" ? 1 : kept === "2" ? 2 : kept === "3" ? 3 : 0;
  } catch {
    return 0;
  }
}

let ns: LabNs | null = null;

/** The proposal this tab shows, 0 for today. */
export function labNs(): LabNs {
  if (ns === null) ns = readStored();
  return ns;
}

// ── New over the screen it was called from ────────────────────────────────────────────────────────────────
// On a large screen with a proposal on, New does not replace the screen: the screen's own address gains
// `over=<the New address>`, and the root draws New over it. Back pops that entry and New is gone.

/** The query key that holds the New address drawn over this screen. */
export const OVER_PARAM = "over";

let live = false;

/** Set by the overlay host on every render: whether New opens over the screen right now. */
export function setOverlayLive(on: boolean): void {
  live = on;
}

/** Whether New opens over the screen right now (large screen, Large-screen layout on, a proposal on). */
export function overlayLive(): boolean {
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

/** `href` with the New address `to` over it. */
export function withOver(href: string, to: string): string {
  const base = withoutOver(href);
  const cut = base.indexOf("?");
  const q = new URLSearchParams(cut === -1 ? "" : base.slice(cut + 1));
  q.set(OVER_PARAM, to);
  return `${cut === -1 ? base : base.slice(0, cut)}?${q.toString()}`;
}

// ── The space page, proposal 2: the dashboard marking one Space ───────────────────────────────────────────

/** The query key of the dashboard that names the Space it scrolls to and marks. */
export const MARK_SPACE_PARAM = "space";
