import { expect, test, type Page, type Route } from "@playwright/test";

import { CHAT_BODY, PANE_SNAPSHOT, PANES, TERMINAL_TEXT } from "./pane-api";

// The pane's polling cadence against web's (src/lib/CADENCE.md). The stub is a live herd as the
// bench saw it: the snapshot's `ts` moves on every read and another agent works, while the OPEN pane
// is idle and its mirror answers 304 to its own ETag. web's rules then rest the open pane at IDLE_MS
// (6 s): snapshot, mirror and chat once per beat, config once per page.
//
// N, from web: mount reads (snapshot, config, mirror, chat) = 4; the first mirror read is "new", so
// one HOT_MS beat at 1.5 s = 3; then IDLE_MS, so one more beat at 7.5 s = 3. That is 10 in 12 s; the
// cap leaves one beat of slack. Before this fix the snapshot's moving `ts` held the beat at HOT_MS
// and the config rode every beat: 21 reads, 5 of them config (measured on the pre-fix build).
const WINDOW_MS = 12_000;
const MAX_REQUESTS = 13;

const path = (paneId: string) => `/pane/${encodeURIComponent(paneId)}`;

interface Counter {
  byPath: Map<string, number>;
  total(): number;
  reset(): void;
}

async function stubLiveHerd(page: Page): Promise<Counter> {
  const byPath = new Map<string, number>();
  const etag = '"mirror-1"';
  await page.route("**/api/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const sub = /^\/api\/pane\/[^/]+(?:\/(\w+))?$/u.exec(url.pathname);
    const name = sub ? `pane ${sub[1] ?? "screen"}` : url.pathname;
    byPath.set(`${req.method()} ${name}`, (byPath.get(`${req.method()} ${name}`) ?? 0) + 1);
    if (url.pathname === "/api/snapshot") {
      // A busy herd: every read is a new body (no ETag), and an agent elsewhere is working.
      const agents = PANE_SNAPSHOT.agents.map((a) => (a.paneId === PANES.walk ? { ...a, status: "working" as const } : a));
      return route.fulfill({ json: { ...PANE_SNAPSHOT, ts: Date.now(), agents } });
    }
    if (url.pathname === "/api/config") return route.fulfill({ json: { push: false, vapidPublicKey: "" } });
    if (sub?.[1] === "chat") return route.fulfill({ json: CHAT_BODY });
    if (sub && sub[1] === undefined) {
      if (req.headers()["if-none-match"] === etag) return route.fulfill({ status: 304, headers: { etag } });
      return route.fulfill({ json: { paneId: PANES.chat, text: TERMINAL_TEXT, truncated: false, revision: 1 }, headers: { etag } });
    }
    return route.fulfill({ status: 404, json: { error: "not stubbed" } });
  });
  return {
    byPath,
    total: () => [...byPath.values()].reduce((a, b) => a + b, 0),
    reset: () => byPath.clear(),
  };
}

/** Headless Chromium never hides a page, so the Page Visibility API is emulated (an init script). */
async function emulateVisibility(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // The flag lives on the document element, so the page and the spec flip one shared value. Read
    // late: the init script runs before the element exists.
    Object.defineProperty(Document.prototype, "hidden", {
      configurable: true,
      get: () => document.documentElement?.dataset.testHidden === "1",
    });
    Object.defineProperty(Document.prototype, "visibilityState", {
      configurable: true,
      get: () => (document.hidden ? "hidden" : "visible"),
    });
  });
}

async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    document.documentElement.dataset.testHidden = h ? "1" : "0";
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test(`an idle pane under a busy herd makes at most ${String(MAX_REQUESTS)} reads in 12 s, config once`, async ({ page }) => {
  const counter = await stubLiveHerd(page);
  const started = Date.now();
  await page.goto(path(PANES.chat));
  await expect(page.getByTestId("pane-title")).toHaveText("fix flaky test");
  await page.waitForTimeout(Math.max(0, WINDOW_MS - (Date.now() - started)));
  const counts = Object.fromEntries(counter.byPath);
  expect(counts["GET /api/config"], JSON.stringify(counts)).toBe(1);
  expect(counter.total(), JSON.stringify(counts)).toBeLessThanOrEqual(MAX_REQUESTS);
  expect(counts["GET /api/snapshot"], JSON.stringify(counts)).toBeLessThanOrEqual(4);
});

test("a hidden page reads nothing, and coming back reads at once", async ({ page }) => {
  await emulateVisibility(page);
  const counter = await stubLiveHerd(page);
  await page.goto(path(PANES.chat));
  await expect(page.getByTestId("pane-title")).toHaveText("fix flaky test");
  await page.waitForTimeout(2_000);
  await setHidden(page, true);
  counter.reset();
  await page.waitForTimeout(8_000);
  expect(Object.fromEntries(counter.byPath)).toEqual({});
  await setHidden(page, false);
  // One immediate read of what the screen renders, and web's "look now" (a POST the stub refuses).
  await expect.poll(() => counter.byPath.get("GET /api/snapshot") ?? 0, { timeout: 1_000 }).toBe(1);
  await expect.poll(() => counter.byPath.get("GET pane screen") ?? 0, { timeout: 1_000 }).toBe(1);
  expect(counter.byPath.get("POST /api/refresh")).toBe(1);
  expect(counter.byPath.get("GET /api/config")).toBeUndefined();
});
