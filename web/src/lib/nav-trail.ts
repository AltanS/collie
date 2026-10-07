// The trail of history entries this tab has visited, for the Files breadcrumb (ADR 0067). Browser
// history cannot be read: a page sees its own index (`history.state.idx`) and nothing behind it. The
// breadcrumb has to know whether an ancestor folder is already in the stack behind the operator, so
// that tapping it can POP back to that entry like an iOS navigation bar does, rather than push a
// second copy of it that a swipe would then walk back through.
//
// So the app writes down what it shows: entry index -> href, filled from one `useLocation` effect in
// the root layout (`useNavTrail`). Kept in memory for speed and mirrored to sessionStorage, which
// lives as long as the tab, so a reload (iOS evicting the installed app) does not forget the stack
// that the browser kept. Capped, oldest first, so a long session cannot grow it without bound.

import { asJsonNumber, asJsonString, parseJson } from "./json";

/** The sessionStorage key mirroring the trail. */
export const TRAIL_KEY = "collie.nav.trail";

/** Entries kept. A breadcrumb pop reaches back through one tree walk, never a hundred levels. */
export const TRAIL_CAP = 100;

type TrailStorage = Pick<Storage, "getItem" | "setItem">;

/** The entries as the search reads them: history index to href. */
export type TrailEntries = ReadonlyMap<number, string>;

export interface Trail {
  record(idx: number, href: string): void;
  entries(): TrailEntries;
}

/**
 * A trail over `storage`, read once on first use. A failing or locked-down storage costs only the
 * mirror: the breadcrumb then falls back to a replace after a reload.
 */
export function createTrail(storage: TrailStorage | undefined): Trail {
  const map = new Map<number, string>();
  let loaded = false;
  const load = () => {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = parseJson(storage?.getItem(TRAIL_KEY) ?? "");
      if (!Array.isArray(parsed)) return;
      for (const pair of parsed) {
        if (!Array.isArray(pair)) continue;
        const idx = asJsonNumber(pair[0]);
        const href = asJsonString(pair[1]);
        if (idx !== undefined && Number.isInteger(idx) && href !== undefined) map.set(idx, href);
      }
    } catch {
      // Unreadable storage: start empty.
    }
  };
  return {
    record(idx, href) {
      load();
      // Re-set moves the entry to the end of the map's order, so the cap drops the stalest visit.
      map.delete(idx);
      map.set(idx, href);
      for (const oldest of map.keys()) {
        if (map.size <= TRAIL_CAP) break;
        map.delete(oldest);
      }
      try {
        storage?.setItem(TRAIL_KEY, JSON.stringify([...map]));
      } catch {
        // Full or locked: the in-memory trail still serves this page.
      }
    },
    entries() {
      load();
      return map;
    },
  };
}

function sessionStorageOrUndefined(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** The app's trail. Module-level, so the idle lock remounting the router does not lose it. */
export const navTrail: Trail = createTrail(sessionStorageOrUndefined());

// ── The search ───────────────────────────────────────────────────────────────────────────────────

/** A Files tree location, parsed out of an href. */
interface FilesLocation {
  /** `pane/<id>` or `space/<id>`: the screen's owner. */
  screen: string;
  /** The machine and session the href is scoped to. */
  scope: string;
  /** The folder, relative to the root; `""` is the root. Empty for a file. */
  dir: string;
  /** The file, relative to the root, or null for a folder. */
  path: string | null;
}

/**
 * A Files location, or null for any other href. The root is the Changes screen itself
 * (`…/changes`) or its old address (`…/changes/files` with no query), a folder is `?dir=`, a file
 * is `?path=`. A Changes diff (`…/changes?repo=&path=`) is another screen and parses to null.
 */
function parseFilesLocation(href: string): FilesLocation | null {
  const cut = href.search(/[?#]/);
  const pathname = cut === -1 ? href : href.slice(0, cut);
  const search = cut === -1 || href[cut] === "#" ? "" : (href.slice(cut + 1).split("#")[0] ?? "");
  const m = /^\/(pane|space)\/([^/]+)\/changes(\/files)?$/.exec(pathname);
  if (m === null) return null;
  const q = new URLSearchParams(search);
  const files = m[3] !== undefined;
  if (!files && (q.has("repo") || q.has("path"))) return null;
  const path = files && q.get("path") ? q.get("path") : null;
  const dir = files && path === null ? (q.get("dir") ?? "") : "";
  let id = m[2] ?? "";
  try {
    id = decodeURIComponent(id);
  } catch {
    // An id that is not valid percent-encoding is compared as written.
  }
  return { screen: `${m[1]}/${id}`, scope: `${q.get("h") ?? ""}\n${q.get("s") ?? ""}`, dir, path };
}

/** Whether `rel` (a folder or file path) is `dir` or lies below it. The root contains everything. */
function isWithin(rel: string, dir: string): boolean {
  return dir === "" || rel === dir || rel.startsWith(`${dir}/`);
}

/**
 * How many history entries a breadcrumb tap must go back to land on the folder it names, or null
 * when that folder is not behind us on the same screen. `idx` is the current entry's index.
 *
 * The walk goes back from `idx - 1` and stops at the first entry that is the target. Every entry on
 * the way must be a place of the same Files screen (same pane or space, same machine and session)
 * inside the target's subtree, because those are the ones that would otherwise stay reachable by a
 * swipe after the pop: a pane, a diff or another screen in between means the target is not an
 * ancestor on this branch of the stack, and a pop would skip over it. A missing entry (never
 * visited by this tab, or evicted from the cap) ends the walk the same way.
 */
export function findCrumbPop(entries: TrailEntries, idx: number, target: string): number | null {
  const goal = parseFilesLocation(target);
  if (goal === null || goal.path !== null) return null;
  for (let at = idx - 1; at >= 0; at--) {
    const href = entries.get(at);
    if (href === undefined) return null;
    const loc = parseFilesLocation(href);
    if (loc === null || loc.screen !== goal.screen || loc.scope !== goal.scope) return null;
    if (loc.path === null && loc.dir === goal.dir) return idx - at;
    if (!isWithin(loc.path ?? loc.dir, goal.dir)) return null;
  }
  return null;
}

/**
 * How many entries back the run of this Files screen's places inside the target's subtree begins,
 * or null when the entry right behind us is already outside it. This is where the operator entered
 * the tree below the target: Files opened on the pane's own folder (`collie/web`) and a crumb names a
 * folder above it (`collie`). The target is not in the stack, so {@link findCrumbPop} has nothing to
 * pop to, but every entry of the run would stay one swipe away if the crumb only replaced the current
 * one. Popping to the run's first entry and replacing THAT one with the target leaves nothing below
 * the target behind it, and the entry behind is again whatever the tree was entered from.
 */
export function findCrumbBase(entries: TrailEntries, idx: number, target: string): number | null {
  const goal = parseFilesLocation(target);
  if (goal === null || goal.path !== null) return null;
  let steps: number | null = null;
  for (let at = idx - 1; at >= 0; at--) {
    const href = entries.get(at);
    if (href === undefined) break;
    const loc = parseFilesLocation(href);
    if (loc === null || loc.screen !== goal.screen || loc.scope !== goal.scope) break;
    if (!isWithin(loc.path ?? loc.dir, goal.dir)) break;
    steps = idx - at;
  }
  return steps;
}

/**
 * Whether `from` (an entry's recorded origin) lies outside this Files screen: a pane, a space, a diff,
 * another pane's tree. Only such a `from` may be carried onto a folder a crumb lands on, because a
 * `from` inside the tree names a place below that folder, and the arrow would step back down into it.
 */
export function fromOutsideTree(from: string | undefined, target: string): boolean {
  if (from === undefined) return false;
  const loc = parseFilesLocation(from);
  const goal = parseFilesLocation(target);
  return loc === null || goal === null || loc.screen !== goal.screen || loc.scope !== goal.scope;
}

/** What a breadcrumb tap does. */
export type CrumbMove =
  | { kind: "stay" }
  | { kind: "pop"; steps: number }
  | { kind: "popReplace"; steps: number; to: string }
  | { kind: "replace"; to: string };

/**
 * A crumb to an ancestor folder pops back to it when that entry is in the stack behind us
 * ({@link findCrumbPop}). When it is not, but places below it are (the tree was entered below the
 * target), it pops to the first of them and replaces that one with the target ({@link findCrumbBase}).
 * Otherwise it replaces this entry with the target. Either way no folder below the target is left one
 * swipe away. Tapping the place you are on does nothing.
 * `idx` is `undefined` where the router stamps no index; nothing can be popped to then.
 */
export function resolveCrumb(entries: TrailEntries, idx: number | undefined, here: string, target: string): CrumbMove {
  const now = parseFilesLocation(here);
  const goal = parseFilesLocation(target);
  if (now !== null && goal !== null && now.path === null && goal.path === null && now.dir === goal.dir && now.screen === goal.screen && now.scope === goal.scope) {
    return { kind: "stay" };
  }
  const inside = now !== null && goal !== null && now.screen === goal.screen && now.scope === goal.scope && isWithin(now.path ?? now.dir, goal.dir);
  if (!inside || idx === undefined) return { kind: "replace", to: target };
  const steps = findCrumbPop(entries, idx, target);
  if (steps !== null) return { kind: "pop", steps };
  const base = findCrumbBase(entries, idx, target);
  return base === null ? { kind: "replace", to: target } : { kind: "popReplace", steps: base, to: target };
}
