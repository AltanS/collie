// Edit a waiting message on Claude Code (ADR 0122, the 2026-11-22 addendum), case 37, on a Claude session of its own.
// Claude writes its queue into its log, so Chat draws the journal's "Waiting to send" card, and the bridge declares
// Claude's dequeue key on it, so the card carries Edit beside Send now.
//
// A long numbered list streams. A send from the composer while it runs goes into Claude's own queue (the receipt is
// `sent` + `queued`), and within one poll the card shows the text with Edit. One tap on Edit posts one take-back
// (`POST /api/pane/:id/dequeue`): the receipt says `taken`, the composer holds the text, the card goes, and Claude's
// box reads empty. The person changes one word and sends it: Claude answers the changed text once, after the list,
// and the first text never became a prompt.
//
// Two model turns: the list and the answer to the changed text. Written on 2026-11-22 and not yet run: the first run
// is a live one that records it (COLLIE_RIG_LIVE=claude COLLIE_RIG_RECORD=1), README "The cases", row 37.
import { asJsonObject, type JsonValue } from "../../src/lib/json";
import { readSendReceipts } from "../../src/lib/send-protocol";
import type { SendReceiptRow } from "../../src/lib/surface/send";
import { NotReached, capture, captureScreen, freeSurface, openSession, phoneOn, resetBox, runScenario, sendFromComposer, spendTurn, tap, tapWords, test, waitIdle, type Rig, type Session } from "./leg";
import { SETUPS } from "./harnesses";
import { PHONE, REPLY_MS, turnRuns } from "./walky-lib";

const H = "claude" as const;
const session: Session = { paneId: null, startNote: "not started" };

/** Long enough that Haiku still streams when the send goes out (case 4 asks for 150). */
const ITEMS = 150;
/** One poll of the Chat window and a margin: the card must show within this after the send settles. */
const CARD_MS = 8000;
/** The text that waits, and the word the person changes before sending it again. */
const QUEUED_TEXT = "Edit check: reply here with only the word DRAFT-OK, nothing else.";
const EDITED_TEXT = "Edit check: reply here with only the word EDIT-OK, nothing else.";
const EDITED_REPLY = /^\s*(?:⏺|●)\s*EDIT-OK\.?\s*$/mu;
/** The screen shows the middle of the list and not its last item: a send now meets a running turn. */
const MID_LIST = /^\s*(?:⏺|●)?\s*1[0-9]\.\s+\S/mu;
const LAST_ITEM = new RegExp(`^\\s*${String(ITEMS)}\\.\\s`, "mu");

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

/** What Claude's box shows while a message waits in its queue. */
const QUEUE_SHOWN = /Press up to edit queued messages|Queued · /u;

/**
 * Leave Claude's queue and box empty on every path, a failed assertion included, so the next case starts clean. A
 * message still in Claude's queue is taken back with Up (the key the bridge declares for it, journal/claude.ts), outside
 * the phone; the turn then runs to its end, and `resetBox` clears what the take-back put in the box. Nothing happens
 * when the queue is empty and the box is free. It never throws: a clean-up that fails is a note.
 */
async function leaveClean(rig: Rig, pane: string, notes: string[]): Promise<void> {
  try {
    if (QUEUE_SHOWN.test(await rig.screen(pane, 40))) {
      await rig.keys(pane, ["Up"]);
      notes.push("clean-up: the waiting text was taken back outside the phone (Up)");
    }
    await rig.until(() => turnRuns(rig, pane), (running) => !running, REPLY_MS);
    await waitIdle(rig, pane, REPLY_MS);
    const reset = await resetBox(rig, pane);
    if (reset !== null) notes.push(`clean-up: ${reset}`);
  } catch (err) {
    notes.push(`clean-up failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** How many user turns of the pane's live window carry `text`. */
async function promptsWith(rig: Rig, pane: string, text: string): Promise<number> {
  const body: JsonValue | undefined = await rig.get(`/api/pane/${encodeURIComponent(pane)}/chat`).catch(() => undefined);
  const upserts = asJsonObject(body)?.upserts;
  if (!Array.isArray(upserts)) return 0;
  return upserts.filter((entry) => asJsonObject(entry)?.role === "user" && JSON.stringify(entry).includes(text)).length;
}

test.describe("edit a waiting message on claude", () => {
  test.beforeAll(async () => {
    Object.assign(session, await openSession(H));
  });

  test("37 edit a waiting message: Edit takes Claude's queue back into the composer, once", async ({ browser, rig }) => {
    await runScenario(H, "queue-edit", session, async (pane, trail) => {
      if (!SETUPS[H].turns) throw new NotReached(SETUPS[H].noTurnsReason);
      const { context, page, recorder } = await phoneOn(browser, rig, pane, PHONE);
      const { log, notes } = trail;
      try {
        const reset = await resetBox(rig, pane);
        if (reset !== null) notes.push(reset);
        const before = { queued: await promptsWith(rig, pane, QUEUED_TEXT), edited: await promptsWith(rig, pane, EDITED_TEXT) };

        // The long turn.
        spendTurn(H, "queue edit: the long list");
        const prompt = `List ${String(ITEMS)} different fruits, one per line, numbered 1 to ${String(ITEMS)}, each with one short sentence about its taste. No other text.`;
        log.push(await sendFromComposer(page, recorder, prompt, "send the long prompt"));
        const streaming = await rig.until(() => rig.screen(pane, 120), (screen) => MID_LIST.test(screen) && !LAST_ITEM.test(screen), 60_000, 150);
        if (streaming === null || !(await turnRuns(rig, pane))) throw new NotReached("the long reply never ran long enough to queue behind it");

        // The send that waits in Claude's own queue.
        const queuedTap = await sendFromComposer(page, recorder, QUEUED_TEXT, "send while the turn runs");
        log.push(queuedTap);
        const sent = queuedTap.answers.find((answer) => answer.path.endsWith("/api/send"));
        const receipt = sent?.requestId === null || sent?.requestId === undefined ? null : await receiptUntil(rig, pane, sent.requestId, (row) => row.outcome !== "held", 10_000);
        // `sent` or `effective`, as case 4 takes it (claude.spec.ts `wentIn`): where Claude has the beacon hooks (the
        // core's rig) the prompt edge of the queued text confirms the send, and the receipt settles `sent` to `effective`
        // (bridge/surface/requests.ts `markEffective`) while it keeps `queued: true` (protocol.ts `receiptOf`).
        const queued = (receipt?.outcome === "sent" || receipt?.outcome === "effective") && receipt.queued === true;
        notes.push(`${tapWords(queuedTap)}; the receipt is ${receipt === null ? "missing" : `${receipt.outcome}${receipt.queued === true ? " + queued" : ", NOT queued"}`}`);

        // The journal's card, with Edit.
        const card = page.locator("[data-slot='stream-queued']").filter({ hasText: "DRAFT-OK" });
        const shown = await card
          .waitFor({ state: "visible", timeout: CARD_MS })
          .then(() => true)
          .catch(() => false);
        const edit = card.locator("[data-slot='stream-queued-edit']");
        const hasEdit = shown && (await edit.count()) === 1;
        notes.push(`the waiting card ${shown ? (hasEdit ? "shows with Edit" : "shows WITHOUT Edit") : `did NOT show within ${String(CARD_MS / 1000)} s`}`);
        trail.captures.push(await capture(page, "queue-edit-37-waiting"));
        if (!queued || !hasEdit) {
          trail.captures.push(await captureScreen(rig, pane, "queue-edit-37-waiting"));
          return { verdict: "fail", taps: log.length, minTaps: 4, note: notes.join("; "), taps_log: log, captures: trail.captures };
        }

        // One tap on Edit: one take-back, `taken`, the text in the composer, the card gone, Claude's box empty.
        const editTap = await tap(recorder, edit, "Edit on the waiting card");
        log.push(editTap);
        const answered = editTap.answers.filter((answer) => answer.path.endsWith("/dequeue"));
        const box = page.getByRole("textbox").last();
        const inComposer = await box
          .evaluate((field, want) => (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) && field.value === want, QUEUED_TEXT)
          .catch(() => false);
        const gone = await card
          .waitFor({ state: "detached", timeout: CARD_MS })
          .then(() => true)
          .catch(() => false);
        const emptyBox = (await rig.until(() => rig.pane(pane).catch(() => null), (found) => found?.surface?.composer === "empty", 5000, 250)) !== null;
        notes.push(`${tapWords(editTap)}; ${String(answered.length)} take-back(s); the composer ${inComposer ? "holds the text" : "does NOT hold the text"}; the card ${gone ? "went" : "STAYED"}; Claude's box ${emptyBox ? "reads empty" : "is NOT empty"}`);
        trail.captures.push(await capture(page, "queue-edit-37-taken"), await captureScreen(rig, pane, "queue-edit-37-taken"));
        const tookBack = answered.length === 1 && answered[0]!.outcome === "taken" && inComposer && gone && emptyBox;

        // The person changes one word and sends it, after the list.
        await rig.until(() => turnRuns(rig, pane), (running) => !running, REPLY_MS);
        await rig.until(() => rig.pane(pane).catch(() => null), (found) => freeSurface(found), 10_000, 250);
        spendTurn(H, "queue edit: the answer to the changed text");
        const editedTap = await sendFromComposer(page, recorder, EDITED_TEXT, "send the changed text");
        log.push(editedTap);
        const reply = await rig.screenUntil(pane, EDITED_REPLY, REPLY_MS, 120);
        await waitIdle(rig, pane, REPLY_MS);
        const edited = (await rig.until(() => promptsWith(rig, pane, EDITED_TEXT), (count) => count > before.edited, 15_000, 1000)) ?? before.edited;
        const never = (await promptsWith(rig, pane, QUEUED_TEXT)) === before.queued;
        notes.push(`${tapWords(editedTap)}; Claude ${reply === null ? "did NOT answer" : "answered EDIT-OK"}; the changed text is in the log ${String(edited - before.edited)} time(s); the first text ${never ? "never became a prompt" : "BECAME a prompt"}`);
        trail.captures.push(await capture(page, "queue-edit-37-end"), await captureScreen(rig, pane, "queue-edit-37-end"));

        const verdict = tookBack && reply !== null && edited === before.edited + 1 && never && log.length === 4 && log.every((entry) => entry.worked) ? "pass" : "fail";
        return { verdict, taps: log.length, minTaps: 4, note: notes.join("; "), taps_log: log, captures: trail.captures };
      } finally {
        await leaveClean(rig, pane, trail.notes);
        await context.close();
      }
    });
  });
});
