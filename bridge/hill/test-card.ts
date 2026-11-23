import { createHash, randomUUID } from "node:crypto";

import type { HillPostInput } from "../../web/src/lib/hill/wire.ts";
import { LOOKING_MS } from "../push.ts";
import type { HillCollieSender, HillCollieVerdict } from "./service.ts";

// THE TEST DECISION (2026-11-22). A person who switched the Hill on can see the whole loop once: Collie posts
// one Decision of its own, marked Now, so a card arrives and the phone gets a notification. It is a card of
// Collie's own with the ref type `test`, and no trick or agent is involved. It is NOT about a trick, so with
// the Hill off nothing posts it, serves it or answers it (wire.ts `HILL_OFF_TRICK_CARDS.test` is false).
//
// FIXED WORDS. Nothing from the request enters the card: the route takes an empty body, and the title, the
// summary and the option are the constants below. One option, "It works", closes it as answered. At most one
// test card is ever open: a new one supersedes the open one, which keeps its notification slot, so the new
// notification replaces the old.
//
// WHY IT WAITS. A device that polled in the last LOOKING_MS (bridge/push.ts) does not get the push while the
// person looks at Collie: its page shows the card. A test sent from the phone's own page would never
// notify that phone. So the post waits HILL_TEST_DELAY_MS, which is the looking window plus nine seconds for
// the person to leave the app. A phone that left within those seconds is no longer looking at the post; one that
// left later has the push held and sent late (push.ts `lookAgain`), never dropped.

/** The sender's name on the card, as on Collie's other cards. */
export const HILL_TEST_SENDER = "Collie";
/** The fixed words of the card. */
export const HILL_TEST_TITLE = "Do asks reach you?";
export const HILL_TEST_SUMMARY = "You sent this test from Settings. Tap the answer to close it.";
/** The card's one option and its label. */
export const HILL_TEST_OK = "ok";
export const HILL_TEST_OK_LABEL = "It works";
/** How long the card stays open when nobody answers it. */
export const HILL_TEST_EXPIRY_MS = 10 * 60_000;
/** How long after the press the card is posted: the looking window and nine seconds to leave the app. */
export const HILL_TEST_DELAY_MS = LOOKING_MS + 9_000;
/** The ref id of the one test card, and its fixed hash: the SHA-256 of "collie hill test". */
export const HILL_TEST_REF_ID = "test";
export const HILL_TEST_REF_HASH = createHash("sha256").update("collie hill test").digest("hex");

/** What the delay's timer hands back: the bridge may let go of it, so a pending test never holds it open. */
export interface HillTestTimer {
  unref?(): void;
}

/** The sender of the test card. */
export function testSender(): HillCollieSender {
  return { kind: "collie", ref: { type: "test", id: HILL_TEST_REF_ID, hash: HILL_TEST_REF_HASH }, label: HILL_TEST_SENDER };
}

/** The card: fixed words, priority now, a fresh request id, and the open test card it replaces, if any. */
export function testCard(now: number, supersedes: string | null, requestId: string = randomUUID()): HillPostInput {
  const card: HillPostInput = {
    requestId,
    title: HILL_TEST_TITLE,
    summary: HILL_TEST_SUMMARY,
    options: [{ intent: HILL_TEST_OK, label: HILL_TEST_OK_LABEL }],
    text: "none",
    priority: "now",
    expiresAt: now + HILL_TEST_EXPIRY_MS,
  };
  if (supersedes !== null) card.supersedes = supersedes;
  return card;
}

/** The answer to the card: "It works" closes it, and nothing else is an option. */
export function answerTest(intent: string): HillCollieVerdict {
  return intent === HILL_TEST_OK ? { ok: true } : { ok: false, reason: "That is not an option of this card." };
}
