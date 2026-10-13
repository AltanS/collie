import { paneName } from "@/lib/pane-name";
import { paneProgress, paneSubtitle, type ProgressReading } from "@/lib/pane-marks";
import type { AgentView, DurableConversationRow } from "@/lib/types";

// THE DURABLE HOME'S LIST (M53 spec 12): a durable program's conversations, open and closed, as one list.
//
// Two sources, merged here and nowhere else. The live panes of the snapshot say how an OPEN conversation
// is right now (working, waiting with its open asks, idle), and they are in hand the moment the dashboard
// draws. The program's own list (`/api/durable/conversations`, spec 11) adds the CLOSED ones and the item
// counts, and arrives a moment later. A conversation in both is one row: the pane gives it its state, the
// program's row gives it its count. Nothing here touches the DOM or the network, so every rule is
// table-testable.

/** The state mark a row draws. `waiting` is a pane that needs a person: blocked, or holding an open ask. */
export type ConversationState = "working" | "waiting" | "idle" | "closed";

/** The filter chips over the list, in the order they are drawn. */
export const CONVERSATION_FILTERS = ["all", "open", "needsYou", "closed"] as const;
export type ConversationFilter = (typeof CONVERSATION_FILTERS)[number];

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
  subtitle: string | null;
  state: ConversationState;
  /** Open asks on the pane, drawn as the count beside a waiting row's title. */
  asks: number;
  /** Epoch ms of the last thing that happened in it, or null when neither source says. */
  at: number | null;
  /** How many items the program holds for it, or null before its list arrived. */
  items: number | null;
  /** How far a working conversation is, for the row's hairline. */
  progress: ProgressReading | null;
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
  return {
    key: row?.id ?? `pane:${pane.paneId}`,
    id: row?.id,
    pane,
    title: paneName(pane),
    subtitle: paneSubtitle(pane) ?? (row?.subtitle === undefined || row.subtitle === "" ? null : row.subtitle),
    state: paneConversationState(pane),
    asks: pane.asks?.length ?? 0,
    at: pane.lastActiveAt ?? epoch(row?.endedAt ?? row?.startedAt),
    items: row?.items ?? null,
    progress: paneProgress(pane),
    workspaceId: pane.workspaceId,
  };
}

function fromRow(row: DurableConversationRow): ConversationItem {
  return {
    key: row.id,
    id: row.id,
    pane: undefined,
    title: row.title,
    subtitle: row.subtitle === undefined || row.subtitle === "" ? null : row.subtitle,
    // An open conversation the snapshot does not show (the pane closed after the list was read, or the
    // program keeps it outside the layout) has no live state to draw, so it reads as idle.
    state: row.state === "closed" ? "closed" : "idle",
    asks: 0,
    at: epoch(row.endedAt ?? row.startedAt),
    items: row.items,
    progress: null,
    workspaceId: row.workspaceId,
  };
}

/** Open conversations sort above closed ones. */
function rank(item: ConversationItem): number {
  return item.state === "closed" ? 1 : 0;
}

/**
 * The list, newest activity first, open ones before closed ones. `rows` is null until the program's list
 * arrived (or when it keeps none), and the live panes alone are the list until then.
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

/** Whether a row passes a filter chip. */
export function passesFilter(item: ConversationItem, filter: ConversationFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "open":
      return item.state !== "closed";
    case "needsYou":
      return item.state === "waiting";
    case "closed":
      return item.state === "closed";
  }
}

/** One workspace's rows, under its label. `label` is null for the rows that name no workspace. */
export interface ConversationGroup {
  key: string;
  label: string | null;
  items: ConversationItem[];
}

/**
 * The rows under their workspace, only when the program has more than one: a list with one workspace has
 * nothing to tell apart, so it is one group with no heading. Groups follow the order their newest row
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

/** Tests only: forget every machine's list and chip. */
export function __resetProgramLists(): void {
  cache.clear();
  filters.clear();
}

const filters = new Map<string, ConversationFilter>();

/** The chip a machine's list last showed on this tab, so a trip into a conversation and back keeps it. */
export function rememberedFilter(key: string): ConversationFilter {
  return filters.get(key) ?? "all";
}

export function rememberFilter(key: string, filter: ConversationFilter): void {
  filters.set(key, filter);
}
