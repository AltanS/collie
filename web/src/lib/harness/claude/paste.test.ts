import { describe, expect, it } from "vitest";

import { collapsesAsPaste, isPastePlaceholderOnly, liftableImagePaths, pasteCarriesSend } from "./paste";

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

  it("rejects a tail that stops SHORT of the end of what we sent (#110)", () => {
    // THE partial-arrival false positive. Live-probed 2026-08-17 (collie-demo, pane `w6:p1`): the
    // head collapsed into a token and two of three tails arrived literally. `Σ M ≤ S` passes (the
    // tail's own newlines were never in the token's count), and the truncated tail is still a
    // prefix-ordered substring, so the indexOf loop passes too — the trailing text being the END of
    // our message is the only thing that separates this screen from a complete one.
    const sent = `${multiline(5)} TAIL-ONE-alpha TAIL-TWO-bravo TAIL-THREE-charlie`;
    expect(pasteCarriesSend(sent, "[Pasted text #3 +5 lines] TAIL-ONE-alpha TAIL-TWO-bravo")).toBe(
      false,
    );
    // …and the complete arrival of the very same send still accepts.
    expect(
      pasteCarriesSend(sent, "[Pasted text #3 +5 lines] TAIL-ONE-alpha TAIL-TWO-bravo TAIL-THREE-charlie"),
    ).toBe(true);
  });

  it("rejects a tail truncated MID-WORD, and a lone trailing scrap", () => {
    const sent = `${multiline(3)} and then the tail four`;
    expect(pasteCarriesSend(sent, "[Pasted text #1 +3 lines] and then the tail fo")).toBe(false);
    expect(pasteCarriesSend(sent, "[Pasted text #1 +3 lines] x")).toBe(false);
  });

  it("still accepts a tail the box WRAPPED — the suffix is checked whitespace-stripped", () => {
    // The wrap falls anywhere, including inside the tail, and extractInputDraft space-joins the rows.
    const sent = `${multiline(3)} and then the tail four`;
    expect(pasteCarriesSend(sent, "[Pasted text #1 +3 lines] and then the ta il fo ur")).toBe(true);
  });

  it("keeps today's looser rule when the draft ends ON a token", () => {
    // The end of our message is inside the token there, so there is nothing visible to compare and
    // the tightening has nothing to bite on. Documented hole (see paste.ts) — rejecting a shape we
    // cannot read would turn working sends into permanent stalls, the worse of the two failures.
    const sent = `${multiline(3)} a literal middle bit and more that collapsed`;
    expect(
      pasteCarriesSend(sent, "a literal middle bit[Pasted text #2 +3 lines]"),
    ).toBe(true);
  });

  it("rejects a draft with no token at all (the generic matcher's job, not ours)", () => {
    expect(pasteCarriesSend(multiline(3), "an unrelated leftover line")).toBe(false);
    expect(pasteCarriesSend(multiline(3), "")).toBe(false);
  });
});

// A long bracketed paste that carries an image path: Claude lifts a path off its end, or off a line
// of its own, into `[Image #N]` and attaches the file (live-probed 2026-10-03, Claude Code 2.1.288).
describe("pasteCarriesSend — an image path Claude lifted out of the paste", () => {
  const long = "x".repeat(1500);
  // The shape the upload route returns: <stateDir>/uploads/<pane>-<base36 time>-<8 hex>.<ext>.
  const shot = "/home/you/.local/state/collie/uploads/w1_p1-mf3x9q-0a1b2c3d.png";
  const shot2 = "/home/you/.local/state/collie/uploads/w1_p1-mf3x9r-1b2c3d4e.jpg";
  const winShot = "C:\\Users\\Jane Doe\\AppData\\collie\\uploads\\w1_p1-mf3x9q-0a1b2c3d.png";

  it("accepts the image token beside the paste when the send ended in an upload path", () => {
    expect(pasteCarriesSend(`${long} ${shot}`, "[Image #8][Pasted text #9]")).toBe(true);
  });

  it("accepts the lifted path taking its own line's newline with it", () => {
    // Two newlines sent; the path's line went into the image, so the token claims one.
    expect(pasteCarriesSend(`${long}\n${shot}\n${long}`, "[Image #10][Pasted text #11 +1 lines]")).toBe(true);
  });

  it("accepts a Windows upload path alone on its line, spaces in the profile name and all", () => {
    expect(pasteCarriesSend(`${long}\r\n${winShot}\r\n${long}`, "[Image #10][Pasted text #11 +1 lines]")).toBe(
      true,
    );
  });

  it("accepts two tokens for two paths, one on its own line and one ending the text", () => {
    expect(pasteCarriesSend(`${long}\n${shot}\n${long} ${shot2}`, "[Image #1][Image #2][Pasted text #3 +1 lines]")).toBe(
      true,
    );
  });

  it("rejects an image token the send had no image path for", () => {
    expect(pasteCarriesSend(`${long} /tmp/notes.txt`, "[Image #8][Pasted text #9]")).toBe(false);
  });

  it("rejects a prose mention of an image name, with a leftover [Image #1] already in the draft", () => {
    expect(pasteCarriesSend(`${long} see screenshot.png`, "[Image #1][Pasted text #9]")).toBe(false);
    expect(pasteCarriesSend(`${long}\nplease open screenshot.png now\n${long}`, "[Image #1][Pasted text #9 +1 lines]")).toBe(
      false,
    );
  });

  it("rejects a bare path outside the uploads shape, and an upload path in the middle of a line", () => {
    expect(pasteCarriesSend(`${long} /tmp/shot.png`, "[Image #8][Pasted text #9]")).toBe(false);
    expect(pasteCarriesSend(`${long} ${shot} and then more words`, "[Image #8][Pasted text #9]")).toBe(false);
  });

  it("rejects more image tokens than the send had upload paths (two paths, three tokens)", () => {
    expect(
      pasteCarriesSend(`${long}\n${shot}\n${long} ${shot2}`, "[Image #1][Image #2][Image #3][Pasted text #4 +1 lines]"),
    ).toBe(false);
    expect(pasteCarriesSend(`${long} ${shot}`, "[Image #7][Image #8][Pasted text #9]")).toBe(false);
  });

  it("still rejects a line count no lifted image explains", () => {
    expect(pasteCarriesSend(`${long}\n${long}\n${long}`, "[Image #10][Pasted text #11 +0 lines]")).toBe(false);
  });
});

describe("liftableImagePaths — only the paths Claude lifts, in the shape Collie sends", () => {
  const p = "/s/uploads/w1_p1-mf3x9q-0a1b2c3d.png";

  it("counts a path on its own line and a path ending the text, once each", () => {
    expect(liftableImagePaths(`a\n${p}\nb`)).toBe(1);
    expect(liftableImagePaths(`a ${p}`)).toBe(1);
    expect(liftableImagePaths(`a\n${p}`)).toBe(1);
    expect(liftableImagePaths(`${p}\nmid ${p}\nend ${p}`)).toBe(2);
  });

  it("counts nothing for prose mentions, foreign paths or a path mid-line", () => {
    expect(liftableImagePaths("look at screenshot.png please")).toBe(0);
    expect(liftableImagePaths("see /tmp/shot.png")).toBe(0);
    expect(liftableImagePaths(`before ${p} after`)).toBe(0);
  });
});

describe("collapsesAsPaste — which sends go as one bracketed paste", () => {
  it("frames only what Claude would collapse: over 800 characters", () => {
    expect(collapsesAsPaste("x".repeat(800))).toBe(false);
    expect(collapsesAsPaste("x".repeat(801))).toBe(true);
  });
});

describe("isPastePlaceholderOnly", () => {
  it("is true for token-only drafts, including a wrapped one", () => {
    expect(isPastePlaceholderOnly("[Pasted text #3 +3 lines]")).toBe(true);
    expect(isPastePlaceholderOnly("[Pasted text #3 +3 li nes]")).toBe(true);
    expect(isPastePlaceholderOnly("[Pasted text #1][Pasted text #2 +4 lines]")).toBe(true);
    expect(isPastePlaceholderOnly("[Image #8][Pasted text #9]")).toBe(true);
  });

  it("is false once the user's own text sits beside the token, and for a plain draft", () => {
    expect(isPastePlaceholderOnly("[Pasted text #1 +3 lines] and the tail")).toBe(false);
    expect(isPastePlaceholderOnly("please review the diff")).toBe(false);
    expect(isPastePlaceholderOnly("")).toBe(false);
  });
});
