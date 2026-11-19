import type { Page } from "@playwright/test";

import { partKey, type MenuRow, type WireTrickInfo, type WireTrickPart } from "@/lib/tricks/schema";
import { fixtureKiroChat, fixtureKiroHistory, fixtureKiroSnapshot, fixtureLaunchersWithAgents, KIRO_PANE_ID } from "@/test/handlers";

import { installApiStub, installCrewWorld, installPaneWorld, paneCapture } from "../fixtures/api";
import { finger, press } from "./touch";
import { installWorld, type SnapshotControl } from "./world";

// EVERY SCREEN THE APP HAS, as a recipe: how to put a page into it with no bridge. A recipe sets the
// stub up (before the first navigation), goes there, and opens whatever the screen needs open (a
// sheet, a dock). The census scans the page afterwards. A recipe that cannot reach its screen throws,
// and the census records the screen as NOT REACHED with the reason, so a hole is a line in the
// report and not a quiet absence.

export interface ScreenRecipe {
  id: string;
  group: "Dashboard" | "Session" | "Hill" | "Settings" | "Pages" | "Sheets";
  title: string;
  /** Set the stub up. Runs before the first navigation. */
  world?: "rich" | "crew" | "kiro" | "plain";
  /** Where to go. */
  path?: string;
  /** Local storage written before the first script: dash prefs, mostly. */
  prefs?: Record<string, string>;
  /** Scan without scrolling targets into view: for a screen of fixed layers, where scrolling moves the layer under the probe. */
  still?: boolean;
  /** After the page loaded: open what the screen is about. */
  open?: (page: Page) => Promise<void>;
}

const PANE = `/pane/${encodeURIComponent(KIRO_PANE_ID)}`;
const DASH_PREFS = "collie:dash-prefs:v1";

async function tapByName(page: Page, name: string | RegExp, scope: "button" | "link" | "tab" = "button"): Promise<void> {
  const target = page.getByRole(scope, { name }).first();
  await target.waitFor({ state: "visible", timeout: 6000 });
  await target.click();
  await page.waitForTimeout(450);
}

async function hold(page: Page, locator: ReturnType<Page["locator"]>, ms = 700): Promise<void> {
  const box = await locator.first().boundingBox();
  if (box === null) throw new Error("no box to hold");
  await press(await finger(page), box.x + box.width / 2, box.y + box.height / 2, { holdMs: ms });
  await page.waitForTimeout(500);
}

export const SCREENS: ScreenRecipe[] = [
  // ── Dashboard ────────────────────────────────────────────────────────────
  { id: "dashboard", group: "Dashboard", title: "Dashboard, the herd", world: "rich", path: "/" },
  { id: "dashboard-files", group: "Dashboard", title: "Dashboard, Files tab", world: "rich", path: "/", open: (p) => tapByName(p, /^Files$/u) },
  { id: "dashboard-crew", group: "Dashboard", title: "Dashboard, Crew tab", world: "crew", path: "/", open: (p) => tapByName(p, /^Crew/u) },
  { id: "space", group: "Dashboard", title: "A space (workspace)", world: "rich", path: "/space/w1" },

  // ── Sheets over the Dashboard ────────────────────────────────────────────
  { id: "sheet-workspace-filter", group: "Sheets", title: "Workspace filter sheet", world: "rich", path: "/", open: (p) => tapByName(p, /^Space /u) },
  { id: "sheet-row-actions", group: "Sheets", title: "A row's actions (long press)", world: "rich", path: "/", open: (p) => hold(p, p.getByRole("button", { name: /needs you/u }).nth(1)) },
  { id: "sheet-new-tab", group: "Sheets", title: "New tab sheet (heading plus)", world: "rich", path: "/", open: (p) => tapByName(p, /^New tab in webapp/u) },
  { id: "sheet-session-switcher", group: "Sheets", title: "Space switcher sheet", world: "rich", path: "/", open: (p) => tapByName(p, /^Space: /u) },

  // ── A session ────────────────────────────────────────────────────────────
  { id: "session-chat", group: "Session", title: "Session, Chat with composer and belt", world: "kiro", path: PANE },
  { id: "session-terminal", group: "Session", title: "Session, Terminal view", world: "plain", path: "/pane/w2%3Ap1", prefs: { paneView: "terminal" } },
  { id: "session-agent-view", group: "Session", title: "Session, agent view", world: "kiro", path: `${PANE}`, prefs: { paneView: "view" } },
  { id: "session-actions-sheet", group: "Session", title: "Session sheet with trick groups", world: "kiro", path: PANE, open: (p) => tapByName(p, "Pane actions") },
  { id: "sheet-pane-switcher", group: "Session", title: "Switch pane sheet, with its New button", world: "kiro", path: PANE, open: (p) => tapByName(p, "Switch pane") },
  { id: "session-pane-settings", group: "Session", title: "Pane settings (name line)", world: "kiro", path: PANE, open: (p) => tapByName(p, /^Pane settings for /u) },
  { id: "session-history", group: "Session", title: "Session History", world: "kiro", path: `${PANE}/history` },
  { id: "session-zoom", group: "Session", title: "Zoomed output", world: "plain", path: "/pane/w2%3Ap1/zoom", prefs: { paneView: "terminal" }, still: true, open: (p) => p.waitForTimeout(2500) },
  { id: "session-changes", group: "Session", title: "Changes of a session", world: "plain", path: "/pane/w1%3Ap1/changes" },
  { id: "session-files", group: "Session", title: "Files of a session", world: "plain", path: "/pane/w1%3Ap1/changes/files" },
  { id: "composer-keys", group: "Session", title: "Composer, Keys dock open", world: "plain", path: "/pane/w2%3Ap1", prefs: { paneView: "terminal" }, open: (p) => tapByName(p, /^Keys/u) },
  { id: "composer-attach", group: "Session", title: "Composer, attach menu", world: "kiro", path: PANE, open: (p) => tapByName(p, "Attach file") },

  // ── Hill ─────────────────────────────────────────────────────────────────
  { id: "hill", group: "Hill", title: "Hill, open decisions", world: "rich", path: "/hill" },

  // ── Settings ─────────────────────────────────────────────────────────────
  { id: "settings", group: "Settings", title: "Settings index", world: "rich", path: "/settings" },
  { id: "settings-appearance", group: "Settings", title: "Settings, Appearance", world: "rich", path: "/settings/appearance" },
  { id: "settings-harnesses", group: "Settings", title: "Settings, Harnesses", world: "rich", path: "/settings/harnesses" },
  { id: "settings-device", group: "Settings", title: "Settings, Device", world: "rich", path: "/settings/device" },
  { id: "settings-voice", group: "Settings", title: "Settings, Voice", world: "rich", path: "/settings/voice" },
  { id: "settings-alerts", group: "Settings", title: "Settings, Alerts", world: "rich", path: "/settings/alerts" },
  { id: "settings-experiments", group: "Settings", title: "Settings, Experiments", world: "rich", path: "/settings/experiments" },
  { id: "settings-tricks", group: "Settings", title: "Settings, Tricks", world: "rich", path: "/settings/tricks" },
  { id: "settings-system", group: "Settings", title: "Settings, System (pairing)", world: "rich", path: "/settings/system" },
  { id: "settings-updates", group: "Settings", title: "Updates card", world: "rich", path: "/settings/updates" },

  // ── Other pages ──────────────────────────────────────────────────────────
  { id: "new", group: "Pages", title: "New page", world: "rich", path: "/new" },
  { id: "new-add", group: "Pages", title: "New, add your own", world: "rich", path: "/new/add" },
  { id: "machines", group: "Pages", title: "Machines", world: "rich", path: "/machines" },
  { id: "crew", group: "Pages", title: "Crew", world: "crew", path: "/crew" },
  { id: "conversations", group: "Pages", title: "Conversations (durable home)", world: "rich", path: "/conversations" },
  { id: "pair-approve", group: "Pages", title: "Approve a pairing request", world: "rich", path: "/pair/approve?r=abcdefghijklmnop" },
];

// Two tricks with rows in a session's sheet (the `menu` place) and a mark on the belt, so the session
// sheet is drawn with its trick groups and the belt with a trick's mark. The shapes are the wire's.
const AS_OF = new Date(Date.now() - 20_000).toISOString();
function trickInfo(id: string, name: string, icon: WireTrickInfo["icon"], places: WireTrickInfo["places"]): WireTrickInfo {
  return { host: "lodge", id, name, icon, on: true, state: "ok", places };
}
function menuPart(trick: string, rows: MenuRow[]): WireTrickPart {
  return { host: "lodge", trick, part: trick, rev: 1, asOf: AS_OF, fresh: "10m", value: { at: "menu", id: trick, rows } };
}
const TRICKS = [trickInfo("ci", "CI", "flask", ["menu", "belt"]), trickInfo("notes", "Notes", "note", ["menu"])];
const TRICK_PARTS: WireTrickPart[] = [
  menuPart("ci", [
    { id: "rerun", kind: "button", label: "Rerun CI", icon: "refresh", intent: "rerun" },
    { id: "watch", kind: "switch", label: "Watch branch", icon: "flag", intent: "watch", on: true },
    { id: "drop", kind: "button", label: "Drop the cache", icon: "delete", intent: "drop", confirm: true },
  ]),
  menuPart("notes", [
    { id: "pin", kind: "button", label: "Pin this session", icon: "pin", intent: "pin" },
    { id: "quiet", kind: "switch", label: "Quiet hours", icon: "clock", intent: "quiet", on: false },
  ]),
  { host: "lodge", trick: "ci", part: "legs", rev: 1, asOf: AS_OF, fresh: "10m", value: { at: "belt", id: "legs", mark: { icon: "check", label: "23/34", tone: "ok" } } },
];

const KIRO_SCREEN = paneCapture("kiro--v3-idle-w120");

/** Set the stub up for a recipe's world. Returns the snapshot control of the rich world, else null. */
export async function setUpWorld(page: Page, recipe: ScreenRecipe): Promise<SnapshotControl | null> {
  const prefs = recipe.prefs;
  if (prefs !== undefined) {
    await page.addInitScript(
      ([key, value]) => {
        if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
      },
      [DASH_PREFS, JSON.stringify(prefs)],
    );
  }
  const world = recipe.world ?? "rich";
  if (world === "rich" || world === "crew") {
    const control = await installWorld(page);
    if (world === "crew") await installCrewWorld(page);
    await page.route("**/api/launchers", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(fixtureLaunchersWithAgents) }));
    return control;
  }
  await installApiStub(page);
  if (world === "kiro") {
    await installPaneWorld(page, {
      paneId: KIRO_PANE_ID,
      snapshot: { ...fixtureKiroSnapshot, tricksRev: 1 },
      chat: fixtureKiroChat,
      history: fixtureKiroHistory,
      screens: { idle: KIRO_SCREEN },
      start: "idle",
    });
    await page.route("**/api/tricks*", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ rev: 1, tricks: TRICKS, parts: TRICK_PARTS, present: TRICK_PARTS.map(partKey) }) }),
    );
  }
  return null;
}
