import { useEffect, useRef, useState } from "react";

import { fetchHistory, imageSrc } from "@/lib/api";
import { transcriptImages } from "@/lib/mirror-images";
import { paneScopeKey, type Scope } from "@/lib/scope";

// The pictures behind the mirror's image placeholders, read from the pane's own session log.
//
// ── THE POLL PATH STAYS A POLL PATH ──────────────────────────────────────────
// A pane read is on a ~1.5 s revalidate, and a journal read is a whole-file parse bridge-side
// whenever the log's mtime moved (`bridge/journal/store.ts`). So the pane read carries NO image
// field and the bridge does no journal work on that path: the WEB decides, here, and it asks only
// when the screen has actually shown it a placeholder it cannot account for.
//
// ── WHICH IS ONE FETCH PER NEW IMAGE ─────────────────────────────────────────
// The trigger is the COUNT of placeholder clusters on screen. A count of zero asks nothing. A count
// that grows means an image arrived, so one page of the existing history route is fetched — the same
// on-demand route the History view uses, forwardable to a member by `?host=` exactly as it already
// is. A count that shrinks (the terminal scrolled the image off) asks nothing: the images in hand
// still cover the clusters that are left, and the alignment runs from the end.
//
// Errors are swallowed. This is an enhancement over the badge the placeholder already renders, so a
// failed read must cost nothing more than the badge staying.

/** Turns requested. A screenful of images sits inside the recent end of the log. */
const TURNS = 40;

/**
 * The image references for this pane, oldest-first, ready to load — `[]` while there is nothing to
 * show, the pane has no journal, or the read has not answered yet.
 */
export function useMirrorImages({
  paneId,
  scope,
  enabled,
  clusterCount,
}: {
  paneId: string;
  /** Which machine + session this pane lives on — the address every other pane read carries. */
  scope?: Scope;
  /** False for a pane with no agent session: there is no log to read images out of. */
  enabled: boolean;
  /** How many placeholder clusters the mirror is currently rendering. */
  clusterCount: number;
}): readonly string[] {
  const [images, setImages] = useState<readonly string[]>([]);
  // The count the images in hand were fetched for. A fetch happens when the screen shows MORE
  // clusters than that, which is the definition of "an image arrived".
  const fetchedFor = useRef(0);
  const [target, setTarget] = useState(0);

  // Images belong to the pane they were read from. Keyed on the ADDRESS: the same pane id on
  // another host or session is a different terminal.
  const address = paneScopeKey(scope, paneId);
  useEffect(() => {
    fetchedFor.current = 0;
    setTarget(0);
    setImages([]);
  }, [address]);

  useEffect(() => {
    if (!enabled) return;
    if (clusterCount <= fetchedFor.current) return;
    fetchedFor.current = clusterCount;
    setTarget(clusterCount);
  }, [enabled, clusterCount]);

  useEffect(() => {
    if (!enabled || target === 0) return;
    const abort = new AbortController();
    let live = true;
    void (async () => {
      try {
        const page = await fetchHistory(paneId, { limit: TURNS }, scope, abort.signal);
        if (!live || !page.available) return;
        // Refused references are dropped here rather than rendered as a broken <img>, so the
        // alignment only ever lines up pictures this phone will actually load.
        const refs = transcriptImages(page.entries)
          .map((ref) => imageSrc(ref, scope))
          .filter((url): url is string => url !== null);
        setImages(refs);
      } catch {
        // A cancelled or failed read leaves the badge in place.
      }
    })();
    return () => {
      live = false;
      abort.abort();
    };
    // `scope` is safe in a dependency array: scopes read off a URL are interned to one frozen
    // instance per (host, session), so its identity is as stable as the string it replaced.
  }, [paneId, scope, enabled, target]);

  return enabled ? images : [];
}
