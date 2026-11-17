// The chaos leg on the solo rig (M102 spec 15, decision 3; chaos-lib.ts has the rules). Run it alone:
//
//     cd web && bunx playwright test -c e2e/rig/chaos.config.ts
//
// No model turn: every case sends `echo ...` into a shell pane. The cases whose world needs a seam the
// rig lacks are skipped and name the seam (CHAOS_CASES in chaos-lib.ts).
import { Rig, phoneOn, test } from "./leg";
import { accountedFor, appendedTo, screenNote, arrivals, chaosCase, chaosLine, phoneWords, recordChaos, restartLeadBridge, sendLine, sendLive, settled, shellPane, startLeadBridge, stopLeadBridge, type ChaosId } from "./chaos-lib";
import { muxOf, resizeDuring, sleep } from "./rig-lib";
import { PHONE } from "./walky-lib";

// One shell pane per case: a case that leaves text in a shell's input line (C1 does, when the bridge dies between the
// write and Enter) must not turn the next case's lines into one long command.
const panes = new Map<string, string>();
async function chaosPane(rig: Rig, label: string): Promise<string> {
  const kept = panes.get(label);
  if (kept !== undefined) return kept;
  const made = await shellPane(rig, "lead", undefined, `solo-${label}`);
  panes.set(label, made);
  return made;
}

/** The rig's bridge lists the pane again (after a restart); throws when it never does. */
async function paneListed(rig: Rig, paneId: string): Promise<void> {
  const seen = await rig.until(() => rig.pane(paneId), (row) => row !== null, 60_000, 700);
  if (seen === null) throw new Error(`the bridge never listed the chaos shell pane ${paneId} after its restart`);
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
  seamCase("background-job");

  test(chaosCase("bridge-dies-mid-send").title, async ({ browser, rig }) => {
    const paneId = await chaosPane(rig, "c1");
    const { context, page, recorder } = await phoneOn(browser, rig, paneId, PHONE);
    const notes: string[] = [];
    try {
      const line = chaosLine("bridge-dies-mid-send", 1);
      // The tap leaves; the lead's bridge is killed (SIGKILL, a crash) while the request is in flight, then comes back.
      const sending = sendLine(page, recorder, line, "Send while the bridge dies");
      await sleep(150);
      stopLeadBridge(true);
      const tapLog = await sending;
      startLeadBridge();
      await paneListed(rig, paneId);
      const end = await settled(rig, page, paneId, undefined, line, 60_000);
      await sleep(1500);
      const count = arrivals(await rig.screen(paneId, 120).catch(() => ""), line);
      notes.push(`arrived ${String(count)}x`, `words "${end.words}"`, await screenNote(rig, paneId));
      // The input arrived once, or the phone said in words what became of it; never twice.
      let ok = accountedFor(count, end.words);
      // The person taps Send again, as the phone asks (M102 spec 16): the same request id after the restart
      // types nothing (`unknown`, `interrupted`), so text a crash left in the line never gets a second copy
      // or another line appended to it.
      // Only after a send that did not arrive: a tap after a send that arrived is a new input.
      const taps = [tapLog];
      if (count === 0) {
        taps.push(await sendLine(page, recorder, line, "Send again after the restart"));
        await sleep(1500);
        const after = await rig.screen(paneId, 120).catch(() => "");
        const again = arrivals(after, line);
        const appended = appendedTo(after, line);
        notes.push(`after Send again: arrived ${String(again)}x, words "${await phoneWords(page)}"${appended ? ", text appended to the line left in the input" : ""}`);
        ok = ok && again <= 1 && !appended;
      }
      const live = await sendLive(page);
      notes.push(live ? "Send is live again" : "Send stayed dead");
      const verdict = ok && live ? "pass" : "fail";
      if (verdict === "fail") notes.push(await screenNote(rig, paneId));
      recordChaos({ id: "bridge-dies-mid-send", verdict, note: notes.join("; "), taps });
      test.expect(verdict, notes.join("; ")).toBe("pass");
    } finally {
      startLeadBridge(); // a case that threw must not leave the rig without its bridge (a bridge that runs is left alone)
      await context.close();
    }
  });

  test(chaosCase("two-bridges-one-pane").title, async ({ browser, rig }) => {
    const second = Rig.second();
    if (second === null) {
      const why = "this rig runs without a second bridge (a rig kept by COLLIE_RIG_REUSE=1 was not started with `up --second-bridge`)";
      recordChaos({ id: "two-bridges-one-pane", verdict: "skipped", note: why });
      test.skip(true, why);
      return;
    }
    const paneId = await chaosPane(rig, "c3");
    const listed = await second.until(() => second.pane(paneId), (row) => row !== null, 30_000, 700);
    if (listed === null) throw new Error(`the second bridge never listed the chaos shell pane ${paneId}`);
    // One phone paired with each bridge, both on the one pane.
    const one = await phoneOn(browser, rig, paneId, PHONE);
    const two = await phoneOn(browser, second, paneId, PHONE);
    const notes: string[] = [];
    try {
      const lineOne = chaosLine("two-bridges-one-pane", 1);
      const lineTwo = chaosLine("two-bridges-one-pane", 2);
      // Both taps leave at the same moment, each through its own bridge: two request ids, two send locks, one terminal.
      const [tapOne, tapTwo] = await Promise.all([sendLine(one.page, one.recorder, lineOne, "bridge one: Send"), sendLine(two.page, two.recorder, lineTwo, "bridge two: Send")]);
      const endOne = await settled(rig, one.page, paneId, undefined, lineOne, 25_000);
      const endTwo = await settled(second, two.page, paneId, undefined, lineTwo, 25_000);
      await sleep(1500);
      const screen = await rig.screen(paneId, 120);
      const countOne = arrivals(screen, lineOne);
      const countTwo = arrivals(screen, lineTwo);
      notes.push(`bridge one: arrived ${String(countOne)}x, words "${endOne.words}"`, `bridge two: arrived ${String(countTwo)}x, words "${endTwo.words}"`);
      // Each input arrived at most once, and an input that did not arrive has words on the phone that sent it.
      const ok = accountedFor(countOne, endOne.words) && accountedFor(countTwo, endTwo.words);
      const live = (await sendLive(one.page)) && (await sendLive(two.page));
      notes.push(live ? "both Send buttons are live again" : "a Send button stayed dead");
      const verdict = ok && live ? "pass" : "fail";
      if (verdict === "fail") notes.push(await screenNote(rig, paneId));
      recordChaos({ id: "two-bridges-one-pane", verdict, note: notes.join("; "), taps: [tapOne, tapTwo] });
      test.expect(verdict, notes.join("; ")).toBe("pass");
    } finally {
      await one.context.close();
      await two.context.close();
    }
  });

  test(chaosCase("resize-mid-send").title, async ({ browser, rig }) => {
    if (muxOf("lead") !== "herdr") {
      const why = "the rig knows a split and pane.resize on Herdr only (rig-lib.ts resizeDuring), not on the core";
      recordChaos({ id: "resize-mid-send", verdict: "skipped", note: why });
      test.skip(true, why);
      return;
    }
    const paneId = await chaosPane(rig, "c4");
    const { context, page, recorder } = await phoneOn(browser, rig, paneId, PHONE);
    const notes: string[] = [];
    try {
      const line = chaosLine("resize-mid-send", 1);
      // A split beside the pane, whose edge moves left and right while the tap leaves and the send runs.
      const ran = await resizeDuring(paneId, () => sendLine(page, recorder, line, "Send while the pane resizes"));
      notes.push(`${String(ran.resizes)} resize steps, ${String(ran.moved)} moved the split`);
      const end = await settled(rig, page, paneId, undefined, line, 25_000);
      await sleep(1500);
      const count = arrivals(await rig.screen(paneId, 120).catch(() => ""), line);
      notes.push(`arrived ${String(count)}x`, `words "${end.words}"`);
      const ok = ran.resizes > 0 && accountedFor(count, end.words);
      const live = await sendLive(page);
      notes.push(live ? "Send is live again" : "Send stayed dead");
      const verdict = ok && live ? "pass" : "fail";
      if (verdict === "fail") notes.push(await screenNote(rig, paneId));
      recordChaos({ id: "resize-mid-send", verdict, note: notes.join("; "), taps: [ran.result] });
      test.expect(verdict, notes.join("; ")).toBe("pass");
    } finally {
      await context.close();
    }
  });

  test(chaosCase("slow-mux").title, async ({ browser, rig }) => {
    if (muxOf("lead") !== "herdr") {
      const why = "the delay proxy sits on Herdr's API socket (rig.ts bridge start --slow-mux); the core has no such seam";
      recordChaos({ id: "slow-mux", verdict: "skipped", note: why });
      test.skip(true, why);
      return;
    }
    const paneId = await chaosPane(rig, "c6");
    // The lead's bridge dials Herdr through a proxy that holds every call (and every answer) for SLOW_MS.
    const SLOW_MS = 500;
    restartLeadBridge(false, SLOW_MS);
    const notes: string[] = [`every Herdr call waits ${String(SLOW_MS)} ms each way`];
    let context: Awaited<ReturnType<typeof phoneOn>>["context"] | null = null;
    try {
      await paneListed(rig, paneId);
      const phone = await phoneOn(browser, rig, paneId, PHONE);
      context = phone.context;
      const line = chaosLine("slow-mux", 1);
      const tapLog = await sendLine(phone.page, phone.recorder, line, "Send through the slow multiplexer");
      const end = await settled(rig, phone.page, paneId, undefined, line, 60_000);
      await sleep(1500);
      const count = arrivals(await rig.screen(paneId, 120).catch(() => ""), line);
      notes.push(`arrived ${String(count)}x`, `words "${end.words}"`);
      const ok = accountedFor(count, end.words);
      const live = await sendLive(phone.page);
      notes.push(live ? "Send is live again" : "Send stayed dead");
      const verdict = ok && live ? "pass" : "fail";
      if (verdict === "fail") notes.push(await screenNote(rig, paneId));
      recordChaos({ id: "slow-mux", verdict, note: notes.join("; "), taps: [tapLog] });
      test.expect(verdict, notes.join("; ")).toBe("pass");
    } finally {
      await context?.close();
      restartLeadBridge(false); // back on the real socket, for the cases after this one
      await paneListed(rig, paneId).catch(() => undefined);
    }
  });

  test(chaosCase("second-phone").title, async ({ browser, rig }) => {
    const paneId = await chaosPane(rig, "c5");
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
      if (verdict === "fail") notes.push(await screenNote(rig, paneId));
      recordChaos({ id: "second-phone", verdict, note: notes.join("; "), taps: [tapOne, tapTwo] });
      test.expect(verdict, notes.join("; ")).toBe("pass");
    } finally {
      await one.context.close();
      await two.context.close();
    }
  });

  test("C0 a plain send arrives once (the control case for the chaos cases)", async ({ browser, rig }) => {
    const paneId = await chaosPane(rig, "c0");
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
