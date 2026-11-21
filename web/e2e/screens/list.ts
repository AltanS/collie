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
  { id: "space", route: "space/:spaceId", path: "/space/w2", title: "One Space with its sessions", wide: "column", setup: "herd12" , waive: { "targets@390": PHONE_TARGETS } },
  { id: "space-changes", route: "space/:spaceId/changes/*", path: "/space/w1/changes", title: "Changes of a Space", wide: "designed", state: "the folder tree" },

  // ── A session ────────────────────────────────────────────────────────────
  { id: "pane-chat", route: "pane/:paneId", path: "/pane/w1%3Ap1", title: "A session as Chat", wide: "designed", setup: "chat" , waive: { "no-sideways-scroll@390": STREAM_9PX, "targets@390": PHONE_TARGETS } },
  { id: "pane-terminal", route: "pane/:paneId", path: "/pane/w1%3Ap1", title: "A session as Terminal", wide: "designed", state: "Terminal view", setup: "terminal" , waive: { "targets@390": PHONE_TARGETS } },
  { id: "pane-two-columns", route: "pane/:paneId", path: "/pane/w1%3Ap1", title: "Two sessions side by side", wide: "designed", state: "two columns", setup: "twoColumns", widths: [1440], note: "the strip of columns exists only in the large-screen layout" },
  { id: "pane-menu", route: "pane/:paneId", path: "/pane/w1%3Ap1", title: "The pane menu open", wide: "designed", state: "pane menu open", setup: "paneMenu" , waive: { "no-sideways-scroll@390": STREAM_9PX, "targets@390": PHONE_TARGETS } },
  { id: "pane-keys-armed", route: "pane/:paneId", path: "/pane/w1%3Ap1", title: "Two sessions, the prefix armed", wide: "designed", state: "prefix armed, the keys shown", setup: "keysArmed", widths: [1440], note: "the key hints exist only in the large-screen layout" },
  { id: "pane-menu-by-key", route: "pane/:paneId", path: "/pane/w1%3Ap1", title: "The pane menu opened with the prefix and m", wide: "designed", state: "pane menu open by key", setup: "menuByKey", widths: [1440], note: "the key exists only in the large-screen layout" },
  { id: "pane-actions", route: "pane/:paneId", path: "/pane/w1%3Ap1", title: "The Actions palette open", wide: "designed", state: "Actions open", setup: "actions" , waive: { "no-sideways-scroll@390": STREAM_9PX, "targets@390": PHONE_TARGETS } },
  { id: "pane-tabs-long-names", route: "pane/:paneId", path: "/pane/w1%3Ap1?h=lodge", title: "Tab strip with long names", wide: "designed", state: "long Space and host names, five tabs", setup: "longTabs", widths: [1440, 1100, 390], note: "the tab strip defect: a tab drawn over the Space's name when the names are long" , waive: { "nothing-covers-a-label@390": "by design: the icon in the pane identity row is drawn over the middle of the name button, and nothing is hidden (checked on the shot)", "targets@390": PHONE_TARGETS } },
  { id: "pane-history", route: "pane/:paneId/history", path: "/pane/w1%3Ap1/history", title: "A session's History", wide: "column", setup: "chat" , waive: { "targets@390": PHONE_TARGETS } },
  { id: "pane-zoom", route: "pane/:paneId/zoom", path: "/pane/w1%3Ap1/zoom", title: "Zoomed output", wide: "same", state: "output zoomed", setup: "terminal", note: "a full-window reading surface: the output takes the whole window at any width, so one layout serves both" },
  { id: "pane-changes", route: "pane/:paneId/changes/*", path: "/pane/w1%3Ap1/changes", title: "Changes of a session", wide: "designed", state: "Changes only, the list", setup: "changesList" },
  { id: "pane-files", route: "pane/:paneId/changes/*", path: "/pane/w1%3Ap1/changes/files", title: "Files of a session", wide: "designed", state: "the folder tree" },
  { id: "pane-files-file", route: "pane/:paneId/changes/*", path: "/pane/w1%3Ap1/changes/files?path=src%2Fcart.ts", title: "A file open in the tree", wide: "designed", state: "a file open" },
  { id: "pane-changes-split", route: "pane/:paneId/changes/*", path: "/pane/w1%3Ap1/changes?repo=.&path=src%2Froutes%2Fcheckout.tsx", title: "A changed file side by side", wide: "designed", state: "the diff side by side", setup: "changesSplit", widths: [1440], note: "side by side exists only in the large-screen layout; the phone's diff is pane-changes' own" },
  { id: "trick-session", route: "trick/:paneId", path: "/trick/trick%3Alodge%3Aci%3Arun", title: "A trick's own session", wide: "column", setup: "tricks" },

  // ── The Hill ─────────────────────────────────────────────────────────────
  { id: "hill", route: "hill", path: "/hill", title: "The Hill, open decisions", wide: "column", setup: "rich" },
  { id: "trick-card", route: "trick-card/:decisionId", path: "/trick-card/dc_screens0001", title: "A card of Collie's own", wide: "column", setup: "hillCard" },

  // ── New ──────────────────────────────────────────────────────────────────
  { id: "new", route: "new", path: "/new", title: "New session page", wide: "column", setup: "rich" , waive: { "targets@390": PHONE_TARGETS } },
  { id: "new-add", route: "new/add", path: "/new/add", title: "Add your own launcher", wide: "column", setup: "rich" },

  // ── Settings ─────────────────────────────────────────────────────────────
  { id: "settings", route: "settings", path: "/settings", title: "Settings, the index", wide: "designed", setup: "rich" },
  { id: "settings-appearance", route: "settings/appearance", path: "/settings/appearance", title: "Settings, Appearance", wide: "designed" , waive: { "targets@390": PHONE_TARGETS } },
  { id: "settings-character", route: "settings/appearance/character", path: "/settings/appearance/character", title: "Settings, the header character", wide: "designed" , waive: { "targets@390": PHONE_TARGETS } },
  { id: "settings-harnesses", route: "settings/harnesses", path: "/settings/harnesses", title: "Settings, Harnesses", wide: "designed" , waive: { "targets@390": PHONE_TARGETS } },
  { id: "settings-accounts", route: "settings/accounts", path: "/settings/accounts", title: "Settings, Accounts", wide: "designed", setup: "accounts" },
  { id: "settings-accounts-add", route: "settings/accounts/add", path: "/settings/accounts/add", title: "Settings, add an account", wide: "designed", setup: "accounts" },
  { id: "settings-account", route: "settings/accounts/:id", path: "/settings/accounts/acct-work", title: "Settings, one account", wide: "designed", setup: "accounts" },
  { id: "settings-account-login", route: "settings/accounts/:id/login", path: "/settings/accounts/acct-work/login", title: "Settings, change an account's login", wide: "designed", setup: "accounts" },
  { id: "settings-device", route: "settings/device", path: "/settings/device", title: "Settings, Device", wide: "designed" , waive: { "targets@390": PHONE_TARGETS } },
  { id: "settings-voice", route: "settings/voice", path: "/settings/voice", title: "Settings, Voice", wide: "designed" },
  { id: "settings-voice-host", route: "settings/voice/host", path: "/settings/voice/host", title: "Settings, the host's voice option", wide: "designed" },
  { id: "settings-voice-model", route: "settings/voice/model", path: "/settings/voice/model", title: "Settings, the Whistle model", wide: "designed" },
  { id: "settings-alerts", route: "settings/alerts", path: "/settings/alerts", title: "Settings, Alerts", wide: "designed" , waive: { "targets@390": PHONE_TARGETS } },
  { id: "settings-experiments", route: "settings/experiments", path: "/settings/experiments", title: "Settings, Experiments", wide: "designed" , waive: { "targets@390": PHONE_TARGETS } },
  { id: "settings-tricks", route: "settings/tricks", path: "/settings/tricks", title: "Settings, Tricks", wide: "designed", setup: "tricks" , waive: { "targets@390": PHONE_TARGETS } },
  { id: "settings-trick", route: "settings/tricks/:key", path: "/settings/tricks/lodge%3Akettle", title: "Settings, one trick's details", wide: "designed", setup: "tricks", waive: { "targets@390": PHONE_TARGETS } },
  { id: "settings-system", route: "settings/system", path: "/settings/system", title: "Settings, System", wide: "designed" , waive: { "targets@390": PHONE_TARGETS } },
  { id: "settings-install-count", route: "settings/system/install-count", path: "/settings/system/install-count", title: "Settings, the install count", wide: "designed" },
  { id: "settings-updates", route: "settings/updates", path: "/settings/updates", title: "Updates", wide: "designed" , waive: { "targets@390": PHONE_TARGETS } },

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
} satisfies Record<string, string>;
