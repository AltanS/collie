// The last Changes list per screen, kept for the page session (ADR 0065). A return to a workspace's
// Changes screen shows the list it last had on its first frame, with no skeleton, and the open read
// then replaces it only if the answer differs (`shareEqual`, so an identical answer touches nothing).
// In memory only: a reload starts on the skeleton again, which is the honest state after a reload.
import type { ChangesLookup } from "./api";
import { scopeKey, type Scope } from "./scope";
import type { ChangesResponse } from "./types";

const lastLists = new Map<string, ChangesResponse>();

/** `target` is the screen's own key, `pane:<id>` or `space:<id>`, as the route builds it. */
function key(scope: Scope, target: string, lookup: ChangesLookup): string {
  return `${scopeKey(scope)}\u0001${target}\u0001${lookup.nested ? 1 : 0}\u0001${lookup.depth}`;
}

export function keptChangesList(scope: Scope, target: string, lookup: ChangesLookup): ChangesResponse | undefined {
  return lastLists.get(key(scope, target, lookup));
}

export function keepChangesList(scope: Scope, target: string, lookup: ChangesLookup, data: ChangesResponse): void {
  lastLists.set(key(scope, target, lookup), data);
}

/** Tests only: forget every kept list. */
export function resetChangesListCache(): void {
  lastLists.clear();
}
