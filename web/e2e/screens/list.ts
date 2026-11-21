import type { RuleId } from "./rules";
import type { SetupId } from "./setups";

// THE SCREEN LIST: every screen the web app draws, with what it is on a large screen. It is the one place that
// says which screens are still the phone's column pulled wide, so the backlog is a column count and not a feeling.
//
// Three things use it:
//   * `src/screens-list.test.ts` (vitest, in the normal web suite) keeps it complete: every route of `src/router.tsx`
//     has an entry, no entry names a route that is gone, and two ceilings only go down (see below).
//   * `e2e/screens.spec.ts` (`E2E_SET=screens`) opens every entry at 1440x900 (mouse) and 390x844 (touch), checks four
//     layout rules (`e2e/screens/rules.ts`) and, with `SCREENS_SHOTS=<dir>`, writes `<id>.<width>.png`.
//   * `e2e/screens/sheet.ts` turns that folder into contact sheets, 12 screens a sheet, each labelled with its `wide`.
//
// "Screen" and not "surface": the Surface is a word the bridge owns (`bridge/surface`).
//
// This file is plain data, so vitest can load it without Playwright. A `setup` is the NAME of a function in
// `./setups.ts` (that file needs Playwright and the fixtures); the type there keeps the names honest.

export interface Screen {
  /** kebab-case, unique, stable: the screenshot's file name. */
  id: string;
  /** The route pattern of `router.tsx` this entry covers, as a path with no leading slash: "settings/appearance", "pane/:paneId". "/" is the index. */
  route: string;
  /** The concrete path to open, e.g. "/pane/w1%3Ap1". */
  path: string;
  /** What the screen is, in five words. */
  title: string;
  /**
   * The large-screen status, set by a person looking at the 1440x900 shot, and never derived by a test.
   * "designed": has its own large-screen layout. "column": still the phone's column on a large screen, the
   * backlog. "same": one layout serves both on purpose, and `note` says why.
   */
  wide: "designed" | "column" | "same";
  /** A state of the route that is not its default: not paired, no spaces, a sheet or a menu open. */
  state?: string;
  /** Brings that state up: mocks and clicks, from `./setups.ts`. Runs after the fixtures. It opens `path` itself, or the spec does. */
  setup?: SetupId;
  /** The widths to open it at. Default: 1440 (mouse) and 390 (touch). */
  widths?: readonly number[];
  /**
   * Rules this screen is excused from, each with its reason: `"targets"` at every width, `"targets@390"` at one. A reason
   * that starts with `FINDING:` is a defect of the product that is not fixed yet; the person who fixes it removes the waiver.
   * A waiver that no longer excuses anything fails the run.
   */
  waive?: Partial<Record<RuleId | `${RuleId}@${number}`, string>>;
  note?: string;
}


/** One reason for the many phone screens with a button or switch under 44 px. They are the open items of `e2e/hitbox/known.json`. */
const PHONE_TARGETS = "FINDING: phone tap targets under 44px (switches are 44x24, header, tab and filter buttons 24 to 32), open items of e2e/hitbox/known.json";
/** The chat stream's own overflow at 390: a hidden 9px of the column. */
const STREAM_9PX = "FINDING: the chat stream is 9px wider than the 390px column (the 20px block-more buttons hold 30px of content) and its overflow is hidden, so a drag or a focus can nudge it sideways";

export const SCREENS: readonly Screen[] = [
  // ── The Dashboard ────────────────────────────────────────────────────────
  { id: "dashboard", route: "/", path: "/", title: "Dashboard, twelve Spaces", wide: "designed", setup: "herd12" },
  { id: "dashboard-few", route: "/", path: "/", title: "Dashboard, two Spaces", wide: "designed", state: "two Spaces", note: "the stub's own herd: two agents in two Spaces" },
  { id: "dashboard-many", route: "/", path: "/", title: "Dashboard, twenty-four Spaces", wide: "designed", state: "twenty-four Spaces", setup: "herd24" },
  { id: "dashboard-no-spaces", route: "/", path: "/", title: "Dashboard, no Space", wide: "designed", state: "no Space", setup: "herd0" },
  { id: "dashboard-not-paired", route: "/", path: "/", title: "Dashboard, browser not paired", wide: "designed", state: "not paired", setup: "notPaired" , waive: { "targets@390": PHONE_TARGETS } },
  { id: "dashboard-files", route: "/", path: "/", title: "Dashboard, the Files view", wide: "designed", state: "Files view", setup: "dashboardFiles", note: "one line a space, at most 720px from the grid's left edge" },
  { id: "dashboard-tricks", route: "/", path: "/", title: "Dashboard, six trick items in the views switch", wide: "designed", state: "six trick items", setup: "dashboardTricks", widths: [1440, 1100] },
  { id: "dashboard-unreachable", route: "/", path: "/", title: "Dashboard, the bridge unreachable", wide: "designed", state: "unreachable", setup: "unreachable" },
  { id: "dashboard-crew", route: "/", path: "/", title: "Dashboard, a crew of machines", wide: "designed", state: "three machines", setup: "crew" , waive: { "targets@390": PHONE_TARGETS } },
  { id: "dashboard-new-tab", route: "/", path: "/", title: "New tab dialog over the Dashboard", wide: "designed", state: "New tab dialog open", setup: "newTab" , waive: { "targets@390": PHONE_TARGETS } },
  { id: "dashboard-row-menu", route: "/", path: "/", title: "A row's menu over the Dashboard", wide: "designed", state: "row menu open", setup: "rowMenu" , waive: { "targets@390": PHONE_TARGETS } },
  { id: "space", route: "space/:spaceId", path: "/space/w2", title: "The space address", wide: "designed", setup: "herd12", note: "on a large screen the address opens the pane view of the Space's open tab, a Space with no pane the Dashboard (ADR 0173); the phone keeps the space page" },
  { id: "space-changes", route: "space/:spaceId/changes/*", path: "/space/w1/changes", title: "Changes of a Space", wide: "designed", state: "the folder tree" },

  // ── A session ────────────────────────────────────────────────────────────
  { id: "pane-chat", route: "pane/:paneId", path: "/pane/w1%3Ap1", title: "A session as Chat", wide: "designed", setup: "chat" , waive: { "no-sideways-scroll@390": STREAM_9PX, "targets@390": PHONE_TARGETS } },
  { id: "pane-terminal", route: "pane/:paneId", path: "/pane/w1%3Ap1", title: "A session as Terminal", wide: "designed", state: "Terminal view", setup: "terminal" , waive: { "targets@390": PHONE_TARGETS } },
  { id: "pane-two-columns", route: "pane/:paneId", path: "/pane/w1%3Ap1", title: "Two sessions side by side", wide: "designed", state: "two columns", setup: "twoColumns", widths: [1440], note: "the strip of columns exists only in the large-screen layout" },
  { id: "pane-menu", route: "pane/:paneId", path: "/pane/w1%3Ap1", title: "The pane menu open", wide: "designed", state: "pane menu open", setup: "paneMenu" , waive: { "no-sideways-scroll@390": STREAM_9PX, "targets@390": PHONE_TARGETS } },
  { id: "pane-keys-armed", route: "pane/:paneId", path: "/pane/w1%3Ap1", title: "Two sessions, the prefix armed", wide: "designed", state: "prefix armed, the keys shown", setup: "keysArmed", widths: [1440], note: "the key hints exist only in the large-screen layout" },
  { id: "pane-menu-by-key", route: "pane/:paneId", path: "/pane/w1%3Ap1", title: "The pane menu opened with the prefix and m", wide: "designed", state: "pane menu open by key", setup: "menuByKey", widths: [1440], note: "the key exists only in the large-screen layout" },
  { id: "pane-actions", route: "pane/:paneId", path: "/pane/w1%3Ap1", title: "The Actions palette open", wide: "designed", state: "Actions open", setup: "actions" , waive: { "no-sideways-scroll@390": STREAM_9PX, "targets@390": PHONE_TARGETS } },
  { id: "pane-tabs-long-names", route: "pane/:paneId", path: "/pane/w1%3Ap1?h=lodge", title: "Tab strip with long names", wide: "designed", state: "long Space and host names, five tabs", setup: "longTabs", widths: [1440, 1100, 390], note: "the tab strip defect: a tab drawn over the Space's name when the names are long" , waive: { "nothing-covers-a-label@390": "by design: the icon in the pane identity row is drawn over the middle of the name button, and nothing is hidden (checked on the shot)" } },
  { id: "pane-history", route: "pane/:paneId/history", path: "/pane/w1%3Ap1/history", title: "A session's History", wide: "column", setup: "chat" , waive: { "targets@390": PHONE_TARGETS } },
  { id: "pane-zoom", route: "pane/:paneId/zoom", path: "/pane/w1%3Ap1/zoom", title: "Zoomed output", wide: "same", state: "output zoomed", setup: "terminal", note: "a full-window reading surface: the output takes the whole window at any width, so one layout serves both" },
  // The lazy-screens spec opens each route at its LAST entry here, offline: the tree's root, which draws no diff (a
  // diff asks for the highlighter, an older door whose shared chunks that spec does not list).
  { id: "pane-files-file", route: "pane/:paneId/changes/*", path: "/pane/w1%3Ap1/changes/files?path=src%2Fcart.ts", title: "A file open in the tree", wide: "designed", state: "a file open" },
  { id: "pane-changes-split", route: "pane/:paneId/changes/*", path: "/pane/w1%3Ap1/changes?repo=.&path=src%2Froutes%2Fcheckout.tsx", title: "A changed file side by side", wide: "designed", state: "the diff side by side", setup: "changesSplit", widths: [1440], note: "side by side exists only in the large-screen layout; the phone's diff is pane-changes' own" },
  { id: "pane-changes", route: "pane/:paneId/changes/*", path: "/pane/w1%3Ap1/changes", title: "Changes of a session", wide: "designed", state: "Changes only, the list", setup: "changesList" },
  { id: "pane-files", route: "pane/:paneId/changes/*", path: "/pane/w1%3Ap1/changes/files", title: "Files of a session", wide: "designed", state: "the folder tree" },
  { id: "trick-session", route: "trick/:paneId", path: "/trick/trick%3Alodge%3Aci%3Arun", title: "A trick's own session", wide: "column", setup: "tricks" },

  // ── The Hill ─────────────────────────────────────────────────────────────
  { id: "hill", route: "hill", path: "/hill", title: "The Hill, open decisions", wide: "column", setup: "rich" },
  { id: "trick-card", route: "trick-card/:decisionId", path: "/trick-card/dc_screens0001", title: "A card of Collie's own", wide: "column", setup: "hillCard" },

  // ── New ──────────────────────────────────────────────────────────────────
  { id: "new", route: "new", path: "/new", title: "New over the Dashboard", wide: "designed", setup: "newOver", note: "on a large screen `/new` is the Dashboard with New as a dialog over it (ADR 0173); the phone keeps the page", waive: { "targets@390": PHONE_TARGETS } },
  { id: "new-over-pane", route: "new", path: "/pane/w1%3Ap1?over=%2Fnew%3Fpane%3Dw1%253Ap1", title: "New over a session", wide: "designed", state: "New over the pane view", setup: "newOverPane", widths: [1440], note: "New over a screen exists only in the large-screen layout" },
  { id: "new-browse", route: "new", path: "/new", title: "New with Browse open", wide: "designed", state: "Browse open", setup: "newBrowse", widths: [1440], note: "the phone's page is the entry `new`" },
  { id: "new-worktree", route: "new", path: "/new", title: "New with New worktree on", wide: "designed", state: "New worktree on", setup: "newWorktree", widths: [1440], note: "the phone's page is the entry `new`" },
  { id: "new-add", route: "new/add", path: "/new/add", title: "Add your own launcher", wide: "designed", setup: "newOver", note: "on a large screen a one-column dialog over the Dashboard; the phone keeps the page" },

  // ── Settings ─────────────────────────────────────────────────────────────
  { id: "settings", route: "settings", path: "/settings", title: "Settings, the index", wide: "designed", setup: "rich" },
  // The eleven pages (ADR 0170), in the index's order, and the search with a result.
  { id: "settings-search", route: "settings", path: "/settings", title: "Settings, the search with results", wide: "designed", state: "a query with results", setup: "settingsSearch" },
  { id: "settings-look", route: "settings/look", path: "/settings/look", title: "Settings, Look and feel", wide: "designed", waive: { "targets@390": PHONE_TARGETS } },
  { id: "settings-character", route: "settings/look/character", path: "/settings/look/character", title: "Settings, the header character", wide: "designed", waive: { "targets@390": PHONE_TARGETS } },
  { id: "settings-chat", route: "settings/chat", path: "/settings/chat", title: "Settings, Chat and terminal", wide: "designed", waive: { "targets@390": PHONE_TARGETS } },
  { id: "settings-keys", route: "settings/keys", path: "/settings/keys", title: "Settings, Keys and touch", wide: "designed", waive: { "targets@390": PHONE_TARGETS } },
  { id: "settings-notifications", route: "settings/notifications", path: "/settings/notifications", title: "Settings, Notifications", wide: "designed", setup: "settingsMachines", waive: { "targets@390": PHONE_TARGETS } },
  { id: "settings-machine-load", route: "settings/notifications/load/:machine", path: "/settings/notifications/load/lodge", title: "Settings, one machine's load alerts", wide: "designed", setup: "settingsMachines", waive: { "targets@390": PHONE_TARGETS } },
  { id: "settings-voice", route: "settings/voice", path: "/settings/voice", title: "Settings, Voice", wide: "designed" },
  { id: "settings-voice-host", route: "settings/voice/host", path: "/settings/voice/host", title: "Settings, the host's voice option", wide: "designed" },
  { id: "settings-voice-model", route: "settings/voice/model", path: "/settings/voice/model", title: "Settings, the Whistle model", wide: "designed" },
  { id: "settings-dashboard", route: "settings/dashboard", path: "/settings/dashboard", title: "Settings, Dashboard and projects", wide: "designed", waive: { "targets@390": PHONE_TARGETS } },
  { id: "settings-accounts", route: "settings/accounts", path: "/settings/accounts", title: "Settings, Profiles", wide: "designed", setup: "accounts" },
  { id: "settings-accounts-add", route: "settings/accounts/add", path: "/settings/accounts/add", title: "Settings, add a profile", wide: "designed", setup: "accounts" },
  { id: "settings-account", route: "settings/accounts/:id", path: "/settings/accounts/acct-work", title: "Settings, one profile", wide: "designed", setup: "accounts" },
  { id: "settings-account-login", route: "settings/accounts/:id/login", path: "/settings/accounts/acct-work/login", title: "Settings, change a profile's login", wide: "designed", setup: "accounts" },
  { id: "settings-tricks", route: "settings/tricks", path: "/settings/tricks", title: "Settings, Tricks and the Hill", wide: "designed", setup: "tricks", waive: { "targets@390": PHONE_TARGETS } },
  { id: "settings-trick", route: "settings/tricks/:key", path: "/settings/tricks/lodge%3Akettle", title: "Settings, one trick's details", wide: "designed", setup: "tricks", waive: { "targets@390": PHONE_TARGETS } },
  { id: "settings-trick-remove", route: "settings/tricks/:key", path: "/settings/tricks/lodge%3Akettle", title: "A trick that is off, Remove", wide: "designed", state: "trick off, Remove section in view", setup: "trickRemove", waive: { "targets@390": PHONE_TARGETS } },
  { id: "settings-trick-remove-confirm", route: "settings/tricks/:key", path: "/settings/tricks/lodge%3Akettle", title: "The Remove confirm open", wide: "designed", state: "Remove confirm open", setup: "trickRemoveConfirm" },
  { id: "settings-devices", route: "settings/devices", path: "/settings/devices", title: "Settings, Devices and machines", wide: "designed" },
  { id: "settings-privacy", route: "settings/privacy", path: "/settings/privacy", title: "Settings, Privacy and data", wide: "designed" },
  { id: "settings-install-count", route: "settings/privacy/install-count", path: "/settings/privacy/install-count", title: "Settings, the install count", wide: "designed" },
  { id: "settings-updates", route: "settings/updates", path: "/settings/updates", title: "Settings, Updates and about", wide: "designed", waive: { "targets@390": PHONE_TARGETS } },

  // ── Machines and the crew ────────────────────────────────────────────────
  { id: "crew", route: "crew", path: "/crew", title: "The crew census", wide: "column", setup: "crewPage" },
  { id: "machines", route: "machines", path: "/machines", title: "Machines", wide: "column", setup: "machines" },
  { id: "machine", route: "machines/:id", path: "/machines/lodge", title: "One machine's page", wide: "column", setup: "machines" },

  // ── Durable programs and pairing ─────────────────────────────────────────
  { id: "conversations", route: "conversations", path: "/conversations", title: "A durable program's conversations", wide: "column", setup: "conversations" },
  { id: "conversation", route: "conversations/:id", path: "/conversations/conv-1", title: "One conversation, read only", wide: "column", setup: "conversations" },
  { id: "pair-approve", route: "pair/approve", path: "/pair/approve?r=abcdefghijklmnop", title: "Approve a pairing request", wide: "column", setup: "pairApprove" },
];

/**
 * Routes of `router.tsx` that are not a screen, each with its reason. A new route is not welcome here: it takes an entry
 * above, because a route a person can reach is a screen.
 */
export const NOT_A_SCREEN = {
  "slot/:slot": "a permanent address that replaces itself with that browser tab's last pane (lib/slots.ts); it draws nothing of its own",
  pack: "a redirect to crew (the path was renamed in 1.7.0)",
  // The Settings pages before ADR 0170 (2026-11-21): each opens the page that holds most of what it held, with the query
  // and the fragment (routes/settings-redirect.tsx `OldSettingsRedirect`); `e2e/settings-redirects.spec.ts` opens each.
  "settings/appearance": "a redirect to settings/look (Settings became eleven pages, ADR 0170)",
  "settings/appearance/character": "a redirect to settings/look/character (ADR 0170)",
  "settings/harnesses": "a redirect to settings/chat, where the status line per agent is now (ADR 0170)",
  "settings/device": "a redirect to settings/keys; its #changes fragment opens settings/dashboard (ADR 0170)",
  "settings/alerts": "a redirect to settings/notifications (ADR 0170)",
  "settings/experiments": "a redirect to settings/tricks, which holds both experiments' switches (ADR 0170)",
  "settings/system": "a redirect to settings/devices; its #install-count fragment opens settings/privacy (ADR 0170)",
  "settings/system/install-count": "a redirect to settings/privacy/install-count (ADR 0170)",
} satisfies Record<string, string>;
