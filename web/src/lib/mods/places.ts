// THE TWO FIRST PLACES, THE PURE HALF (M94 slice 03): the mod sessions out of the herd, where a tap's
// draft and open go, and the belt's marks in order. The components are `mod-session-row.tsx`,
// `mod-space-section.tsx`, `routes/mod-session.tsx` and the belt in `actions-row.tsx`.
//
// A MOD SESSION IS NOT A PANE OF THE HERD. The bridge sends it on the snapshot as a pane of
// `kind: "mod"` in the host's Mods Space, so its subtitle, badge and progress ride the pane fields.
// The root loader takes those panes, their Space and their tabs out of the lists every other screen
// reads, into `HomeData.modSessions`. So the dashboard's groups, its counts and its corner mark, the
// app icon's count, the needs-you switch, the Spaces navigator, the Files tab and the poll cadence
// never meet one, and none of them needed a line changed to stay that way. Only the places this slice
// draws read the list: the Mods Space on the Dashboard, its rows in Switch session, and its screen.

import { MOD_SESSION_PREFIX, isScopeKey, parseModSessionId } from "./schema";
import type { AgentView, TabView, WorkspaceView } from "../types";

/** Whether a pane is a mod's own session. */
export function isModPane(pane: Pick<AgentView, "kind">): boolean {
  return pane.kind === "mod";
}

/** Whether a Space or a tab id is a Mods Space's or a mod's tab (schema.ts `modSpaceId`, `modSessionId`). */
export function isModPlaceId(id: string): boolean {
  return id.startsWith(MOD_SESSION_PREFIX);
}

/** The lists a snapshot carries, with the mod sessions taken out of them. */
export interface ModSplit {
  agents: AgentView[];
  shellPanes: AgentView[];
  workspaces: WorkspaceView[];
  tabs: TabView[];
  /** The mod sessions in the bridge's order: Space, tab (manifest order), part. */
  modSessions: AgentView[];
}

/**
 * Take the mod sessions out of a snapshot's lists. The common case, a body with none, hands every
 * list back as the same array, so nothing downstream re-renders for it.
 */
export function splitModSessions(lists: {
  agents: AgentView[];
  shellPanes: AgentView[];
  workspaces: WorkspaceView[];
  tabs: TabView[];
}): ModSplit {
  const any = lists.agents.some(isModPane) || lists.shellPanes.some(isModPane);
  if (!any) return { ...lists, modSessions: [] };
  const modSessions = [...lists.agents, ...lists.shellPanes].filter(isModPane);
  return {
    agents: lists.agents.filter((pane) => !isModPane(pane)),
    shellPanes: lists.shellPanes.filter((pane) => !isModPane(pane)),
    workspaces: lists.workspaces.filter((space) => !isModPlaceId(space.workspaceId)),
    tabs: lists.tabs.filter((tab) => !isModPlaceId(tab.tabId)),
    modSessions,
  };
}

/** The mod session an open names: `mod:<host>:<id>` is the mod's first session part, with `:<part>` that part. */
export function findModSession(id: string, sessions: readonly AgentView[]): AgentView | undefined {
  const address = parseModSessionId(id);
  if (address === undefined) return undefined;
  const exact = sessions.find((pane) => pane.paneId === id);
  if (exact !== undefined) return exact;
  if (address.part !== undefined) return undefined;
  return sessions.find((pane) => parseModSessionId(pane.paneId)?.mod === address.mod && parseModSessionId(pane.paneId)?.host === address.host);
}

/**
 * The real pane a scope key (`host:paneId`, design §3.1) names. `modsHost` is the host the bridge's
 * own mods run on (the tapped part's), which is the name its panes go by in a key: on a solo snapshot
 * they carry no host at all, and on a crew the lead's panes carry the lead's id. A mod session never
 * matches: it has no reply box (schema.ts `isScopeKey` refuses its id too).
 */
export function findScopedPane(key: string, panes: readonly AgentView[], modsHost: string): AgentView | undefined {
  if (!isScopeKey(key)) return undefined;
  const colon = key.indexOf(":");
  const host = key.slice(0, colon);
  const paneId = key.slice(colon + 1);
  const mine = host === modsHost;
  return panes.find((pane) => pane.paneId === paneId && !isModPane(pane) && (pane.host === host || (mine && pane.host === undefined)));
}

/** What placing a draft came to: placed in an empty box, or refused because the box holds text. */
export type DraftPlacement = "placed" | "box-has-text" | "no-session";

/**
 * The draft rule of the design (section 8): a draft fills an EMPTY reply box and never overwrites
 * text. `current` is what the box holds now (the draft store, or the mounted composer's own text).
 */
export function draftPlacement(current: string | null | undefined, target: AgentView | undefined): DraftPlacement {
  if (target === undefined) return "no-session";
  return (current ?? "").trim() === "" ? "placed" : "box-has-text";
}
