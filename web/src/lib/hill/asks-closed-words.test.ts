import { describe, expect, it } from "vitest";

import { closedSentence } from "@/components/ask-closed";
import { askDecision } from "@/test/asks-fixtures";

import { closedAskWhy } from "./asks";
import { HILL_ASK_ANSWERED_HERE, HILL_ASK_CLEARED } from "./wire";
import { closedWord } from "./words";

// The words of an ask that closed without the phone: in the board's closed list (`closedWord`) and on the ask's own screen.

const closed = (closedReason: string | null, state: "withdrawn" | "answered" | "superseded" | "undeliverable" | "expired" = "withdrawn") => askDecision({ state, closedReason });

describe("an ask closed in its session", () => {
  it("is answered in the session, in its own words, never 'Withdrawn by the poster'", () => {
    expect(closedWord(closed(HILL_ASK_ANSWERED_HERE))).toBe("You answered it in the session.");
    expect(closedSentence(closedAskWhy(closed(HILL_ASK_ANSWERED_HERE)))).toBe("You answered it in the session.");
  });

  it("says the conversation was cleared", () => {
    expect(closedWord(closed(HILL_ASK_CLEARED))).toBe("The conversation was cleared. This ask is closed.");
    expect(closedSentence(closedAskWhy(closed(HILL_ASK_CLEARED)))).toBe("The conversation was cleared. This ask is closed.");
  });

  it("keeps the plain words for an ask the agent took back, one that was replaced and one whose session ended", () => {
    expect(closedWord(closed("by the poster"))).toBe("Withdrawn by the poster");
    expect(closedSentence(closedAskWhy(closed("by the poster")))).toBe("The agent took this ask back.");
    expect(closedSentence(closedAskWhy(closed(null, "superseded")))).toBe("The agent sent a newer ask in its place.");
    expect(closedSentence(closedAskWhy(closed("target session ended", "undeliverable")))).toBe("The session that asked has ended.");
    expect(closedSentence(closedAskWhy(closed(null, "expired")))).toBe("This ask is closed.");
  });

  it("says an id the board does not hold is not on it", () => {
    expect(closedSentence(null)).toBe("This ask is not on the board.");
  });
});
