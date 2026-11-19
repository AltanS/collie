import { expect, test, type Page } from "@playwright/test";

import { CROSSFADE_QUIET_MS } from "@/components/ui/crossfade-text";
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

  // A name fades only after it held still for the quiet time, so let the row's name sit that long.
  await page.waitForTimeout(CROSSFADE_QUIET_MS + 200);
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

// THE OLD COPY SITS ON THE NEW WORDS (operator, 2026-11-19: "the words drop below the tab label"). The
// old copy is `absolute` inside an inline `relative` span, and a label that sits in a grid cell, a flex
// item or beside a reserved copy could put it somewhere else than the new words. Four surfaces, read in
// the engine during the fade: the old copy's top and left agree with the new copy's within half a pixel,
// and the old copy does not reach below the box that holds the label. `still` is read with every
// animation cancelled (the layout alone), `moving` on the fade's first frame (a 2px drift once put the new words 2px off the old ones there).

interface Rect {
  top: number;
  left: number;
  bottom: number;
}
interface PairSample {
  text: string;
  moving: { out: Rect; in: Rect };
  still: { out: Rect; in: Rect; host: Rect };
}

declare global {
  interface Window {
    recordPair?: (sample: PairSample) => void;
  }
}

/** The gap between two edges, to a hundredth of a pixel. */
function gap(a: number, b: number): number {
  return Math.round((a - b) * 100) / 100;
}

interface Surface {
  name: string;
  url: string;
  /** The selector the outgoing copy sits under. */
  scope: string;
  /** The snapshot before the rename and after it. */
  snapshot: (renamed: boolean) => typeof fixtureSnapshot;
}

const withTab = (label: string) => ({
  ...fixtureSnapshot,
  tabs: fixtureSnapshot.tabs.map((t) => (t.tabId === "w2:t1" ? Object.assign({}, t, { label }) : t)),
});
const withSpace = (label: string) => ({
  ...fixtureSnapshot,
  workspaces: fixtureSnapshot.workspaces.map((w) => (w.workspaceId === "w2" ? Object.assign({}, w, { label }) : w)),
  agents: fixtureSnapshot.agents.map((a) => (a.workspaceId === "w2" ? Object.assign({}, a, { workspaceLabel: label }) : a)),
});
const withPane = (label: string) => ({
  ...fixtureSnapshot,
  agents: fixtureSnapshot.agents.map((a) => (a.paneId === "w2:p1" ? Object.assign({}, a, { paneLabel: label }) : a)),
});

const SURFACES: Surface[] = [
  { name: "a tab label in the tab strip", url: "/space/w2", scope: 'nav[aria-label="Tabs"]', snapshot: (r) => withTab(r ? "docs" : "code") },
  { name: "the Chat header's name", url: `/pane/${encodeURIComponent("w2:p1")}`, scope: '[data-slot="pane-name"]', snapshot: (r) => withPane(r ? "wiring" : "plumbing") },
  { name: "a dashboard row's name", url: "/", scope: '[data-slot="agent-row-title"]', snapshot: (r) => withPane(r ? "wiring" : "plumbing") },
  { name: "a Space chip", url: "/space/w2", scope: 'nav[aria-labelledby]', snapshot: (r) => withSpace(r ? "workshop" : "lab") },
];

for (const surface of SURFACES) {
  test(`${surface.name}: the old copy sits on the new words`, async ({ page }, testInfo) => {
    let renamed = false;
    await page.route("**/api/snapshot", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(surface.snapshot(renamed)) }),
    );
    const samples: PairSample[] = [];
    await page.exposeFunction("recordPair", (sample: PairSample) => {
      samples.push(sample);
    });
    await page.addInitScript((scope) => {
      let taken = false;
      new MutationObserver(() => {
        const record = window.recordPair;
        const out = document.querySelector<HTMLElement>(`${scope} [data-slot="crossfade-out"]`);
        if (taken || record === undefined || out === null) return;
        const wrap = out.parentElement;
        const fresh = wrap?.querySelector<HTMLElement>('[data-slot="crossfade-in"]');
        if (wrap === null || wrap === undefined || fresh === null || fresh === undefined) return;
        taken = true;
        // The rect of the WORDS (a range over the copy), not of the element: an inline span's box is its
        // font's content area and a blockified one is its line box, so the two boxes differ by half the
        // leading while the glyphs sit on one line.
        const words = () =>
          [out, fresh].map((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const r = range.getBoundingClientRect();
            return { top: r.top, left: r.left, bottom: r.bottom };
          });
        const [movingOut, movingIn] = words();
        for (const el of [out, fresh]) for (const a of el.getAnimations()) a.cancel();
        const [stillOut, stillIn] = words();
        const host = (out.closest("button") ?? wrap.parentElement ?? wrap).getBoundingClientRect();
        record({
          text: out.textContent ?? "",
          moving: { out: movingOut!, in: movingIn! },
          still: { out: stillOut!, in: stillIn!, host: { top: host.top, left: host.left, bottom: host.bottom } },
        });
      }).observe(document, { childList: true, subtree: true });
    }, surface.scope);
    await page.goto(surface.url);
    await expect(page.locator(surface.scope).first()).toBeVisible();
    await page.waitForTimeout(CROSSFADE_QUIET_MS + 200);
    renamed = true;
    await expect.poll(() => samples.length, { timeout: 30_000 }).toBe(1);
    const s = samples[0]!;
    testInfo.annotations.push({
      type: "offsets",
      description: JSON.stringify({
        old: s.text,
        movingDTop: gap(s.moving.in.top, s.moving.out.top),
        movingDLeft: gap(s.moving.in.left, s.moving.out.left),
        stillDTop: gap(s.still.in.top, s.still.out.top),
        stillDLeft: gap(s.still.in.left, s.still.out.left),
        outBottomPastHost: gap(s.still.out.bottom, s.still.host.bottom),
      }),
    });
    console.log(`OFFSETS ${testInfo.project.name} ${surface.name} ${JSON.stringify(testInfo.annotations.at(-1)?.description)}`);
    expect(Math.abs(s.still.out.top - s.still.in.top)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(s.still.out.left - s.still.in.left)).toBeLessThanOrEqual(0.5);
    expect(s.still.out.bottom).toBeLessThanOrEqual(s.still.host.bottom + 0.5);
    // Opacity only, no drift: even on the first frame the two copies share one line.
    expect(Math.abs(s.moving.out.top - s.moving.in.top)).toBeLessThanOrEqual(0.5);
  });
}
