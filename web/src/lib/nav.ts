// Route path helpers. Pane ids contain a colon (e.g. "wE:p2"), so they must be URL-encoded in the
// path; React Router decodes them back in useParams. The active scope — which machine, which named
// session — rides along in the query (`?h=` / `?s=`, see lib/scope.ts) so a navigation stays pointed
// at the pane you were actually looking at. Lead + primary emits nothing, so a solo install's paths
// are byte-identical to what shipped before the host dimension existed.
//
// The host stays in the QUERY, never in the path: a `/host/:h/pane/:paneId` shape would fork every
// route, break every existing deep link, and force the loaders' isPaneUrl() to grow a parser.
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "./json";
import { internScope, scopeFromSearchParams, scopeKey, scopeSearch, SESSION_PARAM, type Scope } from "./scope";
import type { AgentView } from "./types";
import type { AgentLaunch } from "./agent-startup";
import type { PageId } from "./settings/types";

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
 * A pane's output, zoomed: the mirror's text alone, full screen, for pinch and pan. A child path of
 * the pane, like History, so it is a level and the phone's back closes it (ADR 0067). It reads the
 * pane's own loader and never moves the pane (ADR 0008).
 */
export function zoomPath(paneId: string, scope?: Scope): string {
  return `/pane/${encodeURIComponent(paneId)}/zoom${scopeSearch(scope)}`;
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

/**
 * A trick's own session (M94 slice 03): the screen with its view and its actions, one level below the
 * Dashboard. The id names its host (`trick:<host>:<trick>:<part>`), so no `?h=` rides along.
 */
export function trickSessionPath(paneId: string): string {
  return `/trick/${encodeURIComponent(paneId)}`;
}

/** A space's detail route (its tabs + panes). Deep-linkable; carries the scope like panePath. */
export function spacePath(spaceId: string, scope?: Scope): string {
  return `/space/${encodeURIComponent(spaceId)}${scopeSearch(scope)}`;
}

/** The dashboard path, carrying the current scope so "go home" doesn't drop you back to the lead. */
export function homePath(scope?: Scope, opts?: { all?: boolean }): string {
  return `/${scopeSearch(scope, opts)}`;
}

/** The query key that names the pane a conversations list was opened from, so its row leads. */
export const CONVERSATIONS_PANE_PARAM = "pane";
/** The query key a conversation's address carries for the state its list row showed. */
export const CONVERSATION_STATE_PARAM = "state";

function withQuery(base: string, extra: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) parts.push(`${key}=${encodeURIComponent(value)}`);
  }
  if (parts.length === 0) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${parts.join("&")}`;
}

/**
 * One conversation of that list, read-only. `state` is what the list row said, which is how the view
 * knows whether to offer Reopen; absent draws no Reopen.
 */
export function conversationPath(id: string, scope?: Scope, opts: { state?: "open" | "closed" } = {}): string {
  return withQuery(`/conversations/${encodeURIComponent(id)}${scopeSearch(scope)}`, { [CONVERSATION_STATE_PARAM]: opts.state });
}

/** The pane a conversations list was opened for (`?pane=`), or undefined. */
export function readConversationsPane(search: string): string | undefined {
  const pane = new URLSearchParams(search).get(CONVERSATIONS_PANE_PARAM);
  return pane === null || pane === "" ? undefined : pane;
}

/** The state a conversation's address carries (`?state=`); anything but the two words reads as absent. */
export function readConversationState(search: string): "open" | "closed" | undefined {
  const state = new URLSearchParams(search).get(CONVERSATION_STATE_PARAM);
  return state === "open" || state === "closed" ? state : undefined;
}

/** The settings route, carrying the current scope like the other path helpers. */
export function settingsPath(scope?: Scope): string {
  return `/settings${scopeSearch(scope)}`;
}

/**
 * Where the New page was opened from, which it reads back off its own address so a reload keeps it.
 * `machine` is the crew member it opens on (absent is the machine the view shows, else the lead);
 * `pane` is the pane whose folder and branch a worktree starts from, a pane's ⋯ "New agent in a
 * worktree"; `session` is that pane's named Herdr session. `machine` rides beside it as the pane's
 * own machine, where the worktree is made (ADR 0126).
 *
 * `beside` is a pane whose SPACE the new agent starts in, as a new tab there (a large screen's "New
 * agent in this space", ADR 0120): the bridge's launch route takes it as `paneId`. It is not `pane`:
 * that one opens a worktree, a new space. The page then stays on that pane's machine and offers no
 * worktree, since a worktree is a space of its own.
 */
export interface NewAt {
  machine?: string;
  pane?: string;
  beside?: string;
  session?: string;
  /**
   * The select option to open on, an item key (`row:claude --model opus`): where "Add your own"
   * sends the person back to, with the row it just made chosen.
   */
  pick?: string;
}

/** The query keys of {@link NewAt}. `session` is the scope's own `s`, so the root snapshot follows it. */
export const NEW_MACHINE_PARAM = "machine";
export const NEW_PANE_PARAM = "pane";
export const NEW_BESIDE_PARAM = "beside";
export const NEW_PICK_PARAM = "pick";
export const NEW_KIND_PARAM = "kind";

/** The New page (`/new`), a child of the screen it was opened from. Absent fields emit nothing. */
export function newPath(at: NewAt = {}): string {
  const q = new URLSearchParams();
  if (at.machine) q.set(NEW_MACHINE_PARAM, at.machine);
  if (at.pane) q.set(NEW_PANE_PARAM, at.pane);
  if (at.beside) q.set(NEW_BESIDE_PARAM, at.beside);
  if (at.session) q.set(SESSION_PARAM, at.session);
  if (at.pick) q.set(NEW_PICK_PARAM, at.pick);
  const query = q.toString();
  return query === "" ? "/new" : `/new?${query}`;
}

/** "Add your own" (`/new/add`), a child of the New page: the same machine, pane and session, and which half opens. */
export function newAddPath(at: NewAt = {}, kind: "agent" | "command" = "agent"): string {
  const q = new URLSearchParams({ [NEW_KIND_PARAM]: kind });
  if (at.machine) q.set(NEW_MACHINE_PARAM, at.machine);
  if (at.pane) q.set(NEW_PANE_PARAM, at.pane);
  if (at.beside) q.set(NEW_BESIDE_PARAM, at.beside);
  if (at.session) q.set(SESSION_PARAM, at.session);
  return `/new/add?${q.toString()}`;
}

/** Which half "Add your own" opens on, from its query. Anything but `command` is Agent. */
export function readNewAddKind(search: string): "agent" | "command" {
  return new URLSearchParams(search).get(NEW_KIND_PARAM) === "command" ? "command" : "agent";
}

/** {@link NewAt} read back off a query string. Blank values are absent. */
export function readNewAt(search: string): NewAt {
  const q = new URLSearchParams(search);
  const field = (key: string): string | undefined => {
    const v = q.get(key)?.trim();
    return v ? v : undefined;
  };
  return {
    machine: field(NEW_MACHINE_PARAM),
    pane: field(NEW_PANE_PARAM),
    beside: field(NEW_BESIDE_PARAM),
    session: field(SESSION_PARAM),
    pick: field(NEW_PICK_PARAM),
  };
}

/**
 * The Settings pages: the eleven of the registry (lib/settings/pages.ts, ADR 0170). Settings is an index of these,
 * not a column of every card it has. A union rather than a bare string, so a row naming a page nobody built is a
 * compile error instead of a page that renders nothing.
 */
export type SettingsSection = PageId;

/** One Settings section — a CHILD of the index, carrying the scope like every other path helper. */
export function settingsSectionPath(section: SettingsSection, scope?: Scope): string {
  return `/settings/${section}${scopeSearch(scope)}`;
}

/** The two pages below Settings → Voice: what the host uses for every device, and the Whistle model. */
export type VoicePage = "host" | "model";

/**
 * A page below Settings → Voice, a CHILD of that section (Back lands on Voice, not on the index).
 * Carries the scope like the others.
 */
export function voicePagePath(page: VoicePage, scope?: Scope): string {
  return `/settings/voice/${page}${scopeSearch(scope)}`;
}

/**
 * The two kinds of page below Settings → Accounts (M101): the Add form, and one account's page.
 * Both are CHILDREN of the list (Back lands on it, not on the index). Carry the scope like the others.
 */
export function accountsAddPath(scope?: Scope): string {
  return `/settings/accounts/add${scopeSearch(scope)}`;
}

/** One account's page. The id is the bridge's opaque one (`claude:default` for a Default row), so it is encoded. */
export function accountPath(id: string, scope?: Scope): string {
  return `/settings/accounts/${encodeURIComponent(id)}${scopeSearch(scope)}`;
}

/**
 * A trick's details page, below Settings → Tricks and the Hill: what the trick does, where it comes from, its code and its
 * settings. The key is `<host>:<id>` for a trick on a machine, the same two parts its own page's id names
 * (`trick:<host>:<id>`), and the bare `<id>` for an entry of this machine's official list that is not added
 * yet. Neither a host nor a trick id holds a colon (lib/tricks/schema.ts `HOST`, `TRICK_ID`), so the key splits
 * back. Encoded: the colon is written `%3A`, as a pane id's is. A CHILD of the list, and of the trick's own page
 * it may be opened from. Carries the scope like the others.
 */
export function trickDetailPath(key: string, scope?: Scope): string {
  return `/settings/tricks/${encodeURIComponent(key)}${scopeSearch(scope)}`;
}

/** The details page key of a trick on a machine: `<host>:<id>`. */
export function trickDetailKey(host: string, id: string): string {
  return `${host}:${id}`;
}

/** A details page key read back: the host and the id of a trick on a machine, or the id of an official entry. */
export type TrickDetailAddress = { kind: "trick"; host: string; id: string } | { kind: "official"; id: string };

/** Read a details page key (already decoded by the router). Undefined for a key of neither shape. */
export function readTrickDetailKey(key: string): TrickDetailAddress | undefined {
  const parts = key.split(":");
  if (parts.length === 1 && parts[0] !== "") return { kind: "official", id: parts[0] ?? "" };
  if (parts.length !== 2) return undefined;
  const [host = "", id = ""] = parts;
  if (host === "" || id === "") return undefined;
  return { kind: "trick", host, id };
}

/** One account's Change login page, below the account's page (M101). */
export function changeLoginPath(id: string, scope?: Scope): string {
  return `/settings/accounts/${encodeURIComponent(id)}/login${scopeSearch(scope)}`;
}

/**
 * The crew overview — the read-only census of every machine in the crew. Carries the scope like the
 * others so "back" returns you to the machine you were looking at, not to the lead.
 */
export function crewPath(scope?: Scope): string {
  return `/crew${scopeSearch(scope)}`;
}

/**
 * The hill (M96): the Decisions agents posted. A CHILD of the Dashboard, opened from the bottom bar. Carries the
 * scope like the others, so Back returns to the machine and session the Dashboard was showing.
 */
export function hillPath(scope?: Scope): string {
  return `/hill${scopeSearch(scope)}`;
}

/**
 * One card of Collie's own about a trick (M96 spec 14): a proposal, a new version, a trick's rights. Its own
 * page, with no Hill around it, so it works with the Hill off. Opened from Settings, Tricks and the Hill and from the
 * Dashboard's line; Back steps back to either, else to the Dashboard. Carries the scope like the others.
 */
export function trickCardPath(decisionId: string, scope?: Scope): string {
  return `/trick-card/${encodeURIComponent(decisionId)}${scopeSearch(scope)}`;
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

/** The fragment naming the Telemetry card on its page (M86 spec 02). */
export const TELEMETRY_SETTINGS_HASH = "install-count";

/**
 * Settings → Privacy and data → Telemetry: the page below Privacy and data that holds the switch and its
 * explanation (the dashboard notice's button lands here). A CHILD of that page, carrying the scope.
 */
export function installCountPath(scope?: Scope): string {
  return `/settings/privacy/install-count${scopeSearch(scope)}`;
}

/**
 * Settings → Look and feel → Character: the page below Look and feel that lists the characters the header
 * can draw (ADR 0136, amended 2026-11-12). A CHILD of that page, carrying the scope.
 */
export function characterPath(scope?: Scope): string {
  return `/settings/look/character${scopeSearch(scope)}`;
}

/** Settings → Notifications → one machine's load alerts: the machine's own card, one level below Notifications. */
export function machineLoadPath(id: string, scope?: Scope): string {
  return `/settings/notifications/load/${encodeURIComponent(id)}${scopeSearch(scope)}`;
}

/** Where the dashboard notice's button opens the Telemetry card. */
export function telemetrySettingsPath(scope?: Scope): string {
  return installCountPath(scope);
}

/** The fragment naming the Changes card inside Settings, which `changes-control.tsx` answers to. */
export const CHANGES_SETTINGS_HASH = "changes";

/**
 * Settings → Dashboard and projects, scrolled to the Changes card: the Changes list's "look deeper" link (ADR 0065).
 *
 * The fragment survived both splits; the page under it did not. A deep link names a PAGE, and it must, because a
 * hash pointing at a card the page does not mount scrolls to nothing.
 */
export function changesSettingsPath(scope?: Scope): string {
  return `${settingsSectionPath("dashboard", scope)}#${CHANGES_SETTINGS_HASH}`;
}

/** Settings → Devices and machines, scrolled to the card that pairs this phone — the read-only strip's remedy. */
export function pairedDevicesPath(scope?: Scope): string {
  return `${settingsSectionPath("devices", scope)}#${PAIRED_DEVICES_HASH}`;
}

/**
 * Where a `/settings` request with `?pair=` belongs: Settings → Devices and machines, the query string intact, or
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
  return `/settings/devices${search}`;
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
 * What Collie keeps in `location.state`: where a DOWN move came from, beside route-local extras
 * such as a just-created pane and its independently scoped launch intent.
 */
export interface NavState {
  from?: string;
  freshPane?: AgentView;
  /** A named terminal-agent launch, scoped separately from the optimistic shell bootstrap. */
  agentLaunch?: AgentLaunch;
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
  /**
   * A trick's page opened from an agent pane, for that pane's session (`from`): a belt mark, a status item or
   * the switcher. A button with `does = "draft"` on the page puts its text into that pane's reply box. A
   * sideways move does not carry it, so a page reached through the bottom bar fills no box.
   */
  forSession?: true;
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

/** Whether this trick page was opened for the session of the pane in `from` (see {@link NavState.forSession}). */
export function readForSession(state: JsonValue | undefined): boolean {
  return asJsonBoolean(asJsonObject(state)?.forSession) === true;
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
/** Likewise for a pane: the New page is opened from any one of them. */
const ANY_PANE = "/pane/*";
/** A trick session: a trick's view opens a pane, and back comes up to the view (M94 slice 03). */
const ANY_TRICK = "/trick/*";

/**
 * Every pathname that may legitimately sit above `pathname` in the level tree, nearest first.
 *
 *   L0 `/`
 *   L1 `/space/:id`, `/settings` (opened from the screen it was left, ADR 0163), `/crew`, `/hill`, `/new` (from the dashboard, a space or a pane)
 *   L1 `/trick/:id`, a trick session (M94 slice 03)
 *   L2 `/pane/:id`, `/new/add` (below the New page), `/space/:id/changes`, `/settings/:section`, `/settings/updates`, `/machines`
 *   L3 `/settings/accounts/add`, `/settings/accounts/:id`, `/settings/tricks/:key` (also below `/trick/:id`), `/settings/voice/host`, `/settings/voice/model`, `/settings/system/install-count`, `/settings/appearance/character`, `/pane/:id/history`, `/pane/:id/zoom`, `/pane/:id/changes` (a file view is the same path with `?repo=&path=`),
 *      `/space/:id/changes/commit`, `/space/:id/changes/files` (a folder or a file of the tree, with
 *      `?dir=` or `?path=`)
 *   L4 `/pane/:id/changes/commit` (the commit's file view adds `&path=`), `/pane/:id/changes/files`,
 *      `/settings/accounts/:id/login` (Change login; a pane is a parent too)
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
  if (head === "pane" && seg.length === 2) return [ANY_SPACE, "/", ANY_TRICK];
  if (head === "pane" && seg.length === 3 && (leaf === "history" || leaf === "zoom" || leaf === "changes")) {
    return [`/pane/${id}`, ANY_SPACE, "/"];
  }
  // A trick session sits on the Dashboard (M94 slice 03). It is opened from a pane too (Switch session,
  // a belt mark), and a trick's own view may open another trick's session.
  if (head === "trick" && seg.length === 2) return ["/", ANY_PANE, ANY_TRICK];
  // Settings is opened from the Dashboard's and a space's gear and from the large screen's sidebar, which
  // stands beside a pane, and a person may arrive from Crew, the Hill, New or Conversations too. It goes
  // back to whichever opened it (ADR 0163); a cold open has no entry behind and goes to the Dashboard.
  if (head === "settings" && seg.length === 1) return ["/", ANY_SPACE, ANY_PANE, "/crew", "/hill", "/new", "/conversations"];
  // The hill is opened from the bottom bar's fixed Hill item (M96): down from the Dashboard, or sideways
  // from a trick's Session, where the bar stays too (amended 2026-11-10). A sideways move carries `from`,
  // so the Dashboard is its only parent either way.
  if (head === "hill" && seg.length === 1) return ["/"];
  // A trick's card (M96 spec 14) is opened from Settings, Tricks and the Hill and from the Dashboard's line.
  if (head === "trick-card" && seg.length === 2) return ["/", "/settings/tricks"];
  // The approver's page (ADR 0139) is opened from a QR, from outside the app: the Dashboard is its parent.
  if (head === "pair" && seg.length === 2 && id === "approve") return ["/"];
  // A durable program's conversations are opened from a space's sheet (dashboard or space page) and
  // from a pane's menu; one conversation sits below the list.
  if (head === "conversations" && seg.length === 1) return ["/", ANY_SPACE, ANY_PANE];
  if (head === "conversations" && seg.length === 2) return ["/conversations", "/", ANY_SPACE, ANY_PANE];
  // The New page is opened from the dashboard, from a space, and from a pane's ⋯ menu.
  if (head === "new" && seg.length === 1) return ["/", ANY_SPACE, ANY_PANE];
  // "Add your own" is a level below the New page.
  if (head === "new" && seg.length === 2 && id === "add") return ["/new", "/", ANY_SPACE, ANY_PANE];
  // Every Settings page, Updates and about included, is a child of the index (ADR 0170).
  if (head === "settings" && seg.length === 2) return ["/settings", "/"];
  // Host speech and the Whistle model sit one level below Voice.
  if (head === "settings" && seg.length === 3 && id === "voice" && (leaf === "host" || leaf === "model")) {
    return ["/settings/voice", "/settings", "/"];
  }
  // The install count's page sits one level below Privacy and data.
  if (head === "settings" && seg.length === 3 && id === "privacy" && leaf === "install-count") {
    return ["/settings/privacy", "/settings", "/"];
  }
  // The Character page sits one level below Look and feel.
  if (head === "settings" && seg.length === 3 && id === "look" && leaf === "character") {
    return ["/settings/look", "/settings", "/"];
  }
  // One machine's load alerts sit one level below Notifications.
  if (head === "settings" && seg.length === 4 && id === "notifications" && leaf === "load") {
    return ["/settings/notifications", "/settings", "/"];
  }
  // A trick's details page sits one level below Tricks. Its own page (`/trick/:id`, the header's details button)
  // opens it too, so a step back onto that page is a step up and not a push.
  if (head === "settings" && seg.length === 3 && id === "tricks") {
    return ["/settings/tricks", ANY_TRICK, "/settings", "/"];
  }
  // The Add form and one account's page sit one level below Accounts.
  if (head === "settings" && seg.length === 3 && id === "accounts") {
    return ["/settings/accounts", "/settings", "/"];
  }
  // Change login sits below its account's page. A session's settings sheet opens it too, so a step back
  // onto that pane is a step up and not a push.
  if (head === "settings" && seg.length === 4 && id === "accounts" && seg[3] === "login") {
    return [`/settings/accounts/${leaf}`, ANY_PANE, "/settings/accounts", "/settings", "/"];
  }
  if (head === "crew" && seg.length === 1) return ["/settings/devices", "/settings", "/"];
  // Machines is opened from Devices and machines, its structural parent.
  if (head === "machines" && seg.length === 1) return ["/settings/devices", "/settings", "/"];
  // A machine goes up to Machines. The crew census opens one too (the member sheet's "Load and
  // alerts"), so a step back onto /crew is still a step UP and not a push.
  if (head === "machines" && seg.length === 2) return ["/machines", "/crew", "/settings/devices", "/settings", "/"];
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
  if (pattern === ANY_SPACE) return /^\/space\/[^/]+$/.test(pathname);
  if (pattern === ANY_PANE) return /^\/pane\/[^/]+$/.test(pathname);
  if (pattern === ANY_TRICK) return /^\/trick\/[^/]+$/.test(pathname);
  return decodedPath(pattern) === decodedPath(pathname);
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
 * parent: a cold deep link, an Updates page opened from the ribbon.
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

function searchOf(href: string): string {
  const cut = href.search(/[?#]/);
  return cut === -1 || href[cut] === "#" ? "" : href.slice(cut + 1).split("#")[0] ?? "";
}

function sameScope(a: string, b: string): boolean {
  const sa = scopeFromSearchParams(new URLSearchParams(searchOf(a)));
  const sb = scopeFromSearchParams(new URLSearchParams(searchOf(b)));
  return scopeKey(sa) === scopeKey(sb);
}

/**
 * The dashboard scope a route returns to on `nav.upTo(homePath(...))`. Most routes carry `?h=` /
 * `?s=` in their own URL; `/new` and `/new/add` carry `?machine=` / `?s=` instead, and `/trick/*`
 * carries neither so its caller's scope lives on `state.from`.
 */
export function resolveHomeScope(pathname: string, search: string, state?: JsonValue): Scope {
  const urlScope = scopeFromSearchParams(new URLSearchParams(search));
  const path = pathOnly(pathname);
  if (path === "/new" || path === "/new/add") {
    const at = readNewAt(search);
    const host = urlScope.host ?? at.machine;
    const session = urlScope.session ?? at.session;
    if (host !== undefined || session !== undefined) return internScope({ host, session });
  }
  if (urlScope.host !== undefined || urlScope.session !== undefined) return internScope(urlScope);
  if (path === "/new" || path === "/new/add" || path.startsWith("/trick/")) {
    const from = readFrom(state);
    if (from !== undefined) return internScope(scopeFromSearchParams(new URLSearchParams(searchOf(from))));
  }
  return internScope({});
}

/**
 * An UP move to one NAMED parent, not the nearest one: the pane's space breadcrumb goes to its space
 * even when the dashboard opened the pane. It steps back only when the entry behind us is that very
 * parent on the same host and session (`?h=` / `?s=`, because workspace ids collide across both),
 * and otherwise replaces this entry with it, so the space's own up still finds the dashboard.
 */
export function resolveUpTo(from: string | undefined, target: string, canGoBack = true): UpMove {
  if (
    canGoBack &&
    from !== undefined &&
    decodedPath(pathOnly(from)) === decodedPath(pathOnly(target)) &&
    sameScope(from, target)
  ) {
    return { kind: "back" };
  }
  return { kind: "replace", to: target };
}

/** A stored href as a comparable key: its pathname and its query pairs in a fixed order. */
function locationKey(href: string): string {
  const cut = href.search(/[?#]/);
  const pathname = cut === -1 ? href : href.slice(0, cut);
  const pairs = [...new URLSearchParams(searchOf(href)).entries()].map(([k, v]) => `${k}=${v}`).toSorted();
  return `${decodedPath(pathname)}?${pairs.join("&")}`;
}

/**
 * An UP move to one exact LOCATION: it steps back only when the entry behind is that very pathname
 * and query, and otherwise replaces this entry with it. `resolveUpTo` compares pathname and scope,
 * which is right between screens and wrong inside the Files view, where every folder shares one
 * pathname and only `?dir=` tells them apart (ADR 0083).
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
  if (head === "trick" && seg.length === 2) return [home];
  if (head === "pane" && seg.length === 3 && (leaf === "history" || leaf === "zoom" || leaf === "changes")) {
    const pane = `/pane/${id}${q}`;
    return file ? [home, pane, `/pane/${id}/changes${q}`] : [home, pane];
  }
  if (head === "settings" && seg.length === 1) return [home];
  if (head === "hill" && seg.length === 1) return [home];
  // A trick's card from its notification or a bookmark: the Dashboard behind it.
  if (head === "trick-card" && seg.length === 2) return [home];
  if (head === "pair" && seg.length === 2 && id === "approve") return [home];
  // The conversations list: behind it the pane it was opened for, else the dashboard. One conversation
  // sits under the dashboard, which is a durable machine's conversation list (M53 spec 12).
  if (head === "conversations" && seg.length === 1) {
    const pane = readConversationsPane(search);
    return pane === undefined ? [home] : [home, panePath(pane, scope)];
  }
  if (head === "conversations" && seg.length === 2) return [home];
  // The New page: behind it the screen it names (the pane whose worktree it is, else the view's machine).
  if (head === "new" && seg.length === 1) {
    const at = readNewAt(search);
    const view = { host: at.machine, session: at.session };
    const behind = at.pane ?? at.beside;
    return behind === undefined ? [homePath(view)] : [homePath(view), panePath(behind, view)];
  }
  // "Add your own": behind it the New page it was opened from, and behind that the New page's own.
  if (head === "new" && seg.length === 2 && id === "add") {
    const at = readNewAt(search);
    const view = { host: at.machine, session: at.session };
    const behind = at.pane ?? at.beside;
    const chain = behind === undefined ? [homePath(view)] : [homePath(view), panePath(behind, view)];
    return [...chain, newPath({ machine: at.machine, pane: at.pane, beside: at.beside, session: at.session })];
  }
  if (head === "settings" && seg.length === 2) return [home, `/settings${q}`];
  if (head === "settings" && seg.length === 3 && id === "voice" && (leaf === "host" || leaf === "model")) {
    return [home, `/settings${q}`, `/settings/voice${q}`];
  }
  if (head === "settings" && seg.length === 3 && id === "privacy" && leaf === "install-count") {
    return [home, `/settings${q}`, `/settings/privacy${q}`];
  }
  if (head === "settings" && seg.length === 3 && id === "look" && leaf === "character") {
    return [home, `/settings${q}`, `/settings/look${q}`];
  }
  if (head === "settings" && seg.length === 4 && id === "notifications" && leaf === "load") {
    return [home, `/settings${q}`, `/settings/notifications${q}`];
  }
  if (head === "settings" && seg.length === 3 && id === "accounts") {
    return [home, `/settings${q}`, `/settings/accounts${q}`];
  }
  if (head === "settings" && seg.length === 4 && id === "accounts" && seg[3] === "login") {
    return [home, `/settings${q}`, `/settings/accounts${q}`, `/settings/accounts/${leaf}${q}`];
  }
  if (head === "crew" && seg.length === 1) return [home, `/settings${q}`, `/settings/devices${q}`];
  if (head === "machines" && seg.length === 1) return [home, `/settings${q}`, `/settings/devices${q}`];
  if (head === "machines" && seg.length === 2) return [home, `/settings${q}`, `/settings/devices${q}`, `/machines${q}`];
  return [];
}
