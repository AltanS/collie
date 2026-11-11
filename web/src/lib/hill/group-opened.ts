import { useCallback, useState } from "react";

import { asJsonNumber, parseJson } from "@/lib/json";

import { HILL_GROUP_PARTS } from "./wire";

// WHICH CARDS OF A GROUP THIS PHONE OPENED (crew slice 8). A Decision whose code does not fit one card
// carries a group of 2 to 8 cards, and its yes waits until every card was on screen. The marks live in
// memory and in sessionStorage, keyed by the Decision's id AND the group's digest: a group that changed
// is a new key, so no mark of the old cards counts for the new ones. A reload of the tab keeps them; a
// new tab, a second phone, or the app killed starts again. Only the marks are kept, never the card the
// person was on: the group always opens on card 1, whatever the link, push or scroll that led there.
//
// The marks are the phone's own claim, and the answer carries them to the bridge as such: a display
// check that the person paged through the cards, never a proof that they read them.

const PREFIX = "collie:hill-group-opened:v1:";

function safeStorage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function keyOf(id: string, digest: string): string {
  return `${PREFIX}${id}:${digest}`;
}

/** The cards marked opened for this group (numbered from 1), as stored; a damaged value reads as none. */
export function readOpenedCards(id: string, digest: string): Set<number> {
  const raw = safeStorage()?.getItem(keyOf(id, digest));
  if (raw === null || raw === undefined) return new Set();
  const list = parseJson(raw);
  if (!Array.isArray(list)) return new Set();
  const out = new Set<number>();
  for (const item of list) {
    const card = asJsonNumber(item);
    if (card !== undefined && Number.isInteger(card) && card >= 1 && card <= HILL_GROUP_PARTS.max) out.add(card);
  }
  return out;
}

function writeOpenedCards(id: string, digest: string, opened: ReadonlySet<number>): void {
  try {
    safeStorage()?.setItem(keyOf(id, digest), JSON.stringify([...opened].toSorted((a, b) => a - b)));
  } catch {
    // A full or blocked store keeps the marks in memory only: the yes still waits for them.
  }
}

/** One group's opened cards and the call that marks one. */
export interface OpenedCards {
  opened: ReadonlySet<number>;
  mark: (card: number) => void;
}

/** One group's opened cards and the call that marks one, by the Decision's id and the group's digest. */
export function useOpenedCards(id: string, digest: string): OpenedCards {
  const key = keyOf(id, digest);
  const [state, setState] = useState(() => ({ key, opened: readOpenedCards(id, digest) }));
  // A new digest is a new group: its marks are its own, read fresh.
  const current = state.key === key ? state : { key, opened: readOpenedCards(id, digest) };
  if (current !== state) setState(current);
  const mark = useCallback(
    (card: number) => {
      setState((prev) => {
        const base = prev.key === key ? prev.opened : readOpenedCards(id, digest);
        if (base.has(card)) return prev.key === key ? prev : { key, opened: base };
        const opened = new Set(base).add(card);
        writeOpenedCards(id, digest, opened);
        return { key, opened };
      });
    },
    [id, digest, key],
  );
  return { opened: current.opened, mark };
}
