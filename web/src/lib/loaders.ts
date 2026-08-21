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

import { fetchHistory, fetchPane, fetchSnapshot, isApiErrorStatus } from "@/lib/api";
import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { isLostLatched } from "@/lib/connection-health";
import {
  dropLastPaneText,
  loadLastPaneText,
  loadLastSnapshot,
  saveLastPaneText,
  saveLastSnapshot,
} from "@/lib/last-seen";
import { detectNoEchoPrompt } from "@/lib/no-echo";
import { SESSION_PARAM, normalizeSession } from "@/lib/session";
import type {
  AgentView,
  BridgeStatus,
  DeviceAuth,
  PaneHistoryResponse,
  PaneReadResponse,
  SessionSummary,
  SnapshotResponse,
  TabView,
  TranscriptEntry,
  UpdateInfo,
  WorkspaceView,
} from "@/lib/types";

// A superseded revalidation is aborted via the loader's request.signal; that surfaces as an
// AbortError we must RETHROW so React Router discards the stale run — swallowing it into the
// stale-data/error-banner path would flash a spurious "reconnecting…" on every fast poll.
function isAbortError<TThrown>(e: TThrown): boolean {
  // `fetch` rejects an aborted request with a DOMException, which is an Error subclass in every
  // engine Collie runs in (and in jsdom) — so an `instanceof Error` test reaches it without having
  // to inspect the shape of an arbitrary thrown value.
  return e instanceof Error && e.name === "AbortError";
}

// The root route's id, paired with rootLoader. Children read its data via
// `useRouteLoaderData(ROOT_ROUTE_ID)`; keeping it a constant means a rename is a single edit, not a
// silent runtime `undefined` from a stale string literal.
export const ROOT_ROUTE_ID = "root";

// The pane route's id, paired with paneLoader. Named for the same reason ROOT_ROUTE_ID is — and used
// by exactly one thing: RootLayout reads this route's data (undefined unless a pane is the active
// route) so the connection bar can date the MIRROR on screen rather than the herd behind it.
export const PANE_ROUTE_ID = "pane";

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
  /** True when the failed refresh was rejected with HTTP 401 or 403. */
  authError: boolean;
  /**
   * When this herd was actually fetched — set ONLY on a stale render, and only when the write-through
   * cache can date it (lib/last-seen.ts). It is what lets the UI say "last seen 14:32" instead of
   * showing an undated old screen; absent means live data, or stale data we cannot date.
   */
  lastSeenAt?: number;
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
  /** True when the failed refresh was rejected with HTTP 401 or 403. */
  authError: boolean;
  /** When this mirror was actually fetched — set only on a datable stale render, as on HomeData. */
  lastSeenAt?: number;
}

// Keep-previous-data cache is now PER-SESSION: switching sessions must not show the other session's
// herd flagged as stale. Keyed by session name ("" = primary).
const lastSnapshot = new Map<string, SnapshotResponse>();

// A latched navigation skips the network, so retain whether the last real outcome for each session
// was an auth rejection. Store only rejected sessions; every other real outcome removes the marker.
const authErrorSessions = new Set<string>();

function rememberAuthError(session: string | undefined, authError: boolean): void {
  const key = session ?? "";
  if (authError) authErrorSessions.add(key);
  else authErrorSessions.delete(key);
}

function hasAuthError(session: string | undefined): boolean {
  return authErrorSessions.has(session ?? "");
}

function isAuthError<TThrown>(error: TThrown): boolean {
  return isApiErrorStatus(error, 401) || isApiErrorStatus(error, 403);
}

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

function toHomeData(
  snap: SnapshotResponse,
  session: string | undefined,
  error: boolean,
  lastSeenAt?: number,
): HomeData {
  return {
    lastSeenAt,
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
    authError: error && hasAuthError(session),
  };
}

// Last-known home for a session, flagged stale — the cached snapshot if we have one, else an empty
// error snapshot. Shared by BOTH the failed-refresh catch and the offline navigation fast path, so the
// two return byte-identical shapes (the UI can't tell "fetch just failed" from "navigated while known-
// offline" — both are "stale-but-present, flagged").
//
// Two tiers, in this order: the module cache (this page's own last good fetch), then the write-through
// sessionStorage cache (lib/last-seen.ts). The second tier is what a COLD boot reads — a discarded and
// restored PWA has an empty module cache and a failing first fetch, and without it the operator gets an
// empty herd instead of the screen they left. A restored snapshot is promoted into the module cache so
// the rest of this page session behaves exactly as if we had fetched it.
function staleHome(session: string | undefined): HomeData {
  const restored = loadLastSnapshot(session);
  const cached = lastSnapshot.get(session ?? "") ?? restored?.value;
  if (cached) {
    lastSnapshot.set(session ?? "", cached);
    return toHomeData(cached, session, true, restored?.at);
  }
  // Nothing cached at all — an outage on a tab that never saw a good snapshot. `error: true` is what
  // keeps this apart from a genuinely empty herd downstream: the empty state is only allowed to say
  // "No agents running" when the bridge really answered (components/agent-list.tsx).
  return {
    lastSeenAt: undefined,
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
    authError: hasAuthError(session),
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
    // Write-through: the same body, dated, in a store that outlives this page (lib/last-seen.ts).
    saveLastSnapshot(session, snap);
    rememberAuthError(session, false);
    return toHomeData(snap, session, false);
  } catch (e) {
    if (isAbortError(e)) throw e; // superseded revalidation — let React Router drop it
    rememberAuthError(session, isAuthError(e));
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
// "Load older" raises the requested window by a step per tap, up to a cap.
//
// The cap is 1000 because HERDR clamps `pane.read` there — silently, and without setting `truncated`.
// Live-probed against a pane holding 6895 lines of scrollback: 999→1000, 1000→1001, 2000→1001,
// 6000→1001. Asking for more than 1000 returns the same 1000 lines, so a higher cap only bought taps
// that fetched nothing new. (The bridge's own MAX_READ_LINES=10000 is the outer guard; this is the
// real ceiling.) If Herdr ever lifts its clamp, raise this to match.
const DETAIL_HISTORY_STEP = 600;
export const DETAIL_HISTORY_MAX = 1000;

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
//
// Same two tiers as staleHome: the module cache, then the write-through sessionStorage mirror that
// survives the page being discarded. A restored mirror is promoted into the module cache.
function stalePane(paneId: string, session: string | undefined, lines: number): PaneData {
  const key = paneKey(paneId, session);
  const restored = loadLastPaneText(session, paneId);
  const text = lastPaneText.get(key) ?? restored?.value ?? "";
  if (text) rememberPaneText(key, text);
  return {
    paneId,
    session,
    text,
    truncated: false,
    requestedLines: lines,
    revision: 0,
    error: true,
    authError: hasAuthError(session),
    lastSeenAt: text ? restored?.at : undefined,
  };
}

// How much of the mirror the check below parses. `detectNoEchoPrompt` reads the last two NON-BLANK
// lines, so 40 gives the same answer as 600 for a fraction of the work on every poll: a prompt with
// 38 blank lines under it is not a terminal blocked waiting for a password.
const NO_ECHO_TAIL_LINES = 40;

/**
 * Whether this mirror is a pane sitting at a password prompt — the ADR 0017 exclusion.
 *
 * Recognition already exists and already changes what Collie SAYS (lib/no-echo.ts); this is the one
 * other thing it changes, and it is a subtraction: a screen the operator is being asked to type a
 * secret into is not written to the browser's store, and whatever was written for that pane earlier is
 * dropped. Note what it is NOT about — the prompt echoes nothing, so there is no secret on the screen
 * to leak. It is about the pane the operator is answering `sudo` in not being kept, and about the next
 * read of that pane never being the one that restores it.
 */
function holdsNoEchoPrompt(text: string): boolean {
  const tail = text.split("\n").slice(-NO_ECHO_TAIL_LINES).join("\n");
  return detectNoEchoPrompt(splitLines(parseAnsi(tail))) !== null;
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
    // Write-through, EXCEPT while the pane is asking for a secret — see holdsNoEchoPrompt (ADR 0017).
    if (holdsNoEchoPrompt(text)) dropLastPaneText(session, paneId);
    else saveLastPaneText(session, paneId, text);
    rememberAuthError(session, false);
    return {
      paneId,
      session,
      text,
      truncated: read.truncated,
      requestedLines: lines,
      revision: read.revision,
      error: false,
      authError: false,
    };
  } catch (e) {
    if (isAbortError(e)) throw e; // superseded revalidation — let React Router drop it
    rememberAuthError(session, isAuthError(e));
    // Genuine network / server failure: show stale text flagged as degraded.
    return stalePane(paneId, session, lines);
  }
}

// ── Pane history (the agent's own transcript) ─────────────────────────────────
//
// A Claude pane runs on the terminal's ALTERNATE SCREEN, which keeps no scrollback ring — Herdr can
// only ever hand us the visible viewport, so "load older" against the mirror is physically
// impossible. The real history lives in the agent's own session log, and this loader fetches its
// newest page. Unlike the pane loader this one is NOT on the poll loop: the history route sets
// `shouldRevalidate: () => false` (see router.tsx), because re-pulling a 900-turn transcript every
// 1.5s would be pure waste and would fight the component's own "load older" paging.

/**
 * Turns requested when the history view opens.
 *
 * "Show entire history" is taken literally: the point of this view is that the terminal mirror
 * CAN'T show you the past, so opening it and still being 40 turns from the start would miss the
 * point. This is high enough to swallow whole conversations (the longest measured live: 1415 turns);
 * `hasMore` + "Load older" remain for anything beyond it, so a pathological log still degrades to
 * paging rather than a stall.
 */
export const HISTORY_PAGE_SIZE = 5000;

export interface HistoryData {
  paneId: string;
  session: string | undefined;
  /** Oldest-first. Empty when unavailable or on a failed fetch. */
  entries: TranscriptEntry[];
  /** Older turns exist before `entries[0]` — the view pages back with `before`. */
  hasMore: boolean;
  total: number;
  /** The log was byte-capped, so even the oldest page isn't the true start. */
  fileTruncated: boolean;
  /** Why there's nothing to show; undefined when history IS available. */
  unavailable?: "disabled" | "no-session" | "no-log" | "error";
}

export async function historyLoader({
  params,
  request,
}: {
  params: { paneId?: string };
  request?: Request;
}): Promise<HistoryData> {
  const { paneId } = params;
  if (!paneId) throw new Error("historyLoader: missing :paneId route param");
  const session = sessionFromRequest(request);
  const base = { paneId, session, entries: [], hasMore: false, total: 0, fileTruncated: false };

  try {
    const res: PaneHistoryResponse = await fetchHistory(
      paneId,
      { limit: HISTORY_PAGE_SIZE },
      session,
      request?.signal,
    );
    if (!res.available) return { ...base, unavailable: res.reason };
    return {
      paneId,
      session,
      entries: res.entries,
      hasMore: res.hasMore,
      total: res.total,
      fileTruncated: res.fileTruncated,
    };
  } catch (e) {
    if (isAbortError(e)) throw e; // superseded — let React Router drop it
    return { ...base, unavailable: "error" };
  }
}
