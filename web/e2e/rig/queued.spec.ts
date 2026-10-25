// A queued send on omp (ADR 0122, case 29), on the omp session the run started. omp writes nothing
// about a queued message into its log until the turn ends, so Chat draws Collie's own receipt card.
//
// Pass 1. A long numbered list streams. A send from the composer while it runs is queued (omp's queue
// key); the receipt is `sent` + `queued`, and within one poll Chat shows the "Waiting to send" card with
// the text and no button. Stop (two taps) ends the turn, omp puts the text back into its box, and the
// card turns "Back in the box" with Send and Discard; the receipt carries `late: "returned"`. Send
// presses the submit key alone: the text lands once, omp answers it, and the log holds it once.
//
// Pass 2. The same up to Stop with another text, then Discard: the box reads empty and the card goes.
//
// Three model turns: the two lists and the answer to the sent text. omp needs a provider key
// (COLLIE_RIG_KEY_FILE); without one the case reports "not reached".
import type { Page } from "@playwright/test";
import { asJsonObject, type JsonValue } from "../../src/lib/json";
import { readSendReceipts } from "../../src/lib/send-protocol";
import type { SendReceiptRow } from "../../src/lib/surface/send";
import { SETUPS } from "./harnesses";
import { NotReached, capture, captureScreen, message, openSession, phoneOn, resetBox, runScenario, sendFromComposer, spendTurn, tap, tapWords, test, waitIdle, type Rig, type Session, type TapLog, type TapRecorder, type Trail } from "./leg";
import { sleep } from "./rig-lib";
import { PHONE, REPLY_MS, turnRuns } from "./walky-lib";

const H = "omp" as const;
const session: Session = { paneId: null, startNote: "not started" };

/** Long enough to run about 40 s on omp (case 16 asks the same), so the queue and the Stop land mid-turn. */
const ITEMS = 80;
/** One poll of the Chat window and a margin: the card must show within this after the send settles. */
const CARD_MS = 6000;
const SENT_TEXT = "Queue check: reply here with only the word QUEUE-OK, nothing else.";
const SENT_REPLY = /^\s*QUEUE-OK\.?\s*$/m;
const DROPPED_TEXT = "Queue check two: reply here with only the word DROP-OK, nothing else.";

/** The receipt row of one request, once `pick` accepts it, or null after `ms`. */
async function receiptUntil(rig: Rig, pane: string, requestId: string, pick: (row: SendReceiptRow) => boolean, ms: number): Promise<SendReceiptRow | null> {
  const found = await rig.until(
    async () => readSendReceipts(await rig.get(`/api/send/receipts?pane=${encodeURIComponent(pane)}`)).receipts.find((row) => row.requestId === requestId) ?? null,
    (row) => row !== null && pick(row),
    ms,
    1000,
  );
  return found ?? null;
}

/** How many user turns of the pane's live window carry `text`. */
async function promptsWith(rig: Rig, pane: string, text: string): Promise<number> {
  const body: JsonValue | undefined = await rig.get(`/api/pane/${encodeURIComponent(pane)}/chat`).catch(() => undefined);
  const upserts = asJsonObject(body)?.upserts;
  if (!Array.isArray(upserts)) return 0;
  return upserts.filter((entry) => asJsonObject(entry)?.role === "user" && JSON.stringify(entry).includes(text)).length;
}

interface QueuedThenStopped {
  readonly ok: boolean;
  /** The queued send's request id, the returned card's own. */
  readonly requestId: string | null;
}

/**
 * The shared first half of both passes: the long list, a queued send during it, the waiting card,
 * Stop, and the returned card with the receipt's late mark. Every step writes its note.
 */
async function queueThenStop(rig: Rig, pane: string, page: Page, recorder: TapRecorder, trail: Trail, text: string, tag: string): Promise<QueuedThenStopped> {
  const { log, notes } = trail;
  const reset = await resetBox(rig, pane);
  if (reset !== null) notes.push(reset);
  spendTurn(H, `queued ${tag}: the long list`);
  const prompt = `List ${String(ITEMS)} different fruits, one per line, numbered 1 to ${String(ITEMS)}, each with one sentence of about twenty words about its taste. Write the list as plain text in your reply and call no tool. No other text.`;
  log.push(await sendFromComposer(page, recorder, prompt, `${tag}: send the long prompt`));
  const streaming = await rig.screenUntil(pane, /^\s*1[0-9]\.\s+\S/m, 60_000, 120);
  if (streaming === null || !(await turnRuns(rig, pane))) {
    notes.push(`${tag}: the turn did not run`);
    return { ok: false, requestId: null };
  }

  // The queued send: the composer's plain Send while the turn runs.
  const queuedTap = await sendFromComposer(page, recorder, text, `${tag}: send while the turn runs`);
  log.push(queuedTap);
  const sent = queuedTap.answers.find((answer) => answer.path.endsWith("/api/send"));
  const requestId = sent?.requestId ?? null;
  const settledAt = Date.now();
  const receipt = requestId === null ? null : await receiptUntil(rig, pane, requestId, (row) => row.outcome !== "held", 10_000);
  const queued = receipt?.outcome === "sent" && receipt.queued === true;
  notes.push(`${tag}: ${tapWords(queuedTap)}; the receipt is ${receipt === null ? "missing" : `${receipt.outcome}${receipt.queued === true ? " + queued" : ", NOT queued"}`}`);

  const waiting = page.locator("[data-slot='stream-queued-receipts']").filter({ hasText: text });
  const shown = await waiting
    .waitFor({ state: "visible", timeout: CARD_MS })
    .then(() => true)
    .catch(() => false);
  const buttons = shown ? await waiting.locator("button").count() : -1;
  notes.push(`${tag}: the waiting card ${shown ? `showed ${String(Math.round((Date.now() - settledAt) / 100) / 10)} s after the send, with ${String(buttons)} buttons` : `did NOT show within ${String(CARD_MS / 1000)} s`}`);
  trail.captures.push(await capture(page, `queued-29-${tag}-waiting`));

  // Stop: the first tap arms, the second stops (case 25).
  const stop = page.locator("[data-slot='belt-stop']:not([aria-disabled='true'])");
  const live = await stop
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!live) {
    notes.push(`${tag}: the belt shows NO live Stop`);
    return { ok: false, requestId };
  }
  const arm: TapLog = await tap(recorder, stop, `${tag}: arm Stop`, { expectAnswer: false });
  log.push(arm);
  const stopTap = await tap(recorder, page.locator("[data-slot='belt-stop']"), `${tag}: Stop`);
  log.push(stopTap);
  const stopped = stopTap.answers.find((answer) => answer.path.endsWith("/abort"))?.outcome === "stopped";
  const sentence = await page
    .getByText(message("belt.stop.receipt.returned.one", { count: 1 }), { exact: false })
    .waitFor({ state: "visible", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  notes.push(`${tag}: ${tapWords(stopTap)}; the Stop sentence ${sentence ? "names the message back as a draft" : "does not name it (the poll may mark it)"}`);

  const returned = page.locator("[data-slot='stream-returned']").filter({ hasText: text });
  const back = await returned
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  const pair = back && (await returned.locator("[data-slot='stream-returned-send']").count()) === 1 && (await returned.locator("[data-slot='stream-returned-discard']").count()) === 1;
  const late = requestId === null ? null : await receiptUntil(rig, pane, requestId, (row) => row.late === "returned", 10_000);
  notes.push(`${tag}: the returned card ${back ? (pair ? "shows Send and Discard" : "shows WITHOUT its two buttons") : "NEVER showed"}; the receipt ${late === null ? "has NO late mark" : 'carries late: "returned"'}`);
  await sleep(300);
  trail.captures.push(await capture(page, `queued-29-${tag}-returned`), await captureScreen(rig, pane, `queued-29-${tag}-returned`));
  return { ok: queued && shown && buttons === 0 && stopped && back && pair && late !== null, requestId };
}

test.describe("a queued send on omp", () => {
  test.beforeAll(async () => {
    Object.assign(session, await openSession(H));
  });

  test("29 a queued send on omp: a card at once, back in the box after Stop, then Send or Discard", async ({ browser, rig }) => {
    await runScenario(H, "queued-omp", session, async (pane, trail) => {
      if (!SETUPS[H].turns) throw new NotReached(SETUPS[H].noTurnsReason);
      const { context, page, recorder } = await phoneOn(browser, rig, pane, PHONE);
      const notes = trail.notes;
      try {
        // Pass 1: Send on the returned card.
        const first = await queueThenStop(rig, pane, page, recorder, trail, SENT_TEXT, "send");
        let sendOk = false;
        if (first.ok) {
          // The box holds the draft, so the pane never reads free here: wait for the turn alone to end.
          await rig.until(() => turnRuns(rig, pane), (running) => !running, 10_000);
          spendTurn(H, "queued send: the answer to the sent text");
          const sendTap = await tap(recorder, page.locator("[data-slot='stream-returned']").filter({ hasText: SENT_TEXT }).locator("[data-slot='stream-returned-send']"), "send: Send on the returned card");
          trail.log.push(sendTap);
          const answered = sendTap.answers.find((answer) => answer.path.endsWith("/api/send"));
          const reply = await rig.screenUntil(pane, SENT_REPLY, REPLY_MS, 60);
          await waitIdle(rig, pane, REPLY_MS);
          const once = await rig.until(() => promptsWith(rig, pane, SENT_TEXT), (count) => count >= 1, 15_000, 1000);
          const gone = await page
            .locator("[data-slot='stream-returned']")
            .filter({ hasText: SENT_TEXT })
            .waitFor({ state: "detached", timeout: 10_000 })
            .then(() => true)
            .catch(() => false);
          notes.push(`send: ${tapWords(sendTap)}; the agent ${reply === null ? "did NOT answer" : "answered QUEUE-OK"}; the log holds the text ${String(once ?? 0)} time(s); the card ${gone ? "went" : "STAYED"}`);
          sendOk = answered?.outcome === "sent" && reply !== null && once === 1 && gone;
        }

        // Pass 2: Discard on the returned card.
        const second = await queueThenStop(rig, pane, page, recorder, trail, DROPPED_TEXT, "discard");
        let discardOk = false;
        if (second.ok) {
          // The box holds the draft, so the pane never reads free here: wait for the turn alone to end.
          await rig.until(() => turnRuns(rig, pane), (running) => !running, 10_000);
          const discardTap = await tap(recorder, page.locator("[data-slot='stream-returned']").filter({ hasText: DROPPED_TEXT }).locator("[data-slot='stream-returned-discard']"), "discard: Discard on the returned card");
          trail.log.push(discardTap);
          const answered = discardTap.answers.find((answer) => answer.path.endsWith("/api/send"));
          const empty = await waitIdle(rig, pane, 5000);
          const gone = await page
            .locator("[data-slot='stream-returned']")
            .filter({ hasText: DROPPED_TEXT })
            .waitFor({ state: "detached", timeout: 10_000 })
            .then(() => true)
            .catch(() => false);
          const never = (await promptsWith(rig, pane, DROPPED_TEXT)) === 0;
          notes.push(`discard: ${tapWords(discardTap)}; the box ${empty ? "reads empty" : "is NOT empty"}; the card ${gone ? "went" : "STAYED"}; the text ${never ? "never became a prompt" : "BECAME a prompt"}`);
          discardOk = answered?.outcome !== undefined && answered.outcome !== "refused" && empty && gone && never;
        }
        trail.captures.push(await capture(page, "queued-29-end"), await captureScreen(rig, pane, "queued-29-end"));
        const verdict = first.ok && sendOk && second.ok && discardOk && trail.log.length === 10 ? "pass" : "fail";
        return { verdict, taps: trail.log.length, minTaps: 10, note: notes.join("; "), taps_log: trail.log, captures: trail.captures };
      } finally {
        await context.close();
      }
    });
  });
});
