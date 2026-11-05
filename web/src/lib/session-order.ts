// The operator's own order of the Sessions sheet, so the sessions in use sit at its top.
//
// Per device and per machine, like lib/pins.ts: a place the operator chose, never written to a
// bridge. Session names repeat across machines ("default"), so each machine keeps its own list. And
// like a pin, a place survives its session's absence: a session can pass through a listing without
// being there, and it comes back to where it was.

import { asJsonString, parseJsonObject, type JsonObject } from "./json";

const STORAGE_KEY = "collie:session-order:v1";
/** The local machine's list. A scope with no host is the bridge this page came from. */
const LOCAL_MACHINE = "";

type OrderStorage = Pick<Storage, "getItem" | "setItem">;

function deviceStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // locked-down storage
  }
}

function readAll(local: OrderStorage | undefined): JsonObject {
  try {
    return parseJsonObject(local?.getItem(STORAGE_KEY) ?? "") ?? {};
  } catch {
    return {};
  }
}

function namesIn(all: JsonObject, host: string | undefined): string[] {
  const stored = all[host ?? LOCAL_MACHINE];
  if (!Array.isArray(stored)) return [];
  return [...new Set(stored.map(asJsonString).filter((name) => name !== undefined))];
}

/** The given sessions in this device's order for the machine; those with no place follow, as given. */
export function orderSessions<T extends { name: string }>(
  sessions: readonly T[],
  host: string | undefined,
  local: OrderStorage | undefined = deviceStorage(),
): T[] {
  const places = new Map(namesIn(readAll(local), host).map((name, place) => [name, place]));
  const placeOf = (session: T) => places.get(session.name) ?? places.size;
  return sessions.toSorted((a, b) => placeOf(a) - placeOf(b));
}

/** Moves the row at `from` to `to` in the list as drawn, and stores the result for the machine. */
export function moveSession(
  names: readonly string[],
  from: number,
  to: number,
  host: string | undefined,
  local: OrderStorage | undefined = deviceStorage(),
): void {
  const moved = names.toSpliced(from, 1).toSpliced(to, 0, ...names.slice(from, from + 1));
  const all = readAll(local);
  const absent = namesIn(all, host).filter((name) => !names.includes(name));
  try {
    local?.setItem(STORAGE_KEY, JSON.stringify({ ...all, [host ?? LOCAL_MACHINE]: [...moved, ...absent] }));
  } catch {
    // Quota or locked-down storage: the sheet keeps the order it has.
  }
}

/** Unpair: every machine's order goes (the names are the operator's). */
export function forgetSessionOrder(local: Pick<Storage, "removeItem"> | undefined = deviceStorage()): void {
  try {
    local?.removeItem(STORAGE_KEY);
  } catch {
    // Locked-down storage holds nothing to forget.
  }
}
