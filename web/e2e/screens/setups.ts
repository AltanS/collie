import type { Page, Route } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { AgentView, SnapshotResponse, TabView } from "@/lib/types";
import {
  fixtureCrewStatus,
  fixtureLaunchersWithAgents,
  fixtureSnapshot,
} from "@/test/handlers";
import { collieCard } from "@/test/hill-fixtures";
import { partKey, type MenuRow, type WireTrickInfo, type WireTrickPart } from "@/lib/tricks/schema";

import { actionsButton } from "../fixtures/actions";
import { installApiStub, installCrewWorld, installLauncherWorld, installMachinesWorld } from "../fixtures/api";
import { installHeadWorld } from "../fixtures/wide-head";
import { installWideChatWorld, openColumns } from "../fixtures/wide-chat";
import { wideSnapshot } from "../fixtures/wide-herd";
import { installWorld } from "../hitbox/world";
import type { Screen } from "./list";

// THE WORLDS OF THE SCREEN LIST. Each setup puts a page into the state its entry names, with the repository's own
// fixtures and no bridge: `installApiStub` answers every `/api/*` in the page (e2e/fixtures/api.ts). A setup opens
// the entry's `path` itself; one that does not leaves it to the spec. This file needs Playwright, so the plain
// list (`list.ts`) only names its functions.

export type Setup = (page: Page, screen: Screen) => Promise<void>;

const DASH_PREFS = "collie:dash-prefs:v1";

function json<T extends object>(route: Route, body: T, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/** Answer the snapshot with one fixed body. The stub's order rule holds: the newest `page.route` is checked first. */
async function serveSnapshot(page: Page, snapshot: SnapshotResponse): Promise<void> {
  await page.route((url) => url.pathname === "/api/snapshot", (route) => json(route, snapshot));
}

/**
 * Answers the reads the default stub leaves at 501, so a page is drawn in its real state and not as an error. The newest
 * `page.route` wins, so a setup may still answer any of these its own way. Nothing here carries text from a real machine.
 */
export async function installScreenStubs(page: Page): Promise<void> {
  await page.route("**/api/telemetry", (route) => json(route, { on: false, decidedBy: "ci", setting: null, next: null }));
  await page.route("**/api/telemetry/trouble", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/diag/composer", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/folders", (route) => json(route, { recent: ["/home/you/webapp", "/home/you/collie"], favourites: ["/home/you/docs"], home: "/home/you" }));
  await page.route("**/api/stt/host", (route) =>
    json(route, { provider: "whistle", available: true, configuredBy: "file", codexBin: "/usr/bin/codex", switchable: { whistle: { ok: true }, codex: { ok: true }, off: { ok: true } } }),
  );
  await page.route("**/api/worktree/folder", (route) => json(route, { ok: true, dir: null, fallback: "/home/you/worktrees" }));
  await page.route("**/api/notifications/cache-watch/list", (route) => json(route, { entries: [] }));
  await page.route("**/api/report/context", (route) => json(route, { collie: "1.27.0", line: "stable", os: "linux", arch: "x64", mux: "herdr", harness: "claude", screenable: false }));
}

const official = (id: string, name: string, state: "absent" | "added", description: string) => ({
  id, name, description, repo: `https://github.com/lodge/${id}`, repoName: `lodge/${id}`, commit: "0123456789abcdef0123456789abcdef01234567", state,
});

/**
 * The reads that make a page show its filled state, answered once before the entry's setup. A world that serves the same path
 * registers after this and wins. Not part of `installScreenStubs`, which `visit` runs again after the world.
 */
export async function installFilledReads(page: Page): Promise<void> {
  await page.route("**/api/accounts", (route) =>
    json(route, {
      harnesses: [{ id: "claude", label: "Claude Code", select: "CLAUDE_CONFIG_DIR", kinds: ["shared", "own"], newFolder: "~/.claude-{slug}", binary: "claude" }],
      accounts: [{ harness: "claude", live: false, seenAt: null, windows: [], id: "claude:default", label: "", kind: "default", folder: "~/.claude", startLine: "claude" }],
      found: [],
    }),
  );
  await page.route("**/api/tricks/official", (route) =>
    json(route, { tricks: [official("kettle-watch", "Kettle Watch", "absent", "Says when the kettle in the build log is boiling."), official("shelf", "Shelf", "added", "Keeps a list of jars on a shelf.")] }),
  );
  await page.route("**/api/tricks/*/*/code", (route) => json(route, { hash: "a".repeat(64), copy: "approved", files: [{ file: "kettle.ts", size: 1840, flagged: 1 }, { file: "README.md", size: 620, flagged: 0 }] }));
  await page.route("**/api/hill/state", (route) => json(route, { state: "here", at: null, by: null, told: null }));
  await page.route("**/api/trick-views*", (route) => json(route, { rev: 1, views: [] }));
}

/** `filled: false` for a world that serves one of the filled reads itself and must not be overwritten. */
async function visit(page: Page, screen: Screen, filled = true): Promise<void> {
  await installScreenStubs(page);
  if (filled) await installFilledReads(page);
  await page.goto(screen.path);
}

/** Wait for an open dialog: an entry that opens a sheet or a menu must not be read before it is there. */
async function dialogShown(page: Page): Promise<void> {
  await page.locator('[role="dialog"]').first().waitFor({ state: "visible", timeout: 8000 });
}

/** The larger herd of the hitbox census, with the Hill on, and launchers to offer. */
async function richWorld(page: Page, screen: Screen, folders = false): Promise<void> {
  await installWorld(page);
  await page.route("**/api/launchers", (route) => json(route, fixtureLaunchersWithAgents));
  // After the world, so these answer first (Playwright checks the newest route first).
  if (folders) await newFolders(page);
  await visit(page, screen);
}

/** The folder reads New makes: a home folder to browse, and a worktree plan for a git folder. */
async function newFolders(page: Page): Promise<void> {
  const names = ["collie", "docs", "notes", "projects", "scratch", "webapp", "worktrees"];
  await page.route(
    (url) => url.pathname === "/api/folders/browse",
    (route) => json(route, { path: "~", parent: null, folders: names.map((name) => ({ name, git: name !== "notes" && name !== "scratch" })), filter: "", truncated: false }),
  );
  await page.route(
    (url) => url.pathname === "/api/worktree/plan",
    (route) => json(route, { ok: true, currentBranch: "main", defaultBranch: "main", branchValid: true, defaultTarget: { path: "/home/you/worktrees/webapp-fix", exists: false } }),
  );
}

const preferences = (page: Page, prefs: Record<string, string>) =>
  page.addInitScript(
    ([key, value]) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    [DASH_PREFS, JSON.stringify(prefs)],
  );

// ── The tricks world: two tricks with rows in a pane's menu, a mark on the belt and a session page ───────────────
const AS_OF = new Date(Date.now() - 20_000).toISOString();
function trickInfo(id: string, name: string, icon: WireTrickInfo["icon"], places: WireTrickInfo["places"]): WireTrickInfo {
  return { host: "lodge", id, name, icon, on: true, state: "ok", places };
}
function menuPart(trick: string, rows: MenuRow[]): WireTrickPart {
  return { host: "lodge", trick, part: trick, rev: 1, asOf: AS_OF, fresh: "10m", value: { at: "menu", id: trick, rows } };
}
/** A third-party trick from a repository, with a program, settings, a warning and a README: the details page has something to show. */
const KETTLE: WireTrickInfo = {
  host: "lodge",
  id: "kettle",
  name: "Kettle Watch",
  icon: "flask",
  on: true,
  state: "ok",
  places: ["session", "belt"],
  description: "Says when the kettle in the build log is boiling.",
  about: "Kettle Watch reads one line of the build log every minute and draws how hot the kettle is.\n\nIt never writes a file.",
  run: "bun run kettle.ts",
  everyMs: 300_000,
  inputs: { globs: ["kettle.log"], crew: false },
  env: ["KETTLE_TOKEN"],
  warnings: [{ kind: "network", text: "This trick reaches the network." }],
  version: "1.2.0",
  fields: [{ key: "room", kind: "text", label: "Room", hint: "where the kettle stands" }],
  provenance: { via: "repo", at: "2026-11-08T09:38:00Z", repo: "lodge/kettle-watch", sha: "3f2a91c0d1e2" },
};
const TRICKS = [trickInfo("ci", "CI", "flask", ["menu", "belt", "session"]), trickInfo("notes", "Notes", "note", ["menu"]), KETTLE];
const TRICK_PARTS: WireTrickPart[] = [
  menuPart("ci", [
    { id: "rerun", kind: "button", label: "Rerun CI", icon: "refresh", intent: "rerun" },
    { id: "watch", kind: "switch", label: "Watch branch", icon: "flag", intent: "watch", on: true },
  ]),
  menuPart("notes", [{ id: "pin", kind: "button", label: "Pin this session", icon: "pin", intent: "pin" }]),
  { host: "lodge", trick: "ci", part: "legs", rev: 1, asOf: AS_OF, fresh: "10m", value: { at: "belt", id: "legs", mark: { icon: "check", label: "23/34", tone: "ok" } } },
  {
    host: "lodge",
    trick: "ci",
    part: "run",
    rev: 1,
    asOf: AS_OF,
    fresh: "10m",
    value: {
      at: "session",
      id: "run",
      name: "Browser leg",
      actions: [
        { id: "rerun", label: "Rerun red", intent: "rerun" },
        { id: "fix", label: "Ask for a fix", intent: "fix" },
      ],
      view: [
        { kind: "para", text: "23 of 34 cases green" },
        { kind: "list", kids: [{ kind: "row", text: "case 24: the menu", kids: [{ kind: "button", attrs: { label: "Rerun case", intent: "rerun", value: "24" } }] }] },
      ],
    },
  },
];
const TRICK_SESSION: AgentView = {
  paneId: "trick:lodge:ci:run",
  workspaceId: "trick:lodge",
  workspaceLabel: "Tricks",
  workspaceNumber: 99,
  tabId: "trick:lodge:ci",
  agent: "ci",
  status: "working",
  cwd: "/home/you/.config/collie/tricks/ci",
  focused: false,
  kind: "trick",
  paneLabel: "Browser leg",
  sessionName: "Browser leg",
  subtitle: "case 24 red",
  badge: { count: 1 },
  view: "lodge/ci/run",
};

async function tricksWorld(page: Page, tricks: readonly WireTrickInfo[] = TRICKS): Promise<void> {
  const snapshot: SnapshotResponse = { ...fixtureSnapshot, tricksRev: 1, agents: [...fixtureSnapshot.agents, TRICK_SESSION] };
  await serveSnapshot(page, snapshot);
  await page.route("**/api/tricks?*", (route) => json(route, { rev: 1, tricks, parts: TRICK_PARTS, present: TRICK_PARTS.map(partKey) }));
  await page.route("**/api/tricks", (route) => json(route, { rev: 1, tricks, parts: TRICK_PARTS, present: TRICK_PARTS.map(partKey) }));
}

/** The tricks world with Kettle Watch switched off: its details page offers Remove (ADR 0168). */
const KETTLE_OFF: WireTrickInfo = { ...KETTLE, on: false, state: "off" };
const TRICKS_KETTLE_OFF = TRICKS.map((trick) => (trick.id === "kettle" ? KETTLE_OFF : trick));

// ── The accounts world, the durable conversations and the machine pages ──────────────────────────────────────────
async function accountsWorld(page: Page): Promise<void> {
  const base = { harness: "claude", live: false, seenAt: null, windows: [] };
  await page.route("**/api/accounts", (route) =>
    json(route, {
      harnesses: [{ id: "claude", label: "Claude Code", select: "CLAUDE_CONFIG_DIR", kinds: ["shared", "own"], newFolder: "~/.claude-{slug}", binary: "claude" }],
      accounts: [
        { ...base, id: "claude:default", label: "", kind: "default", folder: "~/.claude", startLine: "claude" },
        { ...base, id: "acct-work", label: "Work", kind: "shared", folder: "~/.claude-work", startLine: "CLAUDE_CONFIG_DIR=~/.claude-work claude", windows: [{ window: "5h", usedPct: 41, resetsAt: Date.now() + 3_600_000 }], seenAt: Date.now() },
      ],
      found: [],
    }),
  );
}

async function conversationsWorld(page: Page): Promise<void> {
  const items = [
    { id: "conv-1", title: "Release notes for the new build", subtitle: "3 turns", startedAt: "2026-11-20T09:00:00Z", state: "closed", items: 3 },
    { id: "conv-2", title: "Fix the stamp date", startedAt: "2026-11-20T10:00:00Z", state: "open", items: 7 },
  ];
  await page.route("**/api/durable/conversations*", (route) => json(route, { available: true, items }));
  await page.route("**/api/durable/conversation/*/items*", (route) =>
    json(route, {
      available: true,
      id: "conv-1",
      more: false,
      entries: [
        { uuid: "e1", ts: "2026-11-20T09:00:00Z", role: "user", parts: [{ kind: "text", text: "Find where the release date comes from." }] },
        { uuid: "e2", ts: "2026-11-20T09:01:00Z", role: "assistant", parts: [{ kind: "text", text: "It comes from the stamp script. I change it to read the build date." }] },
      ],
    }),
  );
}

// ── The long-name tab strip (a tab drawn over the space's name) ─────────────────────────────
const LONG_SPACE = "release-train-planning-and-the-weekly-changelog";
const LONG_HOST = "build-workstation-in-the-basement";
const LONG_TABS = ["release lead", "changelog and release notes", "browser leg on the phone", "tricks", "scratch"];

function longTabs(): SnapshotResponse {
  const base = wideSnapshot({ spaces: 3, crew: true });
  const workspaces = base.workspaces.map((w) => (w.workspaceId === "w1" ? Object.assign({}, w, { label: LONG_SPACE, tabCount: LONG_TABS.length, activeTabId: "w1:t1" }) : w));
  const tabs: TabView[] = [
    ...base.tabs.filter((t) => t.workspaceId !== "w1"),
    ...LONG_TABS.map((label, i): TabView => ({ tabId: `w1:t${String(i + 1)}`, workspaceId: "w1", number: i + 1, label, focused: i === 0, paneCount: 1, host: "lodge" })),
  ];
  const first = base.agents.find((a) => a.paneId === "w1:p1");
  if (first === undefined) throw new Error("the wide herd has no pane w1:p1");
  const extra: AgentView[] = LONG_TABS.slice(1).map((label, i) => Object.assign({}, first, { paneId: `w1:p${String(i + 10)}`, tabId: `w1:t${String(i + 2)}`, tabLabel: label, workspaceLabel: LONG_SPACE, terminalTitle: label }));
  const agents = base.agents.map((a) => (a.workspaceId === "w1" ? Object.assign({}, a, { workspaceLabel: LONG_SPACE, tabLabel: LONG_TABS[0] }) : a));
  const servers = (base.servers ?? []).map((s) => (s.id === "lodge" ? Object.assign({}, s, { name: LONG_HOST }) : s));
  return { ...base, workspaces, tabs, agents: [...agents, ...extra], servers };
}

/**
 * The pane's Terminal text of these worlds. Made up here, because the recorded screens of the unit layer carry a real
 * person's name and paths and a shot of one would put them in a report.
 */
const TERMINAL_TEXT = [
  "$ bun test scripts/stamp.test.ts",
  "bun test v1.3",
  "",
  "scripts/stamp.test.ts:",
  "(pass) the stamp reads the build date",
  "(pass) the stamp keeps the tag date for a release",
  "",
  " 2 pass",
  " 0 fail",
  "Ran 2 tests across 1 file.",
  "$ ",
].join("\n");

/** The chat world, with a made-up Terminal. */
async function chatWorld(page: Page): Promise<void> {
  await installWideChatWorld(page);
  await page.route(
    (url) => /^\/api\/pane\/[^/]+$/.test(url.pathname),
    (route) => json(route, { paneId: decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3] ?? ""), text: TERMINAL_TEXT, truncated: false, revision: 1 }),
  );
}

/** Every setup by name. A name is what an entry of `list.ts` holds. */
export const SETUPS = {
  /** The larger herd of the hitbox census, with the Hill on. */
  rich: (page, screen) => richWorld(page, screen),
  /** The same herd for a crew: three machines in the roster, the census to match, the four machines of Machines. */
  crew: async (page, screen) => {
    await installWorld(page);
    await installCrewWorld(page);
    await installMachinesWorld(page);
    await visit(page, screen);
  },
  /** One machine's crew census alone. */
  crewPage: async (page, screen) => {
    await installCrewWorld(page);
    await page.route((url) => url.pathname === "/api/crew", (route) => json(route, fixtureCrewStatus));
    await visit(page, screen);
  },
  /** Twelve Spaces of two or three sessions each, two blocked and one unseen. */
  herd12: async (page, screen) => {
    await serveSnapshot(page, wideSnapshot({ spaces: 12, blocked: ["w2:p1", "w7:p1"], unseen: ["w4:p2"] }));
    await visit(page, screen);
  },
  /** Twenty-four Spaces. */
  herd24: async (page, screen) => {
    await serveSnapshot(page, wideSnapshot({ spaces: 24, blocked: ["w2:p1", "w7:p1"], unseen: ["w4:p2"] }));
    await visit(page, screen);
  },
  /** A bridge with no Space at all. */
  herd0: async (page, screen) => {
    await serveSnapshot(page, { ...fixtureSnapshot, agents: [], shellPanes: [], workspaces: [], tabs: [] });
    await visit(page, screen);
  },
  /** The Dashboard's Files view: the views switch of the header on a large screen, the foot's tab on a phone. */
  dashboardFiles: async (page, screen) => {
    await serveSnapshot(page, wideSnapshot({ spaces: 3, blocked: ["w2:p1"], unseen: ["w3:p2"] }));
    await visit(page, screen);
    const wide = (page.viewportSize()?.width ?? 0) >= 900;
    const files = wide ? page.getByRole("tab", { name: en["files.title"] }) : page.getByRole("navigation", { name: en["home.tabs.aria"] }).getByRole("button", { name: en["files.title"] });
    await files.first().click();
    await page.getByRole("heading", { name: "space-01" }).waitFor({ state: "detached", timeout: 8000 });
  },
  /** Files with Changes only chosen: the list of changes, not the tree. */
  changesList: async (page, screen) => {
    await page.addInitScript((key) => window.localStorage.setItem(key, JSON.stringify({ changesOnly: true })), DASH_PREFS);
    await visit(page, screen);
  },
  /** A changed file open beside the list, its diff side by side by the person's choice. */
  changesSplit: async (page, screen) => {
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, JSON.stringify({ changesOnly: true }));
      window.localStorage.setItem("collie:diff-layout:v1", "split");
    }, DASH_PREFS);
    await visit(page, screen);
  },
  /** Six tricks with an item in the views switch of the Dashboard's header. */
  dashboardTricks: async (page, screen) => {
    await installApiStub(page);
    await installHeadWorld(page, wideSnapshot({ spaces: 3, blocked: ["w2:p1"], unseen: ["w3:p2"] }), { tricks: 6 });
    await visit(page, screen);
  },
  /** The bridge does not answer at all: the Dashboard's unreachable state. */
  unreachable: async (page, screen) => {
    await page.route("**/api/**", (route) => route.abort("connectionrefused"));
    await visit(page, screen, false);
  },
  /** The prefix is armed in two columns: every control wears the key of its action. Only a large screen arms it. */
  keysArmed: async (page) => {
    await chatWorld(page);
    await installScreenStubs(page);
    await installFilledReads(page);
    await openColumns(page, ["w1:p1", "w1:p2"], "w1:p1");
    if ((page.viewportSize()?.width ?? 0) < 900) return;
    await page.keyboard.press("Control+b");
    await page.locator('[data-slot="shortcut-hint-layer"]').waitFor({ state: "attached", timeout: 8000 });
  },
  /** The pane menu opened with the prefix and `m`. Only a large screen has the key. */
  menuByKey: async (page, screen) => {
    await chatWorld(page);
    await visit(page, screen);
    if ((page.viewportSize()?.width ?? 0) < 900) return;
    await page.locator('[data-slot="wide-layout"]').waitFor({ state: "visible", timeout: 8000 });
    await page.keyboard.press("Control+b");
    await page.locator('[data-slot="shortcut-hint-layer"]').waitFor({ state: "attached", timeout: 8000 });
    await page.keyboard.press("m");
    await page.locator('[data-presentation="menu"]').waitFor({ state: "visible", timeout: 8000 });
  },
  /** A browser the bridge does not know: every read answers "device not paired". */
  notPaired: async (page, screen) => {
    await page.route("**/api/**", (route) => route.fulfill({ status: 403, contentType: "text/plain", body: "device not paired" }));
    await visit(page, screen);
  },
  /** Five Spaces, and in Space 1 two agent panes with a real transcript. */
  chat: async (page, screen) => {
    await chatWorld(page);
    await visit(page, screen);
  },
  /** The same pane, drawn as its terminal. */
  terminal: async (page, screen) => {
    await preferences(page, { paneView: "terminal" });
    await chatWorld(page);
    await visit(page, screen);
  },
  /** Two panes of Space 1 side by side, as half-width columns. */
  twoColumns: async (page) => {
    await chatWorld(page);
    await installScreenStubs(page);
    await installFilledReads(page);
    await openColumns(page, ["w1:p1", "w1:p2"], "w1:p1");
  },
  /** A space whose name and host are long, with five tabs with long names. */
  longTabs: async (page, screen) => {
    await installApiStub(page);
    await installCrewWorld(page);
    await serveSnapshot(page, longTabs());
    await visit(page, screen);
  },
  /** The pane's own menu, from the three dots. */
  paneMenu: async (page, screen) => {
    await chatWorld(page);
    await visit(page, screen);
    await page.getByRole("button", { name: en["chat.paneMenu.aria"], exact: true }).first().click();
    await dialogShown(page);
  },
  /** The Actions palette. */
  actions: async (page, screen) => {
    await chatWorld(page);
    await visit(page, screen);
    await actionsButton(page).first().click();
    await dialogShown(page);
  },
  /** The New tab dialog, from the "+" of a dashboard Space heading. */
  newTab: async (page, screen) => {
    await serveSnapshot(page, wideSnapshot({ spaces: 12, blocked: ["w2:p1"] }));
    await installLauncherWorld(page);
    await visit(page, screen);
    await page.getByRole("main").getByRole("button", { name: /^New tab in /u }).first().click();
    await dialogShown(page);
  },
  /** New, the page on a phone and the dialog over the Dashboard on a large screen (`/new` and `/new/add` redirect there). */
  newOver: async (page, screen) => {
    await richWorld(page, screen);
    await page.locator('[role="dialog"], [data-slot="bottom-bar"]').first().waitFor({ state: "visible", timeout: 8000 });
  },
  /** New over the pane view, opened from the sidebar's New. */
  newOverPane: async (page, screen) => {
    await chatWorld(page);
    await page.route("**/api/launchers", (route) => json(route, fixtureLaunchersWithAgents));
    await visit(page, screen);
    await dialogShown(page);
  },
  /** New over the Dashboard with Browse open on the home folder. */
  newBrowse: async (page, screen) => {
    await richWorld(page, screen, true);
    await dialogShown(page);
    await page.getByRole("dialog").getByRole("button", { name: new RegExp(`^${en["newPage.browse"]}`, "u") }).click();
    await page.getByRole("dialog").getByText("worktrees", { exact: true }).waitFor();
  },
  /** New over the Dashboard with New worktree on. */
  newWorktree: async (page, screen) => {
    await richWorld(page, screen, true);
    await dialogShown(page);
    await page.getByRole("dialog").getByRole("switch").click();
    await page.getByRole("dialog").getByTestId("new-page-target").waitFor();
  },
  /** A dashboard row's own menu, from a right click. */
  rowMenu: async (page, screen) => {
    await visit(page, screen);
    await page.getByRole("main").getByRole("button", { name: /^codex logo codex/u }).first().click({ button: "right" });
    await dialogShown(page);
  },
  /** The tricks: a menu part, a belt mark, a session page and the list in Settings. */
  tricks: async (page, screen) => {
    await installApiStub(page);
    await tricksWorld(page);
    await visit(page, screen);
  },
  /** A trick that is off: its details page scrolled to its last section, Remove (ADR 0168). */
  trickRemove: async (page, screen) => {
    await installApiStub(page);
    await tricksWorld(page, TRICKS_KETTLE_OFF);
    await visit(page, screen);
    await page.locator('[data-section="remove"]').scrollIntoViewIfNeeded();
  },
  /** The same, with the Remove confirm open. */
  trickRemoveConfirm: async (page, screen) => {
    await installApiStub(page);
    await tricksWorld(page, TRICKS_KETTLE_OFF);
    await visit(page, screen);
    await page.locator('[data-section="remove"]').getByRole("button", { name: en["settings.tricks.remove.button"] }).click();
    await dialogShown(page);
  },
  /** The decision a card of Collie's own asks about. */
  hillCard: async (page, screen) => {
    await installWorld(page);
    const card = collieCard("proposal", "legs", { id: "dc_screens0001" });
    await page.route("**/api/hill", (route) => json(route, { rev: 1, open: [card], closed: [] }));
    await visit(page, screen);
  },
  /** Accounts: the list, the add form and one account. */
  accounts: async (page, screen) => {
    await installApiStub(page);
    await accountsWorld(page);
    await visit(page, screen, false);
  },
  /** The durable programs' conversations. */
  conversations: async (page, screen) => {
    await installApiStub(page);
    await conversationsWorld(page);
    await visit(page, screen);
  },
  /** A paired browser asked to approve another device: three codes and the new device's browser and system. */
  pairApprove: async (page, screen) => {
    await page.addInitScript(() => window.localStorage.setItem("collie:device-token", "screens-placeholder-token"));
    await page.route("**/api/pair/approve/*", (route) => json(route, { state: "open", browser: "Chrome", os: "Linux", choices: ["12", "47", "83"], expiresInMs: 120_000, endsAt: null }));
    await visit(page, screen);
  },
  /** The four machines of a crew. */
  /** Notifications with two machines in the census, so the Machine load group draws one row per machine. */
  settingsMachines: async (page, screen) => {
    await installCrewWorld(page);
    await installMachinesWorld(page);
    await visit(page, screen);
  },
  /** The Settings index with a query in its search field, so the results stand where the list was. */
  settingsSearch: async (page, screen) => {
    await visit(page, screen);
    await page.getByRole("textbox", { name: "Search settings" }).fill("dark");
    await page.locator('[data-slot="settings-search-results"]').first().waitFor({ state: "visible", timeout: 8000 });
  },
  machines: async (page, screen) => {
    await installApiStub(page);
    await installCrewWorld(page);
    await installMachinesWorld(page);
    await visit(page, screen);
  },
} satisfies Record<string, Setup>;

export type SetupId = keyof typeof SETUPS;
