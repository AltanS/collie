// The chaos leg on the solo rig (M102 spec 15, decision 3; chaos-lib.ts has the rules). Run it alone:
//
//     cd web && bunx playwright test -c e2e/rig/chaos.config.ts
//
// No model turn: every case sends `echo ...` into a shell pane. The cases whose world needs a seam the
// rig lacks are skipped and name the seam (CHAOS_CASES in chaos-lib.ts).
import { phoneOn, test, type Rig } from "./leg";
import { arrivals, chaosCase, chaosLine, phoneWords, recordChaos, sendLine, sendLive, settled, shellPane, type ChaosId } from "./chaos-lib";
import { sleep } from "./rig-lib";
import { PHONE } from "./walky-lib";

let pane: string | null = null;
async function chaosPane(rig: Rig): Promise<string> {
  if (pane === null) pane = await shellPane(rig, "lead", undefined, "solo");
  return pane;
}

/** A case that waits for a seam: skipped, with a ledger row that names the seam. */
function seamCase(id: ChaosId): void {
  const c = chaosCase(id);
  test(c.title, () => {
    recordChaos({ id, verdict: "skipped", note: `needs a seam: ${c.seam ?? "-"}` });
    test.skip(true, c.seam ?? "needs a seam");
  });
}

test.describe("chaos on the solo rig", () => {
  seamCase("bridge-dies-mid-send");
  seamCase("two-bridges-one-pane");
  seamCase("resize-mid-send");
  seamCase("slow-mux");
  seamCase("background-job");

  test(chaosCase("second-phone").title, async ({ browser, rig }) => {
    const paneId = await chaosPane(rig);
    const one = await phoneOn(browser, rig, paneId, PHONE);
    const two = await phoneOn(browser, rig, paneId, PHONE);
    const notes: string[] = [];
    try {
      const lineOne = chaosLine("second-phone", 1);
      const lineTwo = chaosLine("second-phone", 2);
      // Both taps leave at the same moment: two request ids, two inputs.
      const [tapOne, tapTwo] = await Promise.all([sendLine(one.page, one.recorder, lineOne, "phone one: Send"), sendLine(two.page, two.recorder, lineTwo, "phone two: Send")]);
      const endOne = await settled(rig, one.page, paneId, undefined, lineOne, 25_000);
      const endTwo = await settled(rig, two.page, paneId, undefined, lineTwo, 25_000);
      await sleep(1500);
      const screen = await rig.screen(paneId, 120);
      const countOne = arrivals(screen, lineOne);
      const countTwo = arrivals(screen, lineTwo);
      notes.push(`phone one: arrived ${String(countOne)}x, words "${endOne.words}"`, `phone two: arrived ${String(countTwo)}x, words "${endTwo.words}"`);
      // Each input arrived at most once, and an input that did not arrive has words on its own phone.
      const okOne = countOne <= 1 && (countOne === 1 || endOne.words !== "");
      const okTwo = countTwo <= 1 && (countTwo === 1 || endTwo.words !== "");
      const live = (await sendLive(one.page)) && (await sendLive(two.page));
      notes.push(live ? "both Send buttons are live again" : "a Send button stayed dead");
      const verdict = okOne && okTwo && live ? "pass" : "fail";
      recordChaos({ id: "second-phone", verdict, note: notes.join("; "), taps: [tapOne, tapTwo] });
      test.expect(verdict, notes.join("; ")).toBe("pass");
    } finally {
      await one.context.close();
      await two.context.close();
    }
  });

  test("C0 a plain send arrives once (the control case for the chaos cases)", async ({ browser, rig }) => {
    const paneId = await chaosPane(rig);
    const { context, page, recorder } = await phoneOn(browser, rig, paneId, PHONE);
    try {
      const line = chaosLine("second-phone", 0);
      await sendLine(page, recorder, line, "Send");
      const end = await settled(rig, page, paneId, undefined, line, 20_000);
      test.expect(end.arrived, `words "${await phoneWords(page)}"`).toBe(1);
    } finally {
      await context.close();
    }
  });
});
