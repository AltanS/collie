// React Router data loaders are the data layer — there is intentionally no separate data-fetching
// library. The home/detail routes declare these as `loader`s; polling is just
// `useRevalidator().revalidate()` re-running them (see hooks/use-polling.ts). Each loader keeps the
// last good result in a module cache so a transient fetch failure shows stale-but-present data
// (flagged) instead of flashing empty — i.e. keep-previous-data while a refetch is in flight.

import { fetchPane, fetchSnapshot } from "@/lib/api";
import type {
  AgentView,
  BridgeStatus,
  DeviceAuth,
  PaneReadResponse,
  SnapshotResponse,
  TabView,
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

export interface HomeData {
  bridge: BridgeStatus | undefined;
  /** Per-device authorisation; undefined when the feature is off or not yet known. */
  device: DeviceAuth | undefined;
  agents: AgentView[];
  shellPanes: AgentView[];
  workspaces: WorkspaceView[];
  tabs: TabView[];
  /** Active notification snooze deadline (epoch ms), or null when not snoozed. */
  snoozedUntil: number | null;
  /** True when this render is the last-good snapshot after a failed refresh. */
  error: boolean;
}

export interface PaneData {
  paneId: string;
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

let lastSnapshot: SnapshotResponse | null = null;

function toHomeData(snap: SnapshotResponse, error: boolean): HomeData {
  return {
    bridge: snap.bridge,
    device: snap.device,
    agents: snap.agents,
    shellPanes: snap.shellPanes ?? [],
    workspaces: snap.workspaces ?? [],
    tabs: snap.tabs ?? [],
    snoozedUntil: snap.notifications?.snoozedUntil ?? null,
    error,
  };
}

export async function rootLoader({ request }: { request?: Request } = {}): Promise<HomeData> {
  try {
    const snap = await fetchSnapshot(request?.signal);
    lastSnapshot = snap;
    return toHomeData(snap, false);
  } catch (e) {
    if (isAbortError(e)) throw e; // superseded revalidation — let React Router drop it
    // Keep the last good herd on screen, flagged so the ConnectionBar can say "reconnecting…".
    return lastSnapshot
      ? toHomeData(lastSnapshot, true)
      : {
          bridge: undefined,
          device: undefined,
          agents: [],
          shellPanes: [],
          workspaces: [],
          tabs: [],
          snoozedUntil: null,
          error: true,
        };
  }
}

const lastPaneText = new Map<string, string>();
// Cap the per-pane stale-text cache so it can't grow without bound over a long session of opening
// many panes. Evict the oldest (insertion-order) entry beyond the cap — dumb FIFO is plenty for a
// phone that views one pane at a time.
const PANE_TEXT_MAX = 20;

function rememberPaneText(paneId: string, text: string): void {
  lastPaneText.set(paneId, text);
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
export function getRequestedLines(paneId: string): number {
  return requestedLines.get(paneId) ?? DETAIL_HISTORY_LINES;
}

/** True while more scrollback can still be requested (below the cap). */
export function canGrowRequestedLines(paneId: string): boolean {
  return getRequestedLines(paneId) < DETAIL_HISTORY_MAX;
}

/** Raise the requested scrollback by one step (capped) and return the new value. */
export function growRequestedLines(paneId: string): number {
  const next = Math.min(getRequestedLines(paneId) + DETAIL_HISTORY_STEP, DETAIL_HISTORY_MAX);
  requestedLines.set(paneId, next);
  if (requestedLines.size > PANE_TEXT_MAX) {
    const oldest = requestedLines.keys().next().value;
    if (oldest !== undefined) requestedLines.delete(oldest);
  }
  return next;
}

/** Reset a pane's requested scrollback back to the base window (used by tests). */
export function resetRequestedLines(paneId?: string): void {
  if (paneId === undefined) requestedLines.clear();
  else requestedLines.delete(paneId);
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
  const lines = getRequestedLines(paneId);
  try {
    // On a 304 fetchPane returns the cached body, so `read.text` is populated either way; the
    // `?? lastPaneText` is just belt-and-suspenders. Both paths are a success (not the error
    // branch) so the connection bar doesn't flicker on an unchanged poll.
    const read: PaneReadResponse = await fetchPane(paneId, lines, request?.signal);
    const text = read.text || lastPaneText.get(paneId) || "";
    rememberPaneText(paneId, text);
    return { paneId, text, truncated: read.truncated, requestedLines: lines, revision: read.revision, error: false };
  } catch (e) {
    if (isAbortError(e)) throw e; // superseded revalidation — let React Router drop it
    // Genuine network / server failure: show stale text flagged as degraded.
    return {
      paneId,
      text: lastPaneText.get(paneId) ?? "",
      truncated: false,
      requestedLines: lines,
      revision: 0,
      error: true,
    };
  }
}
