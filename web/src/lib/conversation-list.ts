import { paneName } from "@/lib/pane-name";
import { paneSubtitle } from "@/lib/pane-marks";
import type { AgentView, DurableConversationRow } from "@/lib/types";

// THE DURABLE HOME'S LIST: a durable program's conversations, as a messaging app lists its chats.
//
// Two sources, merged here and nowhere else. The live panes of the snapshot say how an OPEN conversation
// is right now (working, waiting with its open asks, idle), and they are in hand the moment the dashboard
// draws. The program's own list (`/api/durable/conversations`, M53 spec 11) adds the CLOSED ones, and
// arrives a moment later. A conversation in both is one row, drawn from the pane. Nothing here touches the
// DOM or the network, so every rule is table-testable.
//
// ONE LIST, NO FILTERS (durable-simple, 2026-10-13). The four chips All, Open, Needs you and Closed were a
// second way to read one short list. The list orders itself instead: what waits on you first, then the
// other open conversations, newest first, then the closed ones under their own label.

/** The state mark a row draws. `waiting` is a pane that needs a person: blocked, or holding an open ask. */
export type ConversationState = "working" | "waiting" | "idle" | "closed";

/** One row of the list. */
export interface ConversationItem {
  /** Stable across the two sources: the program's conversation id when known, else the pane's. */
  key: string;
  /** The id the program serves this conversation's items under, when its list named it. */
  id: string | undefined;
  /** The live pane that shows it, when the snapshot holds one. A tap opens this pane. */
  pane: AgentView | undefined;
  /** The title as given. Empty means the program left it blank; the row says "Untitled conversation". */
  title: string;
  /**
   * The row's second line: the question that waits on you when one does, else the program's subtitle,
   * else null. A messaging app shows the newest message there; the question is the newest thing that
   * matters, and the subtitle is what the program says the conversation is about.
   */
  line: string | null;
  /** The second line is an open question, not the subtitle. */
  asking: boolean;
  state: ConversationState;
  /** Open asks on the pane, drawn as the count beside a waiting row's title. */
  asks: number;
  /** Epoch ms of the last thing that happened in it, or null when neither source says. */
  at: number | null;
  /** The workspace it sits in, when either source says, for grouping. */
  workspaceId: string | undefined;
}

function epoch(iso: string | undefined): number | null {
  if (iso === undefined || iso === "") return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** The mark an open conversation's pane draws. An open ask outranks the status, since it waits on a person. */
export function paneConversationState(pane: Pick<AgentView, "status" | "asks">): Exclude<ConversationState, "closed"> {
  if (pane.status === "blocked" || (pane.asks?.length ?? 0) > 0) return "waiting";
  if (pane.status === "working") return "working";
  return "idle";
}

function fromPane(pane: AgentView, row: DurableConversationRow | undefined): ConversationItem {
  const question = pane.asks?.[0]?.title.trim();
  const subtitle = paneSubtitle(pane) ?? (row?.subtitle === undefined || row.subtitle === "" ? null : row.subtitle);
  const asking = question !== undefined && question !== "";
  return {
    key: row?.id ?? `pane:${pane.paneId}`,
    id: row?.id,
    pane,
    title: paneName(pane),
    line: asking ? question : subtitle,
    asking,
    state: paneConversationState(pane),
    asks: pane.asks?.length ?? 0,
    at: pane.lastActiveAt ?? epoch(row?.endedAt ?? row?.startedAt),
    workspaceId: pane.workspaceId,
  };
}

function fromRow(row: DurableConversationRow): ConversationItem {
  return {
    key: row.id,
    id: row.id,
    pane: undefined,
    title: row.title,
    line: row.subtitle === undefined || row.subtitle === "" ? null : row.subtitle,
    asking: false,
    // An open conversation the snapshot does not show (the pane closed after the list was read, or the
    // program keeps it outside the layout) has no live state to draw, so it reads as idle.
    state: row.state === "closed" ? "closed" : "idle",
    asks: 0,
    at: epoch(row.endedAt ?? row.startedAt),
    workspaceId: row.workspaceId,
  };
}

/** What waits on you comes first, then the other open conversations, then the closed ones. */
function rank(item: ConversationItem): number {
  if (item.state === "waiting") return 0;
  return item.state === "closed" ? 2 : 1;
}

/**
 * The list: conversations that wait on you, then the other open ones, then the closed ones, each newest
 * activity first. `rows` is null until the program's list arrived (or when it keeps none), and the live
 * panes alone are the list until then.
 */
export function mergeConversations(
  panes: readonly AgentView[],
  rows: readonly DurableConversationRow[] | null,
): ConversationItem[] {
  const byPane = new Map<string, DurableConversationRow>();
  for (const row of rows ?? []) if (row.state === "open" && row.paneId !== undefined) byPane.set(row.paneId, row);
  const live = new Set<string>();
  const items: ConversationItem[] = [];
  for (const pane of panes) {
    // A bare shell is no conversation, and a durable machine has none; the guard keeps a crew's odd pane out.
    if (pane.kind === "shell") continue;
    live.add(pane.paneId);
    items.push(fromPane(pane, byPane.get(pane.paneId)));
  }
  for (const row of rows ?? []) {
    if (row.state === "open" && row.paneId !== undefined && live.has(row.paneId)) continue;
    items.push(fromRow(row));
  }
  return items
    .map((item, index) => ({ item, index }))
    .toSorted((a, b) => rank(a.item) - rank(b.item) || (b.item.at ?? -1) - (a.item.at ?? -1) || a.index - b.index)
    .map(({ item }) => item);
}

/** One workspace's rows, under its label. `label` is null for the rows that name no workspace. */
export interface ConversationGroup {
  key: string;
  label: string | null;
  items: ConversationItem[];
}

/**
 * The open rows under their workspace, only when the program has more than one: a list with one workspace
 * has nothing to tell apart, so it is one group with no heading. Groups follow the order their first row
 * takes in the list; rows that name no workspace go last, with no heading.
 */
export function groupConversations(
  items: readonly ConversationItem[],
  workspaces: readonly { workspaceId: string; label: string }[],
): ConversationGroup[] {
  const ids = new Set<string>(workspaces.map((ws) => ws.workspaceId));
  for (const item of items) if (item.workspaceId !== undefined) ids.add(item.workspaceId);
  if (ids.size <= 1) return [{ key: "", label: null, items: [...items] }];
  const labels = new Map(workspaces.map((ws) => [ws.workspaceId, ws.label]));
  const groups = new Map<string, ConversationGroup>();
  const loose: ConversationItem[] = [];
  for (const item of items) {
    if (item.workspaceId === undefined) {
      loose.push(item);
      continue;
    }
    let group = groups.get(item.workspaceId);
    if (group === undefined) {
      const label = labels.get(item.workspaceId) ?? item.workspaceId;
      group = { key: item.workspaceId, label, items: [] };
      groups.set(item.workspaceId, group);
    }
    group.items.push(item);
  }
  const out = [...groups.values()];
  if (loose.length > 0) out.push({ key: "", label: null, items: loose });
  return out;
}

/** What the program's list said last, per machine, so the home draws it at once on the next visit. */
export interface ProgramList {
  rows: DurableConversationRow[];
  next: string | undefined;
}

const cache = new Map<string, ProgramList>();

export function cachedProgramList(key: string): ProgramList | undefined {
  return cache.get(key);
}

export function rememberProgramList(key: string, list: ProgramList): void {
  cache.set(key, list);
}

/** Tests only: forget every machine's list. */
export function __resetProgramLists(): void {
  cache.clear();
}
