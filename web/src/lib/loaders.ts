// React Router data loaders are the data layer — there is intentionally no separate data-fetching
// library. The home/detail routes declare these as `loader`s; polling is just
// `useRevalidator().revalidate()` re-running them (see hooks/use-polling.ts). Each loader keeps the
// last good result in a module cache so a transient fetch failure shows stale-but-present data
// (flagged) instead of flashing empty — i.e. keep-previous-data while a refetch is in flight.
//
// Offline fast path (a PWA should navigate instantly to last-known data): during a KNOWN, escalated
// outage (the shared connection-health store has latched "lost"), a NAVIGATION must not block on a
// fetch that will only time out — it returns cached data immediately (flagged error). A REVALIDATION
// (the poll) must keep really fetching so recovery is discovered and the stale data swapped out. React
// Router never tells a loader which kind of run it is, but the request URL does: a revalidation re-runs
// a loader at the SAME url; a navigation runs it at a DIFFERENT one (see isNavigation below). No timer,
// no flag, no race — and because a navigation aborts any in-flight revalidation, the nav is instant
// even while a poll's doomed fetch is still hanging.

import { fetchPane, fetchSnapshot } from "@/lib/api";
import { isLostLatched } from "@/lib/connection-health";
import { SESSION_PARAM, normalizeSession } from "@/lib/session";
import type {
  AgentView,
  BridgeStatus,
  DeviceAuth,
  PaneReadResponse,
  SessionSummary,
  SnapshotResponse,
  TabView,
  UpdateInfo,
  WorkspaceView,
} from "@/lib/types";

// A superseded revalidation is aborted via the loader's request.signal; that surfaces as an
// AbortError we must RETHROW so React Router discards the stale run — swallowing it into the
// stale-data/error-banner path would flash a spurious "reconnecting…" on every fast poll.
function isAbortError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    (e as { name?: unknown }).name === "AbortError"
  );
}

// The root route's id, paired with rootLoader. Children read its data via
// `useRouteLoaderData(ROOT_ROUTE_ID)`; keeping it a constant means a rename is a single edit, not a
// silent runtime `undefined` from a stale string literal.
export const ROOT_ROUTE_ID = "root";

// The session a loader run was scoped to, read from the request URL's `?s=`. Extracted once per run
// and threaded into every fetch + cache key so a session switch (a plain URL change picked up by the
// revalidator) is automatically correct. Undefined = primary.
function sessionFromRequest(request?: Request): string | undefined {
  if (!request) return undefined;
  try {
    return normalizeSession(new URL(request.url).searchParams.get(SESSION_PARAM));
  } catch {
    return undefined;
  }
}

export interface HomeData {
  bridge: BridgeStatus | undefined;
  /** Per-device authorisation; undefined when the feature is off or not yet known. */
  device: DeviceAuth | undefined;
  agents: AgentView[];
  shellPanes: AgentView[];
  workspaces: WorkspaceView[];
  tabs: TabView[];
  /** The bridge's session registry (primary-first); empty on a single-session / older bridge. */
  sessions: SessionSummary[];
  /** The session this snapshot was fetched for (undefined = primary) — so children don't re-derive. */
  session: string | undefined;
  /** Active notification snooze deadline (epoch ms), or null when not snoozed. */
  snoozedUntil: number | null;
  /** Version / upgrade status for the footer update banner; undefined on an older bridge. */
  update: UpdateInfo | undefined;
  /** True when this render is the last-good snapshot after a failed refresh. */
  error: boolean;
}

export interface PaneData {
  paneId: string;
  /** The session this pane was fetched for (undefined = primary) — threaded into every write. */
  session: string | undefined;
  text: string;
  /** True when the buffer was cut off at the requested line count — older scrollback still exists. */
  truncated: boolean;
  /** The scrollback window this result was fetched with — lets the UI tell a grown fetch from a
   * stale in-flight poll (a "Load older" tap raises this; see growRequestedLines). */
  requestedLines: number;
  /** Herdr's monotonic revision for `text` — the prompt-select race guard checks against it. 0 on
   * the degraded (stale-text) path, where the guard's fresh fetch will reject a mismatch anyway. */
  revision: number;
  error: boolean;
}

// Keep-previous-data cache is now PER-SESSION: switching sessions must not show the other session's
// herd flagged as stale. Keyed by session name ("" = primary).
const lastSnapshot = new Map<string, SnapshotResponse>();

// The URL each loader last RAN for — the nav-vs-revalidate discriminator for the offline fast path (see
// the header comment). Module-scoped so it survives revalidations (the loader re-runs every poll) and
// resets on a full reload — same lifetime as the caches. `lastRootUrl` is enough for the root loader
// because it runs on EVERY navigation (it's the parent of all routes); the pane loader only runs while
// a pane is mounted, so `lastRootUrl` also CLEARS `lastPaneUrl` whenever we're on a non-pane URL — that
// way re-entering the same pane (pane → home → same pane) reads as a fresh navigation, not a poll.
let lastRootUrl: string | undefined;
let lastPaneUrl: string | undefined;

function isPaneUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).pathname.startsWith("/pane/");
  } catch {
    return url.includes("/pane/");
  }
}

function toHomeData(snap: SnapshotResponse, session: string | undefined, error: boolean): HomeData {
  return {
    bridge: snap.bridge,
    device: snap.device,
    agents: snap.agents,
    shellPanes: snap.shellPanes ?? [],
    workspaces: snap.workspaces ?? [],
    tabs: snap.tabs ?? [],
    sessions: snap.sessions ?? [],
    session,
    snoozedUntil: snap.notifications?.snoozedUntil ?? null,
    update: snap.update,
    error,
  };
}

// Last-known home for a session, flagged stale — the cached snapshot if we have one, else an empty
// error snapshot. Shared by BOTH the failed-refresh catch and the offline navigation fast path, so the
// two return byte-identical shapes (the UI can't tell "fetch just failed" from "navigated while known-
// offline" — both are "stale-but-present, flagged").
function staleHome(session: string | undefined): HomeData {
  const cached = lastSnapshot.get(session ?? "");
  return cached
    ? toHomeData(cached, session, true)
    : {
        bridge: undefined,
        device: undefined,
        agents: [],
        shellPanes: [],
        workspaces: [],
        tabs: [],
        sessions: [],
        session,
        snoozedUntil: null,
        update: undefined,
        error: true,
      };
}

export async function rootLoader({ request }: { request?: Request } = {}): Promise<HomeData> {
  const session = sessionFromRequest(request);
  // Nav-vs-revalidate: a revalidation (poll) re-runs at the SAME url; a navigation runs at a different
  // one. Cold start (lastRootUrl undefined) reads as a navigation too, but the latch gate below is
  // never set that early, so the first run always really fetches (BootSplash + escalation, as today).
  const url = request?.url;
  const isNavigation = lastRootUrl !== url;
  lastRootUrl = url;
  // Leaving a pane clears the pane loader's discriminator so a later return to it reads as a fresh nav.
  if (!isPaneUrl(url)) lastPaneUrl = undefined;

  // Fast path: a navigation during a known, escalated outage returns last-known data INSTANTLY rather
  // than hanging on a doomed fetch. Revalidations fall through and really fetch (so recovery lands and
  // markLive clears the latch → the next run fetches live and replaces the stale herd).
  if (isNavigation && isLostLatched()) return staleHome(session);

  try {
    const snap = await fetchSnapshot(session, request?.signal);
    lastSnapshot.set(session ?? "", snap);
    return toHomeData(snap, session, false);
  } catch (e) {
    if (isAbortError(e)) throw e; // superseded revalidation — let React Router drop it
    // Keep the last good herd on screen, flagged so the ConnectionBanner can say "reconnecting…".
    return staleHome(session);
  }
}

// Pane ids are per-session, so every per-pane cache is keyed by (session, paneId) — a NUL joiner
// keeps the two fields unambiguous. "" session = primary.
function paneKey(paneId: string, session?: string): string {
  return `${session ?? ""}\u0000${paneId}`;
}

const lastPaneText = new Map<string, string>();
// Cap the per-pane stale-text cache so it can't grow without bound over a long session of opening
// many panes. Evict the oldest (insertion-order) entry beyond the cap — dumb FIFO is plenty for a
// phone that views one pane at a time.
const PANE_TEXT_MAX = 20;

function rememberPaneText(key: string, text: string): void {
  lastPaneText.set(key, text);
  if (lastPaneText.size > PANE_TEXT_MAX) {
    const oldest = lastPaneText.keys().next().value;
    if (oldest !== undefined) lastPaneText.delete(oldest);
  }
}

// The detail view pulls a deeper window than the home snapshot's status reads, so you can scroll
// back through a long exchange. The live tail still follows; scrolling up freezes it (see
// AgentChat). Larger = more scrollback but more bytes per poll — 600 holds several exchanges.
const DETAIL_HISTORY_LINES = 600;
// "Load older" raises the requested window by a step per tap, up to a cap. The bridge itself clamps
// at 10000, so we stop well below that — 5000 lines is plenty of phone scrollback per poll.
const DETAIL_HISTORY_STEP = 600;
export const DETAIL_HISTORY_MAX = 5000;

// Per-pane requested scrollback, raised by "Load older". Module-scoped so it survives revalidations
// (the loader re-runs on every poll) but resets on a full app reload — mirrors lastPaneText. Bounded
// the same way so a long session of opening many panes can't grow it without bound.
const requestedLines = new Map<string, number>();

/** The scrollback window currently requested for a pane (defaults to the base window). */
export function getRequestedLines(paneId: string, session?: string): number {
  return requestedLines.get(paneKey(paneId, session)) ?? DETAIL_HISTORY_LINES;
}

/** True while more scrollback can still be requested (below the cap). */
export function canGrowRequestedLines(paneId: string, session?: string): boolean {
  return getRequestedLines(paneId, session) < DETAIL_HISTORY_MAX;
}

/** Raise the requested scrollback by one step (capped) and return the new value. */
export function growRequestedLines(paneId: string, session?: string): number {
  const next = Math.min(getRequestedLines(paneId, session) + DETAIL_HISTORY_STEP, DETAIL_HISTORY_MAX);
  requestedLines.set(paneKey(paneId, session), next);
  if (requestedLines.size > PANE_TEXT_MAX) {
    const oldest = requestedLines.keys().next().value;
    if (oldest !== undefined) requestedLines.delete(oldest);
  }
  return next;
}

/** Reset a pane's requested scrollback back to the base window (used by tests). */
export function resetRequestedLines(paneId?: string, session?: string): void {
  if (paneId === undefined) requestedLines.clear();
  else requestedLines.delete(paneKey(paneId, session));
}

// Last-known pane payload, flagged degraded — stale text (empty if this pane was never fetched),
// truncated cleared, revision 0 (the prompt-select guard rejects a 0-revision mismatch anyway). Shared
// by the failed-refresh catch and the offline navigation fast path, so both return the same shape.
function stalePane(paneId: string, session: string | undefined, lines: number): PaneData {
  return {
    paneId,
    session,
    text: lastPaneText.get(paneKey(paneId, session)) ?? "",
    truncated: false,
    requestedLines: lines,
    revision: 0,
    error: true,
  };
}

export async function paneLoader({
  params,
  request,
}: {
  params: { paneId?: string };
  request?: Request;
}): Promise<PaneData> {
  const { paneId } = params;
  // The route is `/pane/:paneId`, so a missing param means a misconfigured route, not a user state
  // — fail loudly to the error boundary rather than fetching `/api/pane/` and rendering an empty pane.
  if (!paneId) throw new Error("paneLoader: missing :paneId route param");
  const session = sessionFromRequest(request);
  const key = paneKey(paneId, session);
  const lines = getRequestedLines(paneId, session);
  // Nav-vs-revalidate, as in rootLoader. `lastPaneUrl` also flips to undefined whenever rootLoader sees
  // a non-pane URL, so opening a pane (even one just left) reads as a navigation, and polling within it
  // (same URL) reads as a revalidation.
  const url = request?.url;
  const isNavigation = lastPaneUrl !== url;
  lastPaneUrl = url;

  // Fast path: navigating to a pane during a known, escalated outage shows its last-known mirror (or an
  // empty degraded pane if never visited) INSTANTLY — never a 10s hang on a fetch that can't land.
  if (isNavigation && isLostLatched()) return stalePane(paneId, session, lines);

  try {
    // On a 304 fetchPane returns the cached body, so `read.text` is populated either way; the
    // `?? lastPaneText` is just belt-and-suspenders. Both paths are a success (not the error
    // branch) so the connection bar doesn't flicker on an unchanged poll.
    const read: PaneReadResponse = await fetchPane(paneId, lines, session, request?.signal);
    const text = read.text || lastPaneText.get(key) || "";
    rememberPaneText(key, text);
    return { paneId, session, text, truncated: read.truncated, requestedLines: lines, revision: read.revision, error: false };
  } catch (e) {
    if (isAbortError(e)) throw e; // superseded revalidation — let React Router drop it
    // Genuine network / server failure: show stale text flagged as degraded.
    return stalePane(paneId, session, lines);
  }
}
