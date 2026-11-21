import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { installApiStub } from "./fixtures/api";
import { collieHalves } from "./fixtures/collie-theme";
import { DESIGN_KEY } from "./fixtures/still-mark";

// THE CHARACTER MOVES AT REST, AT ALL TIMES WHILE THE PAGE IS VISIBLE (the owner's order, 2026-11-13).
// The one spec of the tier that turns the motion on: every other case runs with the device's switch off
// (`fixtures/still-mark.ts`), because a page that moves asks the engine for a frame at every vsync. Only an
// engine can say that an animation runs, so jsdom's `data-still` cases (`lib/mark-motion.test.tsx`) are
// held here against what the browser does: the mark's animations are running, with no touch at all.

test.use({ serviceWorkers: "block" });

/** Seed the device's design blob before the first navigation: its own write replaces the config's. */
async function seedDesign(page: Page, design: Readonly<Record<string, string | boolean>>): Promise<void> {
  await page.addInitScript(([key, blob]) => localStorage.setItem(key, blob), [DESIGN_KEY, JSON.stringify(design)] as const);
}

const header = (page: Page): Locator => page.getByRole("button", { name: en["nav.home.aria.default"] }).locator("svg[data-mark]");

function playStates(mark: Locator): Promise<string[]> {
  return mark.evaluate((svg) => svg.getAnimations({ subtree: true }).map((a) => a.playState));
}

function runningIn(mark: Locator): Promise<number> {
  return mark.evaluate((svg) => svg.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length);
}

/** Say the page is hidden, the way the browser does (see idle-repaint.spec.ts). */
function hide(page: Page, hidden: boolean): Promise<void> {
  return page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (value ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test("the header mark runs with no touch at all when the switch is on", async ({ page }) => {
  await seedDesign(page, { markMoves: true });
  await installApiStub(page);
  await page.goto("/");
  const mark = header(page);
  await expect(mark).toHaveAttribute("data-state", "rest");
  await expect(mark).not.toHaveAttribute("data-still", "");
  await expect.poll(() => runningIn(mark)).toBeGreaterThan(0);
});

test("a device that never touched the switch moves too", async ({ page }) => {
  await seedDesign(page, {});
  await installApiStub(page);
  await page.goto("/");
  await expect.poll(() => runningIn(header(page))).toBeGreaterThan(0);
});

test("the switch off holds every animation of the mark, paused", async ({ page }) => {
  await seedDesign(page, { markMoves: false });
  await installApiStub(page);
  await page.goto("/");
  const mark = header(page);
  await expect(mark).toHaveAttribute("data-still", "");
  const states = await playStates(mark);
  expect(states.length).toBeGreaterThan(0);
  expect(new Set(states)).toEqual(new Set(["paused"]));
});

test("a hidden page rests, and a visible one drifts again", async ({ page }) => {
  await seedDesign(page, { markMoves: true });
  await installApiStub(page);
  await page.goto("/");
  const mark = header(page);
  await expect.poll(() => runningIn(mark)).toBeGreaterThan(0);
  await hide(page, true);
  await expect(mark).toHaveAttribute("data-still", "");
  await expect.poll(() => runningIn(mark)).toBe(0);
  await hide(page, false);
  await expect(mark).not.toHaveAttribute("data-still", "");
  await expect.poll(() => runningIn(mark)).toBeGreaterThan(0);
});

test("the system's reduced motion holds the mark, whatever the switch says", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await seedDesign(page, { markMoves: true });
  await installApiStub(page);
  await page.goto("/");
  const mark = header(page);
  await expect(mark).toHaveAttribute("data-still", "");
  await expect.poll(() => runningIn(mark)).toBe(0);
});

test("a theme that says still holds the mark, and a touched switch beats it", async ({ page }) => {
  const theme = { version: 5, id: "calm", name: "Calm", characterMotion: "still", light: collieHalves.light, dark: collieHalves.dark };
  await page.addInitScript(
    ([key, library]) => localStorage.setItem(key, library),
    ["collie:themes:v1", JSON.stringify({ version: 1, themes: [theme] })] as const,
  );
  await seedDesign(page, { theme: "calm" });
  await installApiStub(page);
  await page.goto("/");
  const mark = header(page);
  await expect(mark).toHaveAttribute("data-still", "");
  await page.goto("/settings/look/character");
  const moves = page.getByRole("switch", { name: en["settings.character.moves"] });
  await expect(moves).toHaveAttribute("aria-checked", "false");
  // The page's own preview draws the worn character at rest: held under the theme, drifting after the tap.
  const preview = page.locator('[data-slot="character-preview"] svg[data-mark]').first();
  await expect(preview).toHaveAttribute("data-still", "");
  await moves.click();
  await expect(moves).toHaveAttribute("aria-checked", "true");
  // The tap scrolled the preview off screen, where the page holds its marks; bring it back.
  await preview.scrollIntoViewIfNeeded();
  await expect(preview).not.toHaveAttribute("data-still", "");
});
