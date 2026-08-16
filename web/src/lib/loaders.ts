// React Router data loaders are the data layer — there is intentionally no separate data-fetching
// library. The home/detail routes declare these as `loader`s; polling is just
// `useRevalidator().revalidate()` re-running them (see hooks/use-polling.ts). Each loader keeps its
// own last-good result in a module cache so a transient fetch failure shows stale data instead of
// flashing empty. Root-snapshot and pane freshness stay independent: every loader run attempts its
// own endpoint, and a successful or failed surface never changes another surface's outcome.

import { fetchHistory, fetchPane, fetchSnapshot, isApiErrorStatus } from "@/lib/api";
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
// AbortError we must RETHROW so React Router discards the stale run rather than treating a
// superseded poll as a genuine stale-freshness result.
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
  /** True only when the bridge explicitly advertises the server-side voice capability. */
  transcriptionEnabled: boolean;
  /** True when this render is stale after a failed root-snapshot refresh. */
  snapshotStale: boolean;
  /** True when the failed root-snapshot refresh was rejected with HTTP 401 or 403. */
  snapshotAuthError: boolean;
  /** True when a last-good root snapshot exists, including an intentionally empty snapshot. */
  snapshotHasLastGood: boolean;
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
   * the stale-text path, where the guard's fresh fetch will reject a mismatch anyway. */
  revision: number;
  /** True when this render is stale after a failed pane refresh. */
  paneStale: boolean;
  /** True when the failed pane refresh was rejected with HTTP 401 or 403. */
  paneAuthError: boolean;
  /** True when a last-good pane result exists, including intentionally empty output. */
  paneHasLastGood: boolean;
}

// Keep-previous-data cache is now PER-SESSION: switching sessions must not show the other session's
// herd flagged as stale. Keyed by session name ("" = primary).
const lastSnapshot = new Map<string, SnapshotResponse>();

function isAuthError(error: unknown): boolean {
  return isApiErrorStatus(error, 401) || isApiErrorStatus(error, 403);
}

function toHomeData(snap: SnapshotResponse, session: string | undefined): HomeData {
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
    // An older bridge omits the capability; fail closed to the existing text-only composer.
    transcriptionEnabled: snap.transcriptionEnabled ?? false,
    snapshotStale: false,
    snapshotAuthError: false,
    snapshotHasLastGood: lastSnapshot.has(session ?? ""),
  };
}

// Last-known root snapshot for a session, flagged stale. `Map.has()` deliberately distinguishes an
// intentionally empty cached snapshot from a cold failure with nothing to show.
function staleHome(session: string | undefined, snapshotAuthError: boolean): HomeData {
  const key = session ?? "";
  const snapshotHasLastGood = lastSnapshot.has(key);
  const cached = lastSnapshot.get(key);
  if (snapshotHasLastGood && cached) {
    return {
      ...toHomeData(cached, session),
      snapshotStale: true,
      snapshotAuthError,
      snapshotHasLastGood,
    };
  }
  return {
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
    transcriptionEnabled: false,
    snapshotStale: true,
    snapshotAuthError,
    snapshotHasLastGood,
  };
}

export async function rootLoader({ request }: { request?: Request } = {}): Promise<HomeData> {
  const session = sessionFromRequest(request);
  try {
    const snap = await fetchSnapshot(session, request?.signal);
    lastSnapshot.set(session ?? "", snap);
    return toHomeData(snap, session);
  } catch (e) {
    if (isAbortError(e)) throw e; // superseded revalidation — let React Router drop it
    return staleHome(session, isAuthError(e));
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

// Last-known pane payload, flagged stale. `Map.has()` deliberately distinguishes an empty cached
// pane from a cold failure with no output. The stale path clears metadata that cannot be current.
function stalePane(
  paneId: string,
  session: string | undefined,
  lines: number,
  paneAuthError: boolean,
): PaneData {
  const key = paneKey(paneId, session);
  const paneHasLastGood = lastPaneText.has(key);
  return {
    paneId,
    session,
    text: lastPaneText.get(key) ?? "",
    truncated: false,
    requestedLines: lines,
    revision: 0,
    paneStale: true,
    paneAuthError,
    paneHasLastGood,
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

  try {
    // On a 304 fetchPane returns the cached body, so `read.text` is populated either way. An empty
    // successful read is still authoritative and must replace rather than infer from the old text.
    const read: PaneReadResponse = await fetchPane(paneId, lines, session, request?.signal);
    const text = read.text;
    rememberPaneText(key, text);
    return {
      paneId,
      session,
      text,
      truncated: read.truncated,
      requestedLines: lines,
      revision: read.revision,
      paneStale: false,
      paneAuthError: false,
      paneHasLastGood: lastPaneText.has(key),
    };
  } catch (e) {
    if (isAbortError(e)) throw e; // superseded revalidation — let React Router drop it
    return stalePane(paneId, session, lines, isAuthError(e));
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
