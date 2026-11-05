// A permanent address for one browser tab that reopens on the pane the tab last showed.
//
// A pane's address names the pane, so a tab pinned on it returns there after a browser restart, however
// far the operator moved inside the app. `/slot/<n>` names the tab instead. The tab that opens it
// belongs to slot n (sessionStorage lives per tab), each pane it then shows is written down for n
// (localStorage survives the restart), and `/slot/<n>` leads to the last one written.
//
// Per device, like lib/strips-collapsed.ts: never written to a bridge. A duplicated tab copies its
// sessionStorage and so shares the slot; the tab that moves last wins.

import { asJsonString, parseJsonObject, type JsonObject } from "./json";

const TAB_SLOT_KEY = "collie.slot.tab";
const PANES_KEY = "collie:slots:v1";
const SLOT_NUMBER = /^[1-9][0-9]?$/;
/** A pane page and nothing under it, with its query: `?s=` is what names the project. */
const PANE_PAGE = /^\/pane\/[^/?#]+(?:\?[^#]*)?$/;
const HOME = "/";

type SlotStorage = Pick<Storage, "getItem" | "setItem">;

function tabStorage(): SlotStorage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined; // locked-down storage
  }
}

function deviceStorage(): SlotStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // locked-down storage
  }
}

/** The stored map, or an empty one when the entry is missing, unreadable or not a map. */
function readPanes(local: SlotStorage | undefined): JsonObject {
  try {
    return parseJsonObject(local?.getItem(PANES_KEY) ?? "") ?? {};
  } catch {
    return {};
  }
}

/**
 * Where a tab opening `/slot/<raw>` goes: the slot's last pane, or home. A valid number also makes
 * this tab that slot's; an invalid one changes nothing.
 */
export function enterSlot(
  raw: string | undefined,
  session: SlotStorage | undefined = tabStorage(),
  local: SlotStorage | undefined = deviceStorage(),
): string {
  if (raw === undefined || !SLOT_NUMBER.test(raw)) return HOME;
  try {
    session?.setItem(TAB_SLOT_KEY, raw);
  } catch {
    // The tab stays out of the slot: it can still open the slot's pane, and writes nothing.
  }
  const stored = asJsonString(readPanes(local)[raw]);
  return stored !== undefined && PANE_PAGE.test(stored) ? stored : HOME;
}

/** Write the address down for this tab's slot, when the tab has one and the address is a pane page. */
export function rememberSlotPane(
  pathname: string,
  search: string,
  session: SlotStorage | undefined = tabStorage(),
  local: SlotStorage | undefined = deviceStorage(),
): void {
  const address = `${pathname}${search}`;
  if (!PANE_PAGE.test(address)) return;
  try {
    const slot = session?.getItem(TAB_SLOT_KEY);
    if (slot === null || slot === undefined) return;
    local?.setItem(PANES_KEY, JSON.stringify({ ...readPanes(local), [slot]: address }));
  } catch {
    // Quota or private mode: the slot keeps its previous pane.
  }
}
