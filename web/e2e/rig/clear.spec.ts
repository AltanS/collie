// Clear in the browser leg (ADR 0116, the Clear paragraph, case 28), on the pi session the run started.
// A word sits in pi's box, typed outside the phone (the keys route, as case 22 types one) and never sent.
// The Surface reads `draft`, so the Keys board's Clear button is enabled. One tap posts one clear request,
// the bridge presses pi's clear key as a person's tap, the receipt says `cleared`, the notice "Box
// cleared." shows under the box, and the box reads free within 5 s. No prompt is sent: ZERO model turns.
//
// pi needs a provider key (COLLIE_RIG_KEY_FILE) to start; without one the case reports "not reached".
import { NotReached, capture, captureScreen, expect, message, openSession, phoneOn, runScenario, tap, tapWords, test, waitIdle, type Session } from "./leg";
import { sleep } from "./rig-lib";
import { PHONE } from "./walky-lib";

const H = "pi" as const;
const session: Session = { paneId: null, startNote: "not started" };

/** The draft: one word of letters, easy to find on the screen and needing no space key. */
const DRAFT = "cleardraftword";

test.describe("clear on pi", () => {
  test.beforeAll(async () => {
    Object.assign(session, await openSession(H));
  });

  test("28 Clear a pi draft from the Keys board: one tap, the receipt says cleared, the box reads free", async ({ browser, rig }) => {
    await runScenario(H, "clear-pi", session, async (pane, trail) => {
      const { context, page, recorder } = await phoneOn(browser, rig, pane, PHONE);
      const log = trail.log;
      const notes = trail.notes;
      try {
        // The draft is typed outside the phone and never sent: no model turn.
        await rig.keys(pane, [...DRAFT]);
        const drafted = await rig.until(() => rig.pane(pane), (p) => p?.surface?.composer === "draft", 8000);
        if (drafted === null) throw new NotReached("the draft did not show in pi's box");
        notes.push("the Surface reads a draft");

        // The Keys board: its toggle is local (no request). Clear is enabled once the phone's own read shows the draft.
        const keys = page.getByRole("group", { name: "Controls" }).getByRole("button", { name: message("composer.controls.keys"), exact: true });
        log.push(await tap(recorder, keys, "open the Keys board", { expectAnswer: false }));
        const clear = page.locator("[data-slot='keys-clear']");
        const enabled = await expect(clear)
          .toBeEnabled({ timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        notes.push(`Clear is ${enabled ? "enabled" : "NOT enabled"} over the draft`);
        if (!enabled) {
          trail.captures.push(await capture(page, "clear-28-not-enabled"), await captureScreen(rig, pane, "clear-28-not-enabled"));
          return { verdict: "fail", taps: log.length, minTaps: 2, note: notes.join("; "), taps_log: log, captures: trail.captures };
        }

        // One tap, one request, one receipt.
        const t = await tap(recorder, clear, "Clear");
        log.push(t);
        const posts = t.answers.filter((answer) => answer.path.endsWith("/clear"));
        const receipt = posts[0]?.outcome ?? "no /clear answer";
        notes.push(`${tapWords(t)}; ${String(posts.length)} clear request${posts.length === 1 ? "" : "s"}; receipt ${receipt}`);
        const tappedAt = Date.now();
        const notice = await page
          .getByText(message("keys.clear.receipt.cleared"), { exact: true })
          .first()
          .waitFor({ state: "visible", timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        const free = await waitIdle(rig, pane, 5000);
        const gone = !(await rig.screen(pane, 80)).includes(DRAFT);
        notes.push(`the notice ${notice ? "says Box cleared." : "NEVER showed"}, the box ${free ? "reads free" : "is NOT free"} ${String(Math.round((Date.now() - tappedAt) / 1000))} s after the tap, the draft ${gone ? "is gone" : "IS STILL ON THE SCREEN"}`);
        await sleep(300);
        trail.captures.push(await capture(page, "clear-28-cleared"), await captureScreen(rig, pane, "clear-28-cleared"));
        const verdict = t.worked && posts.length === 1 && receipt === "cleared" && notice && free && gone && log.length === 2 ? "pass" : "fail";
        return { verdict, taps: log.length, minTaps: 2, note: notes.join("; "), taps_log: log, captures: trail.captures };
      } finally {
        await context.close();
      }
    });
  });
});
