import { expect, test, type Page } from "@playwright/test";

import { PANES, stubPaneBridge, TERMINAL_TEXT } from "./pane-api";

// "Load older" in the Chat view (research note 07, f.5; ACTION-PLAN D.10): an older page merges in by
// turn key and the reader's place holds. The first block in view stays where it was, measured on EVERY
// animation frame from the tap until the page is on screen, so a one-frame jump fails too.

const TS = "2026-10-06T10:00:00.000Z";
const LIVE_FIRST = 100;
const LIVE_COUNT = 30;
const OLDER_COUNT = 40;

interface Turn {
  uuid: string;
  seq: number;
  ts: string;
  role: "user" | "assistant";
  parts: Array<{ kind: "text"; text: string }>;
}

function turn(n: number): Turn {
  const lines = Array.from({ length: 1 + (n % 4) }, (_, i) => `turn ${String(n)} line ${String(i + 1)}`).join("\n\n");
  return { uuid: `u${String(n)}`, seq: n, ts: TS, role: n % 2 === 0 ? "user" : "assistant", parts: [{ kind: "text", text: lines }] };
}

const range = (first: number, count: number): Turn[] => Array.from({ length: count }, (_, i) => turn(first + i));

async function stubChat(page: Page, olderRequests: string[]): Promise<void> {
  await stubPaneBridge(page, { [PANES.chat]: TERMINAL_TEXT });
  await page.route(/\/api\/pane\/[^/]+\/chat/u, (route) => {
    const url = new URL(route.request().url());
    const before = url.searchParams.get("before");
    if (before !== null) {
      olderRequests.push(before);
      // The older page repeats the held first turn, as a page can: the merge must not double it.
      return route.fulfill({ json: { paneId: PANES.chat, available: true, page: "older", gen: 1, hasOlder: false, upserts: [...range(LIVE_FIRST - OLDER_COUNT, OLDER_COUNT), turn(LIVE_FIRST)] } });
    }
    return route.fulfill({
      json: { paneId: PANES.chat, available: true, page: "live", gen: 1, rev: 1, head: LIVE_FIRST + LIVE_COUNT - 1, oldest: LIVE_FIRST, hasOlder: true, queued: [], upserts: range(LIVE_FIRST, LIVE_COUNT) },
    });
  });
}

declare global {
  interface Window {
    __drift?: { key: string; start: number; worst: number; frames: number };
    __stopDrift?: () => void;
  }
}

test("Load older prepends by key, dedupes, and the first visible block never moves", async ({ page }) => {
  const olderRequests: string[] = [];
  await stubChat(page, olderRequests);
  await page.goto(`/pane/${encodeURIComponent(PANES.chat)}`);
  const stream = page.getByTestId("chat-stream");
  await expect(stream.locator("[data-block]")).toHaveCount(LIVE_COUNT);
  await expect(page.getByTestId("chat-load-older")).toBeVisible();

  // The reader is at the top of the window with the button on screen (that is where it sits), not
  // following the tail. Scrolled a little, so the first block in view is partly above the top edge.
  await stream.evaluate((node) => {
    node.scrollTop = 40;
  });
  await expect(page.getByTestId("scroll-to-latest")).toBeVisible();
  await page.waitForTimeout(200);

  // Pick the first block in view and watch its offset every frame from here on.
  const key = await stream.evaluate((node) => {
    const top = node.getBoundingClientRect().top;
    const first = [...node.querySelectorAll<HTMLElement>("[data-block]")].find((b) => b.getBoundingClientRect().bottom > top);
    if (!first?.dataset.key) throw new Error("no block in view");
    const find = (): number => {
      const el = [...node.querySelectorAll<HTMLElement>("[data-block]")].find((b) => b.dataset.key === first.dataset.key);
      return el ? el.getBoundingClientRect().top - node.getBoundingClientRect().top : Number.NaN;
    };
    const start = find();
    const drift = { key: first.dataset.key, start, worst: 0, frames: 0 };
    window.__drift = drift;
    let running = true;
    window.__stopDrift = () => {
      running = false;
    };
    const loop = (): void => {
      if (!running) return;
      drift.frames++;
      const now = find();
      if (!Number.isNaN(now)) drift.worst = Math.max(drift.worst, Math.abs(now - start));
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return first.dataset.key;
  });

  // A DOM click: Playwright's own click would scroll the button into view first and move the reader.
  await page.getByTestId("chat-load-older").evaluate((button: HTMLElement) => {
    button.click();
  });
  await expect(stream.locator("[data-block]")).toHaveCount(LIVE_COUNT + OLDER_COUNT);
  await expect(page.getByTestId("chat-load-older")).toHaveCount(0);
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__stopDrift?.());

  expect(olderRequests).toHaveLength(1);
  expect(olderRequests[0]).toBe(`${String(LIVE_FIRST)}:u${String(LIVE_FIRST)}`);
  // No turn twice: the repeated held turn merged into its own block.
  const keys = await stream.locator("[data-block]").evaluateAll((nodes) => nodes.map((n) => (n instanceof HTMLElement ? n.dataset.key : undefined)));
  expect(new Set(keys).size).toBe(keys.length);
  const drift = await page.evaluate(() => window.__drift);
  expect(drift?.key).toBe(key);
  expect(key).toBe(`u${String(LIVE_FIRST)}:0`); // the held first turn: what the older page lands above
  expect(drift?.frames ?? 0).toBeGreaterThan(5);
  expect(drift?.worst ?? 99).toBeLessThanOrEqual(1);
});
