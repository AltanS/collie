import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router";

import { lazyChunk } from "@/lib/lazy-route";
import { fragmentRowId, OLD_BELOW, OLD_FRAGMENTS, OLD_PAGES } from "@/lib/settings/pages";
import type { PageId } from "@/lib/settings/types";

// ── THE OLD SETTINGS ADDRESSES (ADR 0170) ────────────────────────────────────────────────────────────────────────
// Appearance, Harness configurations, Device, Alerts, Experiments and System are redirects now, for good: a push
// already delivered, a crew member on an older Collie, a bookmark and an installed app's history still carry them.
// Each opens the page that holds most of what it held, with the query string (the scope, a pairing code) and the
// fragment. An old fragment names its row's page, which may be another one: `/settings/device#changes` opens
// Dashboard and projects. A fragment that is a row's id opens the page that holds the row today, so a row that
// split away from its old page is still found. The redirect is an element and not a loader because a loader's
// request has no fragment. `replace`, so Back does not land on an address that only forwards.
//
// A module of its own, apart from the pages: a redirect is an element in the route table and needs no chunk
// (ADR 0169), so it must not pull the pages into the first paint. The registry, which a row id needs, is a chunk of
// its own that the idle preload already holds.

const loadRegistry = lazyChunk(() => import("@/lib/settings"));

function fragmentOf(hash: string): string {
  return hash.startsWith("#") ? hash.slice(1) : hash;
}

/** The page an old fragment names (`#changes`, `#paired-devices`, `#install-count`), or undefined. */
function oldFragmentPage(hash: string): PageId | undefined {
  return new Map<string, PageId>(Object.entries(OLD_FRAGMENTS)).get(fragmentOf(hash));
}

/** Where an old address goes: the page and the part below it, with the fragment's page winning. */
export function oldSettingsTarget(old: keyof typeof OLD_PAGES, below: string | undefined, search: string, hash: string): string {
  const moved = below === undefined ? undefined : new Map<string, string>(Object.entries(OLD_BELOW)).get(`${old}/${below}`);
  const path = moved ?? oldFragmentPage(hash) ?? OLD_PAGES[old];
  return `/settings/${path}${search}${hash}`;
}

/**
 * Where `/settings` itself goes for an old fragment: the read-only banner linked `/settings#paired-devices` and the
 * Changes link `/settings#changes` before the pages split (1.0 to 1.28). Null: no old fragment, the index stays.
 */
export function oldIndexTarget(search: string, hash: string): string | null {
  const page = oldFragmentPage(hash);
  return page === undefined ? null : `/settings/${page}${search}${hash}`;
}

/** Where a row's id goes today: its page and the part below it, the id as the fragment. Null: no such row. */
async function rowTarget(id: string, search: string): Promise<string | null> {
  const { settingById, settingPath } = await loadRegistry();
  const row = settingById(id);
  const path = row === undefined ? null : settingPath(row);
  if (path === null) return null;
  const [base = path, fragment = ""] = path.split("#");
  return `${base}${search}#${fragment}`;
}

export function OldSettingsRedirect({ from, below }: { from: keyof typeof OLD_PAGES; below?: string }) {
  const { search, hash, state } = useLocation();
  const plain = oldSettingsTarget(from, below, search, hash);
  // A row id that is not an old fragment: read the registry for the row's page. Until it answers, draw nothing.
  const rowId = oldFragmentPage(hash) === undefined ? fragmentRowId(hash) : undefined;
  const [target, setTarget] = useState<string | null>(rowId === undefined ? plain : null);
  useEffect(() => {
    if (rowId === undefined) return;
    let live = true;
    const land = async () => {
      const found = await rowTarget(rowId, search).catch(() => null);
      if (live) setTarget(found ?? plain);
    };
    void land();
    return () => {
      live = false;
    };
  }, [rowId, search, plain]);
  if (target === null) return null;
  return <Navigate to={target} replace state={state} />;
}
