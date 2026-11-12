import { test, type Browser } from "@playwright/test";

import { SHIPPED_THEME_IDS } from "@/lib/theme/schema";

import { writeKey, type Json } from "./out";
import { finger, press, sleep } from "./touch";
import { installWorld } from "./world";

// PROPOSAL 4, MEASURED: A ROW THAT IS OPENING SAYS SO, IGNORES A SECOND TAP, AND MOVES NOTHING.
// With the pane's read answered after 1500ms, a row is tapped, and then tapped again. Read back: the mark
// (a `.row-opening` bar and `aria-busy`), the row's own box and its neighbour's before and during, the reads
// that went out, when the pane opened, and, for every shipped theme in light and dark and with reduced motion
// on and off, the bar's colours and their contrast against the page. Before the change there is no mark and
// every tap sends its own read, which is what the same run records on the old build.
//
//     HITBOX_OUT=/tmp/x.json HITBOX_TAG=after bunx playwright test -c e2e/hitbox/playwright.config.ts opening

const TAG = process.env.HITBOX_TAG ?? "after";
const READ_MS = 1500;
/** WCAG contrast of two CSS colours, read through a canvas so any colour syntax (oklch included) resolves. */
const CONTRAST = `
window.__hbContrast = (a, b) => {
  const rgb = (css) => {
    const c = document.createElement("canvas"); c.width = 1; c.height = 1;
    const g = c.getContext("2d"); g.fillStyle = css; g.fillRect(0, 0, 1, 1);
    return Array.from(g.getImageData(0, 0, 1, 1).data).slice(0, 3);
  };
  const lum = (px) => { const v = px.map((u) => { const s = u / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const x = lum(rgb(a)); const y = lum(rgb(b));
  return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100;
};
`;

interface Opening {
  mark: boolean;
  busy: boolean;
  rowMoved: number;
  neighbourMoved: number;
  reads: number;
  openedAfterMs: number | null;
  bar: { contrast: number | null; track: string | null; bar: string | null; page: string | null } | null;
}

async function once(browser: Browser, opts: { theme: string; scheme: "light" | "dark"; reduced: boolean; taps: number }): Promise<Opening> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
    colorScheme: opts.scheme,
    reducedMotion: opts.reduced ? "reduce" : "no-preference",
    baseURL: `http://127.0.0.1:${process.env.HITBOX_PORT ?? "5301"}`,
  });
  const page = await context.newPage();
  await page.addInitScript((theme) => localStorage.setItem("collie:design:v1", JSON.stringify({ font: "system", theme })), opts.theme);
  await page.addInitScript({ content: CONTRAST });
  await installWorld(page);
  let reads = 0;
  await page.route(/\/api\/pane\/[^/]+(\/chat)?(\?.*)?$/, async (route) => {
    reads += 1;
    await sleep(READ_MS);
    await route.fallback();
  });
  await page.goto("/");
  await page.waitForSelector('[data-glide-origin="pane"]');
  await sleep(1200);
  const f = await finger(page);
  const row = page.locator('[data-glide-origin="pane"]').nth(1);
  const next = page.locator('[data-glide-origin="pane"]').nth(2);
  const rowBefore = await row.boundingBox();
  const nextBefore = await next.boundingBox();
  if (rowBefore === null || nextBefore === null) throw new Error("rows have no box");
  const x = rowBefore.x + rowBefore.width / 2;
  const y = rowBefore.y + rowBefore.height / 2;
  const start = Date.now();
  await press(f, x, y, { holdMs: 60 });
  await sleep(500);
  // The row, 500ms into a 1500ms read.
  const mark = (await row.locator(".row-opening").count()) > 0;
  const busy = (await row.getAttribute("aria-busy")) === "true";
  const rowDuring = await row.boundingBox();
  const nextDuring = await next.boundingBox();
  const bar = mark
    ? await page.evaluate(() => {
        const track = document.querySelector(".row-opening");
        if (track === null) return null;
        const barColour = getComputedStyle(track, "::before").backgroundColor;
        const trackColour = getComputedStyle(track).backgroundColor;
        // The page's ground is a token, not the body's own paint (the body is transparent): resolve `--background`
        // through a probe, and the row's card colour the bar actually sits on.
        const probe = document.createElement("div");
        document.body.append(probe);
        probe.style.background = "var(--background)";
        const pageColour = getComputedStyle(probe).backgroundColor;
        probe.style.background = "var(--card)";
        const cardColour = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const onPage = window.__hbContrast?.(barColour, pageColour) ?? null;
        const onCard = window.__hbContrast?.(barColour, cardColour) ?? null;
        // The row is a flat row on the page ground or a card: the lower of the two is the one to meet.
        const contrast = onPage === null || onCard === null ? null : Math.min(onPage, onCard);
        return { contrast, track: trackColour, bar: barColour, page: pageColour };
      })
    : null;
  // More taps on the same row while the read is out.
  for (let k = 1; k < opts.taps; k += 1) {
    await press(f, x, y, { holdMs: 60 });
    await sleep(300);
  }
  let openedAfterMs: number | null = null;
  try {
    await page.waitForURL(/\/pane\//, { timeout: 9000 });
    openedAfterMs = Date.now() - start;
  } catch {
    openedAfterMs = null;
  }
  const result: Opening = {
    mark,
    busy,
    rowMoved: rowDuring === null ? -1 : Math.abs(rowDuring.y - rowBefore.y) + Math.abs(rowDuring.height - rowBefore.height),
    neighbourMoved: nextDuring === null ? -1 : Math.abs(nextDuring.y - nextBefore.y),
    reads,
    openedAfterMs,
    bar,
  };
  await context.close();
  return result;
}

test("a row that is opening: the mark, the second tap, and every theme", async ({ browser }) => {
  const out: { [key: string]: Json } = {};
  // Three taps on one row over a 1500ms read, in the default theme.
  const taps = await once(browser, { theme: "collie", scheme: "light", reduced: false, taps: 3 });
  out.threeTaps = { ...taps };
  // One tap in every shipped theme, light and dark, motion on and reduced.
  const themes: { [key: string]: Json } = {};
  for (const theme of SHIPPED_THEME_IDS) {
    for (const scheme of ["light", "dark"] as const) {
      for (const reduced of [false, true]) {
        const r = await once(browser, { theme, scheme, reduced, taps: 1 });
        themes[`${theme}/${scheme}/${reduced ? "reduced" : "motion"}`] = { ...r };
      }
    }
  }
  out.themes = themes;
  writeKey(`opening:${TAG}`, out);
  console.log(JSON.stringify({ threeTaps: out.threeTaps }));
});
