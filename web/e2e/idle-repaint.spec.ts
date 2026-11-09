import { expect, test, type Locator, type Page } from "@playwright/test";

import { MARK_DRIFT } from "@/components/mark-contract";
import { en } from "@/lib/i18n/messages/en";
import { MARKS } from "@/lib/mark-ids";
import type { AgentView, PaneChatResponse, SnapshotResponse } from "@/lib/types";
import { FIXTURE_CHAT_GEN, FIXTURE_SEQ_BASE, fixtureAgents, fixtureShellPanes, fixtureSnapshot, fixtureTranscript } from "@/test/handlers";
import { installApiStub, installPaneWorld, paneCapture, pinLocale } from "./fixtures/api";
import { collieHalves } from "./fixtures/collie-theme";

// ISSUE 748, ADR 0138: AN APP THAT IS LEFT ALONE ASKS FOR NO FRAME. Three claims only an engine can check,
// because jsdom runs no CSS animation: the header mark holds still at rest for every character, a
// dashboard at rest runs no animation anywhere, and a hidden page pauses the ones a working pane runs.
// Since 2026-11-09 the resting mark drifts again, smooth, while the page is in use: a person touched,
// scrolled or typed in the last MARK_DRIFT.windowMs. Then it eases to a stop and holds (`data-still`),
// every animation paused. The cases fake the clock and let that window pass, so the claims below hold
// for a page left alone, which is the page issue 748 is about.

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
      [JSON.stringify({ theme: theme.id }), JSON.stringify({ version: 1, themes: [theme] })] as const,
    );
    await page.clock.install();
    await installApiStub(page);
    await page.goto("/");
    const mark = page.getByRole("button", { name: en["nav.home.aria.default"] }).locator(`svg[data-mark="${id}"]`);
    await expect(mark).toHaveAttribute("data-state", "rest");
    // The load itself may turn the mark (a route loader is work the operator waits on). Then the drift
    // runs while the page counts as in use, eases, and holds: every animation is there, every one paused.
    await page.clock.runFor(LEFT_ALONE_MS);
    await expect(mark).toHaveAttribute("data-still", "", { timeout: 5000 });
    await expect.poll(() => runningIn(mark)).toEqual([]);
    const states = await playStatesIn(mark);
    expect(states.length).toBeGreaterThan(0);
    expect(new Set(states)).toEqual(new Set(["paused"]));
  });
}

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
