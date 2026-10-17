// Walky talky in the browser leg (M62): the operator's message from the phone, on Claude Code. One
// model turn, the pane's own reply. It reuses the Claude session claude.spec.ts started (the run's
// session file), so no second agent starts.
//
// What a person does: write a line, hold Send, tap "Send as message". What must follow, with the
// first hold and the first tap:
//   - the bridge takes the message (POST /api/walky answers a receipt that is not refused);
//   - the pane receives ONE prompt: the header `[walky-talky <id>] from operator (<device label>)`
//     with the body on the next row (header and body not split into two turns);
//   - the receipt settles at `delivered`;
//   - the phone's Chat draws the "Message from <device label>" card with the operator badge, from
//     the bridge's log, not from the printed header;
//   - Claude answers the body.
import { devices } from "@playwright/test";

import { asJsonObject, asJsonString } from "../../src/lib/json";
import {
  PHONE_DEVICE,
  capture,
  captureScreen,
  hold,
  jsonRows,
  message,
  openSession,
  phoneOn,
  runScenario,
  spendTurn,
  tap,
  tapWords,
  test,
  waitIdle,
  type Rig,
  type Session,
} from "./leg";
import { DEVICE_LABEL } from "./rig-lib";

const H = "claude" as const;
const PHONE = devices[PHONE_DEVICE];
const session: Session = { paneId: null, startNote: "not started" };

/** How long a reply on Haiku may take before the case gives up on it. */
const REPLY_MS = 120_000;
/** The body. One word back and no tool call, so the turn asks no permission and stays cheap. */
const BODY = "Walky check: reply with only the word WALKY-OK.";

test.describe("walky talky", () => {
  test.beforeAll(async () => {
    Object.assign(session, await openSession(H));
  });

  test("6 walky talky: 'Send as message' from the phone types one header and body, the card shows", async ({ browser, rig }) => {
    await runScenario(H, "walky", session, async (pane, trail) => {
      spendTurn(H, "walky: an operator message");
      const { context, page, recorder } = await phoneOn(browser, rig, pane, PHONE);
      const log = trail.log;
      const notes = trail.notes;
      try {
        await page.getByRole("textbox").last().fill(BODY);
        const send = page.getByRole("button", { name: message("composer.send.sendAria"), exact: true });
        log.push(await hold(page, send, "hold Send"));
        const row = page.getByRole("button", { name: message("walky.composer.sendAsMessage"), exact: true });
        const menu = await row
          .waitFor({ state: "visible", timeout: 5000 })
          .then(() => true)
          .catch(() => false);
        if (!menu) {
          trail.captures.push(await capture(page, "walky-6-no-menu"));
          return { verdict: "fail", taps: log.length, minTaps: 2, note: "the first hold on Send opened no 'Send as message' row", taps_log: log, captures: trail.captures };
        }
        const t = await tap(recorder, row, "Send as message");
        log.push(t);
        const answer = t.answers.find((a) => a.path === "/api/walky");
        const id = answer?.requestId ?? null;
        if (id === null) throw new Error(`the tap made no walky talky request: ${tapWords(t)}`);
        const strip = message("walky.composer.outcome", { label: message("walky.composer.toThisPane"), state: "" }).trim();
        const stripShown = await page
          .getByText(strip)
          .first()
          .isVisible()
          .catch(() => false);
        notes.push(`${tapWords(t)}; strip ${stripShown ? "shown" : "not shown"}`);

        // One prompt: the header row, then the body on the next row, in the pane's input history.
        const header = `[walky-talky ${id}] from operator (${DEVICE_LABEL})`;
        const typed = new RegExp(`${escape(header)}\\s*\\n\\s*${escape(BODY)}`);
        const screen = await rig.screenUntil(pane, typed, 30_000, 120);
        notes.push(screen === null ? "the header and body did not reach the pane as one prompt" : "the pane got the header and body as one prompt");
        const receipt = await settledWalky(rig, pane, id, 30_000);
        notes.push(`receipt ${receipt}`);
        const reply = (await rig.screenUntil(pane, /^\s*(?:⏺|●)\s*WALKY-OK/m, REPLY_MS, 120)) !== null;
        notes.push(reply ? "Claude answered the body" : "no answer to the body on screen");
        await waitIdle(rig, pane, REPLY_MS);

        // The card, drawn from the log: its title names the device, its badge names the kind.
        const title = page.getByText(message("walky.card.title", { label: DEVICE_LABEL }), { exact: true }).last();
        const card = await title
          .waitFor({ state: "visible", timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        if (card) await title.scrollIntoViewIfNeeded();
        const badge = await page
          .getByText(message("walky.kind.operator"), { exact: true })
          .last()
          .isVisible()
          .catch(() => false);
        notes.push(`card ${card ? "shown" : "not shown"}, operator badge ${badge ? "shown" : "not shown"}`);
        trail.captures.push(await capture(page, "walky-6-card"), await captureScreen(rig, pane, "walky-6-pane"));
        const verdict = t.worked && screen !== null && receipt === "delivered" && card && badge && reply ? "pass" : "fail";
        return { verdict, taps: log.length, minTaps: 2, note: notes.join("; "), taps_log: log, captures: trail.captures };
      } finally {
        await context.close();
      }
    });
  });
});

/** A literal string as a RegExp source. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The message's receipt state once it left `accepted`, read from the pane's own walky list. */
async function settledWalky(rig: Rig, paneId: string, id: string, ms: number): Promise<string> {
  const state = await rig.until(
    async () => {
      const doc = asJsonObject(await rig.get(`/api/pane/${encodeURIComponent(paneId)}/walky?limit=20`));
      const row = jsonRows(doc?.messages).find((m) => m.id === id);
      return asJsonString(asJsonObject(row?.receipt)?.state) ?? null;
    },
    (value) => value !== null && value !== "accepted",
    ms,
    700,
  );
  return state ?? `not settled in ${String(ms / 1000)} s`;
}
