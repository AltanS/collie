import { useCallback, useEffect, useRef, useState } from "react";

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
// ── ONE READ AT A TIME, AND NEVER A STALE ANSWER ─────────────────────────────
// Growth events arrive in bursts: a tall image lands as several polls in a row, each one showing one
// more cluster than the last. So a growth while a read is in flight does NOT start a second read —
// it only REMEMBERS that one more is wanted, and that one runs when the current read settles. N
// growth events during one flight therefore cost one extra read, not N. Changing pane is the one
// case that does not wait: a new address means the images in hand are the wrong pane's, so its read
// starts at once. Every request carries a generation number that is checked ON ARRIVAL, so an answer
// from an older request (or from the pane you just left) is dropped instead of overwriting a newer
// one.
//
// Errors are swallowed. This is an enhancement over the badge the placeholder already renders, so a
// failed read must cost nothing more than the badge staying.

/** Turns requested. A screenful of images sits inside the recent end of the log. */
const TURNS = 40;

/** Stable empty list, so "no images for this pane" is one identity and re-renders nothing. */
const NO_IMAGES: readonly string[] = [];

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
  const [images, setImages] = useState<readonly string[]>(NO_IMAGES);
  // The count the images in hand were fetched for. A fetch happens when the screen shows MORE
  // clusters than that, which is the definition of "an image arrived".
  const fetchedFor = useRef(0);
  // Whether a read is out there right now, and whether one more is wanted after it — the coalescing
  // pair (see the header). `refetchWanted` is a flag, not a queue: any number of growth events
  // during one flight ask for the same single follow-up read.
  const inFlight = useRef(false);
  const refetchWanted = useRef(false);
  // The generation of the newest request made, and of the newest answer allowed to reach state.
  // Compared on arrival: an answer whose generation is not newer than `newestApplied` is stale and
  // is dropped. A pane switch raises the bar to the newest request, which bars everything in flight.
  const requestGen = useRef(0);
  const newestApplied = useRef(0);
  const inFlightAbort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inFlightAbort.current?.abort();
    };
  }, []);

  const fetchImages = useCallback(async (): Promise<void> => {
    const gen = ++requestGen.current;
    inFlight.current = true;
    const abort = new AbortController();
    inFlightAbort.current = abort;
    try {
      const page = await fetchHistory(paneId, { limit: TURNS }, scope, abort.signal);
      // The generation check. A slower older read must never overwrite a newer one's images.
      if (!mounted.current || gen <= newestApplied.current) return;
      if (!page.available) return;
      newestApplied.current = gen;
      // Refused references are dropped here rather than rendered as a broken <img>, so the
      // alignment only ever lines up pictures this phone will actually load.
      const refs = transcriptImages(page.entries)
        .map((ref) => imageSrc(ref, scope))
        .filter((url): url is string => url !== null);
      setImages(refs);
    } catch {
      // A cancelled or failed read leaves the badge in place.
    } finally {
      // Only the NEWEST request owns the in-flight flag and the follow-up. An older one settling
      // late has already been superseded, and must not start a read of its own.
      if (gen === requestGen.current) {
        inFlight.current = false;
        if (refetchWanted.current && mounted.current) {
          refetchWanted.current = false;
          void fetchImages();
        }
      }
    }
  }, [paneId, scope]);

  // Images belong to the pane they were read from. Keyed on the ADDRESS: the same pane id on
  // another host or session is a different terminal.
  const address = paneScopeKey(scope, paneId);
  useEffect(() => {
    fetchedFor.current = 0;
    refetchWanted.current = false;
    // Bar every answer still out there, then let the new address read at once rather than queue
    // behind the old pane's read.
    newestApplied.current = requestGen.current;
    inFlightAbort.current?.abort();
    inFlight.current = false;
    setImages(NO_IMAGES);
  }, [address]);

  useEffect(() => {
    if (!enabled) return;
    if (clusterCount <= fetchedFor.current) return;
    fetchedFor.current = clusterCount;
    if (inFlight.current) {
      refetchWanted.current = true;
      return;
    }
    void fetchImages();
    // `fetchImages` changes identity with the pane's address, and the reset effect above runs first
    // on that render, so this effect is what re-reads for the pane just switched to.
  }, [enabled, clusterCount, fetchImages]);

  return enabled ? images : NO_IMAGES;
}
