// A steer from the phone (M69), on the Claude-free harnesses whose profile has a steer key. One case,
// judged by the bridge's receipt AND by what the phone and the pane show, every tap on the first try:
//
//   26 steer while working (pi): a long turn runs (a bash call that counts to 40 over 40 s). The
//      operator types a line, holds Send and taps the Steer row. The receipt says `steered`, the phone
//      says "Steered: the agent takes it after its current step." within 5 s, and the turn still runs
//      right after (a steer is taken after the current tool call, in the same turn, never by
//      interrupting it). The plain tap and its queue stay case 16's and the unit suites' business.
//
//   27 steer while working (Codex) is the same case on Codex, with the profile's `steerDelayMs` (1000)
//      added to the time the receipt may take. The helper below takes that pause. The case itself
//      waits for a Codex harness in this rig: harnesses.ts starts claude, pi and omp only.
import type { Browser } from "@playwright/test";

import type { HarnessId } from "./harnesses";
import {
  NotReached,
  Rig,
  capture,
  captureScreen,
  hold,
  message,
  openSession,
  phoneOn,
  runScenario,
  sendFromComposer,
  spendTurn,
  tap,
  tapWords,
  test,
  waitIdle,
  type ScenarioResult,
  type Session,
  type Trail,
} from "./leg";
import { sleep } from "./rig-lib";
import { PHONE, REPLY_MS } from "./walky-lib";

/** What a steer case needs from its harness. */
interface SteerCase {
  readonly harness: HarnessId;
  /** The case's number in the table, for the capture names. */
  readonly tag: string;
  /** The profile's `keys.steerDelayMs`: the pause before the steer key, added to the receipt's window. */
  readonly steerDelayMs: number;
  /** A row of the harness's screen that shows the long call runs (the count's first lines). */
  readonly running: RegExp;
  /** The line the operator steers with. */
  readonly line: string;
}

/** The long turn: one bash call that counts for 40 s, the same one the capture lab used (2026-10-23). */
const LONG_TURN = "Run this exact bash command with your bash tool, then say done: for i in $(seq 1 40); do echo $i; sleep 1; done";

/** How long the phone may take to say "Steered", from the tap, beside the profile's own pause. */
const NOTICE_MS = 5000;

/** Whether the agent's turn runs now, by the Surface when the harness has one, else by Herdr's status. */
async function turnRuns(rig: Rig, pane: string): Promise<boolean> {
  const found = await rig.pane(pane).catch(() => null);
  if (found === null) return false;
  return found.surface === null ? found.status === "working" : found.surface.turn === "running";
}

async function steerWhileWorking(browser: Browser, rig: Rig, pane: string, trail: Trail, c: SteerCase): Promise<ScenarioResult> {
  spendTurn(c.harness, "steer while working: the long turn and the steered line");
  const { context, page, recorder } = await phoneOn(browser, rig, pane, PHONE);
  const log = trail.log;
  const notes = trail.notes;
  try {
    log.push(await sendFromComposer(page, recorder, LONG_TURN, "send the long turn"));
    if ((await rig.screenUntil(pane, c.running, 90_000, 120)) === null) {
      trail.captures.push(await captureScreen(rig, pane, `steer-${c.tag}-no-run`));
      throw new NotReached("the long turn never showed its count");
    }
    await sleep(3000);
    const before = await turnRuns(rig, pane);

    // The hold opens the menu; the Steer row is in it only while the turn runs and the pane says canSteer.
    await page.getByRole("textbox").last().fill(c.line);
    const send = page.getByRole("button", { name: message("composer.send.sendAria"), exact: true });
    log.push(await hold(page, send, "hold Send"));
    const row = page.getByRole("button", { name: message("composer.steer.row"), exact: true });
    const menu = await row
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!menu) {
      trail.captures.push(await capture(page, `steer-${c.tag}-no-row`));
      return { verdict: "fail", taps: log.length, minTaps: 3, note: `the hold on Send opened no Steer row (turn ${before ? "running" : "not running"} at the hold)`, taps_log: log, captures: trail.captures };
    }
    const t = await tap(recorder, row, "Steer", { answerMs: 10_000 + c.steerDelayMs });
    log.push(t);
    const send200 = t.answers.find((a) => a.path === "/api/send");
    const receipt = send200?.outcome ?? "no /api/send answer";
    notes.push(`${tapWords(t)}; receipt ${receipt}`);

    // The phone's own words, from the tap on: the notice is the status line a verified steer leaves.
    const notice = page.getByText(message("sendReceipts.outcome.steered"), {}).first();
    const shown = await notice
      .waitFor({ state: "visible", timeout: NOTICE_MS + c.steerDelayMs })
      .then(() => true)
      .catch(() => false);
    notes.push(shown ? "the phone said Steered" : "the phone never said Steered");

    // A steer is taken after the current tool call, in the same turn: it must not have ended it.
    const stillRunning = await turnRuns(rig, pane);
    notes.push(stillRunning ? "the turn still runs right after" : "the turn was OVER right after the steer");
    trail.captures.push(await capture(page, `steer-${c.tag}`), await captureScreen(rig, pane, `steer-${c.tag}`));

    // Leave the pane free for the next case: the call ends at 40 s, the agent answers the line, the turn ends.
    await waitIdle(rig, pane, REPLY_MS);
    const screen = await rig.screen(pane, 300);
    notes.push(/hello/i.test(screen.slice(screen.lastIndexOf(c.line.slice(0, 12)))) ? "the agent answered the line" : "no answer to the line on screen (not judged)");
    const verdict = before && t.worked && receipt === "steered" && shown && stillRunning ? "pass" : "fail";
    return { verdict, taps: log.length, minTaps: 3, note: notes.join("; "), taps_log: log, captures: trail.captures };
  } finally {
    await context.close();
  }
}

const piSession: Session = { paneId: null, startNote: "not started" };

test.describe("steer", () => {
  test.beforeAll(async () => {
    Object.assign(piSession, await openSession("pi"));
  });

  test("26 steer while working (pi): hold Send, tap Steer, the receipt says steered and the turn runs on", async ({ browser, rig }) => {
    await runScenario("pi", "steer", piSession, (pane, trail) => steerWhileWorking(browser, rig, pane, trail, { harness: "pi", tag: "26-pi", steerDelayMs: 0, running: /^\s*[1-9]\s*$/m, line: "also say hello at the end" }));
  });
});
