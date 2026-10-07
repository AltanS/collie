// Route path helpers. Pane ids contain a colon (e.g. "wE:p2"), so they must be URL-encoded in the
// path; React Router decodes them back in useParams. The active scope — which machine, which named
// session — rides along in the query (`?h=` / `?s=`, see lib/scope.ts) so a navigation stays pointed
// at the pane you were actually looking at. Lead + primary emits nothing, so a solo install's paths
// are byte-identical to what shipped before the host dimension existed.
//
// The host stays in the QUERY, never in the path: a `/host/:h/pane/:paneId` shape would fork every
// route, break every existing deep link, and force the loaders' isPaneUrl() to grow a parser.
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "./json";
import { scopeFromSearchParams, scopeSearch, type Scope } from "./scope";
import type { AgentView } from "./types";

// The two Machines paths live in `machine-paths.ts` so the service worker can build them: this file
// reads `window`, which a worker has no type for. Re-exported, so every caller still asks nav.ts.
export { machinePath, machinesPath, machineTabOf, type MachineTab } from "./machine-paths";

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

/**
 * The last commit of one repo, below a Changes list (ADR 0065, the commit view): `base` is the list's
 * path (`/pane/:id/changes` or `/space/:id/changes`, scope query included). With `file`, one file of
 * that commit. A level below the list, so "back" lands on the list.
 */
function commitUnder(base: string, repo: string, path?: string): string {
  const cut = base.indexOf("?");
  const [pathname, search] = cut === -1 ? [base, ""] : [base.slice(0, cut), base.slice(cut + 1)];
  const q = new URLSearchParams(search);
  q.set("repo", repo);
  if (path !== undefined) q.set("path", path);
  return `${pathname}/commit?${q.toString()}`;
}

/** A pane's commit view: the last commit of `repo`, or with `path` one file of it. */
export function changesCommitPath(paneId: string, scope: Scope | undefined, repo: string, path?: string): string {
  return commitUnder(changesPath(paneId, scope), repo, path);
}

/** A space's commit view: the same, asked by space. */
export function spaceChangesCommitPath(spaceId: string, scope: Scope | undefined, repo: string, path?: string): string {
  return commitUnder(spaceChangesPath(spaceId, scope), repo, path);
}

/**
 * Where the Changes screen's folder tree is, inside the Changes root (ADR 0083): `dir` names a folder,
 * `path` a file, both relative to the root with `/` and never a leading one. Neither is the root,
 * which is the Changes screen itself. `line` is a 1-based line of `path` to bring into view, as a
 * path the agent printed named it (`src/a.ts:12`, ADR 0088). It rides in the query as `&line=`, and
 * the screen alone reads it: the bridge is never asked for a line.
 */
export interface FilesAt {
  dir?: string;
  path?: string;
  line?: number;
}

/**
 * A folder or a file of the Changes screen's tree: `base` is the screen's path (`/pane/:id/changes`
 * or `/space/:id/changes`, scope query included). A folder or a file is one segment below it
 * (`…/changes/files?dir=` or `?path=`), the same route, so the router keeps one component for every
 * level. The root is the screen itself: with no `at`, this is `base`.
 */
function filesUnder(base: string, at?: FilesAt): string {
  if (!at?.dir && !at?.path) return base;
  const cut = base.indexOf("?");
  const [pathname, search] = cut === -1 ? [base, ""] : [base.slice(0, cut), base.slice(cut + 1)];
  const q = new URLSearchParams(search);
  if (at.dir) q.set("dir", at.dir);
  else if (at.path) {
    q.set("path", at.path);
    if (at.line !== undefined && Number.isSafeInteger(at.line) && at.line > 0) q.set("line", String(at.line));
  }
  return `${pathname}/files?${q.toString()}`;
}

/** A pane's Changes tree: the root (the Changes screen), or with `at` one folder or one file. */
export function filesPath(paneId: string, scope?: Scope, at?: FilesAt): string {
  return filesUnder(changesPath(paneId, scope), at);
}

/** A space's Changes tree: the same, asked by space. */
export function spaceFilesPath(spaceId: string, scope?: Scope, at?: FilesAt): string {
  return filesUnder(spaceChangesPath(spaceId, scope), at);
}

/**
 * The level above one tree location: a file goes up to its folder, a folder to its parent, a
 * top-level folder to the root. `null` at the root, where the way up is the Changes screen's own.
 */
export function filesParent(at: FilesAt): FilesAt | null {
  const rel = at.path ?? at.dir ?? "";
  if (rel === "") return null;
  const cut = rel.lastIndexOf("/");
  return cut === -1 ? {} : { dir: rel.slice(0, cut) };
}

/** Every folder above a Files location, outermost first, the root excluded: `a/b/c.md` gives `a`, `a/b`. */
export function filesFolders(at: FilesAt): string[] {
  const rel = at.path ?? at.dir ?? "";
  const segments = rel.split("/").filter((s) => s !== "");
  const upTo = at.path !== undefined ? segments.length - 1 : segments.length;
  const folders: string[] = [];
  for (let n = 1; n <= upTo; n++) folders.push(segments.slice(0, n).join("/"));
  return folders;
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
 * The Settings sections. Settings is an index of these, not a column of every card it has
 * (routes/settings-sections.tsx says why, and which card went where).
 *
 * A union rather than a bare string, so a row naming a section nobody built is a compile error
 * instead of a page that renders nothing.
 *
 * The fifth is the only one that can be absent from the index: Experiments renders while
 * `lib/experiments.ts` holds something. Its path needs nothing here — the two ladders below already
 * read every `/settings/<x>` as a child of the index.
 */
export type SettingsSection = "appearance" | "device" | "alerts" | "system" | "experiments";

/** One Settings section — a CHILD of the index, carrying the scope like every other path helper. */
export function settingsSectionPath(section: SettingsSection, scope?: Scope): string {
  return `/settings/${section}${scopeSearch(scope)}`;
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

/**
 * Settings → Device, scrolled to the Changes card: the Changes list's "look deeper" link (ADR 0065).
 *
 * The fragment survived the split; the page under it did not. Both deep links name a SECTION now,
 * and they must, because a hash pointing at a card the index no longer mounts scrolls to nothing.
 */
export function changesSettingsPath(scope?: Scope): string {
  return `${settingsSectionPath("device", scope)}#${CHANGES_SETTINGS_HASH}`;
}

/** Settings → System, scrolled to the card that pairs this phone — the read-only strip's remedy. */
export function pairedDevicesPath(scope?: Scope): string {
  return `${settingsSectionPath("system", scope)}#${PAIRED_DEVICES_HASH}`;
}

/**
 * Where a `/settings` request with `?pair=` belongs: Settings → System, the query string intact, or
 * `null` when there is no code to carry.
 *
 * `collie pair` prints a QR for `/settings?pair=<code>`, and that URL outlives the page it named.
 * The Paired-devices card left the index for the System section, so a scan that stopped at the index
 * found no form and dropped the code. The URL stays as printed, because a phone still holding an
 * older cached shell only knows `/settings`; the index forwards instead. The whole query rides
 * along, so the scope (`?h=`) still names the machine the code was minted on.
 */
export function pairLandingPath(search: string): string | null {
  if (!new URLSearchParams(search).has("pair")) return null;
  return `/settings/system${search}`;
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
  /**
   * The Changes tree opened this file from a `link` row. A symlink is listed and never followed, so
   * the row cannot say whether it points at a file or a folder, and the file read answers
   * `unknown-path` for a folder: the one case where the view asks again as a folder.
   */
  viaLink?: true;
  /**
   * The file screen opens on its Preview rather than its default (a changed file's Diff): the diff's
   * own "Preview" offer asked for it.
   */
  fileView?: "preview";
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

/** Whether the entry this location came from was a Files `link` row (see {@link NavState.viaLink}). */
export function readViaLink(state: JsonValue | undefined): boolean {
  return asJsonBoolean(asJsonObject(state)?.viaLink) === true;
}

/** Whether this location was opened by a diff's "Preview" (see {@link NavState.fileView}). */
export function readPreviewAsked(state: JsonValue | undefined): boolean {
  return asJsonString(asJsonObject(state)?.fileView) === "preview";
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
 *   L2 `/pane/:id`, `/space/:id/changes`, `/settings/:section`, `/settings/updates`, `/machines`
 *   L3 `/pane/:id/history`, `/pane/:id/changes` (a file view is the same path with `?repo=&path=`),
 *      `/space/:id/changes/commit`, `/space/:id/changes/files` (a folder or a file of the tree, with
 *      `?dir=` or `?path=`)
 *   L4 `/pane/:id/changes/commit` (the commit's file view adds `&path=`), `/pane/:id/changes/files`
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
  if (head === "space" && seg.length === 4 && leaf === "changes" && seg[3] === "commit") {
    return [`/space/${id}/changes`, `/space/${id}`, "/"];
  }
  if (head === "pane" && seg.length === 4 && leaf === "changes" && seg[3] === "commit") {
    return [`/pane/${id}/changes`, `/pane/${id}`, ANY_SPACE, "/"];
  }
  // A folder or a file of the Changes tree sits below the Changes screen, its root (ADR 0083). The
  // folders share one pathname, so a step between them is the screen's own (`filesParent`).
  if (head === "space" && seg.length === 4 && leaf === "changes" && seg[3] === "files") {
    return [`/space/${id}/changes`, `/space/${id}`, "/"];
  }
  if (head === "pane" && seg.length === 4 && leaf === "changes" && seg[3] === "files") {
    return [`/pane/${id}/changes`, `/pane/${id}`, ANY_SPACE, "/"];
  }
  if (head === "pane" && seg.length === 2) return [ANY_SPACE, "/"];
  if (head === "pane" && seg.length === 3 && (leaf === "history" || leaf === "changes")) {
    return [`/pane/${id}`, ANY_SPACE, "/"];
  }
  if (head === "settings" && seg.length === 1) return ["/"];
  // Updates and the crew census are opened from the System section, so that is their nearest
  // legitimate parent. `/settings` stays in the list behind it: both were reachable straight from
  // the index before the split, and a stored `from` pointing there is still a step UP, not a push.
  if (head === "settings" && seg.length === 2 && id === "updates") {
    return ["/settings/system", "/settings", "/"];
  }
  if (head === "settings" && seg.length === 2) return ["/settings", "/"];
  if (head === "crew" && seg.length === 1) return ["/settings/system", "/settings", "/"];
  // Machines is opened from the Settings index and from the crew card in System, so both are
  // legitimate parents; its structural parent is Settings.
  if (head === "machines" && seg.length === 1) return ["/settings/system", "/settings", "/"];
  // A machine goes up to Machines. The crew census opens one too (the member sheet's "Load and
  // alerts"), so a step back onto /crew is still a step UP and not a push.
  if (head === "machines" && seg.length === 2) return ["/machines", "/crew", "/settings/system", "/settings", "/"];
  return [];
}

/**
 * A pathname with each segment percent-decoded, for comparing two spellings of one screen. A pane id
 * holds a colon (`w1:p2`), which `panePath` writes as `%3A` and a typed or pasted URL may not, and
 * the router keeps the spelling the entry was opened with. A segment that is not valid encoding is
 * kept as written.
 */
export function decodedPath(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join("/");
}

function matches(pattern: string, pathname: string): boolean {
  if (pattern !== ANY_SPACE) return decodedPath(pattern) === decodedPath(pathname);
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
  const idx = historyIdx();
  return idx === undefined ? true : idx > 0;
}

/**
 * The index React Router stamped on the current history entry (`history.state.idx`), or `undefined`
 * where the router does not stamp `window.history` (a memory router in a test, a fresh document).
 */
export function historyIdx(): number | undefined {
  return asJsonNumber(asJsonObject(window.history.state)?.idx);
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
  if (canGoBack && from !== undefined && decodedPath(pathOnly(from)) === decodedPath(pathOnly(target))) return { kind: "back" };
  return { kind: "replace", to: target };
}

/** A stored href as a comparable key: its pathname and its query pairs in a fixed order. */
function locationKey(href: string): string {
  const cut = href.search(/[?#]/);
  const pathname = cut === -1 ? href : href.slice(0, cut);
  const search = cut === -1 || href[cut] === "#" ? "" : href.slice(cut + 1).split("#")[0] ?? "";
  const pairs = [...new URLSearchParams(search).entries()].map(([k, v]) => `${k}=${v}`).toSorted();
  return `${decodedPath(pathname)}?${pairs.join("&")}`;
}

/**
 * An UP move to one exact LOCATION: it steps back only when the entry behind is that very pathname
 * and query, and otherwise replaces this entry with it. `resolveUpTo` compares pathnames, which is
 * right between screens and wrong inside the Files view, where every folder shares one pathname and
 * only `?dir=` tells them apart (ADR 0083).
 */
export function resolveUpToExact(from: string | undefined, target: string, canGoBack = true): UpMove {
  if (canGoBack && from !== undefined && locationKey(from) === locationKey(target)) return { kind: "back" };
  return { kind: "replace", to: target };
}

/**
 * The back arrow of a folder or a file in the Files tree. It goes back to where the operator came
 * from whenever it can, because the tree is entered from many places (a path a pane printed, a
 * diff's Preview, a link inside a Markdown file) and the phone's edge swipe is a step back to that
 * same entry (ADR 0067). `resolveUpToExact` steps back only onto the parent FOLDER, which for those
 * entries meant the arrow walked up the folders while the swipe left the tree: two screens for one
 * gesture. With no `from` (a cold deep link) or no entry behind, it replaces onto `parent`, the
 * structural parent folder, so the child never stays behind it.
 */
export function resolveTreeUp(from: string | undefined, parent: string, canGoBack = true): UpMove {
  if (canGoBack && from !== undefined) return { kind: "back" };
  return { kind: "replace", to: parent };
}

/** What the tree's back arrow lands on, named for its accessible label. */
export type TreeUpLanding = "pane" | "workspace" | "dashboard" | "list" | "folder" | "parent";

/**
 * Where {@link resolveTreeUp} lands, as a name for the arrow's label: the same guard, read without
 * moving. A step back lands on `from`, and `from` is a pane, its history, a space, the dashboard, a
 * Changes diff or commit, the change list, or another place in the tree. A replace lands on the
 * parent folder. Both land on a place in the tree as "the folder" from a file and "up one folder"
 * from a folder, the labels the arrow always had, so the tree's own places answer `replaced`.
 * `fromFile` says whether the screen the arrow sits on is a file. The Changes screen with no file in
 * its query is the tree's root, or the change list when the operator chose Changes only: `rootIsList`
 * says which.
 */
export function treeUpLanding(
  from: string | undefined,
  fromFile: boolean,
  rootIsList: boolean,
  canGoBack = true,
): TreeUpLanding {
  const replaced: TreeUpLanding = fromFile ? "folder" : "parent";
  if (!canGoBack || from === undefined) return replaced;
  const seg = pathOnly(from).split("/").filter((s) => s !== "");
  const [head, , leaf, sub] = seg;
  if (seg.length === 0) return "dashboard";
  if (head === "space" && seg.length === 2) return "workspace";
  if (head === "pane" && (seg.length === 2 || (seg.length === 3 && leaf === "history"))) return "pane";
  if ((head === "pane" || head === "space") && leaf === "changes") {
    if (seg.length === 4 && sub === "commit") return "list";
    if (seg.length === 3) {
      const cut = from.indexOf("?");
      const diff = cut !== -1 && new URLSearchParams(from.slice(cut + 1).split("#")[0]).has("path");
      if (diff || rootIsList) return "list";
    }
  }
  return replaced;
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
  // The commit view sits under its list, and the commit's file view under the commit.
  if ((head === "space" || head === "pane") && seg.length === 4 && leaf === "changes" && seg[3] === "commit") {
    const params = new URLSearchParams(search);
    const repo = params.get("repo");
    const list = `/${head}/${id}/changes${q}`;
    const chain = [home, `/${head}/${id}${q}`, list];
    return repo !== null && params.has("path") ? [...chain, commitUnder(list, repo)] : chain;
  }
  // The Changes tree: a folder or a file sits under every folder above it, then the Changes screen
  // that is the tree's root, then the way up that screen has (ADR 0083). `…/changes/files` with
  // neither `?dir=` nor `?path=` is the root itself under an older address.
  if ((head === "space" || head === "pane") && seg.length === 4 && leaf === "changes" && seg[3] === "files") {
    const params = new URLSearchParams(search);
    const at: FilesAt = { dir: params.get("dir") ?? undefined, path: params.get("path") ?? undefined };
    const list = `/${head}/${id}/changes${q}`;
    const chain = [home, `/${head}/${id}${q}`];
    if (filesParent(at) === null) return chain;
    return [...chain, filesUnder(list), ...filesFolders(at).slice(0, at.path !== undefined ? undefined : -1).map((dir) => filesUnder(list, { dir }))];
  }
  if (head === "pane" && seg.length === 2) return [home];
  if (head === "pane" && seg.length === 3 && (leaf === "history" || leaf === "changes")) {
    const pane = `/pane/${id}${q}`;
    return file ? [home, pane, `/pane/${id}/changes${q}`] : [home, pane];
  }
  if (head === "settings" && seg.length === 1) return [home];
  if (head === "settings" && seg.length === 2 && id === "updates") {
    return [home, `/settings${q}`, `/settings/system${q}`];
  }
  if (head === "settings" && seg.length === 2) return [home, `/settings${q}`];
  if (head === "crew" && seg.length === 1) return [home, `/settings${q}`, `/settings/system${q}`];
  if (head === "machines" && seg.length === 1) return [home, `/settings${q}`];
  if (head === "machines" && seg.length === 2) return [home, `/settings${q}`, `/machines${q}`];
  return [];
}
