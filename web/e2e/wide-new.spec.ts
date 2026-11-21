import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Browser, type Page, type Route } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { AgentView, LaunchersAdding, LaunchersResponse, SnapshotResponse } from "@/lib/types";
import { fixtureLaunchedTab, fixtureLaunchersWithAgents } from "@/test/handlers";

import { stillMarkState } from "./fixtures/still-mark";
import { installWideChatWorld } from "./fixtures/wide-chat";
import { wideSnapshot } from "./fixtures/wide-herd";
import { installFilledReads, installScreenStubs } from "./screens/setups";

// NEW OVER THE SCREEN, AND THE SPACE ADDRESS, ON A LARGE SCREEN (ADR 0173). At 1440x900 and
// 1920x1080: New is a dialog over the Dashboard and over the pane view, Start is in view with no scroll, Escape,
// Back and the close button close it and give the focus back to the control that opened it, the Tab key walks
// the form in order and stays inside it, `/new` opened directly is New over the Dashboard, a start replaces New
// with the new pane. `/space/:id` opens the pane view with the sidebar on the landed row, or the Dashboard for a
// Space with no pane. At 390x844 the New page, "Add your own" and the space page keep every box they had: the
// boxes are compared with `e2e/wide-new.phone-boxes.json`, recorded on the build before this change.
// The `space` boxes were recorded again on 2026-11-21 after ADR 0171 changed the phone's tab row and pane row to
// 44 px (the tab row grew 8 px and everything under it moved down 8 px); `new` and `new-add` are as first recorded.
// Both `space` recordings were made on a `-dev` build, whose stamp carries a second line; since 2026-11-21 the
// stamp under `main` is pinned (`pinBuildStamp`: the release build's one line, in the bundled face), and `space` was
// recorded once more so.
//
// `WIDE_NEW_SHOTS=<dir>` also writes the screens of each state; `WIDE_NEW_RECORD=1` writes the phone boxes.

const SHOTS = process.env.WIDE_NEW_SHOTS;
const RECORD = process.env.WIDE_NEW_RECORD === "1";
const BOXES_FILE = join(import.meta.dirname, "wide-new.phone-boxes.json");
const SIZES = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the fixture has no ${what}`);
  return value;
}

function json<T extends object>(route: Route, body: T): Promise<void> {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

/** Twelve Spaces. Space 11 has two tabs and five sessions; Space 13 has no pane at all. */
function herd(): SnapshotResponse {
  const snapshot = wideSnapshot({ spaces: 12, blocked: ["w2:p1", "w7:p1"], unseen: ["w4:p2"] });
  for (const agent of snapshot.agents) agent.hasSession = true;
  const ws = must(snapshot.workspaces.find((w) => w.workspaceId === "w11"), "w11");
  ws.tabCount = 2;
  ws.paneCount = 5;
  ws.activeTabId = "w11:t2";
  must(snapshot.tabs.find((t) => t.tabId === "w11:t1"), "w11:t1").paneCount = 3;
  snapshot.tabs.push({ tabId: "w11:t2", workspaceId: "w11", number: 2, label: "review", focused: false, paneCount: 2 });
  const base = must(snapshot.agents.find((a) => a.paneId === "w11:p1"), "w11:p1");
  const pane = (id: string, tabId: string, agent: string, status: AgentView["status"]): AgentView => {
    const review = tabId.endsWith("t2");
    return { ...base, paneId: id, tabId, tabLabel: review ? "review" : "main", agent, status, terminalTitle: `${review ? "review" : "work"} in space-11` };
  };
  snapshot.shellPanes.push({ ...pane("w11:p3", "w11:t1", "shell", "unknown"), kind: "shell", paneLabel: "shell", terminalTitle: undefined });
  snapshot.agents.push(pane("w11:p4", "w11:t2", "claude", "working"), pane("w11:p5", "w11:t2", "codex", "idle"));
  snapshot.workspaces.push({ workspaceId: "w13", number: 13, label: "space-13", focused: false, activeTabId: "w13:t1", tabCount: 1, paneCount: 0 });
  snapshot.tabs.push({ tabId: "w13:t1", workspaceId: "w13", number: 1, label: "main", focused: false, paneCount: 0 });
  return snapshot;
}

const ADDING: LaunchersAdding = {
  adds: true,
  freeText: false,
  run: true,
  file: "/home/you/.config/collie/launchers.toml",
  count: 0,
  max: 20,
  recipes: [
    { harness: "claude", label: "Claude Code", binary: "claude", options: [{ id: "plan", label: "Plan mode", args: "--permission-mode plan" }, { id: "continue", label: "Continue last", args: "--continue" }] },
    { harness: "codex", label: "Codex", binary: "codex", options: [] },
  ],
  off: [],
};
const LAUNCHERS: LaunchersResponse = { ...fixtureLaunchersWithAgents, adding: ADDING };
const BROWSE = ["collie", "docs", "notes", "projects", "scratch", "webapp", "worktrees"];

async function world(page: Page): Promise<void> {
  await installWideChatWorld(page);
  await installScreenStubs(page);
  await installFilledReads(page);
  const snapshot = herd();
  await page.route((url) => url.pathname === "/api/snapshot", (route) => json(route, snapshot));
  await page.route((url) => url.pathname === "/api/launchers", (route) => json(route, LAUNCHERS));
  await page.route((url) => url.pathname === "/api/launch", (route) => json(route, fixtureLaunchedTab));
  await page.route(
    (url) => url.pathname === "/api/folders/browse",
    (route) => json(route, { path: "~", parent: null, folders: BROWSE.map((name) => ({ name, git: name !== "notes" && name !== "scratch" })), filter: "", truncated: false }),
  );
  await page.route(
    (url) => url.pathname === "/api/worktree/plan",
    (route) => json(route, { ok: true, currentBranch: "main", defaultBranch: "main", branchValid: true, defaultTarget: { path: "/home/you/worktrees/webapp-fix", exists: false } }),
  );
  // The one-time keyboard hint would cover the top right after the first key press.
  await page.addInitScript(() => window.localStorage.setItem("collie:keyboard-hint-done:v1", "1"));
}

async function open(browser: Browser, baseURL: string, size: { width: number; height: number }, touch = false) {
  const context = await browser.newContext({ baseURL, viewport: size, hasTouch: touch, deviceScaleFactor: touch ? 2 : 1, serviceWorkers: "block", storageState: stillMarkState(baseURL) });
  const page = await context.newPage();
  await world(page);
  return { context, page };
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
}

const startButton = (page: Page) => page.getByRole("button", { name: en["newPage.start"], exact: true });
const dialog = (page: Page) => page.locator('[role="dialog"]:has([data-slot="new-dialog"])');
const dashboardNew = (page: Page) => page.getByRole("button", { name: en["home.new.label"], exact: true }).first();
const sidebarNew = (page: Page) => page.getByRole("button", { name: en["wide.newSpace"], exact: true }).first();

async function openFromDashboard(page: Page): Promise<void> {
  await page.goto("/");
  await dashboardNew(page).click();
  await expect(dialog(page)).toBeVisible();
}

async function openFromPane(page: Page): Promise<void> {
  await page.goto("/pane/w1%3Ap1");
  await page.waitForSelector('[data-slot="wide-layout"]', { timeout: 10_000 });
  await settle(page);
  await sidebarNew(page).click();
  await expect(dialog(page)).toBeVisible();
}

/** Start is drawn whole inside the window, and nothing in the dialog had to scroll to show it. */
async function startInView(page: Page): Promise<void> {
  const box = await startButton(page).boundingBox();
  const vp = page.viewportSize();
  if (box === null || vp === null) throw new Error("Start has no box");
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
  const panelScroll = await dialog(page).locator('[data-presentation="dialog"]').evaluate((el) => el.scrollTop);
  expect(panelScroll).toBe(0);
}

async function shot(page: Page, name: string, width: number): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await settle(page);
  await page.screenshot({ path: join(SHOTS, `${name}.${String(width)}.png`) });
}

test.use({ serviceWorkers: "block" });

test.describe("New over the screen, large screen", () => {
  test.beforeEach(({ browserName: _browser }, testInfo) => {
    test.skip(testInfo.project.name !== "app-phone", "sets its own viewports; one project is enough");
  });

  for (const size of SIZES) {
    const w = size.width;

    test(`over the Dashboard at ${String(w)}: Start in view, Escape closes and the focus returns`, async ({ browser }, testInfo) => {
      const { context, page } = await open(browser, String(testInfo.project.use.baseURL), size);
      try {
        await openFromDashboard(page);
        expect(new URL(page.url()).pathname).toBe("/");
        expect(new URL(page.url()).searchParams.get("over")).toBe("/new");
        await startInView(page);
        await shot(page, "new-dashboard", w);
        await page.keyboard.press("Escape");
        await expect(dialog(page)).toHaveCount(0);
        expect(new URL(page.url()).searchParams.get("over")).toBeNull();
        await expect(dashboardNew(page)).toBeFocused();
      } finally {
        await context.close();
      }
    });

    test(`over the pane view at ${String(w)}: the pane stays, Back closes and the focus returns`, async ({ browser }, testInfo) => {
      const { context, page } = await open(browser, String(testInfo.project.use.baseURL), size);
      try {
        await openFromPane(page);
        expect(new URL(page.url()).pathname).toBe("/pane/w1%3Ap1");
        await expect(page.locator('[data-slot="wide-layout"]')).toHaveCount(1);
        await startInView(page);
        await shot(page, "new-pane", w);
        await page.goBack();
        await expect(dialog(page)).toHaveCount(0);
        expect(new URL(page.url()).pathname).toBe("/pane/w1%3Ap1");
        await expect(sidebarNew(page)).toBeFocused();
        // The close button does the same.
        await sidebarNew(page).click();
        await dialog(page).getByRole("button", { name: en["common.closeAria"], exact: true }).click();
        await expect(dialog(page)).toHaveCount(0);
        await expect(sidebarNew(page)).toBeFocused();
      } finally {
        await context.close();
      }
    });

    test(`Browse open and New worktree on at ${String(w)}: Start stays in view`, async ({ browser }, testInfo) => {
      const { context, page } = await open(browser, String(testInfo.project.use.baseURL), size);
      try {
        await openFromDashboard(page);
        await dialog(page).getByRole("button", { name: new RegExp(`^${en["newPage.browse"]}`, "u") }).click();
        await dialog(page).getByText("worktrees", { exact: true }).waitFor();
        await startInView(page);
        await shot(page, "new-browse", w);
        await dialog(page).getByRole("switch").click();
        await dialog(page).getByTestId("new-page-target").waitFor();
        await startInView(page);
        await shot(page, "new-worktree", w);
        await dialog(page).getByRole("radio", { name: en["newPage.shell"], exact: true }).click();
        await startInView(page);
        await shot(page, "new-shell", w);
      } finally {
        await context.close();
      }
    });

    test(`"Add your own" at ${String(w)}: the same dialog, its back goes to New, nothing is cut`, async ({ browser }, testInfo) => {
      const { context, page } = await open(browser, String(testInfo.project.use.baseURL), size);
      try {
        await openFromDashboard(page);
        await dialog(page).getByRole("button", { name: en["newPage.add"], exact: true }).click();
        const add = page.locator('[role="dialog"]:has([data-slot="new-add-dialog"])');
        await expect(add).toBeVisible();
        expect(new URL(page.url()).searchParams.get("over")).toMatch(/^\/new\/add\?/u);
        await shot(page, "new-add", w);
        // The form takes its own height: no reserved gap between the name field and the link under it.
        const nameBox = await add.getByRole("textbox", { name: en["launcherAdd.name"], exact: true }).boundingBox();
        const howBox = await add.getByRole("button", { name: en["launcherAdd.how.link"], exact: true }).boundingBox();
        if (nameBox === null || howBox === null) throw new Error("no name or link box");
        expect(howBox.y - (nameBox.y + nameBox.height)).toBeLessThan(80);
        // Another variant of the form changes the height downward: the top edge stays.
        const panel = add.locator('[data-presentation="dialog"]');
        // Past the entrance zoom (a transform) before the first measure.
        await settle(page);
        const before = await panel.boundingBox();
        await add.getByRole("radio", { name: en["launcherAdd.mode.text"], exact: true }).click();
        await page.waitForTimeout(300);
        const after = await panel.boundingBox();
        if (before === null || after === null) throw new Error("no panel box");
        expect(Math.abs(after.y - before.y)).toBeLessThan(1);
        await shot(page, "new-add-text", w);
        await add.getByRole("radio", { name: en["launcherAdd.way.recipe"], exact: true }).click();
        // Scrolled to its end, the form's last part ("Added for the crew" and its line) stands whole above the foot.
        await add.locator('[data-slot="new-add-dialog-body"]').evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        const foot = await add.locator('[data-slot="new-add-dialog-foot"]').boundingBox();
        const crew = add.getByRole("region", { name: en["launcherAdd.manage.title"], exact: true });
        const last = await crew.locator("li").last().boundingBox();
        const title = await crew.boundingBox();
        if (foot === null || last === null || title === null) throw new Error("no foot or list box");
        expect(last.y + last.height).toBeLessThanOrEqual(foot.y);
        expect(title.y).toBeGreaterThan(0);
        await shot(page, "new-add-end", w);
        await add.getByRole("button", { name: en["newPage.back"], exact: true }).click();
        await expect(dialog(page)).toBeVisible();
        await expect(add).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(dialog(page)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });
  }

  test("the Tab key walks the form in order and stays inside the dialog", async ({ browser }, testInfo) => {
    const { context, page } = await open(browser, String(testInfo.project.use.baseURL), SIZES[0]);
    try {
      await openFromDashboard(page);
      // The machine's offer has landed: the agent select and the worktree switch are drawn.
      await dialog(page).getByRole("switch").waitFor();
      await dialog(page).locator("select").first().waitFor();
      const order: string[] = [];
      for (let i = 0; i < 40; i += 1) {
        await page.keyboard.press("Tab");
        const name = await page.evaluate(() => {
          const el = document.activeElement;
          if (!(el instanceof HTMLElement)) return "";
          const inside = el.closest('[role="dialog"]') !== null;
          const label = el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? el.textContent?.trim() ?? "";
          return `${inside ? "in" : "OUT"}:${el.tagName.toLowerCase()}:${el.getAttribute("role") ?? ""}:${label}`;
        });
        order.push(name);
      }
      expect(order.filter((n) => n.startsWith("OUT"))).toEqual([]);
      const at = (match: (n: string) => boolean) => order.findIndex(match);
      const agent = at((n) => n.includes(":radio:") && n.endsWith(en["newPage.kind.agent"]));
      const select = at((n) => n.includes(":select:"));
      const worktree = at((n) => n.includes(":switch:"));
      const folder = at((n) => n.startsWith("in:input:"));
      const browse = at((n) => n.includes(en["newPage.browse"]));
      const start = at((n) => n.startsWith(`in:button::${en["newPage.start"]}`));
      for (const i of [agent, select, worktree, folder, browse, start]) expect(i).toBeGreaterThanOrEqual(0);
      expect(agent).toBeLessThan(select);
      expect(select).toBeLessThan(worktree);
      expect(worktree).toBeLessThan(folder);
      expect(folder).toBeLessThan(browse);
      expect(browse).toBeLessThan(start);
      // Past Start, the focus wraps to the dialog's first control, its close button.
      expect(order[start + 1]).toContain(en["common.closeAria"]);
    } finally {
      await context.close();
    }
  });

  test("/new opened directly is New over the Dashboard, and a start replaces New with the new pane", async ({ browser }, testInfo) => {
    const { context, page } = await open(browser, String(testInfo.project.use.baseURL), SIZES[0]);
    try {
      await page.goto("/");
      await page.goto("/new");
      await expect(dialog(page)).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/");
      expect(new URL(page.url()).searchParams.get("over")).toBe("/new");
      await page.goto("/new/add?kind=agent");
      await expect(page.locator('[data-slot="new-add-dialog"]')).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/");
      // A start, from New opened with the button.
      await page.goto("/");
      await dashboardNew(page).click();
      await expect(startButton(page)).toBeEnabled();
      await startButton(page).click();
      await page.waitForURL((url) => url.pathname === `/pane/${encodeURIComponent(fixtureLaunchedTab.pane.paneId)}`);
      await expect(dialog(page)).toHaveCount(0);
      await page.goBack();
      await page.waitForURL((url) => url.pathname === "/");
      expect(new URL(page.url()).searchParams.get("over")).toBeNull();
      await expect(dialog(page)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

test.describe("New over the screen on a cold load", () => {
  test.beforeEach(({ browserName: _browser }, testInfo) => {
    test.skip(testInfo.project.name !== "app-phone", "sets its own viewport; one project is enough");
  });

  // New's chunk loads on demand (ADR 0169). Opened at once after a cold load, before the idle preload has
  // fetched it, New over the screen must come up as the dialog, from the button and from the address.
  test("New opened at once after a cold load shows the dialog", async ({ browser }, testInfo) => {
    const { context, page } = await open(browser, String(testInfo.project.use.baseURL), SIZES[0]);
    const scripts: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname);
    });
    try {
      await page.goto("/");
      await dashboardNew(page).click();
      await expect(dialog(page)).toBeVisible();
      await expect(startButton(page)).toBeVisible();
      // The dialog came from New's own chunk, not from the main one.
      expect(scripts.some((path) => /\/assets\/new-[\w-]+\.js$/u.test(path))).toBe(true);
      await page.goto("/pane/w1%3Ap1?over=%2Fnew%3Fpane%3Dw1%253Ap1");
      await expect(dialog(page)).toBeVisible();
      await expect(page.locator('[data-slot="wide-layout"]')).toHaveCount(1);
      await page.goto("/new/add?kind=agent");
      await expect(page.locator('[data-slot="new-add-dialog"]')).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

test.describe("The space address, large screen", () => {
  test.beforeEach(({ browserName: _browser }, testInfo) => {
    test.skip(testInfo.project.name !== "app-phone", "sets its own viewports; one project is enough");
  });

  for (const size of SIZES) {
    test(`a Space with panes opens the pane view of its open tab at ${String(size.width)}, the sidebar on the row`, async ({ browser }, testInfo) => {
      const { context, page } = await open(browser, String(testInfo.project.use.baseURL), size);
      try {
        await page.goto("/space/w11");
        await page.waitForURL((url) => url.pathname === "/pane/w11%3Ap4");
        await page.waitForSelector('[data-slot="wide-layout"]', { timeout: 10_000 });
        await settle(page);
        const row = page.locator('[data-slot="wide-layout"] aside [aria-current="page"]');
        await expect(row).toBeInViewport();
        await shot(page, "space", size.width);
      } finally {
        await context.close();
      }
    });
  }

  test("a Space with no pane opens the Dashboard, and never draws the space page", async ({ browser }, testInfo) => {
    const { context, page } = await open(browser, String(testInfo.project.use.baseURL), SIZES[0]);
    try {
      await page.goto("/space/w13");
      await page.waitForURL((url) => url.pathname === "/");
      await expect(page.locator('[data-slot="wide-rows"]')).toBeVisible();
      await shot(page, "space-empty", SIZES[0].width);
    } finally {
      await context.close();
    }
  });
});

// ── The order of the agents to start ───────────────────────────────────────────────────────────────────────

/** The launchers with one own agent made with "Add your own": a neutral invented name. */
const WITH_OWN: LaunchersResponse = {
  ...LAUNCHERS,
  items: [
    ...(LAUNCHERS.items ?? []),
    { key: "row:claude --review", start: { command: "claude --review" }, group: "agents", label: "Review bot", harness: "claude", command: "claude --review", source: "added", noPrompts: true, branch: true, available: true },
  ],
};

for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }] as const) {
  test(`at ${String(size.width)}x${String(size.height)} New lists own agents first and opens on the same agent`, async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== "app-phone", "sets its own viewport; one project is enough");
    const { context, page } = await open(browser, String(testInfo.project.use.baseURL), size, size.width < 900);
    try {
      await page.route((url) => url.pathname === "/api/launchers", (route) => json(route, WITH_OWN));
      await page.goto("/new");
      const select = page.getByRole("combobox", { name: en["newPage.kind.agent"], exact: true });
      await expect(select.locator("option")).toHaveCount(3);
      const values = await select.locator("option").evaluateAll((options) => options.map((o) => o.getAttribute("value")));
      expect(values).toEqual(["row:claude --review", "harness:claude", "harness:codex"]);
      await expect(select).toHaveValue("harness:claude");
    } finally {
      await context.close();
    }
  });
}

// ── The phone keeps every box ───────────────────────────────────────────────────────────────────────────────

const PHONE_PAGES = [
  { id: "new", path: "/new" },
  { id: "new-add", path: "/new/add?kind=agent" },
  { id: "space", path: "/space/w11" },
] as const;

/**
 * THE BUILD STAMP, PINNED. The stamp (components/build-stamp.tsx) sits under `main`, which fills the rest of
 * the scroller, so the stamp's height is taken off `main`. Two inputs of the machine set that height, and
 * neither is the layout this test guards:
 * - The build. A build off an untagged commit stamps its version `-dev` (vite.config.ts, `channelFor`), and
 *   the stamp then adds a second line, the viewport sizes (`ViewportStamp`, a diagnostic of dev builds
 *   only, 16 px). A clone with tags builds `-dev` until the release tag exists; the CI checkout holds no
 *   tags and builds a release. The line is taken out of the layout, as a release build draws the stamp.
 * - The installed fonts. The stamp's label is set in the mono stack, whose first faces are system fonts; a
 *   fallback face with other ascent and descent makes the line box about a pixel taller or shorter. The
 *   label takes the stamp's own bundled face while the boxes are read.
 * The stamp's own boxes are left out of the list (`boxes`); this only fixes the room it takes.
 */
async function pinBuildStamp(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const stamp of document.querySelectorAll<HTMLElement>(".text-center.text-\\[11px\\]")) {
      for (const line of stamp.querySelectorAll<HTMLElement>(":scope > div")) {
        if (/^vp \d/.test(line.textContent ?? "")) line.style.display = "none";
      }
      for (const mono of stamp.querySelectorAll<HTMLElement>(".font-mono")) mono.style.fontFamily = "inherit";
    }
  });
}

/** Every drawn element's tag and box, in document order. The build stamp (`components/build-stamp.tsx`) names the build, so it is left out. */
async function boxes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll("#root *")) {
      if (el.closest(".text-center.text-\\[11px\\]") !== null) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      out.push(`${el.tagName.toLowerCase()} ${String(Math.round(r.x))},${String(Math.round(r.y))} ${String(Math.round(r.width))}x${String(Math.round(r.height))}`);
    }
    return out;
  });
}

test("at 390x844 the New page, Add your own and the space page keep every box", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "app-phone", "sets its own viewport; one project is enough");
  test.setTimeout(60_000);
  const recorded: Record<string, string[]> = {};
  // SAFETY: the file is this spec's own output (`WIDE_NEW_RECORD=1` below writes it), a map of page id to box lines.
  const expected = RECORD || !existsSync(BOXES_FILE) ? null : (JSON.parse(readFileSync(BOXES_FILE, "utf8")) as Record<string, string[]>);
  for (const { id, path } of PHONE_PAGES) {
    const { context, page } = await open(browser, String(testInfo.project.use.baseURL), { width: 390, height: 844 }, true);
    try {
      await page.goto(path);
      await page.waitForSelector("#root main, #root [data-slot='bottom-bar']", { timeout: 10_000 });
      await settle(page);
      await page.waitForTimeout(600);
      await expect(page.locator('[role="dialog"]')).toHaveCount(0);
      await pinBuildStamp(page);
      recorded[id] = await boxes(page);
      if (expected !== null) expect(recorded[id], id).toEqual(expected[id]);
    } finally {
      await context.close();
    }
  }
  if (RECORD) writeFileSync(BOXES_FILE, `${JSON.stringify(recorded, null, 1)}\n`);
  else expect(expected, `record ${BOXES_FILE} on the build before this change`).not.toBeNull();
});
