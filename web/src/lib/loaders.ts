// React Router data loaders — the replacement for the old TanStack Query reads. The home/detail
// routes declare these as `loader`s; polling is just `useRevalidator().revalidate()` re-running
// them (see hooks/use-polling.ts). Each loader keeps the last good result in a module cache so a
// transient fetch failure shows stale-but-present data (flagged) instead of flashing empty — the
// behaviour TanStack gave us via `placeholderData: keepPreviousData`.

import { fetchPane, fetchSnapshot } from "@/lib/api";
import type {
  AgentView,
  BridgeStatus,
  PaneReadResponse,
  SnapshotResponse,
  TabView,
  WorkspaceView,
} from "@/lib/types";

export interface HomeData {
  bridge: BridgeStatus | undefined;
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
      : { bridge: undefined, agents: [], shellPanes: [], workspaces: [], tabs: [], error: true };
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
  const paneId = params.paneId ?? "";
  try {
    const read: PaneReadResponse = await fetchPane(paneId, DETAIL_HISTORY_LINES);
    lastPaneText.set(paneId, read.text);
    return { paneId, text: read.text, error: false };
  } catch {
    return { paneId, text: lastPaneText.get(paneId) ?? "", error: true };
  }
}
