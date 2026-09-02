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

import {
  fetchDevices,
  fetchHistory,
  fetchPack,
  fetchPane,
  fetchSnapshot,
  isApiErrorStatus,
} from "@/lib/api";
import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { isLostLatched } from "@/lib/connection-health";
import { ambientSpaces } from "@/lib/hosts";
import {
  dropLastPaneText,
  loadLastPaneText,
  loadLastSnapshot,
  saveLastPaneText,
  saveLastSnapshot,
} from "@/lib/last-seen";
import { detectNoEchoPrompt } from "@/lib/no-echo";
import { markPollResult } from "@/lib/poll-intent";
import { clearNotPaired, markNotPaired } from "@/lib/pairing";
import {
  internScope,
  paneScopeKey,
  type Scope,
  scopeFromUrl,
  scopeKey,
  snapshotKey,
  viewAllFromUrl,
} from "@/lib/scope";
import type {
  AgentView,
  BridgeStatus,
  DeviceAuth,
  PackStatusResponse,
  PairedDeviceWire,
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
  /**
   * The snapshot's own timestamp — the LEAD's clock when it assembled this body. Carried because it
   * is the only sound thing to measure `ServerSummary.lastSeenAt` against, which the lead also stamps
   * (lib/host-health.ts; PACK_PROTOCOL.md §10.2). Measuring a peer's freshness with the phone's clock
   * would measure the skew between two machines instead. `0` on the empty stale shape below, where
   * there are no servers to date anyway.
   */
  ts: number;
  /** The scope this snapshot was fetched for (host + session) — so children don't re-derive it. */
  scope: Scope;
  /**
   * True when this body was WIDENED (`?all=1`): its pane lists hold every Herdr session on the
   * addressed machine, and every pane in them carries its own `session`. False is every view that
   * existed before, where the lists hold one session and no pane names it.
   *
   * Deliberately NOT folded into {@link scope}: a scope is an ADDRESS and this is a breadth. See
   * lib/scope.ts `ALL_PARAM` for the whole argument — the short version is that folding it in would
   * carry it onto every pane URL and split every per-pane cache entry in two.
   */
  viewAll: boolean;
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
  /** When this mirror was actually fetched — set only on a datable stale render, as on HomeData. */
  lastSeenAt?: number;
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
  scope: Scope,
  viewAll: boolean,
  error: boolean,
  lastSeenAt?: number,
): HomeData {
  return {
    lastSeenAt,
    bridge: snap.bridge,
    device: snap.device,
    agents: snap.agents,
    shellPanes: snap.shellPanes ?? [],
    // Narrowed to the address the URL is on, for the reason `ambientPanes` narrows the panes drawn
    // beside them: the navigator is a tree of ONE machine, and on a pack the lead's merged body now
    // carries every machine's spaces. A solo body carries no host on any row, so both calls pass
    // everything through by identity and nothing about a solo dashboard changes.
    workspaces: ambientSpaces(snap.workspaces ?? [], scope, snap.servers),
    tabs: ambientSpaces(snap.tabs ?? [], scope, snap.servers),
    sessions: snap.sessions ?? [],
    servers: snap.servers ?? [],
    ts: snap.ts ?? 0,
    scope,
    viewAll,
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
//
// Two tiers, in this order: the module cache (this page's own last good fetch), then the write-through
// sessionStorage cache (lib/last-seen.ts). The second tier is what a COLD boot reads — a discarded and
// restored PWA has an empty module cache and a failing first fetch, and without it the operator gets an
// empty herd instead of the screen they left. A restored snapshot is promoted into the module cache so
// the rest of this page session behaves exactly as if we had fetched it.
function staleHome(scope: Scope, viewAll: boolean): HomeData {
  const restored = loadLastSnapshot(scope, viewAll);
  const cached = lastSnapshot.get(snapshotKey(scope, viewAll)) ?? restored?.value;
  if (cached) {
    lastSnapshot.set(snapshotKey(scope, viewAll), cached);
    return toHomeData(cached, scope, viewAll, true, restored?.at);
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
    servers: [],
    ts: 0,
    scope,
    viewAll,
    snoozedUntil: null,
    update: undefined,
    error: true,
    authError: hasAuthError(scope),
  };
}

export async function rootLoader({ request }: { request?: Request } = {}): Promise<HomeData> {
  const scope = scopeFromRequest(request);
  // The BREADTH, read off the same URL as the address and kept beside it rather than inside it. It
  // is a home-view concept only: no other loader reads it, and nothing downstream may put it in a
  // pane URL (lib/scope.ts ALL_PARAM).
  const viewAll = viewAllFromUrl(request?.url);
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
  if (isNavigation && isLostLatched()) return staleHome(scope, viewAll);

  try {
    const snap = await fetchSnapshot(scope, request?.signal, viewAll);
    lastSnapshot.set(snapshotKey(scope, viewAll), snap);
    // Write-through: the same body, dated, in a store that outlives this page (lib/last-seen.ts).
    saveLastSnapshot(scope, snap, undefined, viewAll);
    rememberAuthError(scope, false);
    return toHomeData(snap, scope, viewAll, false);
  } catch (e) {
    if (isAbortError(e)) throw e; // superseded revalidation — let React Router drop it
    rememberAuthError(scope, isAuthError(e));
    // Keep the last good herd on screen, flagged so the ConnectionBanner can say "reconnecting…".
    return staleHome(scope, viewAll);
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
//
// Same two tiers as staleHome: the module cache, then the write-through sessionStorage mirror that
// survives the page being discarded. A restored mirror is promoted into the module cache.
function stalePane(paneId: string, scope: Scope, lines: number): PaneData {
  const key = paneKey(paneId, scope);
  const restored = loadLastPaneText(scope, paneId);
  const text = lastPaneText.get(key) ?? restored?.value ?? "";
  if (text) rememberPaneText(key, text);
  return {
    paneId,
    scope,
    text,
    truncated: false,
    requestedLines: lines,
    revision: 0,
    error: true,
    authError: hasAuthError(scope),
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
    // THE "IS THE SCREEN STILL MOVING" SIGNAL, taken at the one place that can honestly answer it.
    //
    // A 304 is the bridge saying the mirror is byte-identical, which is exactly "unchanged". The
    // text compare behind it is not redundant: a bridge that serves no ETag would otherwise report
    // every poll as a change and the burst would never end. Read BEFORE the write-through below,
    // since `rememberPaneText` is what makes this text the previous one.
    //
    // The cadence consumes it (hooks/use-polling.ts): a mirror that keeps moving is one the operator
    // is watching move.
    markPollResult(read.notModified !== true && text !== lastPaneText.get(key));
    rememberPaneText(key, text);
    // Write-through, EXCEPT while the pane is asking for a secret — see holdsNoEchoPrompt (ADR 0017).
    if (holdsNoEchoPrompt(text)) dropLastPaneText(scope, paneId);
    else saveLastPaneText(scope, paneId, text);
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

// ── Paired devices (the Settings registry) ────────────────────────────────────
//
// The settings route's loader. Unlike the snapshot this is NOT a live signal anything else depends
// on — it exists so the pairing card renders from route data (and so a revoke/pair is just
// `revalidator.revalidate()`, like every other mutation in the app). It rides the poll while
// Settings is open, which is what keeps a device revoked from another phone disappearing from the
// list here.

export interface DevicesData {
  /** Whether writes require a bearer token — i.e. whether anything at all is paired. */
  enforced: boolean;
  /** The label THIS device's token authenticated as, or null (unpaired, or its token was revoked). */
  current: string | null;
  devices: PairedDeviceWire[];
  /** True when the fetch failed — the lists below are then empty rather than authoritative. */
  error: boolean;
}

export async function devicesLoader({ request }: { request?: Request } = {}): Promise<DevicesData> {
  try {
    const res = await fetchDevices(request?.signal);
    // This read is the ONLY thing that can positively clear (or set) the refusal latch without a
    // write: it is the one endpoint that reports back who our token authenticated as. Enforcement
    // off means there is nothing to be unpaired from.
    if (!res.enforced || res.current !== null) clearNotPaired();
    else markNotPaired();
    return { enforced: res.enforced, current: res.current, devices: res.devices, error: false };
  } catch (e) {
    if (isAbortError(e)) throw e; // superseded revalidation — let React Router drop it
    // A failed read says nothing about pairing, so the latch is left exactly as it was.
    return { enforced: false, current: null, devices: [], error: true };
  }
}

// ── The pack census (the /pack overview) ─────────────────────────────────────
//
// The pack route's own loader, shaped exactly like `devicesLoader`: it rides the poll loop while the
// page is open (so a member going quiet shows up here without a reload), and a failure DEGRADES —
// it never throws, because a page that answers "how is my pack doing?" with an error boundary has
// answered the question badly.
//
// The 404 is not a failure and must not be rendered as one. Only a lead serves `/api/pack`; a solo
// collie and a peer refuse, and that refusal is the truthful answer "there is no pack here". So it
// is folded to `status: null, error: false`, and the route says so in one honest card. Every OTHER
// refusal — a real outage, a 500 — keeps `status: null` but sets `error`, because "I could not ask"
// and "there is nothing to ask about" are different sentences and the operator's next move differs.

export interface PackData {
  /** The census, or `null` when this collie leads no pack (404) or the fetch failed. */
  status: PackStatusResponse | null;
  /** True only for a fetch that FAILED — a 404 is an answer, not an error. */
  error: boolean;
}

export async function packLoader({ request }: { request?: Request } = {}): Promise<PackData> {
  try {
    return { status: await fetchPack(request?.signal), error: false };
  } catch (e) {
    if (isAbortError(e)) throw e; // superseded revalidation — let React Router drop it
    // Solo or peer: there is no pack to report, and that is a complete answer.
    if (isApiErrorStatus(e, 404)) return { status: null, error: false };
    return { status: null, error: true };
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
