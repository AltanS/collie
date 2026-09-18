import { describe, expect, it } from "vitest";

import { museDraftIsOpaque, musePasteCarriesSend } from "./paste";

// Muse collapses a long SINGLE line to `[Pasted Content N chars]` (N = the line's length in code
// points); other lines stay literal. Threshold in (1000, 1200]: 1000 observed literal, 1200
// collapsed. These cases pin the consistency grammar against synthetic drafts — the live shape is
// pinned by muse--draft-paste-token.txt.

describe("musePasteCarriesSend — the token consistency grammar", () => {
  it("accepts a token whose N is the sent line's length", () => {
    const sent = "q".repeat(1500);
    expect(musePasteCarriesSend(sent, "❯ [Pasted Content 1500 chars]")).toBe(true);
  });

  it("accepts the split token+tail shape (long line collapsed, short lines literal)", () => {
    const sent = `${"q".repeat(1500)}\ntail`;
    expect(musePasteCarriesSend(sent, "[Pasted Content 1500 chars] tail")).toBe(true);
  });

  it("accepts a wrap-split token (matching runs on whitespace-stripped text)", () => {
    const sent = "q".repeat(1500);
    expect(musePasteCarriesSend(sent, "[Pasted Content 1500 cha\nrs]")).toBe(true);
  });

  it("counts code points, not bytes (probed with é)", () => {
    const sent = "é".repeat(1500);
    expect(musePasteCarriesSend(sent, "[Pasted Content 1500 chars]")).toBe(true);
    expect(musePasteCarriesSend(sent, "[Pasted Content 3000 chars]")).toBe(false);
  });

  it("rejects when no sent line is long enough to have collapsed (the stale-token gate)", () => {
    expect(musePasteCarriesSend("short message", "[Pasted Content 1500 chars]")).toBe(false);
  });

  it("rejects a token no sent line accounts for", () => {
    const sent = "q".repeat(1500);
    expect(musePasteCarriesSend(sent, "[Pasted Content 1400 chars]")).toBe(false);
  });

  it("rejects a dropped long line (two collapsed, one token)", () => {
    const sent = `${"a".repeat(1500)}\n${"b".repeat(1500)}`;
    expect(musePasteCarriesSend(sent, "[Pasted Content 1500 chars]")).toBe(false);
    expect(
      musePasteCarriesSend(sent, "[Pasted Content 1500 chars] [Pasted Content 1500 chars]"),
    ).toBe(true);
  });

  it("rejects a literal tail that is not the END of the send (the #110 rule)", () => {
    const sent = `${"q".repeat(1500)}\nfirst-second`;
    // The visible tail is a PREFIX of the message's tail — later text never arrived.
    expect(musePasteCarriesSend(sent, "[Pasted Content 1500 chars] first")).toBe(false);
    expect(musePasteCarriesSend(sent, "[Pasted Content 1500 chars] first-second")).toBe(true);
  });

  it("rejects literal fragments that are not ours, in order", () => {
    const sent = `${"q".repeat(1500)}\nalpha-beta`;
    expect(musePasteCarriesSend(sent, "[Pasted Content 1500 chars] gamma")).toBe(false);
    expect(musePasteCarriesSend(sent, "[Pasted Content 1500 chars] beta-alpha")).toBe(false);
  });

  it("returns false when the draft holds no token (the generic match owns that shape)", () => {
    expect(musePasteCarriesSend("hello", "hello")).toBe(false);
  });
});

describe("museDraftIsOpaque — the take-over stand-down", () => {
  it("is true for any draft carrying a token (take-over would send the token string)", () => {
    expect(museDraftIsOpaque("[Pasted Content 1500 chars]")).toBe(true);
    expect(museDraftIsOpaque("[Pasted Content 1500 chars] tail")).toBe(true);
  });

  it("is false for literal drafts", () => {
    expect(museDraftIsOpaque("hello muse draft")).toBe(false);
    expect(museDraftIsOpaque("")).toBe(false);
  });
});
