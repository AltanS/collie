// Route path helpers. Pane ids contain a colon (e.g. "wE:p2"), so they must be URL-encoded in the
// path; React Router decodes them back in useParams. The active scope — which machine, which named
// session — rides along in the query (`?h=` / `?s=`, see lib/scope.ts) so a navigation stays pointed
// at the pane you were actually looking at. Lead + primary emits nothing, so a solo install's paths
// are byte-identical to what shipped before the host dimension existed.
//
// The host stays in the QUERY, never in the path: a `/host/:h/pane/:paneId` shape would fork every
// route, break every existing deep link, and force the loaders' isPaneUrl() to grow a parser.
import { asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "./json";
import { scopeFromSearchParams, scopeSearch, type Scope } from "./scope";
import type { AgentView } from "./types";

export function panePath(paneId: string, scope?: Scope): string {
  return `/pane/${encodeURIComponent(paneId)}${scopeSearch(scope)}`;
}

/**
 * A pane's conversation history — the agent's own transcript, which is the only scrollback a Claude
 * pane can have (its terminal runs on the alternate screen and retains nothing). A child path of the
 * pane so "back" lands on the live mirror.
 */
export function historyPath(paneId: string, scope?: Scope): string {
  return `/pane/${encodeURIComponent(paneId)}/history${scopeSearch(scope)}`;
}

/**
 * A pane's Changes view (ADR 0065): the list, or with `file` one file's diff. The file rides in the
 * query (`repo`, `path`) beside the scope, so browser back walks from a diff to the list.
 */
export function changesPath(paneId: string, scope?: Scope, file?: { repo: string; path: string }): string {
  const base = `/pane/${encodeURIComponent(paneId)}/changes${scopeSearch(scope)}`;
  if (!file) return base;
  const q = new URLSearchParams({ repo: file.repo, path: file.path });
  return `${base}${base.includes("?") ? "&" : "?"}${q.toString()}`;
}

/**
 * A space's Changes view (ADR 0065): the same list every pane of the space shows, asked by space.
 * A child of the space route so "back" lands on the space.
 */
export function spaceChangesPath(spaceId: string, scope?: Scope, file?: { repo: string; path: string }): string {
  const base = `/space/${encodeURIComponent(spaceId)}/changes${scopeSearch(scope)}`;
  if (!file) return base;
  const q = new URLSearchParams({ repo: file.repo, path: file.path });
  return `${base}${base.includes("?") ? "&" : "?"}${q.toString()}`;
}

/** A space's detail route (its tabs + panes). Deep-linkable; carries the scope like panePath. */
export function spacePath(spaceId: string, scope?: Scope): string {
  return `/space/${encodeURIComponent(spaceId)}${scopeSearch(scope)}`;
}

/** The dashboard path, carrying the current scope so "go home" doesn't drop you back to the lead. */
export function homePath(scope?: Scope, opts?: { all?: boolean }): string {
  return `/${scopeSearch(scope, opts)}`;
}

/** The settings route, carrying the current scope like the other path helpers. */
export function settingsPath(scope?: Scope): string {
  return `/settings${scopeSearch(scope)}`;
}

/**
 * The crew overview — the read-only census of every machine in the crew. Carries the scope like the
 * others so "back" returns you to the machine you were looking at, not to the lead.
 */
export function crewPath(scope?: Scope): string {
  return `/crew${scopeSearch(scope)}`;
}

/**
 * The Updates page — a CHILD of Settings, not an anchor inside it. Updating is a flow with a lead,
 * N peers, progress and a rollback state, so it gets a page and Settings keeps one row that links
 * here. Carries the scope like the others, so "back" returns to the machine you came from.
 */
export function updatesPath(scope?: Scope): string {
  return `/settings/updates${scopeSearch(scope)}`;
}

/**
 * The fragment naming the Paired-devices card inside Settings. It is a route-level anchor, so it
 * lives here beside the paths rather than in the card: `read-only-banner.tsx` links to it and
 * `paired-devices.tsx` answers to it, and neither should own the other's spelling.
 */
export const PAIRED_DEVICES_HASH = "paired-devices";

/** The fragment naming the Changes card inside Settings, which `changes-control.tsx` answers to. */
export const CHANGES_SETTINGS_HASH = "changes";

/** Settings, scrolled to the Changes card: the Changes list's "look deeper" link (ADR 0065). */
export function changesSettingsPath(scope?: Scope): string {
  return `${settingsPath(scope)}#${CHANGES_SETTINGS_HASH}`;
}

/** Settings, scrolled to the card that pairs this phone — the read-only strip's remedy. */
export function pairedDevicesPath(scope?: Scope): string {
  return `${settingsPath(scope)}#${PAIRED_DEVICES_HASH}`;
}

// ── Back goes up one level (ADR 0067) ────────────────────────────────────────────────────────────
// On a phone the edge swipe IS browser history back, so the history stack has to be the level tree.
// Three kinds of move, and each writes history one way:
//
//   DOWN     a push that records where it came from: `state.from` is the pathname + search the
//            operator left. Dashboard → space → pane → History.
//   SIDEWAYS a replace, carrying `state.from` over, so the level's way up survives the switch.
//            Pane → pane, space chip → space chip, machine and session switchers.
//   UP       a step back when the entry behind us is a legitimate parent, else a replace onto the
//            structural parent. Never a push: a pushed parent leaves the child behind it, and the
//            next swipe goes down again.
//
// The pure half lives here, beside the paths it reasons about; `hooks/use-nav.ts` wraps it for
// components and `lib/nav-entry.ts` seeds a cold deep link.

/**
 * What Collie keeps in `location.state`: where a DOWN move came from, beside the one other field a
 * navigation carries (`freshPane`, a just-created pane the snapshot does not list yet).
 */
export interface NavState {
  from?: string;
  freshPane?: AgentView;
}

/** The fields a move may carry beside `from`, which the move itself writes. */
export type NavExtras = Omit<NavState, "from">;

/**
 * `state.from` if the state carries one. `location.state` is whatever the navigation attached, read
 * here through the JSON narrowing helpers; every writer in Collie spreads other fields beside `from`
 * (`freshPane`, `fromList`), so only an app path counts.
 */
export function readFrom(state: JsonValue | undefined): string | undefined {
  const from = asJsonString(asJsonObject(state)?.from);
  return from?.startsWith("/") ? from : undefined;
}

/** A path without its query or fragment. `from` is stored with its search, the tree is pathnames. */
export function pathOnly(href: string): string {
  const cut = href.search(/[?#]/);
  return cut === -1 ? href : href.slice(0, cut);
}

/** `*` stands for any one segment: a pane's space is not in its path, so any space may be its parent. */
const ANY_SPACE = "/space/*";

/**
 * Every pathname that may legitimately sit above `pathname` in the level tree, nearest first.
 *
 *   L0 `/`
 *   L1 `/space/:id`, `/settings`, `/crew`
 *   L2 `/pane/:id`, `/space/:id/changes`, `/settings/updates`
 *   L3 `/pane/:id/history`, `/pane/:id/changes` (a file view is the same path with `?repo=&path=`)
 *
 * A pane's parent is whichever of the dashboard or a space opened it. `/crew` also accepts
 * `/settings`, because the crew card in Settings opens it, and a step back to Settings is the only
 * up that leaves no Settings entry behind to swipe into.
 */
export function ancestorsOf(pathname: string): string[] {
  const seg = pathname.split("/").filter((s) => s !== "");
  const [head, id, leaf] = seg;
  if (seg.length === 0) return [];
  if (head === "space" && seg.length === 2) return ["/"];
  if (head === "space" && seg.length === 3 && leaf === "changes") return [`/space/${id}`, "/"];
  if (head === "pane" && seg.length === 2) return [ANY_SPACE, "/"];
  if (head === "pane" && seg.length === 3 && (leaf === "history" || leaf === "changes")) {
    return [`/pane/${id}`, ANY_SPACE, "/"];
  }
  if (head === "settings" && seg.length === 1) return ["/"];
  if (head === "settings" && seg.length === 2 && id === "updates") return ["/settings", "/"];
  if (head === "crew" && seg.length === 1) return ["/settings", "/"];
  return [];
}

function matches(pattern: string, pathname: string): boolean {
  if (pattern !== ANY_SPACE) return pattern === pathname;
  return /^\/space\/[^/]+$/.test(pathname);
}

/** Whether `from` (a stored href) names a level above `here` (a pathname). */
export function isAncestor(from: string, here: string): boolean {
  const path = pathOnly(from);
  return ancestorsOf(here).some((pattern) => matches(pattern, path));
}

/** What an UP move does: step back one entry, or replace this one with `to`. */
export type UpMove = { kind: "back" } | { kind: "replace"; to: string };

/**
 * False when the router sits on its first entry (`history.state.idx === 0`), which a stale `from`
 * could otherwise send out of the app. A router that does not stamp `window.history` (a memory
 * router in a test) has no index to read, and `from` alone decides there — so this reads `true`.
 */
export function canStepBack(): boolean {
  const idx = asJsonNumber(asJsonObject(window.history.state)?.idx);
  return idx === undefined ? true : idx > 0;
}

/**
 * The back arrow, the Collie mark inside a level, and every automatic exit (a pane or a space that
 * closed under you). `fallback` is the structural parent, used when the entry behind us is not a
 * parent: a cold deep link, a Settings opened from a pane, an Updates page opened from the ribbon.
 *
 * `canGoBack` is false when the router sits on its first entry (`history.state.idx === 0`), which
 * a stale `from` could otherwise send out of the app.
 */
export function resolveUp(here: string, from: string | undefined, fallback: string, canGoBack = true): UpMove {
  if (canGoBack && from !== undefined && isAncestor(from, here)) return { kind: "back" };
  return { kind: "replace", to: fallback };
}

/**
 * The pathname an UP move actually lands on — for a caller that only needs to NAME the destination
 * (an accessible label), never to perform the move. Same guard as `resolveUp`, so the two can never
 * disagree: `from` when it is a legitimate parent (the "back" case), else `fallback`'s own pathname
 * (the "replace" case). Always a bare pathname, even when `fallback` carries a query.
 */
export function upTarget(here: string, from: string | undefined, fallback: string, canGoBack = true): string {
  if (canGoBack && from !== undefined && isAncestor(from, here)) return pathOnly(from);
  return pathOnly(fallback);
}

/**
 * An UP move to one NAMED parent, not the nearest one: the pane's space breadcrumb goes to its space
 * even when the dashboard opened the pane. It steps back only when the entry behind us is that very
 * parent, and otherwise replaces this entry with it, so the space's own up still finds the dashboard.
 */
export function resolveUpTo(from: string | undefined, target: string, canGoBack = true): UpMove {
  if (canGoBack && from !== undefined && pathOnly(from) === pathOnly(target)) return { kind: "back" };
  return { kind: "replace", to: target };
}

/**
 * The structural parents of a deep link, root first, each carrying the link's machine and session:
 * what a cold start puts behind the entry so the first swipe goes up (lib/nav-entry.ts). Empty for
 * the dashboard and for any path the tree does not know.
 */
export function parentChain(pathname: string, search: string): string[] {
  const scope = scopeFromSearchParams(new URLSearchParams(search));
  const seg = pathname.split("/").filter((s) => s !== "");
  const [head, id, leaf] = seg;
  const home = homePath(scope);
  const q = scopeSearch(scope);
  if (head === "space" && seg.length === 2) return [home];
  // A Changes file view (`?repo=&path=`) sits under its list: a swipe from a diff lands on the list.
  const file = leaf === "changes" && new URLSearchParams(search).has("path");
  if (head === "space" && seg.length === 3 && leaf === "changes") {
    const space = `/space/${id}${q}`;
    return file ? [home, space, `/space/${id}/changes${q}`] : [home, space];
  }
  if (head === "pane" && seg.length === 2) return [home];
  if (head === "pane" && seg.length === 3 && (leaf === "history" || leaf === "changes")) {
    const pane = `/pane/${id}${q}`;
    return file ? [home, pane, `/pane/${id}/changes${q}`] : [home, pane];
  }
  if (head === "settings" && seg.length === 1) return [home];
  if (head === "settings" && seg.length === 2 && id === "updates") return [home, `/settings${q}`];
  if (head === "crew" && seg.length === 1) return [home];
  return [];
}
