import { describe, expect, it } from "vitest";

import { en } from "./messages/en";

// ADR 0179: the Hill and the Decision left the product. Asks and an ask took their place, with no alias.
// No English value says "Hill" or "Decision" as a whole word, nor "ring" (the word is "notification"), nor
// "No push" (Here, Quiet, Away says what it does in plain words). The keys keep their `hill.` names.
// A value that must keep one of these words goes on the allow-list below, with the reason.
const BANNED: readonly RegExp[] = [/\bhill\b/iu, /\bdecisions?\b/iu, /\brings?\b/iu, /\bno push\b/iu];

/** Keys allowed to hold a banned word, each with why. Empty: none is needed today. */
const ALLOWED: ReadonlyMap<string, string> = new Map<string, string>([]);

describe("the English catalog after the rename to Asks (ADR 0179)", () => {
  it("holds no Hill, Decision, ring or No push in any value, apart from the allow-list", () => {
    const hits = Object.entries(en).filter(([key, value]) => !ALLOWED.has(key) && BANNED.some((word) => word.test(String(value))));
    expect(hits).toEqual([]);
  });

  it("the allow-list names only keys that exist and still need it", () => {
    const values = new Map<string, string>(Object.entries(en));
    for (const key of ALLOWED.keys()) {
      const value = values.get(key);
      expect(value).toBeDefined();
      expect(BANNED.some((word) => word.test(value ?? ""))).toBe(true);
    }
  });

  it("says Send a test ask, and a durable agent's card is a question card", () => {
    expect(en["settings.hill.test.button"]).toBe("Send a test ask");
    expect(en["ask.stale"]).toContain("question card");
    expect(en["pushTitle.ask.flood"]).toContain("question cards");
  });
});
