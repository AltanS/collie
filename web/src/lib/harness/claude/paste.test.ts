import { describe, expect, it } from "vitest";

import { isPastePlaceholderOnly, pasteCarriesSend } from "./paste";

// The paste-placeholder grammar (.adr/0010). Every shape below was live-probed on 2026-08-06 in the
// collie-demo sandbox; the rejections are the load-bearing half — a `true` here fires the submit key
// into a screen we could not otherwise read, so an inconsistent token must never vouch for a send.

/** A message with `n` newlines in it, long enough that Claude would collapse it. */
function multiline(n: number): string {
  return Array.from({ length: n + 1 }, (_, i) => `line ${i} of a message long enough to collapse`).join(
    "\n",
  );
}

describe("pasteCarriesSend — the collapsed shapes", () => {
  it("accepts a fully-collapsed multi-line send whose +M matches our newline count", () => {
    // The klaracase shape: the box holds nothing but the token, and M is the number of `\n` we typed.
    expect(pasteCarriesSend(multiline(3), "[Pasted text #3 +3 lines]")).toBe(true);
    expect(pasteCarriesSend(multiline(59), "[Pasted text #7 +59 lines]")).toBe(true);
  });

  it("accepts the M-less token for a long SINGLE-line send", () => {
    // No newline in the paste → Claude omits the "+M lines" clause entirely, so S = 0 must match a
    // token that claims nothing.
    expect(pasteCarriesSend("x".repeat(1200), "[Pasted text #1]")).toBe(true);
  });

  it("accepts a token plus the literal tail a PTY chunk split left beside it", () => {
    // Observed: `[Pasted text #1 +3 lines]xxxxx… four` — the token swallowed the first chunk,
    // the second landed literally, cursor between them.
    const sent = multiline(3) + "\nand then the tail four";
    expect(pasteCarriesSend(sent, "[Pasted text #1 +3 lines]and then the tail four")).toBe(true);
  });

  it("matches a token the input box WRAPPED mid-way (extractInputDraft space-joins the rows)", () => {
    // `…+3 li` / `nes]` on two rows comes back as one space-joined line, which only a
    // whitespace-STRIPPED match can see.
    expect(pasteCarriesSend(multiline(3), "[Pasted text #3 +3 li nes]")).toBe(true);
    expect(pasteCarriesSend(multiline(3), "[Pas ted te xt #3 +3 lines]")).toBe(true);
  });

  it("accepts several tokens whose line counts add up to what we sent", () => {
    // Consecutive chunks usually merge into one token, but when they don't the sum is the claim.
    expect(pasteCarriesSend(multiline(5), "[Pasted text #1 +2 lines][Pasted text #2 +3 lines]")).toBe(
      true,
    );
  });
});

describe("pasteCarriesSend — rejections (the guard stays shut)", () => {
  it("rejects a token claiming MORE lines than we sent", () => {
    expect(pasteCarriesSend(multiline(3), "[Pasted text #3 +9 lines]")).toBe(false);
  });

  it("rejects a fully-collapsed token whose count does not match ours exactly", () => {
    // Nothing literal beside it, so there is no chunk-split story that explains the missing lines.
    expect(pasteCarriesSend(multiline(5), "[Pasted text #3 +3 lines]")).toBe(false);
    expect(pasteCarriesSend(multiline(3), "[Pasted text #3]")).toBe(false);
  });

  it("rejects a literal fragment that is not in what we sent", () => {
    expect(
      pasteCarriesSend(multiline(3), "[Pasted text #1 +3 lines] rm -rf the wrong thing"),
    ).toBe(false);
  });

  it("rejects fragments that appear in the wrong ORDER", () => {
    const sent = `alpha bravo\ncharlie delta`;
    expect(pasteCarriesSend(sent, "charliedelta[Pasted text #1 +1 lines]alphabravo")).toBe(false);
  });

  it("rejects a stale token when OUR send was short and single-line", () => {
    // THE false-positive that would matter: `#N` is a session counter we cannot predict, so somebody
    // else's placeholder looks exactly like ours. A short single-line send would have been inserted
    // literally, so a token cannot be evidence for it.
    expect(pasteCarriesSend("ship it please", "[Pasted text #3 +3 lines]")).toBe(false);
    expect(pasteCarriesSend("x".repeat(400), "[Pasted text #3]")).toBe(false);
  });

  it("rejects a draft with no token at all (the generic matcher's job, not ours)", () => {
    expect(pasteCarriesSend(multiline(3), "an unrelated leftover line")).toBe(false);
    expect(pasteCarriesSend(multiline(3), "")).toBe(false);
  });
});

describe("isPastePlaceholderOnly", () => {
  it("is true for token-only drafts, including a wrapped one", () => {
    expect(isPastePlaceholderOnly("[Pasted text #3 +3 lines]")).toBe(true);
    expect(isPastePlaceholderOnly("[Pasted text #3 +3 li nes]")).toBe(true);
    expect(isPastePlaceholderOnly("[Pasted text #1][Pasted text #2 +4 lines]")).toBe(true);
  });

  it("is false once the user's own text sits beside the token, and for a plain draft", () => {
    expect(isPastePlaceholderOnly("[Pasted text #1 +3 lines] and the tail")).toBe(false);
    expect(isPastePlaceholderOnly("please review the diff")).toBe(false);
    expect(isPastePlaceholderOnly("")).toBe(false);
  });
});
