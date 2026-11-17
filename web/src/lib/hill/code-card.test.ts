import { describe, expect, it } from "vitest";

import { trickYesAnswer } from "@/lib/hill/code-card";
import { collieCard, groupDecision } from "@/test/hill-fixtures";

// THE YES'S WIRE ACROSS A VERSION SKEW (ADR 0156). This bridge asks only for the digest. A bridge of 1.29.0-edge.1 to
// edge.4 still refuses a yes that does not name every card in `opened` (its groupRule: every card of the group, or
// card 1 of a single card), so the phone names them all. The old rule is written out here as it stood.

/** The rule of an edge.1 to edge.4 bridge: every card of a group opened, or card 1 of a single card. */
function oldBridgeTakes(cards: number, opened: readonly number[] | undefined): boolean {
  if (opened === undefined) return false;
  return Array.from({ length: cards }, (_, i) => i + 1).every((n) => opened.includes(n));
}

describe("trickYesAnswer", () => {
  it("a group's yes carries its digest and every card number, which an edge.4 bridge takes", () => {
    const decision = groupDecision(4);
    const answer = trickYesAnswer(decision)!;
    expect(answer.digest).toBe(decision.group!.digest);
    expect(answer.opened).toEqual([1, 2, 3, 4]);
    expect(oldBridgeTakes(decision.group!.parts.length, answer.opened)).toBe(true);
  });

  it("a single card's yes carries the ref's hash and card 1", () => {
    const decision = collieCard("proposal", "legs", { view: [{ kind: "diff", attrs: { file: "a.ts" }, text: "@@ -0,0 +1 @@\n+1" }] });
    const answer = trickYesAnswer(decision)!;
    expect(answer.digest).toBe(decision.from.kind === "collie" ? decision.from.ref?.hash : undefined);
    expect(answer.opened).toEqual([1]);
    expect(oldBridgeTakes(1, answer.opened)).toBe(true);
  });

  it("a card with no code gets no yes, so nothing to carry", () => {
    expect(trickYesAnswer(collieCard("proposal", "legs", { view: [{ kind: "para", text: "No code." }] }))).toBeUndefined();
  });
});
