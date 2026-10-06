import { expect, test, type Page, type Route } from "@playwright/test";

import { CHAT_BODY, PANE_SNAPSHOT, PANES, TERMINAL_TEXT } from "./pane-api";

// QUIET POLLS (REMIX3.md, "A module store is right when"): a poll whose payload did not change causes
// zero renders. The stub answers every read with the same payload: the snapshot with a new `ts` each
// time (the live bridge does that, and sends no ETag), the mirror and the chat window with 304 to
// their own ETags. The open pane's agent is working, so the beat runs at HOT_MS (1.5 s) and the
// window holds six or more beats. `?debug` turns on the render counter in this production build
// (lib/render-count.ts): `window.__collieRenders[name]` counts each component's render passes.

declare global {
  interface Window {
    __collieRenders?: Record<string, number>;
  }
}

const WINDOW_MS = 10_000;
const MIN_SNAPSHOT_READS = 5;

async function stubSameAnswers(page: Page, working: string): Promise<Map<string, number>> {
  const reads = new Map<string, number>();
  const etags = { mirror: '"mirror-1"', chat: '"chat-1"' };
  await page.route("**/api/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const sub = /^\/api\/pane\/[^/]+(?:\/(\w+))?$/u.exec(url.pathname);
    const name = sub ? `pane ${sub[1] ?? "screen"}` : url.pathname;
    reads.set(name, (reads.get(name) ?? 0) + 1);
    if (req.method() !== "GET") return route.fulfill({ status: 405, json: { error: "read-only stub" } });
    if (url.pathname === "/api/snapshot") {
      const agents = PANE_SNAPSHOT.agents.map((a) => (a.paneId === working ? { ...a, status: "working" as const } : a));
      return route.fulfill({ json: { ...PANE_SNAPSHOT, ts: Date.now(), agents } });
    }
    if (url.pathname === "/api/config") return route.fulfill({ json: { push: false, vapidPublicKey: "" } });
    if (sub?.[1] === "chat") {
      if (req.headers()["if-none-match"] === etags.chat) return route.fulfill({ status: 304, headers: { etag: etags.chat } });
      return route.fulfill({ json: CHAT_BODY, headers: { etag: etags.chat } });
    }
    if (sub && sub[1] === undefined) {
      if (req.headers()["if-none-match"] === etags.mirror) return route.fulfill({ status: 304, headers: { etag: etags.mirror } });
      const paneId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      return route.fulfill({ json: { paneId, text: TERMINAL_TEXT, truncated: false, revision: 1 }, headers: { etag: etags.mirror } });
    }
    return route.fulfill({ status: 404, json: { error: "not stubbed" } });
  });
  return reads;
}

async function renders(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => ({ ...window.__collieRenders }));
}

async function quietWindow(page: Page, reads: Map<string, number>): Promise<Record<string, number>> {
  // Let the mount reads and their first answers land, then start counting from zero.
  await page.waitForTimeout(3_000);
  await page.evaluate(() => {
    window.__collieRenders = {};
  });
  reads.clear();
  await page.waitForTimeout(WINDOW_MS);
  expect(reads.get("/api/snapshot") ?? 0, JSON.stringify(Object.fromEntries(reads))).toBeGreaterThanOrEqual(MIN_SNAPSHOT_READS);
  return renders(page);
}

const path = (paneId: string) => `/pane/${encodeURIComponent(paneId)}?debug`;

test("an idle Terminal pane renders nothing over 10 s of identical polls", async ({ page }) => {
  const reads = await stubSameAnswers(page, PANES.plain);
  await page.goto(path(PANES.plain));
  await expect(page.getByTestId("pane-text")).toContainText("12 tests passed");
  expect((await renders(page)).PaneRoute ?? 0).toBeGreaterThan(0); // the counter is live
  const counts = await quietWindow(page, reads);
  expect(reads.get("pane screen") ?? 0).toBeGreaterThanOrEqual(MIN_SNAPSHOT_READS);
  expect(counts.PaneRoute ?? 0, JSON.stringify(counts)).toBe(0);
  expect(counts.TerminalView ?? 0, JSON.stringify(counts)).toBe(0);
  expect(counts.Composer ?? 0, JSON.stringify(counts)).toBe(0);
});

test("an idle Chat pane renders nothing over 10 s of identical polls", async ({ page }) => {
  const reads = await stubSameAnswers(page, PANES.chat);
  await page.addInitScript(() => {
    // The pref loader fills every other field with its default (lib/prefs.ts).
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "chat" }));
  });
  await page.goto(path(PANES.chat));
  await expect(page.getByTestId("chat-stream")).toContainText("Fixed: the test now waits for the poll.");
  const counts = await quietWindow(page, reads);
  expect(reads.get("pane chat") ?? 0).toBeGreaterThanOrEqual(MIN_SNAPSHOT_READS);
  expect(counts.PaneRoute ?? 0, JSON.stringify(counts)).toBe(0);
  expect(counts.ChatView ?? 0, JSON.stringify(counts)).toBe(0);
  expect(counts.Composer ?? 0, JSON.stringify(counts)).toBe(0);
});

test("the dashboard renders nothing over 10 s of identical polls", async ({ page }) => {
  // A working agent on the dashboard holds the beat at HOME_BUSY_MS (4 s): fewer reads, same rule.
  const reads = await stubSameAnswers(page, PANES.plain);
  await page.goto("/?debug");
  await expect(page.locator('button[id^="pane-row-"]').first()).toBeVisible();
  await page.waitForTimeout(3_000);
  await page.evaluate(() => {
    window.__collieRenders = {};
  });
  reads.clear();
  await page.waitForTimeout(WINDOW_MS);
  const counts = await renders(page);
  expect(reads.get("/api/snapshot") ?? 0).toBeGreaterThanOrEqual(2);
  expect(counts.HomeRoute ?? 0, JSON.stringify(counts)).toBe(0);
});
