// A permanent address for one browser tab that reopens on the pane the tab last showed.
//
// A pane's address names the pane, so a tab pinned on it returns there after a browser restart, however
// far the operator moved inside the app. `/slot/<n>` names the tab instead. The tab that opens it
// belongs to slot n (sessionStorage lives per tab), each pane it then shows is written down for n
// (localStorage survives the restart), and `/slot/<n>` leads to the last one written.
//
// A pane id is unique only for one bridge process (lib/pins.ts) and a slot outlives it, so the slot
// keeps the workspace name too, and routes/slot.tsx refuses an id another workspace has since taken.
//
// Per device, like lib/strips-collapsed.ts: never written to a bridge. A duplicated tab copies its
// sessionStorage and so shares the slot; the tab that moves last wins.

import { findPane } from "./hosts";
import { asJsonString, parseJsonObject } from "./json";
import { scopeFromSearchParams } from "./scope";
import type { SnapshotResponse } from "./types";

const TAB_SLOT_KEY = "collie.slot.tab";
/** One key per slot: tabs see each other's writes late, so a shared map would lose a slot when two move at once. */
const PANE_KEY_PREFIX = "collie:slot:v1:";
const SLOT_NUMBER = /^[1-9][0-9]?$/;
/** A pane page and nothing under it, with its query: `?s=` is what names the project. */
const PANE_PAGE = /^\/pane\/([^/?#]+)(?:\?([^#]*))?$/;
const HOME = "/";

type SlotStorage = Pick<Storage, "getItem" | "setItem">;

interface SlotRecord {
  address: string;
  space?: string;
}

function tabStorage(): SlotStorage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined; // locked-down storage
  }
}

function deviceStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // locked-down storage
  }
}

/** The slot's stored record, or undefined when it is missing, unreadable or names no pane page. */
function readRecord(slot: string, local: SlotStorage | undefined): SlotRecord | undefined {
  try {
    const stored = parseJsonObject(local?.getItem(`${PANE_KEY_PREFIX}${slot}`) ?? "");
    const address = asJsonString(stored?.address);
    if (address === undefined || !PANE_PAGE.test(address)) return undefined;
    return { address, space: asJsonString(stored?.space) };
  } catch {
    return undefined;
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
  return readRecord(raw, local)?.address ?? HOME;
}

/** The workspace name the slot's pane last sat in, when the slot knows it. */
export function slotSpace(raw: string | undefined, local: SlotStorage | undefined = deviceStorage()): string | undefined {
  if (raw === undefined || !SLOT_NUMBER.test(raw)) return undefined;
  return readRecord(raw, local)?.space;
}

/**
 * Write the address down for this tab's slot, when the tab has one and the address is a pane page.
 * With no `space`, the name stored for this same address stays: a herd without the pane says nothing
 * about where it sits.
 */
export function rememberSlotPane(
  pathname: string,
  search: string,
  session: SlotStorage | undefined = tabStorage(),
  local: SlotStorage | undefined = deviceStorage(),
  space?: string,
): void {
  const address = `${pathname}${search}`;
  if (!PANE_PAGE.test(address)) return;
  try {
    const slot = session?.getItem(TAB_SLOT_KEY);
    if (slot === null || slot === undefined) return;
    const before = readRecord(slot, local);
    const name = space ?? (before?.address === address ? before.space : undefined);
    local?.setItem(`${PANE_KEY_PREFIX}${slot}`, JSON.stringify({ address, space: name }));
  } catch {
    // Quota or private mode: the slot keeps its previous pane.
  }
}

/** The workspace `address` sits in on this herd, when it is a pane page the herd holds. */
export function liveSpaceOf(
  address: string,
  herd: Pick<SnapshotResponse, "agents" | "shellPanes" | "servers" | "sessions">,
): string | undefined {
  const page = PANE_PAGE.exec(address);
  if (page === null) return undefined;
  try {
    const paneId = decodeURIComponent(page[1] ?? "");
    const scope = scopeFromSearchParams(new URLSearchParams(page[2] ?? ""));
    const pane =
      findPane(herd.agents, paneId, scope, herd.servers, herd.sessions) ??
      findPane(herd.shellPanes, paneId, scope, herd.servers, herd.sessions);
    return pane?.workspaceLabel;
  } catch {
    return undefined; // a pane id that does not decode names no pane
  }
}

/** Forget every slot's pane, at unpair (lib/wipe.ts): each names a project. */
export function forgetSlots(local: Storage | undefined = deviceStorage()): void {
  try {
    if (local === undefined) return;
    const keys: string[] = [];
    for (let i = 0; i < local.length; i++) {
      const key = local.key(i);
      if (key !== null && key.startsWith(PANE_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) local.removeItem(key);
  } catch {
    // Enumeration can throw in locked-down storage: there was nothing it could have read either.
  }
}
