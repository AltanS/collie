// Stop in the browser leg (M68 spec 03, case 25, ADR 0116), on the pi session the run started. A long
// numbered list streams, so the turn runs for tens of seconds. Before the turn the belt already shows Stop,
// dimmed (aria-disabled="true"); once the turn runs it is live. The first tap
// only arms it ("Stop?", no request). The second tap posts the abort, the bridge presses pi's interrupt
// key as a person's tap, and the receipt says `stopped`. The notice "Stopped." shows under the box and
// the box reads free within 5 s. One model turn.
//
// pi needs a provider key (COLLIE_RIG_KEY_FILE); without one the case reports "not reached".
import { capture, captureScreen, message, openSession, phoneOn, runScenario, sendFromComposer, spendTurn, tap, tapWords, test, waitIdle, type Session } from "./leg";
import { sleep } from "./rig-lib";
import { PHONE, turnRuns } from "./walky-lib";

const H = "pi" as const;
const session: Session = { paneId: null, startNote: "not started" };

/** Long enough to run about 40 s on pi, so the Stop lands in the middle of the list. */
const ITEMS = 180;

test.describe("stop on pi", () => {
  test.beforeAll(async () => {
    Object.assign(session, await openSession(H));
  });

  test("25 Stop a running pi turn: the first tap arms, the second stops, the receipt says Stopped", async ({ browser, rig }) => {
    await runScenario(H, "stop-pi", session, async (pane, trail) => {
      spendTurn(H, "stop: the long reply");
      const { context, page, recorder } = await phoneOn(browser, rig, pane, PHONE);
      const log = trail.log;
      const notes = trail.notes;
      try {
        // Stop is always drawn for a pane whose profile names an interrupt key: dimmed while nothing runs.
        const stop = page.locator("[data-slot='belt-stop']");
        const dimBefore = await stop
          .waitFor({ state: "visible", timeout: 15_000 })
          .then(async () => (await stop.getAttribute("aria-disabled")) === "true")
          .catch(() => false);
        notes.push(dimBefore ? "Stop stands dimmed before the turn" : "Stop is NOT dimmed (or missing) before the turn");
        const prompt = `List ${String(ITEMS)} different fruits, one per line, numbered 1 to ${String(ITEMS)}, each with one sentence of about twenty words about its taste. Write the list as plain text in your reply and call no tool. No other text.`;
        log.push(await sendFromComposer(page, recorder, prompt, "send the long prompt"));
        const streaming = await rig.screenUntil(pane, /^\s*1[0-9]\.\s+\S/m, 60_000, 120);
        const running = streaming !== null && (await turnRuns(rig, pane));
        notes.push(running ? "the turn runs" : "the turn did not run at the tap");
        // Once the turn runs the same button is live: no aria-disabled.
        const shown = await page
          .locator("[data-slot='belt-stop']:not([aria-disabled='true'])")
          .waitFor({ state: "visible", timeout: 15_000 })
          .then(() => true)
          .catch(() => false);
        if (!running || !shown) {
          trail.captures.push(await capture(page, "stop-25-no-button"), await captureScreen(rig, pane, "stop-25-no-button"));
          return { verdict: "fail", taps: log.length, minTaps: 3, note: [...notes, shown ? "the belt shows a live Stop" : "the belt shows NO live Stop"].join("; "), taps_log: log, captures: trail.captures };
        }

        // The first tap arms. It posts nothing, and the button says "Stop?".
        const arm = await tap(recorder, stop, "arm Stop", { expectAnswer: false });
        log.push(arm);
        const armedAria = await stop.getAttribute("aria-label");
        const armed = armedAria === message("belt.stopArmedAria");
        notes.push(`${tapWords(arm)}; the button ${armed ? "reads Stop?" : "does NOT read Stop?"}`);

        // The second tap stops. One abort request, one receipt.
        const stopTap = await tap(recorder, stop, "Stop");
        log.push(stopTap);
        const answered = stopTap.answers.find((answer) => answer.path.endsWith("/abort"));
        notes.push(tapWords(stopTap));
        const stoppedAt = Date.now();
        const notice = await page
          .getByText(message("belt.stop.receipt.stopped"), { exact: true })
          .waitFor({ state: "visible", timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        const free = await waitIdle(rig, pane, 5000);
        notes.push(`the notice ${notice ? "says Stopped." : "NEVER showed"}, the box ${free ? "reads free" : "is NOT free"} ${String(Math.round((Date.now() - stoppedAt) / 1000))} s after the second tap`);
        await sleep(300);
        trail.captures.push(await capture(page, "stop-25-stopped"), await captureScreen(rig, pane, "stop-25-stopped"));
        const verdict = dimBefore && arm.answers.length === 0 && armed && stopTap.worked && answered?.outcome === "stopped" && notice && free && log.length === 3 ? "pass" : "fail";
        return { verdict, taps: log.length, minTaps: 3, note: notes.join("; "), taps_log: log, captures: trail.captures };
      } finally {
        await context.close();
      }
    });
  });
});
