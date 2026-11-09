// THE TWO FIRST PLACES, THE PURE HALF (M94 slice 03): the trick sessions out of the herd, where a
// link's session goes, and the belt's marks in order. The components are `trick-session-row.tsx`,
// `trick-space-section.tsx`, `routes/trick-session.tsx` and the belt in `actions-row.tsx`.
//
// A TRICK SESSION IS NOT A PANE OF THE HERD. The bridge sends it on the snapshot as a pane of
// `kind: "trick"` in the host's Tricks Space, so its subtitle, badge and progress ride the pane fields.
// The root loader takes those panes, their Space and their tabs out of the lists every other screen
// reads, into `HomeData.trickSessions`. So the dashboard's groups, its counts and its corner mark, the
// app icon's count, the needs-you switch, the Spaces navigator, the Files tab and the poll cadence
// never meet one, and none of them needed a line changed to stay that way. Only the places this slice
// draws read the list: the Tricks Space on the Dashboard, its rows in Switch session, and its screen.

import { TRICK_SESSION_PREFIX, isScopeKey, parseTrickSessionId } from "./schema";
import type { AgentView, TabView, WorkspaceView } from "../types";

/** Whether a pane is a trick's own session. */
export function isTrickPane(pane: Pick<AgentView, "kind">): boolean {
  return pane.kind === "trick";
}

/** Whether a Space or a tab id is a Tricks Space's or a trick's tab (schema.ts `trickSpaceId`, `trickSessionId`). */
export function isTrickPlaceId(id: string): boolean {
  return id.startsWith(TRICK_SESSION_PREFIX);
}

/** The lists a snapshot carries, with the trick sessions taken out of them. */
export interface TrickSplit {
  agents: AgentView[];
  shellPanes: AgentView[];
  workspaces: WorkspaceView[];
  tabs: TabView[];
  /** The trick sessions in the bridge's order: Space, tab (manifest order), part. */
  trickSessions: AgentView[];
}

/**
 * Take the trick sessions out of a snapshot's lists. The common case, a body with none, hands every
 * list back as the same array, so nothing downstream re-renders for it.
 */
export function splitTrickSessions(lists: {
  agents: AgentView[];
  shellPanes: AgentView[];
  workspaces: WorkspaceView[];
  tabs: TabView[];
}): TrickSplit {
  const any = lists.agents.some(isTrickPane) || lists.shellPanes.some(isTrickPane);
  if (!any) return { ...lists, trickSessions: [] };
  const trickSessions = [...lists.agents, ...lists.shellPanes].filter(isTrickPane);
  return {
    agents: lists.agents.filter((pane) => !isTrickPane(pane)),
    shellPanes: lists.shellPanes.filter((pane) => !isTrickPane(pane)),
    workspaces: lists.workspaces.filter((space) => !isTrickPlaceId(space.workspaceId)),
    tabs: lists.tabs.filter((tab) => !isTrickPlaceId(tab.tabId)),
    trickSessions,
  };
}

/** The trick session an open names: `trick:<host>:<id>` is the trick's first session part, with `:<part>` that part. */
export function findTrickSession(id: string, sessions: readonly AgentView[]): AgentView | undefined {
  const address = parseTrickSessionId(id);
  if (address === undefined) return undefined;
  const exact = sessions.find((pane) => pane.paneId === id);
  if (exact !== undefined) return exact;
  if (address.part !== undefined) return undefined;
  return sessions.find((pane) => parseTrickSessionId(pane.paneId)?.trick === address.trick && parseTrickSessionId(pane.paneId)?.host === address.host);
}

/**
 * The real pane a scope key (`host:paneId`, design §3.1) names. `tricksHost` is the host the bridge's
 * own tricks run on (the tapped part's), which is the name its panes go by in a key: on a solo snapshot
 * they carry no host at all, and on a crew the lead's panes carry the lead's id. A trick session never
 * matches: it has no reply box (schema.ts `isScopeKey` refuses its id too).
 */
export function findScopedPane(key: string, panes: readonly AgentView[], tricksHost: string): AgentView | undefined {
  if (!isScopeKey(key)) return undefined;
  const colon = key.indexOf(":");
  const host = key.slice(0, colon);
  const paneId = key.slice(colon + 1);
  const mine = host === tricksHost;
  return panes.find((pane) => pane.paneId === paneId && !isTrickPane(pane) && (pane.host === host || (mine && pane.host === undefined)));
}
