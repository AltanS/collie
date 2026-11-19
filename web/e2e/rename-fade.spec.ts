import { expect, test, type Page } from "@playwright/test";

import { fixtureSnapshot } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";
import { keepPhoneLayout } from "./fixtures/layout";

// A RENAME FADES AND MOVES NOTHING (operator, 2026-11-19). jsdom has no layout, so two claims of
// `ui/crossfade-text.tsx` are read here in an engine: the old words, an out-of-flow copy, take no room
// (no row moves while the fade runs and none after), and the caller's `truncate` still draws its
// ellipsis for a name too long for the line.

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no dashboard poll");
  await installApiStub(page);
  await keepPhoneLayout(page);
});

declare global {
  interface Window {
    /** Exposed by the test: the page reports its first frame of the fade here. */
    recordFade?: (sample: FadeSample) => void;
  }
}

interface FadeSample {
  tops: number[];
  position: string;
  hidden: string | null;
  running: number;
}

const LONG = "a name that is much too long for one line on a phone, so that it has to be cut with an ellipsis";
const renamedSnapshot = (label: string) => ({
  ...fixtureSnapshot,
  agents: fixtureSnapshot.agents.map((a, i) => Object.assign({}, a, i === 0 ? { paneLabel: label } : {})),
});

/** What the page holds about layout, read where the engine knows it. */
function measure(page: Page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="agent-row-title"]')];
    const name = rows[0]?.querySelector<HTMLElement>('[data-glide="name"]');
    return {
      tops: rows.map((row) => Math.round(row.getBoundingClientRect().top * 10) / 10),
      ellipsis: name === undefined || name === null ? null : getComputedStyle(name).textOverflow === "ellipsis" && name.scrollWidth > name.clientWidth,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

test("a renamed pane fades, takes no room, and still ends in an ellipsis", async ({ page }) => {
  let label = `${LONG} one`;
  await page.route("**/api/snapshot", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(renamedSnapshot(label)) }),
  );
  // Sample the layout in the very mutation that draws the outgoing copy, the first frame of the fade.
  const samples: FadeSample[] = [];
  await page.exposeFunction("recordFade", (sample: FadeSample) => {
    samples.push(sample);
  });
  await page.addInitScript(() => {
    let taken = false;
    new MutationObserver(() => {
      const out = document.querySelector<HTMLElement>('[data-slot="crossfade-out"]');
      const record = window.recordFade;
      if (taken || out === null || record === undefined) return;
      taken = true;
      const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="agent-row-title"]')];
      record({
        tops: rows.map((row) => Math.round(row.getBoundingClientRect().top * 10) / 10),
        position: getComputedStyle(out).position,
        hidden: out.getAttribute("aria-hidden"),
        running: out.getAnimations().length,
      });
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto("/");
  await expect(page.locator('[data-slot="agent-row-title"]').first()).toBeVisible();
  const before = await measure(page);
  expect(before.ellipsis).toBe(true);

  label = `${LONG} two`;
  await expect.poll(() => samples.length, { timeout: 30_000 }).toBe(1);
  const sample = samples[0]!;
  // The first frame of the fade: the old copy is out of flow, hidden from a screen reader, animating,
  // and no row moved.
  expect(sample.position).toBe("absolute");
  expect(sample.hidden).toBe("true");
  expect(sample.running).toBeGreaterThan(0);
  expect(sample.tops).toEqual(before.tops);

  // The fade ends: the copy goes, nothing moved, the name still ends in an ellipsis, the page is not wider.
  await expect(page.locator('[data-slot="crossfade-out"]')).toHaveCount(0);
  const after = await measure(page);
  expect(after.tops).toEqual(before.tops);
  expect(after.ellipsis).toBe(true);
  expect(after.pageOverflow).toBe(false);
});
