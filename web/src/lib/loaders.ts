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
  /** True when this render is the last-good snapshot after a failed refresh. */
  error: boolean;
}

export interface PaneData {
  paneId: string;
  text: string;
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
    error,
  };
}

export async function rootLoader(): Promise<HomeData> {
  try {
    const snap = await fetchSnapshot();
    lastSnapshot = snap;
    return toHomeData(snap, false);
  } catch {
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
          error: true,
        };
  }
}

const lastPaneText = new Map<string, string>();

// The detail view pulls a deeper window than the home snapshot's status reads, so you can scroll
// back through a long exchange. The live tail still follows; scrolling up freezes it (see
// AgentChat). Larger = more scrollback but more bytes per poll — 600 holds several exchanges.
const DETAIL_HISTORY_LINES = 600;

export async function paneLoader({
  params,
}: {
  params: { paneId?: string };
}): Promise<PaneData> {
  const { paneId } = params;
  // The route is `/pane/:paneId`, so a missing param means a misconfigured route, not a user state
  // — fail loudly to the error boundary rather than fetching `/api/pane/` and rendering an empty pane.
  if (!paneId) throw new Error("paneLoader: missing :paneId route param");
  try {
    // On a 304 fetchPane returns the cached body, so `read.text` is populated either way; the
    // `?? lastPaneText` is just belt-and-suspenders. Both paths are a success (not the error
    // branch) so the connection bar doesn't flicker on an unchanged poll.
    const read: PaneReadResponse = await fetchPane(paneId, DETAIL_HISTORY_LINES);
    const text = read.text || lastPaneText.get(paneId) || "";
    lastPaneText.set(paneId, text);
    return { paneId, text, error: false };
  } catch {
    // Genuine network / server failure: show stale text flagged as degraded.
    return { paneId, text: lastPaneText.get(paneId) ?? "", error: true };
  }
}
