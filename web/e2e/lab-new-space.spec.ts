import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { AgentView, LaunchersAdding, LaunchersResponse, SnapshotResponse } from "@/lib/types";
import { fixtureLaunchersWithAgents } from "@/test/handlers";

import { stillMarkState } from "./fixtures/still-mark";
import { installWideChatWorld } from "./fixtures/wide-chat";
import { wideSnapshot } from "./fixtures/wide-herd";
import { installFilledReads, installScreenStubs } from "./screens/setups";

// LAB (desktop pass 2, step 1): the New page and the space page, today (`ns=0`) and the three proposals, at
// 1440x900 and 1920x1080. Writes `<state>.ns<N>.<width>.png` to `LAB_SHOTS`; checks only that each state
// draws, and that Start is in view with no scroll. Removed in step 2.
//
//     cd web && LAB_SHOTS=<dir> E2E_SET=rest E2E_WEBKIT=0 bunx playwright test e2e/lab-new-space.spec.ts --project=app-phone --workers=4

const SHOTS = process.env.LAB_SHOTS;
const SIZES = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`fixture has no ${what}`);
  return value;
}

function json<T extends object>(route: Route, body: T): Promise<void> {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

/** Twelve Spaces; Space 11 has two tabs and five sessions (two agents and a shell in `main`, two agents in `review`). */
function labSnapshot(): SnapshotResponse {
  const snapshot = wideSnapshot({ spaces: 12, blocked: ["w2:p1", "w7:p1"], unseen: ["w4:p2"] });
  for (const agent of snapshot.agents) agent.hasSession = true;
  const ws = must(snapshot.workspaces.find((w) => w.workspaceId === "w11"), "w11");
  ws.tabCount = 2;
  ws.paneCount = 5;
  must(snapshot.tabs.find((t) => t.tabId === "w11:t1"), "w11:t1").paneCount = 3;
  snapshot.tabs.push({ tabId: "w11:t2", workspaceId: "w11", number: 2, label: "review", focused: false, paneCount: 2 });
  const base = must(snapshot.agents.find((a) => a.paneId === "w11:p1"), "w11:p1");
  const pane = (id: string, tabId: string, agent: string, status: AgentView["status"], extra: Partial<AgentView> = {}): AgentView => ({
    ...base,
    paneId: id,
    tabId,
    tabLabel: tabId.endsWith("t2") ? "review" : "main",
    agent,
    status,
    terminalTitle: `${tabId.endsWith("t2") ? "review" : "work"} in space-11`,
    ...extra,
  });
  snapshot.shellPanes.push({ ...pane("w11:p3", "w11:t1", "shell", "unknown"), kind: "shell", paneLabel: "shell", terminalTitle: undefined });
  snapshot.agents.push(pane("w11:p4", "w11:t2", "claude", "working"), pane("w11:p5", "w11:t2", "codex", "idle"));
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

async function world(page: Page): Promise<void> {
  await installWideChatWorld(page);
  await installScreenStubs(page);
  await installFilledReads(page);
  const snapshot = labSnapshot();
  await page.route((url) => url.pathname === "/api/snapshot", (route) => json(route, snapshot));
  await page.route((url) => url.pathname === "/api/launchers", (route) => json(route, LAUNCHERS));
  await page.route(
    (url) => url.pathname === "/api/folders/browse",
    (route) => json(route, { path: "~", parent: null, folders: ["collie", "docs", "notes", "projects", "scratch", "webapp", "worktrees"].map((name) => ({ name, git: name !== "notes" && name !== "scratch" })), filter: "", truncated: false }),
  );
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
}

/** Open New the way a person does from where `path` lands. */
async function openNew(page: Page, from: "dashboard" | "pane"): Promise<void> {
  if (from === "dashboard") {
    await page.getByRole("button", { name: en["home.new.label"], exact: true }).first().click();
  } else {
    await page.getByRole("button", { name: en["wide.newSpace"], exact: true }).first().click();
  }
  await page.getByRole("button", { name: en["newPage.start"], exact: true }).waitFor({ state: "visible", timeout: 8000 });
}

/** Start is drawn whole inside the window, and nothing had to scroll to show it. */
async function startInView(page: Page): Promise<void> {
  const start = page.getByRole("button", { name: en["newPage.start"], exact: true });
  const box = await start.boundingBox();
  const vp = page.viewportSize();
  expect(box).not.toBeNull();
  if (box === null || vp === null) return;
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
  expect(box.y).toBeGreaterThanOrEqual(0);
}

type State = { id: string; run: (page: Page, ns: number) => Promise<void>; start?: boolean };

const STATES: State[] = [
  {
    id: "new-dashboard",
    start: true,
    run: async (page, ns) => {
      await page.goto(`/?ns=${String(ns)}`);
      await openNew(page, "dashboard");
    },
  },
  {
    id: "new-pane",
    start: true,
    run: async (page, ns) => {
      await page.goto(`/pane/w1%3Ap1?ns=${String(ns)}`);
      await page.waitForSelector('[data-slot="wide-layout"]', { timeout: 10_000 });
      await settle(page);
      await openNew(page, "pane");
    },
  },
  {
    id: "new-browse",
    start: true,
    run: async (page, ns) => {
      await page.goto(`/?ns=${String(ns)}`);
      await openNew(page, "dashboard");
      await page.getByRole("button", { name: new RegExp(`^${en["newPage.browse"]}`, "u") }).first().click();
      await page.getByText("worktrees", { exact: true }).first().waitFor({ timeout: 8000 });
    },
  },
  {
    id: "new-shell",
    start: true,
    run: async (page, ns) => {
      await page.goto(`/?ns=${String(ns)}`);
      await openNew(page, "dashboard");
      await page.getByRole("radio", { name: en["newPage.shell"], exact: true }).first().click();
    },
  },
  {
    id: "new-add",
    run: async (page, ns) => {
      await page.goto(`/?ns=${String(ns)}`);
      await openNew(page, "dashboard");
      await page.getByRole("button", { name: en["newPage.add"], exact: true }).first().click();
      await page.getByRole("button", { name: en["launcherAdd.add"], exact: true }).waitFor({ state: "visible", timeout: 8000 });
    },
  },
  {
    id: "space",
    run: async (page, ns) => {
      await page.goto(`/space/w11?ns=${String(ns)}`);
      await page.waitForTimeout(600);
    },
  },
];

test.use({ serviceWorkers: "block" });

for (const state of STATES) {
  for (const ns of [0, 1, 2, 3]) {
    test(`${state.id} ns${String(ns)}`, async ({ browser }, testInfo) => {
      test.setTimeout(90_000);
      test.skip(testInfo.project.name !== "app-phone", "sets its own viewports; one project is enough");
      const baseURL = String(testInfo.project.use.baseURL);
      for (const size of SIZES) {
        const context = await browser.newContext({ baseURL, viewport: size, deviceScaleFactor: 1, serviceWorkers: "block", storageState: stillMarkState(baseURL) });
        try {
          const page = await context.newPage();
          await world(page);
          await state.run(page, ns);
          await settle(page);
          if (SHOTS !== undefined) {
            mkdirSync(SHOTS, { recursive: true });
            await page.screenshot({ path: join(SHOTS, `${state.id}.ns${String(ns)}.${String(size.width)}.png`) });
          }
          if (state.start === true && ns !== 0) await startInView(page);
        } finally {
          await context.close();
        }
      }
    });
  }
}

for (const ns of [1, 2, 3]) {
  test(`close and address ns${String(ns)}`, async ({ browser }, testInfo) => {
    test.setTimeout(60_000);
    test.skip(testInfo.project.name !== "app-phone", "sets its own viewports; one project is enough");
    const baseURL = String(testInfo.project.use.baseURL);
    const context = await browser.newContext({ baseURL, viewport: SIZES[0], serviceWorkers: "block", storageState: stillMarkState(baseURL) });
    try {
      const page = await context.newPage();
      await world(page);
      // The one-time keyboard hint would cover the New button after the first key press.
      await page.addInitScript(() => window.localStorage.setItem("collie:keyboard-hint-done:v1", "1"));
      const overlay = page.locator('[data-slot="new-overlay"]');
      // Escape closes, and the opener has the focus back.
      await page.goto(`/?ns=${String(ns)}`);
      await openNew(page, "dashboard");
      await expect(overlay).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(overlay).toHaveCount(0);
      expect(new URL(page.url()).searchParams.get("over")).toBeNull();
      await expect(page.getByRole("button", { name: en["home.new.label"], exact: true }).first()).toBeFocused();
      // Back closes.
      await openNew(page, "dashboard");
      await page.goBack();
      await expect(overlay).toHaveCount(0);
      // From a pane, the pane stays under it, and Escape leaves the pane where it was.
      await page.goto(`/pane/w1%3Ap1`);
      await page.waitForSelector('[data-slot="wide-layout"]', { timeout: 10_000 });
      await openNew(page, "pane");
      await expect(page.locator('[data-slot="wide-layout"]')).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(overlay).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe("/pane/w1%3Ap1");
      // `/new` opened directly is New over the dashboard.
      await page.goto("/new");
      await expect(overlay).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/");
    } finally {
      await context.close();
    }
  });
}
