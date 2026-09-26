import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchHistory, imageSrc } from "@/lib/api";
import { drawsImagesOffGrid } from "@/lib/journal-agents";
import { newestTurnImage, transcriptImages, turnImageCard } from "@/lib/mirror-images";
import { paneScopeKey, type Scope } from "@/lib/scope";
import type { AgentView } from "@/lib/types";

// The pictures an agent showed, read from the pane's own session log: the ones behind the mirror's
// image placeholders, and the newest turn's picture when the agent drew it with no placeholder.
//
// ── THE POLL PATH STAYS A POLL PATH ──────────────────────────────────────────
// A pane read is on a ~1.5 s revalidate, and a journal read is a whole-file parse bridge-side
// whenever the log's mtime moved (`bridge/journal/store.ts`). So the pane read carries NO image
// field and the bridge does no journal work on that path: the WEB decides, here, and it asks only
// on one of the two events below.
//
// ── TRIGGER ONE: A PLACEHOLDER CLUSTER ARRIVED ───────────────────────────────
// The first trigger is the COUNT of placeholder clusters on screen. A count of zero asks nothing. A
// count that grows means an image arrived, so one page of the existing history route is fetched —
// the same on-demand route the History view uses, forwardable to a member by `?host=` exactly as it
// already is. A count that shrinks (the terminal scrolled the image off) asks nothing: the images in
// hand still cover the clusters that are left, and the alignment runs from the end.
//
// ── TRIGGER TWO: A TURN FINISHED ON AN AGENT THAT DRAWS OFF THE GRID ─────────
// pi draws its pictures by direct placement, which leaves no placeholder and so no count to grow
// (#292, `lib/mirror-images.ts` § "the picture a direct placement leaves no trace of"). No screen
// signal says a picture arrived, and knowing whether the newest turn holds one takes a read. So the
// second trigger is the end of a turn: the caller passes a key that changes when the agent's status
// leaves `working` (`finishedTurn`), and each new key costs ONE read of the same page, through the
// same coalescing and the same generation check as the first trigger. A re-render, a poll, or the
// same key again reads nothing, so the same picture is never fetched twice for one turn. The caller
// passes a key only for the agents that draw off the grid (`drawsImagesOffGrid`), so every other
// agent pays no read per turn.
//
// From that page the newest turn's picture is taken (`newestTurnImage`) and returned as the card,
// unless a placeholder cluster already shows it (`turnImageCard`). The card belongs to the turn the
// read was made for: while the agent works on a new turn, and until that turn's read answers, the
// card of the turn before is not shown. A finished turn with no picture removes it.
//
// ── ONE READ AT A TIME, AND NEVER A STALE ANSWER ─────────────────────────────
// Growth events arrive in bursts: a tall image lands as several polls in a row, each one showing one
// more cluster than the last. So a trigger while a read is in flight does NOT start a second read —
// it only REMEMBERS that one more is wanted, and that one runs when the current read settles. N
// events during one flight therefore cost one extra read, not N. Changing pane is the one case that
// does not wait: a new address means the images in hand are the wrong pane's, so its read starts at
// once. Every request carries a generation number that is checked ON ARRIVAL, so an answer from an
// older request (or from the pane you just left) is dropped instead of overwriting a newer one.
//
// Errors are swallowed. This is an enhancement over the badge the placeholder already renders, and
// over the blank rows a direct placement leaves, so a failed read must cost nothing more than that.

/** Turns requested. A screenful of images sits inside the recent end of the log. */
const TURNS = 40;

/** Stable empty list, so "no images for this pane" is one identity and re-renders nothing. */
const NO_IMAGES: readonly string[] = [];

/** The newest turn's picture as last read, and the finished turn that read was made for. */
interface TurnPicture {
  readonly turn: string;
  readonly url: string | null;
}

export interface MirrorImages {
  /**
   * The image references behind the placeholder clusters, oldest-first, ready to load — `[]` while
   * there is nothing to show, the pane has no journal, or the read has not answered yet.
   */
  readonly images: readonly string[];
  /**
   * The newest finished turn's picture, ready to load, when no placeholder cluster shows it — the
   * card after the mirror. Null otherwise.
   */
  readonly turnImage: string | null;
}

const NOTHING: MirrorImages = { images: NO_IMAGES, turnImage: null };

/**
 * The second trigger's key for a pane's agent, off the snapshot the pane view already polls.
 *
 * `undefined` for an agent that draws no picture off the grid, so it never pays a read per turn.
 * `null` while the agent works. Otherwise its `lastActiveAt`, which the bridge stamps on every status
 * transition, so a status leaving `working` is a new key. A bridge too old to send `lastActiveAt`
 * gives one constant key: the pane reads once when it opens and never per turn.
 */
export function finishedTurnKey(
  agent: Pick<AgentView, "agent" | "status" | "lastActiveAt"> | undefined,
): string | null | undefined {
  if (agent === undefined || !drawsImagesOffGrid(agent.agent)) return undefined;
  if (agent.status === "working") return null;
  return String(agent.lastActiveAt ?? 0);
}

export function useMirrorImages({
  paneId,
  scope,
  enabled,
  clusterCount,
  finishedTurn,
}: {
  paneId: string;
  /** Which machine + session this pane lives on — the address every other pane read carries. */
  scope?: Scope;
  /** False for a pane with no agent session: there is no log to read images out of. */
  enabled: boolean;
  /** How many placeholder clusters the mirror is currently rendering. */
  clusterCount: number;
  /**
   * The second trigger's key. `undefined`: this agent draws no picture off the grid, so no read is
   * made per turn and no card is returned. `null`: the agent is working, so nothing is read yet and
   * no card is shown. A string: the turn that finished, and each new one costs one read.
   */
  finishedTurn?: string | null;
}): MirrorImages {
  const [images, setImages] = useState<readonly string[]>(NO_IMAGES);
  const [picture, setPicture] = useState<TurnPicture | null>(null);
  // The count the images in hand were fetched for. A fetch happens when the screen shows MORE
  // clusters than that, which is the definition of "an image arrived".
  const fetchedFor = useRef(0);
  // The finished turn a read was last started for. A fetch happens when the caller names another.
  const turnReadFor = useRef<string | null>(null);
  // The finished turn as of the last commit, so a read records which turn its answer belongs to,
  // and the turn the read in flight recorded.
  const currentTurn = useRef<string | null>(null);
  const inFlightTurn = useRef<string | null>(null);
  // Whether a read is out there right now, and whether one more is wanted after it — the coalescing
  // pair (see the header). `refetchWanted` is a flag, not a queue: any number of trigger events
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
    // Read at request time: the answer describes the log as it stood after THIS turn.
    const turn = currentTurn.current;
    inFlight.current = true;
    inFlightTurn.current = turn;
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
      if (turn !== null) {
        const newest = newestTurnImage(page.entries);
        const url = newest === null ? null : imageSrc(newest, scope);
        // Kept when nothing changed, so a re-read of the same turn re-renders nothing.
        setPicture((prev) => (prev?.turn === turn && prev.url === url ? prev : { turn, url }));
      }
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

  /** Read now, or once the read in flight settles. */
  const requestRead = useCallback(() => {
    if (inFlight.current) {
      refetchWanted.current = true;
      return;
    }
    void fetchImages();
  }, [fetchImages]);

  // Images belong to the pane they were read from. Keyed on the ADDRESS: the same pane id on
  // another host or session is a different terminal.
  const address = paneScopeKey(scope, paneId);
  useEffect(() => {
    fetchedFor.current = 0;
    turnReadFor.current = null;
    refetchWanted.current = false;
    // Bar every answer still out there, then let the new address read at once rather than queue
    // behind the old pane's read.
    newestApplied.current = requestGen.current;
    inFlightAbort.current?.abort();
    inFlight.current = false;
    setImages(NO_IMAGES);
    setPicture(null);
  }, [address]);

  // Declared before both triggers, so a read either of them starts in this commit sees the turn.
  useEffect(() => {
    currentTurn.current = finishedTurn ?? null;
  }, [finishedTurn]);

  // Trigger one: a placeholder cluster arrived.
  useEffect(() => {
    if (!enabled) return;
    if (clusterCount <= fetchedFor.current) return;
    fetchedFor.current = clusterCount;
    requestRead();
    // `requestRead` changes identity with the pane's address, and the reset effect above runs first
    // on that render, so this effect is what re-reads for the pane just switched to.
  }, [enabled, clusterCount, requestRead]);

  // Trigger two: a turn finished on an agent that draws off the grid. The first key a pane shows is
  // a turn already finished when it opened, so opening such a pane costs one read too.
  useEffect(() => {
    if (!enabled || finishedTurn === undefined || finishedTurn === null) return;
    if (finishedTurn === turnReadFor.current) return;
    turnReadFor.current = finishedTurn;
    // A read already out for this very turn (trigger one, in the same commit) answers it too.
    if (inFlight.current && inFlightTurn.current === finishedTurn) return;
    requestRead();
  }, [enabled, finishedTurn, requestRead]);

  // The card shows the picture of the turn the caller names, never one read for an earlier turn.
  const turnUrl =
    finishedTurn !== undefined && finishedTurn !== null && picture?.turn === finishedTurn
      ? picture.url
      : null;
  const turnImage = turnImageCard(turnUrl, clusterCount, images);
  return useMemo(
    () => (enabled ? { images, turnImage } : NOTHING),
    [enabled, images, turnImage],
  );
}
