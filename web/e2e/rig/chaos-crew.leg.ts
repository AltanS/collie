// The chaos leg on the crew rig (M102 spec 15, decision 3; chaos-lib.ts has the rules). Run it alone:
//
//     cd web && bunx playwright test -c e2e/rig/chaos-crew.config.ts
//
// No model turn: every case sends `echo ...` into a shell pane on the MEMBER, through the lead, from a
// phone paired with the lead. The member's bridge is stopped and started with the rig's own verbs.
import { hostOf, phoneOn, test, type Rig } from "./leg";
import { arrivals, screenNote, chaosCase, chaosLine, recordChaos, sendLine, sendLive, settled, shellPane, startMember, stopMember } from "./chaos-lib";
import { sleep } from "./rig-lib";
import { PHONE } from "./walky-lib";

const HOST = hostOf("member");

let pane: string | null = null;
async function memberPane(rig: Rig): Promise<string> {
  if (pane === null) pane = await shellPane(rig, "member", HOST, "crew");
  return pane;
}

test.describe("chaos on the crew rig", () => {
  test(chaosCase("member-dies-mid-send").title, async ({ browser, rig }) => {
    const paneId = await memberPane(rig);
    const { context, page, recorder } = await phoneOn(browser, rig, paneId, PHONE, HOST);
    const notes: string[] = [];
    try {
      const line = chaosLine("member-dies-mid-send", 1);
      // The tap leaves; the member's bridge stops while the request is in flight, then comes back.
      const sending = sendLine(page, recorder, line, "Send while the member stops");
      await sleep(150);
      stopMember();
      const tapLog = await sending;
      startMember();
      const end = await settled(rig, page, paneId, HOST, line, 60_000);
      await sleep(1500);
      const count = arrivals(await rig.screen(paneId, 120, HOST).catch(() => ""), line);
      notes.push(`arrived ${String(count)}x`, `words "${end.words}"`);
      // The input arrived once, or the phone said in words what became of it; never twice.
      const ok = count <= 1 && (count === 1 || end.words !== "");
      const live = await sendLive(page);
      notes.push(live ? "Send is live again" : "Send stayed dead");
      const verdict = ok && live ? "pass" : "fail";
      if (verdict === "fail") notes.push(await screenNote(rig, paneId, HOST));
      recordChaos({ id: "member-dies-mid-send", verdict, note: notes.join("; "), taps: [tapLog] });
      test.expect(verdict, notes.join("; ")).toBe("pass");
    } finally {
      await context.close();
    }
  });

  test(chaosCase("crew-link-drops").title, async ({ browser, rig }) => {
    const paneId = await memberPane(rig);
    const { context, page, recorder } = await phoneOn(browser, rig, paneId, PHONE, HOST);
    const notes: string[] = [];
    try {
      stopMember();
      const line = chaosLine("crew-link-drops", 1);
      const tapLog = await sendLine(page, recorder, line, "Send while the member is down");
      const end = await settled(rig, page, paneId, HOST, line, 25_000);
      notes.push(`words "${end.words}"`);
      const live = await sendLive(page);
      notes.push(live ? "Send is live again" : "Send stayed dead");
      startMember();
      await sleep(3000);
      const count = arrivals(await rig.screen(paneId, 120, HOST).catch(() => ""), line);
      notes.push(`arrived ${String(count)}x after the member came back`);
      // Nothing may arrive later by itself (Collie never sends again on its own), and the tap said why it did not go.
      const verdict = end.words !== "" && live && count === 0 ? "pass" : "fail";
      if (verdict === "fail") notes.push(await screenNote(rig, paneId, HOST));
      recordChaos({ id: "crew-link-drops", verdict, note: notes.join("; "), taps: [tapLog] });
      test.expect(verdict, notes.join("; ")).toBe("pass");
    } finally {
      await context.close();
    }
  });
});
