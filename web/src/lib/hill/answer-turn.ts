// Relative imports and no layout code: the bridge test (bridge/hill/answer-turn.test.ts) reads this module too.
import { HILL_ID_RE } from "./wire";

// THE ANSWER TO A TRICK CARD, AS THE CHAT FINDS IT (Altan, 2026-11-18). A tap on a trick approval card is typed into the
// agent's session as the person's own WalkyTalky message. That message carries no field that names the decision: its
// `kind` is `operator` and its body is the only place the id stands. The words are Collie's own, written by one function,
// `answerMessage` in bridge/hill/service.ts, whose first line for a card of Collie's own (the poster's form) is
//
//     Answer to dc_5k9vtcwnrp3z "Use the new version of hadoken?"
//
// The phone reads exactly that line: `Answer to `, a decision id, a space, the title in double quotes, the end of the
// line. Nothing looser. The id is only a KEY: the card the chat draws is built from the Hill's own decision (its `ref`,
// its `answer`), found by that key, never from the words. A turn whose first line is any other shape stays the plain card.
// bridge/hill/answer-turn.test.ts pins this reader to the writer's own output (it lives in the bridge's tests, because
// the web program must not pull the bridge's code into its type check).

const FIRST_LINE = /^Answer to (dc_[a-z0-9]{12}) "[^\n]*"$/u;

/** The decision a typed answer is about: the id on the first line of the poster's form, else null. */
export function answeredDecisionId(body: string): string | null {
  const id = FIRST_LINE.exec(body.split("\n", 1)[0] ?? "")?.[1];
  return id !== undefined && HILL_ID_RE.test(id) ? id : null;
}
