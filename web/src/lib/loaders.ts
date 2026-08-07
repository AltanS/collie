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
import { isLostLatched } from "@/lib/connection-health";
import { internScope, paneScopeKey, type Scope, scopeFromUrl, scopeKey } from "@/lib/scope";
import type {
  AgentView,
  BridgeStatus,
  DeviceAuth,
  PaneHistoryResponse,
  PaneReadResponse,
  ServerSummary,
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

// The scope a loader run was addressed to — which machine (`?h=`) and which named session (`?s=`),
// read off the request URL. Extracted once per run and threaded into every fetch + cache key, so a
// host OR session switch (a plain URL change picked up by the revalidator) is automatically correct.
// Both absent = the lead's primary session, i.e. today's behaviour on today's URLs.
//
// Free consequence worth naming: because the host rides in the URL, a host switch changes the URL,
// so the nav-vs-revalidate discriminator below already classifies it as a NAVIGATION — the offline
// fast path is correct for it without a special case.
function scopeFromRequest(request?: Request): Scope {
  // Interned, so `data.scope` keeps a STABLE identity across revalidations — it replaces a plain
  // string in React dep arrays and in identity compares, and must not churn on every poll.
  return internScope(scopeFromUrl(request?.url));
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
  /**
   * The pack roster (lead first); EMPTY on a solo bridge, which emits no `servers` at all. Kept as
   * an array rather than `ServerSummary[] | undefined` for the same reason `sessions` is: consumers
   * ask "more than one?" (lib/hosts.ts `isMultiHost`), never "was the key present?".
   */
  servers: ServerSummary[];
  /** The scope this snapshot was fetched for (host + session) — so children don't re-derive it. */
  scope: Scope;
  /** Active notification snooze deadline (epoch ms), or null when not snoozed. */
  snoozedUntil: number | null;
  /** Version / upgrade status for the footer update banner; undefined on an older bridge. */
  update: UpdateInfo | undefined;
  /** True when this render is the last-good snapshot after a failed refresh. */
  error: boolean;
  /** True when the failed refresh was rejected with HTTP 401 or 403. */
  authError: boolean;
}

export interface PaneData {
  paneId: string;
  /** The scope this pane was fetched in (host + session) — threaded into every read and write, so
   * a reply can never land on the right pane name on the wrong machine. */
  scope: Scope;
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
}

// Keep-previous-data cache is PER-SCOPE: switching host or session must not show the other one's
// herd flagged as stale. Keyed by the NUL-joined (host, session) pair via lib/scope.
const lastSnapshot = new Map<string, SnapshotResponse>();

// A latched navigation skips the network, so retain whether the last real outcome for each scope was
// an auth rejection. Store only rejected scopes; every other real outcome removes the marker.
const authErrorScopes = new Set<string>();

function rememberAuthError(scope: Scope, authError: boolean): void {
  const key = scopeKey(scope);
  if (authError) authErrorScopes.add(key);
  else authErrorScopes.delete(key);
}

function hasAuthError(scope: Scope): boolean {
  return authErrorScopes.has(scopeKey(scope));
}

function isAuthError(error: unknown): boolean {
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

function toHomeData(snap: SnapshotResponse, scope: Scope, error: boolean): HomeData {
  return {
    bridge: snap.bridge,
    device: snap.device,
    agents: snap.agents,
    shellPanes: snap.shellPanes ?? [],
    workspaces: snap.workspaces ?? [],
    tabs: snap.tabs ?? [],
    sessions: snap.sessions ?? [],
    servers: snap.servers ?? [],
    scope,
    snoozedUntil: snap.notifications?.snoozedUntil ?? null,
    update: snap.update,
    error,
    authError: error && hasAuthError(scope),
  };
}

// Last-known home for a scope, flagged stale — the cached snapshot if we have one, else an empty
// error snapshot. Shared by BOTH the failed-refresh catch and the offline navigation fast path, so the
// two return byte-identical shapes (the UI can't tell "fetch just failed" from "navigated while known-
// offline" — both are "stale-but-present, flagged").
function staleHome(scope: Scope): HomeData {
  const cached = lastSnapshot.get(scopeKey(scope));
  return cached
    ? toHomeData(cached, scope, true)
    : {
        bridge: undefined,
        device: undefined,
        agents: [],
        shellPanes: [],
        workspaces: [],
        tabs: [],
        sessions: [],
        servers: [],
        scope,
        snoozedUntil: null,
        update: undefined,
        error: true,
        authError: hasAuthError(scope),
      };
}

export async function rootLoader({ request }: { request?: Request } = {}): Promise<HomeData> {
  const scope = scopeFromRequest(request);
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
  if (isNavigation && isLostLatched()) return staleHome(scope);

  try {
    const snap = await fetchSnapshot(scope, request?.signal);
    lastSnapshot.set(scopeKey(scope), snap);
    rememberAuthError(scope, false);
    return toHomeData(snap, scope, false);
  } catch (e) {
    if (isAbortError(e)) throw e; // superseded revalidation — let React Router drop it
    rememberAuthError(scope, isAuthError(e));
    // Keep the last good herd on screen, flagged so the ConnectionBanner can say "reconnecting…".
    return staleHome(scope);
  }
}

// Pane ids are unique only within one session on one machine, so every per-pane cache is keyed by
// the whole (host, session, paneId) triple. The key is built by lib/scope, shared with api.ts's
// ETag cache — the two must not hand-roll the same string.
function paneKey(paneId: string, scope?: Scope): string {
  return paneScopeKey(scope, paneId);
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
export function getRequestedLines(paneId: string, scope?: Scope): number {
  return requestedLines.get(paneKey(paneId, scope)) ?? DETAIL_HISTORY_LINES;
}

/** True while more scrollback can still be requested (below the cap). */
export function canGrowRequestedLines(paneId: string, scope?: Scope): boolean {
  return getRequestedLines(paneId, scope) < DETAIL_HISTORY_MAX;
}

/** Raise the requested scrollback by one step (capped) and return the new value. */
export function growRequestedLines(paneId: string, scope?: Scope): number {
  const next = Math.min(getRequestedLines(paneId, scope) + DETAIL_HISTORY_STEP, DETAIL_HISTORY_MAX);
  requestedLines.set(paneKey(paneId, scope), next);
  if (requestedLines.size > PANE_TEXT_MAX) {
    const oldest = requestedLines.keys().next().value;
    if (oldest !== undefined) requestedLines.delete(oldest);
  }
  return next;
}

/** Reset a pane's requested scrollback back to the base window (used by tests). */
export function resetRequestedLines(paneId?: string, scope?: Scope): void {
  if (paneId === undefined) requestedLines.clear();
  else requestedLines.delete(paneKey(paneId, scope));
}

// Last-known pane payload, flagged degraded — stale text (empty if this pane was never fetched),
// truncated cleared, revision 0 (the prompt-select guard rejects a 0-revision mismatch anyway). Shared
// by the failed-refresh catch and the offline navigation fast path, so both return the same shape.
function stalePane(paneId: string, scope: Scope, lines: number): PaneData {
  return {
    paneId,
    scope,
    text: lastPaneText.get(paneKey(paneId, scope)) ?? "",
    truncated: false,
    requestedLines: lines,
    revision: 0,
    error: true,
    authError: hasAuthError(scope),
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
  const scope = scopeFromRequest(request);
  const key = paneKey(paneId, scope);
  const lines = getRequestedLines(paneId, scope);
  // Nav-vs-revalidate, as in rootLoader. `lastPaneUrl` also flips to undefined whenever rootLoader sees
  // a non-pane URL, so opening a pane (even one just left) reads as a navigation, and polling within it
  // (same URL) reads as a revalidation.
  const url = request?.url;
  const isNavigation = lastPaneUrl !== url;
  lastPaneUrl = url;

  // Fast path: navigating to a pane during a known, escalated outage shows its last-known mirror (or an
  // empty degraded pane if never visited) INSTANTLY — never a 10s hang on a fetch that can't land.
  if (isNavigation && isLostLatched()) return stalePane(paneId, scope, lines);

  try {
    // On a 304 fetchPane returns the cached body, so `read.text` is populated either way; the
    // `?? lastPaneText` is just belt-and-suspenders. Both paths are a success (not the error
    // branch) so the connection bar doesn't flicker on an unchanged poll.
    const read: PaneReadResponse = await fetchPane(paneId, lines, scope, request?.signal);
    const text = read.text || lastPaneText.get(key) || "";
    rememberPaneText(key, text);
    rememberAuthError(scope, false);
    return {
      paneId,
      scope,
      text,
      truncated: read.truncated,
      requestedLines: lines,
      revision: read.revision,
      error: false,
      authError: false,
    };
  } catch (e) {
    if (isAbortError(e)) throw e; // superseded revalidation — let React Router drop it
    rememberAuthError(scope, isAuthError(e));
    // Genuine network / server failure: show stale text flagged as degraded.
    return stalePane(paneId, scope, lines);
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
  scope: Scope;
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
  const scope = scopeFromRequest(request);
  const base = { paneId, scope, entries: [], hasMore: false, total: 0, fileTruncated: false };

  try {
    const res: PaneHistoryResponse = await fetchHistory(
      paneId,
      { limit: HISTORY_PAGE_SIZE },
      scope,
      request?.signal,
    );
    if (!res.available) return { ...base, unavailable: res.reason };
    return {
      paneId,
      scope,
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
