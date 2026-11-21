import { Navigate, useLocation } from "react-router";

import { OLD_BELOW, OLD_FRAGMENTS, OLD_PAGES } from "@/lib/settings/pages";
import type { PageId } from "@/lib/settings/types";

// ── THE OLD SETTINGS ADDRESSES (ADR 0170) ────────────────────────────────────────────────────────────────────────────────────────────
// Appearance, Harness configurations, Device, Alerts, Experiments and System are redirects now: each opens the page
// that holds most of what it held, with the query string (the scope, a pairing code) and the fragment. An old
// fragment names its row's page, which may be another one: `/settings/device#changes` opens Dashboard and projects.
// The redirect is an element and not a loader because a loader's request has no fragment. `replace`, so Back does
// not land on an address that only forwards.
//
// A module of its own, apart from the pages: a redirect is an element in the route table and needs no chunk
// (ADR 0169), so it must not pull the pages into the first paint.

/** Where an old address goes: the page and the part below it, with the fragment's page winning. */
export function oldSettingsTarget(old: keyof typeof OLD_PAGES, below: string | undefined, search: string, hash: string): string {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  const byFragment = new Map<string, PageId>(Object.entries(OLD_FRAGMENTS)).get(fragment);
  const moved = below === undefined ? undefined : new Map<string, string>(Object.entries(OLD_BELOW)).get(`${old}/${below}`);
  const path = moved ?? byFragment ?? OLD_PAGES[old];
  return `/settings/${path}${search}${hash}`;
}

export function OldSettingsRedirect({ from, below }: { from: keyof typeof OLD_PAGES; below?: string }) {
  const { search, hash, state } = useLocation();
  return <Navigate to={oldSettingsTarget(from, below, search, hash)} replace state={state} />;
}
