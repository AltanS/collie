import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { MARK_DRIFT } from "@/components/mark-contract";
import { en } from "@/lib/i18n/messages/en";
import { MARKS } from "@/lib/mark-ids";
import type { AgentView, PaneChatResponse, SnapshotResponse } from "@/lib/types";
import { FIXTURE_CHAT_GEN, FIXTURE_SEQ_BASE, fixtureAgents, fixtureShellPanes, fixtureSnapshot, fixtureTranscript } from "@/test/handlers";
import { installApiStub, installPaneWorld, paneCapture, pinLocale } from "./fixtures/api";
import { collieHalves } from "./fixtures/collie-theme";
import { DESIGN_KEY, STILL_MARK } from "./fixtures/still-mark";

// ISSUE 748, ADR 0138: AN APP THAT IS LEFT ALONE ASKS FOR NO FRAME. Three claims only an engine can check,
// because jsdom runs no CSS animation: the header mark holds still at rest for every character, a
// dashboard at rest runs no animation anywhere, and a hidden page pauses the ones a working pane runs.
// Since 2026-11-09 the resting mark drifts again, smooth; since the owner's order of 2026-11-13 it drifts
// at all times while the page is visible, unless the device's own switch ("Character moves") or the worn
// theme says still. So the first two claims hold for a device with the switch OFF, which is how every case
// of this tier runs (`fixtures/still-mark.ts`): the mark is held from the first frame, every animation
// paused. `mark-moves.spec.ts` holds the other half, the switch on. The cases still fake the clock and let
// the old window pass, so a mark that drifted on a timer would show here.

test.use({ serviceWorkers: "block" });

// A RESTING MARK LEFT ALONE RUNS NO ANIMATION, FOR EVERY CHARACTER. The header mark used to drift at
// rest, one turn in 48 seconds, as a running animation, for as long as the app was open. Slow is not cheap: a running animation asks for a new frame 60 times a second
// whatever its pace, so the browser drew frames for as long as the app was open. On one Android phone
// that drove Chrome's GPU process past the system's file limit, and the system killed Chrome.
//
// jsdom runs no CSS animation, so only an engine can say that none is running: the conformance suite
// (src/test/mark-conformance.tsx) holds the contract's attributes, this holds what the browser does
// with them. Each case wears a theme that names one character and reads the header mark's own
// animations, every one of its parts included.

/** Let the page sit untouched past the drift's window and its ease. */
const LEFT_ALONE_MS = MARK_DRIFT.windowMs + MARK_DRIFT.easeMs + 1000;

/** The play states of every animation in the mark. */
function playStatesIn(mark: Locator): Promise<string[]> {
  return mark.evaluate((svg) => svg.getAnimations({ subtree: true }).map((a) => a.playState));
}

/** The names of the animations running anywhere in the mark. */
function runningIn(mark: Locator): Promise<string[]> {
  return mark.evaluate((svg) =>
    svg
      .getAnimations({ subtree: true })
      .filter((a) => a.playState === "running")
      .map((a) => ("animationName" in a ? String(a.animationName) : "transition")),
  );
}

for (const { id } of MARKS) {
  test(`the ${id} mark runs no animation at rest once the page is left alone`, async ({ page }) => {
    const theme = { version: 4, id: `mark-${id}`, name: `Mark ${id}`, light: collieHalves.light, dark: collieHalves.dark, character: id };
    await page.addInitScript(
      ([design, library]) => {
        localStorage.setItem("collie:design:v1", design);
        localStorage.setItem("collie:themes:v1", library);
      },
      [JSON.stringify({ ...STILL_MARK, theme: theme.id }), JSON.stringify({ version: 1, themes: [theme] })] as const,
    );
    await page.clock.install();
    await installApiStub(page);
    await page.goto("/");
    const mark = page.getByRole("button", { name: en["nav.home.aria.default"] }).locator(`svg[data-mark="${id}"]`);
    await expect(mark).toHaveAttribute("data-state", "rest");
    // The load itself may turn the mark (a route loader is work the operator waits on). The switch is off,
    // so the mark rests from the first frame: every animation is there, every one paused.
    await page.clock.runFor(LEFT_ALONE_MS);
    await expect(mark).toHaveAttribute("data-still", "", { timeout: 5000 });
    await expect.poll(() => runningIn(mark)).toEqual([]);
    const states = await playStatesIn(mark);
    expect(states.length).toBeGreaterThan(0);
    expect(new Set(states)).toEqual(new Set(["paused"]));
  });
}

// THE FRAME BUDGET OF A MARK THAT MOVES (ADR 0138, amendment 2026-11-13). The owner wants the character to
// drift at all times, so a resting dashboard with the DEFAULT setting is not a page that draws nothing. What
// the rule keeps is a bound: the drift is drawn in steps (`.mark-steps`, index.css), about 12 a second, and an
// engine counts them. A smooth drift is 60 frames a second for as long as the page is visible, which is what
// took Chrome's GPU process down on one phone (issue 748). Counted as experiments/fix-748/measure/run.ts counts
// them: a Chromium trace of a settled page, `DrawFrame` for a frame, `BeginMainThreadFrame` for a frame
// the main thread took part in, `Paint` for a paint. Measured on 2026-11-13, headless Chromium, 10 s, 3 runs:
// switch off 0 / 0 / 0, stepped about 127 / 3 / 6, smooth 601 / 3 / 6 (frames, main-thread frames, paints).
const TRACE_CATEGORIES = ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "cc", "viz", "blink", "gpu", "benchmark"];
const TRACE_SECONDS = 6;

interface Counts {
  frames: number;
  mainThreadFrames: number;
  paints: number;
}

/** Trace the page for TRACE_SECONDS, once it has settled, and count what the engine drew. */
async function trace(browser: Browser, page: Page): Promise<Counts> {
  await page.waitForTimeout(2000);
  await browser.startTracing(page, { categories: TRACE_CATEGORIES });
  await page.waitForTimeout(TRACE_SECONDS * 1000);
  const buffer = await browser.stopTracing();
  const events: { name: string }[] = JSON.parse(buffer.toString("utf8")).traceEvents;
  const count = (name: string) => events.filter((event) => event.name === name).length;
  return { frames: count("DrawFrame"), mainThreadFrames: count("BeginMainThreadFrame"), paints: count("Paint") };
}

async function openDashboard(page: Page, design: Readonly<Record<string, boolean>>): Promise<void> {
  await pinLocale(page, "en");
  await page.addInitScript(([key, blob]) => localStorage.setItem(key, blob), [DESIGN_KEY, JSON.stringify(design)] as const);
  await installApiStub(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: en["nav.home.aria.default"] }).locator("svg[data-mark]")).toHaveAttribute("data-state", "rest");
}

test("a resting dashboard whose mark drifts draws at most 16 frames a second, and takes the main thread for next to none", async ({ page, browser, browserName }, testInfo) => {
  test.skip(browserName !== "chromium" || testInfo.project.name !== "app-phone", "a Chromium trace; one phone project is enough");
  await openDashboard(page, {});
  const mark = page.getByRole("button", { name: en["nav.home.aria.default"] }).locator("svg[data-mark]");
  await expect(mark).not.toHaveAttribute("data-still", "");
  const counts = await trace(browser, page);
  // Stepped: about 12.7 a second (76 here). Smooth would be 60 a second (360 here), which fails.
  expect(counts.frames).toBeLessThanOrEqual(16 * TRACE_SECONDS);
  // The near/far swaps of the beads are a paint each; the orbit itself is on the compositor.
  expect(counts.mainThreadFrames).toBeLessThanOrEqual(10);
  expect(counts.paints).toBeLessThanOrEqual(15);
});

test("a resting dashboard whose switch is off draws no frame at all", async ({ page, browser, browserName }, testInfo) => {
  test.skip(browserName !== "chromium" || testInfo.project.name !== "app-phone", "a Chromium trace; one phone project is enough");
  await openDashboard(page, STILL_MARK);
  const counts = await trace(browser, page);
  expect(counts).toEqual({ frames: 0, mainThreadFrames: 0, paints: 0 });
});

/** The names of the animations running anywhere in the document. */
function runningOnPage(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.playState === "running")
      .map((a) => ("animationName" in a ? String(a.animationName) : "transition")),
  );
}

test("a dashboard at rest runs no animation at all", async ({ page }) => {
  await pinLocale(page, "en");
  await page.clock.install();
  await installApiStub(page);
  await page.goto("/");
  const mark = page.getByRole("button", { name: en["nav.home.aria.default"] }).locator("svg[data-mark]");
  await page.clock.runFor(LEFT_ALONE_MS);
  await expect(mark).toHaveAttribute("data-still", "", { timeout: 5000 });
  await expect.poll(() => runningOnPage(page)).toEqual([]);
});

// A WORKING PANE, the one world in the default fixtures where an animation runs for as long as the
// agent works: the watched pane's status dot turns. Built as experiments/fix-748/measure/run.ts builds it.
const PANE_ID = fixtureAgents[0]?.paneId ?? "";

const working: SnapshotResponse = {
  ...fixtureSnapshot,
  agents: fixtureAgents.map((agent, i): AgentView =>
    i === 0
      ? Object.assign({}, agent, {
          agent: "claude",
          status: "working",
          hasSession: true,
          sendProtocol: true,
          surface: { revision: 1, turn: "running", modal: "none", composer: "empty" },
        } as const)
      : Object.assign({}, agent, { status: "idle" } as const),
  ),
  shellPanes: fixtureShellPanes,
};

const chat: PaneChatResponse = {
  paneId: PANE_ID,
  available: true,
  page: "live",
  gen: FIXTURE_CHAT_GEN,
  rev: 1,
  head: FIXTURE_SEQ_BASE + fixtureTranscript.length - 1,
  oldest: FIXTURE_SEQ_BASE,
  hasOlder: false,
  upserts: fixtureTranscript.map((entry, i) => Object.assign({}, entry, { seq: FIXTURE_SEQ_BASE + i })),
};

/** Say the page is hidden, the way the browser does. Playwright keeps every page visible, so the case
 *  overrides the two readings and fires the event (no real hide was found that headless honours). */
function hide(page: Page, hidden: boolean): Promise<void> {
  return page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (value ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test("a hidden page pauses every animation, and a visible one runs them again", async ({ page }) => {
  await pinLocale(page, "en");
  await installApiStub(page);
  await installPaneWorld(page, {
    paneId: PANE_ID,
    snapshot: working,
    chat,
    screens: { working: paneCapture("claude--v2-1-310-working-echo-one-line--w120") },
    start: "working",
  });
  await page.goto(`/pane/${encodeURIComponent(PANE_ID)}`);
  await expect.poll(async () => (await runningOnPage(page)).length).toBeGreaterThan(0);

  await hide(page, true);
  await expect.poll(() => runningOnPage(page)).toEqual([]);

  await hide(page, false);
  await expect.poll(async () => (await runningOnPage(page)).length).toBeGreaterThan(0);
});
